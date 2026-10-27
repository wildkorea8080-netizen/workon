# ADR 0003 — 내구성 있는 실행(Postgres 실행 표 + lease 작업자)

- 날짜: 2026-10-27 · 상태: 채택 · 관련: 05_DATA_API_AND_JOBS.md 6절

## 결정

1. 새 외부 큐 계정 없이 **Postgres 표(work_runs·work_run_steps)와 SQL 함수**로 실행을 관리한다(0034).
   - 넣기 `work_enqueue_run`: (기관·작업·종류·요청 번호) 유일 — 같은 번호·같은 내용이면 같은 실행, 다른 내용이면 409. 같은 종류의 대기 중인 옛 실행은 superseded
   - 가져가기 `work_claim_runs`: `FOR UPDATE SKIP LOCKED` + lease(120초). lease가 끝난 실행은 다른 작업자가 다시 가져가고 시도를 센다. 시도를 다 쓴 채 끝난 lease는 `LEASE_EXPIRED`로 닫는다
   - heartbeat로 단계 사이 lease를 늘린다. 끝내기 `work_finish_run`은 lease를 가진 작업자만(아니면 lost), 다시 시도할 실패는 지연 뒤 대기로
   - 단계 체크포인트(work_run_steps): 다시 시도할 때 끝난 단계(모델 호출 포함)를 건너뛴다 — 같은 응답을 두 번 과금하지 않는다
   - 문서 판 저장 `work_save_document_version`은 기준 판·작업의 현재 실행을 잠금 안에서 확인한다 — 늦게 끝난 옛 실행이 새 판을 덮지 않는다(WK410)
2. 실행을 처리하는 곳(모두 같은 `runWorker`):
   - `POST /api/work/tasks/[id]/runs/[runId]/execute` — 직원이 만든 직후 화면이 부른다(기다림을 줄이는 가속). 요청이 끊겨도 실행은 DB에 남는다
   - `GET|POST /api/work/worker` — `WORK_WORKER_SECRET` Bearer. **주기 호출이 필요하다**(아래)
   - `npm run work:worker` — DATABASE_URL로 직접 붙어 계속 도는 작업자(로컬·자체 서버)
3. 응답 뒤 함수를 흘려 두거나 타이머로 내구성을 주장하지 않는다.

## 주기 호출(운영 설정 — 사용자가 한다)

Vercel Hobby 예약 작업은 하루 한 번뿐이라, 화면이 닫힌 채 실패한 실행을 빨리 이어 받으려면 다음 중 하나가 필요하다.
- **Supabase pg_cron + pg_net**(권장, 추가 계약 없음): 1분마다 `POST https://<도메인>/api/work/worker`에 `Authorization: Bearer <WORK_WORKER_SECRET>`. 비밀값은 Supabase Vault에 둔다. SQL 예시는 IMPLEMENTATION_STATUS.md '운영 전 할 일'.
- Vercel Pro 이상의 분 단위 예약 작업, 또는 자체 서버에서 `npm run work:worker` 상시 실행.
주기 호출이 없으면 화면이 실행을 바로 처리하지 못한 경우(탭을 닫음·함수 시간 초과) 다음 주기(하루 한 번 예약 작업을 걸면 그때)까지 대기한다.

## 검증

- `tests/work-db.test.ts`: 동시 claim은 한 곳만, lease 만료 재가져가기·시도 소진, lost·requeued·superseded.
- `tests/work-flow.test.ts`: 모델 장애 재시도(모델 2회만 호출·사용 기록 1건), 작업자 죽음 뒤 이어 받기(판·파일 1벌), 판 저장 뒤 체크포인트 전 죽음(판 1벌), 파일 올린 뒤 기록 실패(객체 삭제·재시도 성공).
- 별도 프로세스: `npm run work:worker -- --once`가 시험 DB의 대기 실행을 처리(2026-10-27).
