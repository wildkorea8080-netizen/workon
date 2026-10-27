# WORKON 업무 개편 — 출시·운영 자료

작성: 2026-10-27 · 브랜치 `rebuild/workon-vnext` · 이 문서는 **로컬·시험 환경에서 끝낸 상태**를 적는다. 운영 DB·운영 배포에는 아무것도 반영하지 않았다(06 문서 '운영 변경의 경계').

진행 장부(무엇을 했고 무엇이 남았나)는 [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md), 결정 기록은 `adr/`.

---

## 1. 실제로 돌린 검증(2026-10-27)

| 검증 | 결과 | 범위 |
|---|---|---|
| `npx tsc --noEmit` | 통과 | 전체 |
| `npm test`(시험 DB 주소 포함) | **1692 통과 · 0 건너뜀** | 업무 시험은 실제 Postgres 16(0001~0034)·실제 채우기 엔진·실제 표준 양식 |
| `npm test`(시험 DB 없이) | 업무 DB 시험은 건너뜀 | 순수 함수만 |
| `npm run build` | 이 PC에서는 못 돌림(커밋 메모리 부족) → **Vercel 미리보기 빌드 통과**(2026-10-27, 브랜치 푸시 `5b674b8`) | 운영 배포는 아님 — 운영 0034 적용 뒤 main 푸시 |
| `npm run work:template-check` | 표준 양식 7종 ✓(사람의 시각 검토 기록 없음 경고) | `--release`는 사람 검토 기록이 있어야 통과 |
| `npm run work:template-verify` | 7종 한글 2018 COM으로 열기·넣은 글 확인·편집·다시 저장·다시 열기·PDF 통과 | 쪽 배치·글꼴 시각 검토는 사람 몫 |
| 로컬 Supabase(Docker, 포트 55321~) | 0001~0034 실제 Supabase Postgres 17에 적용 통과. 로그인 화면으로 공문·취합·규정·접수·정산·회신 생성, 결과 파일 가져오기, 기관 격리(동료·관리자·다른 기관 404), 스위치 꺼진 기관 403, 관리자 업무 관리(양식 등록·현황) 확인 | **시험 모드(모델 없음)**. 실제 모델 화면 생성은 공문 1건(서버 시험)뿐 |
| 실제 모델(`npm run work:llm-smoke -- --yes-cost`) | **모델을 쓰는 업무 8개 모두 성공**, 결과 파일 검사 통과, 합계 170원 — 점검에서 4건(공문 발신명의를 모델이 지어 넣음 등)을 찾아 고치고 다시 확인(75원). `evidence/llm-smoke-2026-10-27*.md` | 시험 DB·가상 자료. 취합·정산은 모델을 쓰지 않는다. **화면에서** 실제 모델로 만든 것은 아직 없음(서버 경로는 같다) |
| 실제 한글 렌더 | 별도 작업자 `--hancom`으로 공문 HWPX → 한글 PDF 미리보기(sha256 연결) | Windows·한글 설치 PC에서만 |

확인 못 한 것: 운영 빌드, 슈퍼관리자 '업무 화면 전환' 화면(시험 환경에 슈퍼관리자 계정 없음 — API 인증 시험만), 실제 모델로 화면에서 끝까지(점검 스크립트는 같은 서버 경로를 씀), 스테이징·운영 DB의 `db:check`·`isolation:check`(운영 DB를 시험에 쓰지 않았다).

---

## 2. 환경 변수(이름만)

기존 그대로: `NEXT_PUBLIC_SUPABASE_URL` `NEXT_PUBLIC_SUPABASE_ANON_KEY` `SUPABASE_SERVICE_ROLE_KEY` `NEXTAUTH_URL` `NEXTAUTH_SECRET` `ANTHROPIC_API_KEY` `SUPER_ADMIN_SETUP_KEY` `SUPER_JWT_SECRET` `ENCRYPTION_KEY` `NODA_API_KEY`(규정 확인의 기관 문서·공통 자료실 검색) `LAW_API_OC`(규정 확인의 법령 — 비우면 법제처 시험 계정 'test').

새로 쓰는 것:

