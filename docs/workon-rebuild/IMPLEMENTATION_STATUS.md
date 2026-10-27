# WORKON 전면 개편 — 구현 장부

갱신: 2026-10-27 · 브랜치 `rebuild/workon-vnext`(main에 합치지 않음·푸시 안 함) · 분석 기준 `702cc43` 이후 `4fbf0b7`(NODA 놓친 웹훅 다시 받기)만 더해짐 — 업무 개편과 겹치지 않음

구분: **설계** · **코드** · **자동 시험** · **실제 파일 검증** · **브라우저 확인** · **스테이징** · **운영 반영**을 따로 적는다. 체크만 고치고 완료라 하지 않는다.

## 1. 현재 단계 요약

| 단계 | 코드 | 자동 시험 | 실제 파일 | 브라우저 | 스테이징·운영 |
|---|---|---|---|---|---|
| P0 실제 문서 관문 | 완료 | 완료 | **한글 자동 검증 통과**(3종) · 사람의 시각 검토 없음 | 해당 없음 | — |
| P1 작업·권한·내구성 | 완료(0034·서비스·작업자) | 완료(실제 Postgres 25건) | 공문 HWPX 생성·한글 렌더 | — | **0034 미적용**(사용자 몫) |
| P2 화면·공문 끝까지 | 완료(화면·API) | API 인증 시험 | 공문(실제 모델)·한글 PDF | **로그인 전 경로만**(컴파일·리다이렉트·401) | 로그인 흐름 미확인 — 아래 7절 |
| P3 핵심 3개 | 공문·**자료 취합** 구현, 규정 미구현 | 취합 엔진 8·흐름 1(실제 XLSX·Postgres) | 취합 XLSX(값만·5시트) 수치 확인 | — | — |
| P4~P6 | 미착수 | — | — | — | — |

**첫 제품 완료 단위**(양식·입력 → 생성 → 검토 → 수정 → 새 파일 내려받기)는 **서버·실제 DB·실제 파일까지 통과**, **로그인한 브라우저 흐름은 미확인**(시험용 Supabase 필요).

## 2. 변경 파일(주요)

- DB: `supabase/migrations/0034_work_domain.sql`(추가만 — 기존 표 무변경)
- 도메인: `src/lib/work/**` — access·catalog·types·documents(fields·package-check·generate-file·templates·renderer)·generation/compose·runs(executor·worker)·store(supabase·pg)·files·sources·artifacts·review·services·server·client·workflows
- API: `src/app/api/workflows`, `src/app/api/work/**`(19개 라우트), `src/app/api/work/worker`
- 화면: `src/app/page.tsx`(스위치), `src/app/chat`, `src/app/{assistants,tasks,tasks/new,tasks/[id],tasks/[id]/history,files,templates}`, `src/components/work/*`, 기존 대화 홈은 `src/components/chat/ChatHome.tsx`로 옮김(내용 그대로)
- 양식: `assets/templates/{official_letter,report,minutes}.hwpx` + `src/*.html` + `verification.json`
- 스크립트: `build-standard-templates.ps1`, `hancom-verify.ps1`, `work-template-check.mjs`, `work-template-verify.mjs`, `work-testdb.mjs`, `work-worker.mjs`, `work-hancom-renderer.mjs`
- 설정: `config.ts`(WORK_WORKER_SECRET·WORK_GENERATOR), `next.config.mjs`(/api/work/** 양식 추적, NEXT_BUILD_CPUS), `tests/route-auth.test.ts`(작업자 엔드포인트 공개 이유)
- 결정: `adr/0001`(엔진 범위 D1·D2) · `0002`(렌더러) · `0003`(내구성 실행)
- 의존: `@types/pg`(개발 의존 — `pg`는 이미 개발 의존)

## 3. 시험 결과(2026-10-27 실행)

| 명령 | 결과 |
|---|---|
| `npx tsc --noEmit` | 통과 |
| `npm test`(WORK_TEST_DATABASE_URL 포함) | **1632 통과 · 0 건너뜀**(기존 1580 + 업무 49 + 기본 양식 시험 3건이 파일이 생겨 실행됨) |
| `npm test`(DB 주소 없이) | 업무 DB 시험 25건은 건너뜀(시험 DB가 있어야 돈다) |
| `npm run build` | **이 PC에서 실패(메모리)** — 기존 코드 기준선도 같은 실패(`Zone Allocation failed`, 남은 커밋 메모리 1.2GB). 개편 전후 같음. Vercel 빌드로 확인 필요 |
| `next dev` 컴파일 | 새 화면 9·업무 API 전부 컴파일, 로그인 전 리다이렉트·401·작업자 503 확인 |
| `npm run work:template-check` | 3종 ✓(사람의 시각 검토 경고), `--release`는 실패(정상 — 시각 검토 기록 필요) |
| `npm run work:template-verify` | 3종 한글 열기·넣은 글·편집·다시 저장·PDF 통과 |
| 별도 작업자 프로세스 | `npm run work:worker -- --once --hancom`: 시험 DB 대기 실행 처리 → 실제 HWPX + 한글 PDF 미리보기(1쪽, sha256 연결) |
| 실제 모델 | 공문 1건(가상 자료) — claude-sonnet-4-6, 입력 858·출력 444 토큰, 기록 원가 12원, usage_logs에 모델·토큰·원가·run_id |

시험 DB: `npm run work:testdb -- start`(이 PC의 PostgreSQL 16 바이너리로 임시 클러스터, 54329). 옛 벡터 칸만 text로 대체. **운영 DB 드리프트 발견**: `agents.icon·color·usage_guide·starter_prompts`는 저장소 마이그레이션 어디에도 없지만 0019·0026이 쓴다(운영에서 손으로 추가한 칸) — 시험 DB는 그 칸을 보충해 적용.

## 4. 시나리오(08 문서) 확인 상태

| ID | 상태 | 근거 |
|---|---|---|
| A01 | 코드·컴파일 — 로그인 화면 미확인 | WorkHome은 실제 작업에서 센 값만(가짜 실적 없음) |
| A02 | 코드 — `/?conv=` → `/chat?conv=`(스위치 켠 기관), 꺼진 기관은 기존 그대로 | 로그인 확인 필요 |
| A03 | **서버·실파일 통과** | work-flow 시험, 실제 모델·한글 렌더 |
| A04 | 서버 통과 | 양식 해시 불일치·파일 없음 → TEMPLATE_MISSING, 입력 보존 |
| A05 | **통과** | 발신명의 없음 → 빈 칸 + REQUIRED_EMPTY, 공개구분·경유는 AI가 채우지 않음 |
| A06 | 부분 | 한글 열기·편집·저장 자동 통과. 로고·긴 표 양식은 아직 없음 |
| A07 | **서버 통과** | 고른 칸만·잠금·직원 수정 보존·같은 후보 두 번 적용 막음 |
| A08 | **서버 통과** | 늦은 저장 409 + 최신 판 번호 |
| A09 | **서버 통과** | 복구 = 새 판, 과거 판·파일 해시 그대로 |
| A10 | 부분 | 미리보기는 파일 sha256에 연결. 운영 렌더러 없음(ADR 0002) |
| A11 | **통과** | 같은 키 같은 실행, 다른 내용 409 |
| A12 | **통과** | 작업자 죽음·체크포인트 전 죽음 → 판·파일 1벌, 모델 재호출 없음 |
| A13 | **통과** | 기록 실패 시 객체 삭제·재시도 성공 |
| A14 | **통과** | 세 부서·원/천원·중복 사본·소계 행 → 예산 2,600,000원·집행 1,850,000원·참여 62명·집행률 71.15(fixture 기대값), 원본 대응·미제출 잠정 |
| A15 | **통과(엔진)** | 일부만 읽힌 표 → 막는 사항 SOURCE_TRUNCATED |
| A16~A19 | 미착수(규정·회의·정산·회신·감사) | P3~P5 |
| A20 | **통과** | 대화 삭제 뒤 작업·파일 그대로 |
| A21·A22 | **통과(서버)** | 다른 기관·같은 기관 관리자·남 → 404, 구성원만 역할대로 |
| A23 | 부분 | 매 요청 권한·활성 재확인, 서명 주소 60초. 진행 중 실행의 권한 철회 취소는 미구현 |
| A24 | 부분 | 원자료는 표시된 자료 블록·지시 금지 규칙. 주입 평가 사례 없음 |
| A25 | 부분 | 패키지 검사(경로 탈출·DOCTYPE·압축 폭탄·매크로) 단위 시험. 업로드 원자료 악성 파일 평가는 기존 첨부 읽기에 의존 |
| A26 | 부분 | 모델 장애 재시도·한도 검사. 동시 한도 예약은 미구현 |
| A27 | 통과 | 같은 실행 다시 처리해도 판·파일·사용 기록 중복 없음 |
| A28 | 부분 | /api/work/** 양식 추적 포함 설정. 배포 확인 필요 |
| A29 | 코드 — 라벨·포커스·탭 전환·aria | 로그인 화면 미확인 |
| A30 | 코드 — 스위치 끄면 홈은 대화로, 새 작업은 FEATURE_DISABLED, 읽기·내려받기 유지 | 미확인 |

## 5. 10개 업무 상태

| 업무 | 상태 |
|---|---|
| official-letter 공문 기안 | **구현** — 양식·입력·생성·검수·파일·수정·복구 |
| collection 자료 취합 | **구현** — 원자료 표 → 표 엔진 → 부서·항목 합(프로그램 계산), 중복·미제출·단위·잘림 검수, 직원 결정(포함·제외·단위·잠정) → 다시 취합, 통합 XLSX(결과·제출 현황·원본 대응·확인 사항·계산 근거, 수식 없음) |
| regulations | 미구현(P3 다음 작업) |
| intake·report·meeting·handover | 미구현(P4) |
| settlement·reply·audit-response | 미구현(P5) |
화면은 구현 안 된 9개를 '준비 중 — 처리·검수·파일 산출 구현이 끝나지 않음'으로 막는다.

## 5-1. 발견한 기존 문제

- 표 엔진이 표 위 글 '(단위: 천원)'을 '참여자'처럼 차원 낱말이 없는 셈 열에도 붙인다 — 대화의 표 합치기가 참여자 합을 '천원'으로 표시할 수 있음. 취합 업무는 셈 항목에서 그 단위를 버리게 막았고, 엔진 수정은 별도 작업으로 제안함
- 운영 DB 드리프트(agents.icon·color·usage_guide·starter_prompts — 3절)

## 6. 미완료 의존성(외부·사용자)

1. **시험용 Supabase**(로그인한 브라우저 흐름 확인): 이 PC의 Docker Desktop이 WSL 오류로 엔진을 못 띄움(`running wslexec`). 둘 중 하나가 필요 — (a) WSL·Docker를 고쳐 `supabase start`, (b) 무료 시험 프로젝트를 만들어 `.env.staging.local`로 주소·키를 주면 거기에 0001~0034를 적용하고 브라우저로 끝까지 확인. **운영 DB는 시험 자료로 쓰지 않는다**
2. **사람의 시각 검토**: `docs/workon-rebuild/evidence/p0/*.pdf`(한글이 그린 결과)를 보고 `assets/templates/verification.json`에 `human-visual` 기록. 표준 공문은 초안 서식 — 기관 서식을 쓰려면 기관 양식 등록(P6)
3. **운영 렌더러**: 서버 HWPX 렌더러 없음(ADR 0002). 한컴 서버 제품·기관 내부 렌더링 서버 등은 사용권·데이터 경로 결정 필요
4. **주기 작업자 호출**(ADR 0003): Supabase pg_cron+pg_net 1분 호출 또는 상시 작업자
5. 이 PC의 `next build` 메모리 부족 — 다른 프로그램을 닫거나 Vercel에서 확인

## 7. 운영 전 할 일(사용자 — 자동 실행하지 않음)

1. 시험 환경(6-1)에서 0034 적용 → 브라우저 확인
2. 운영: `npm run db:migrate -- 0034` — **코드 배포 전**(추가만, 옛 코드는 이 표를 모름). 적용 뒤 `SELECT count(*) FROM work_tasks;`
3. 환경 변수(이름만): `WORK_WORKER_SECRET`(작업자 엔드포인트), 시험 때만 `WORK_GENERATOR=mock`(운영에서는 무시됨)
4. 기관 스위치: `INSERT INTO work_org_settings (organization_id, home_enabled, new_tasks_enabled) VALUES ('<기관 id>', true, true);` — 대표 기관 하나부터. 롤백은 둘 다 false(작업·파일은 남고 읽기 유지)
5. pg_cron 예시(Supabase SQL — 비밀값은 Vault에):
   ```sql
   select cron.schedule('workon-work-worker', '* * * * *', $$
     select net.http_post(url := 'https://<도메인>/api/work/worker',
       headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'work_worker_secret')),
       timeout_milliseconds := 290000);
   $$);
   ```
6. 표준 양식 3종이 배포 파일에 실제로 들어가는지(A28): 배포 뒤 `/templates`에서 '파일 없음'이 아닌지
7. **주의 — 대화 기능 영향**: 저장소에 표준 양식 3종이 생겼으므로 푸시하면 기존 대화의 '문서 만들기' 능력도 이 양식을 쓰기 시작한다(전에는 '아직 준비되지 않음'). 공문 서식이 초안이므로 사람의 시각 검토 뒤 푸시를 권한다

## 8. 다음 구체 작업

1. ~~P3 collection~~ 구현됨(2026-10-27). 남은 것: 항목 ↔ 열 대응이 모호할 때 직원이 고르는 화면(지금은 짐작하지 않고 '항목 없음'으로 알림), 부서 지정(departmentOverrides) 화면, 원본 시트 셀 주소(지금은 추출 표 행 — 셀 주소를 지어내지 않음)
2. P3 `regulations`: NODA·공통 자료실·법령 커넥터 근거 → 근거 검토 메모 HWPX(보고서 양식 기반), 모르는 근거는 유보
3. 작업실 보완: 진행 중 실행의 권한 철회 취소(A23), 동시 한도 예약(A26), 구성원 공유 화면
4. P6: 기관 양식 등록·대응·시험 생성(관리자), 기관 스위치 관리 화면(슈퍼관리자), 옛 결과물 가져오기