| 이름 | 뜻 | 없으면 |
|---|---|---|
| `WORK_WORKER_SECRET` | 작업자 엔드포인트 `/api/work/worker`의 Bearer 비밀값(pg_cron·예약 작업이 싣는다) | 그 엔드포인트만 503. 화면이 실행을 바로 거는 길은 그대로 돈다 |
| `WORK_GENERATOR` | `mock`이면 모델 없이 시험 모드 | 실제 모델. **운영(NODE_ENV=production)에서는 무시** |
| `WORK_DATABASE_URL` 또는 `DATABASE_URL` | 상시 작업자(`npm run work:worker`)의 Postgres 직결 주소 | 작업자 실행 불가(웹 앱과 무관) |

값은 문서·채팅에 적지 않는다. `.env.example`에는 이름만 있다.

---

## 3. 로컬 기동

```bash
npm install
npm run dev                         # 기존과 같음 — 기관 스위치가 꺼져 있으면 지금 화면 그대로
```

업무 화면을 로컬에서 보려면 **시험용 Supabase**가 필요하다(운영 Supabase를 시험에 쓰지 않는다). 이 PC에서 쓴 방법:

1. Docker Desktop을 켠다
2. 임시 폴더에 `npx supabase init` → `config.toml`의 포트를 다른 프로젝트와 겹치지 않게(예: 55321~) → `supabase/migrations/`에 저장소 0001~0034를 버전 순서대로 복사. **운영에 손으로 추가된 칸**(`agents.icon·color·usage_guide·starter_prompts` — 마이그레이션 파일에 없음)을 0019 앞에 보충해야 0019가 적용된다
3. `npx supabase start` → 시험 기관·부서·계정을 `auth.admin.createUser`로 만들고 `work_org_settings`를 켠다
4. 그 Supabase 주소·키로 `next dev`(운영 키·NODA·메일은 비우거나 막는다)

시험 DB만 필요한 자동 시험:

```bash
npm run work:testdb -- start        # 설치된 PostgreSQL 16 바이너리로 임시 클러스터(54329), 0001~0034 적용
npm test                            # WORK_TEST_DATABASE_URL을 주면 업무 DB 시험도 돈다
npm run work:testdb -- stop
```

---

## 4. 작업자·렌더러

- **화면이 바로 건다**: 실행을 만들면 화면이 `/api/work/tasks/{id}/runs/{runId}/execute`를 부르고(최대 300초), 열린 화면은 대기 실행을 다시 건다. 화면을 닫으면 아무도 안 건다 → 아래 둘 중 하나가 필요하다
- **pg_cron 1분 호출(권장, ADR 0003)** — Supabase SQL(비밀값은 Vault):
  ```sql
  select cron.schedule('workon-work-worker', '* * * * *', $$
    select net.http_post(url := 'https://<도메인>/api/work/worker',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'work_worker_secret')),
      timeout_milliseconds := 290000);
  $$);
  ```
- **상시 작업자**: `npm run work:worker`(DB 직결 + Supabase Storage), `-- --once` 한 바퀴, `-- --local-files 폴더` 시험용
- **한글 렌더러(미리보기 PDF)**: Windows·한글 설치 PC에서 `npm run work:worker -- --hancom`. 서버에는 렌더러가 없어 화면은 '실제 파일 미리보기 없음'으로 표시한다(ADR 0002). 운영 렌더러(한컴 서버 제품 등)는 사용권·데이터 경로 결정이 필요하다

---

## 5. 마이그레이션·배포 순서(사용자가 한다)

0034는 **추가만** 한다(기존 표·칸·버킷 무변경). 0028·0032의 수동 적용 조건은 그대로다.

1. 시험 환경(위 3절)에서 0034 적용 → 화면 확인
2. 운영: `npm run db:migrate -- 0034` — **코드 배포 전**(옛 코드는 새 표를 모른다). 적용 뒤 확인:
   ```sql
   SELECT count(*) FROM work_tasks;                         -- 0
   SELECT count(*) FROM work_org_settings;                  -- 0 (모든 기관이 꺼진 상태)
   ```
3. 코드 푸시(배포 확인) — 기관 스위치가 전부 꺼져 있어 직원 화면은 그대로다. `/api/work/**`에 표준 양식이 실려 가는지(`next.config.mjs` `outputFileTracingIncludes`) 배포 뒤 `/templates`에서 '파일 없음'이 아닌지 본다
4. `WORK_WORKER_SECRET`을 넣고 pg_cron(4절)을 건다
5. 슈퍼관리자 `/super/work`에서 **대표 기관 하나**의 '새 작업'을 켜고 업무 하나를 끝까지 써 본다 → '업무 홈'을 켠다
6. 기관 관리자 `/admin/work`에서 쓰지 않을 업무를 끄고, 기관 양식이 있으면 등록·시험 생성·한글 확인 기록
7. 기관을 넓힌다

> **대화 기능 영향**: 저장소에 표준 양식 7종이 생겨 푸시하면 기존 대화의 '문서 만들기' 목록에도 나온다(전에는 '아직 준비되지 않음'). 공문 서식은 초안이라 사람의 시각 검토 뒤 푸시를 권한다.

---

## 6. 롤백

- **새 실행 멈추기**: `/super/work`에서 그 기관의 '새 작업'을 끈다 → 새 작업·실행이 막힌다. 이미 만든 작업·파일은 읽기·내려받기가 남는다
- **화면 되돌리기**: '업무 홈'을 끄면 직원 홈이 대화 화면으로 돌아간다. 옛 주소 `/?conv=`는 그대로 열린다
- **업무 하나만**: `/admin/work`에서 그 업무를 끈다
- 0034 표를 DROP하는 것을 기본 롤백으로 삼지 않는다(만든 작업·파일이 사라진다). 새 자료를 옛 대화로 억지로 되돌리지 않는다

---

## 7. 사용법(요약)

직원 — 업무 홈 → 업무 비서에서 업무 고르기 → 양식·필수 입력 → 작업실 왼쪽 '원자료'에 파일 올리기(파일 갈래가 여럿이면 고르기, '내 결과물에서 가져오기'·'대화 파일에서 가져오기') → 만들기 → 가운데에서 결과 파일·항목·칸 확인 → 오른쪽 '확인할 사항'을 고치거나 확인 → 칸 직접 수정(새 판·새 파일) 또는 'AI 수정' → '검토 완료'(반드시 고칠 것이 없고 지금 판 파일이 모두 있을 때만). '검토 완료'는 제출·발송이 아니다.

기관 관리자 — `/admin/work`: 업무 비서 켜고 끄기, 기관 업무 양식 등록(시험 생성은 패키지 검사뿐 — 한글에서 열어 보고 '한글에서 확인함'을 직접 기록), 업무 현황(건수·실패 코드만, 직원 작업 내용은 보이지 않음).

슈퍼관리자 — `/super/work`: 기관별 업무 홈·새 작업 스위치(바꾼 기록은 슈퍼관리자 로그).

---

## 8. 운영 전 남은 항목

1. 시험용 Supabase(또는 스테이징)에 0034 적용 뒤 실제 모델로 업무를 화면에서 — 서버 경로는 `npm run work:llm-smoke`로 8개 모두 확인함(가상 자료). 기관의 실제 자료 형태(긴 공문·스캔 PDF·큰 엑셀)로 한 번 더 보는 것을 권함
2. 사람의 시각 검토: `docs/workon-rebuild/evidence/p0/*.pdf`(한글이 그린 표준 양식 7종) → `assets/templates/verification.json`에 `human-visual`
3. 운영 렌더러 결정(ADR 0002), pg_cron 설정
4. ~~Vercel 빌드 확인~~ — 미리보기 빌드 통과(2026-10-27)
5. 스테이징 DB에서 `npm run db:check`·`npm run isolation:check`
6. 데이터 흐름 문서 갱신: 업무 원자료·발췌가 Claude로 가는 경로(공문·보고서·규정 의견·항목 뽑기·질문별 답변), 규정 확인의 NODA·법제처 경로. 정산·취합은 모델을 부르지 않는다
7. 알려진 한계는 장부 5-3·5-5·5-7절(선택 산출물 3종 미구현 등)
