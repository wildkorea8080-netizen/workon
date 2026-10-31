# 미커밋 작업 트리 분류 (2026-10-31)

기준: `feat/s6-1-currentize` / `457d215` 위의 작업 트리. `git status --short` 기준 수정 57개·미추적 56개(폴더 포함). 아래는 **기능 묶음별 커밋 제안**이며 실제 커밋은 사용자가 결정한다. 분류는 `git diff -U0`로 파일마다 바뀐 내용을 보고 정했다. 묶음 순서는 의존 관계 순(앞 묶음이 없으면 뒤 묶음이 타입 검사에 실패한다).

검증 기준선(2026-10-31, 이 작업 트리): `npx tsc --noEmit --incremental false` 오류 0 · 전체 Vitest **122 파일 2,190개 통과, 건너뜀 0**(`npm run work:testdb -- start`로 띄운 임시 PostgreSQL 54329에 마이그레이션 44개를 적용하고 `WORK_TEST_DATABASE_URL`을 준 실행, `NODE_OPTIONS=--max-old-space-size=4096`, 50초; DB 없이 돌리면 114 파일 2,118개·8파일 건너뜀) · 프로덕션 빌드 `NEXT_BUILD_CPUS=2 NODE_OPTIONS=--max-old-space-size=4096 npm run build` 종료 코드 0(동적 API 라우트의 정적 생성 진단은 기존과 같음, 빌드 실패 아님).

## 연결된 DB의 마이그레이션 적용 상태 (2026-10-31 읽기 전용 확인)

`.env.local`의 `DATABASE_URL` 연결(문서상 사용자가 시험용으로 확인한 DB)에서 카탈로그만 읽어 확인했다. 행 데이터·접속 주소는 출력하지 않았고 `BEGIN READ ONLY` 뒤 `ROLLBACK`했다.

| 마이그레이션 | 확인한 것 | 결과 |
| --- | --- | --- |
| 0036 | `work_tasks.app_snapshot` 칸·`work_app_snapshot_shape` CHECK | 적용됨 |
| 0037~0041 | `work_tasks`·`workflow_installations`의 workflow_key CHECK에 새 업무 5종 | 적용됨 |
| 0042 | `users.favorite_workflow_keys`·`set_user_app_favorite()`·anon 실행 불가/service_role 가능 | 적용됨 |
| 0043 | `agents.app_definition`·CHECK·`agent_snapshot()`이 `app_definition` 포함 | 적용됨 |
| 0044 | `generated_files_app_result_unique` 인덱스 | 적용됨 |
| **0035** | `work_sources_purpose_check`에 `'prior'` | **미적용** |
| `schema_migrations` | 0036~0044 행 있음, 0035 없음 | — |

**0035가 빠져 있다.** 현행화 엔진(S6-1, 이 브랜치)은 작년 파일을 `purpose='prior'`로 올리므로, 이 트리의 코드가 이 DB를 쓰는 환경에 배포돼 있다면 현행화 작업의 작년 파일 올리기가 CHECK 위반으로 실패한다. 사용자 확인(2026-10-31): `.env.local`의 연결 DB는 **운영과 같은 프로젝트**다. 운영 배포 원본 목록(`DEPLOYMENT_SOURCE_MANIFEST.json`, 10-29 준비)에 `src/lib/work/runs/currentize-op.ts`·`workflows/currentize/*`·`api/work/tasks/[id]/currentize/route.ts`가 들어 있고, 원자료 올리기 주소 발급(`sources/upload-url`)은 `purpose: 'prior'`를 받으므로, **지금 운영에서 보고서 업무에 작년 파일을 올리면 `work_sources` 행 삽입이 CHECK 위반(23514)으로 실패한다.** 다른 업무·용도는 영향 없다. 조치는 `npm run db:migrate -- 0035`(값만 넓히는 변경, 여러 번 적용해도 안전, 되돌리기는 0034의 CHECK로 다시 걸기). 사용자 승인 뒤 적용한다. → **2026-10-31 사용자 승인으로 `npm run db:migrate -- 0035` 적용 완료**(OK, 읽기 전용 재확인에서 CHECK에 `'prior'` 포함·`schema_migrations`에 0035 기록).

## 묶음 1 — 공통 시험 도우미·설정 (먼저)

| 파일 | 내용 |
| --- | --- |
| `tests/helpers/source-files.ts` (신규) | Unix `find` 의존을 Node 파일 탐색으로 교체 |
| `tests/llm-boundary.test.ts`·`tests/usage-limit.test.ts`·`tests/route-auth.test.ts` | 위 도우미 사용. `route-auth`는 `/apps/favorites`·`/apps/export`·`/apps/history` 공개 예외 목록 추가(묶음 2에 걸침) |
| `.gitignore`(`.vercel`)·`.vercelignore`(신규)·`next.config.mjs`(`/api/apps/export`의 양식 자산 포함) | 배포 설정 |
| `scripts/work-testdb.mjs` | `WORK_TEST_DB_INSTANCE`로 별도 시험 DB 인스턴스 |
| `scripts/noda-check.mjs` | `--saas`·`--isolated` 옵션 |
| `scripts/work-llm-smoke.mjs` | 새 업무 5종 스모크(묶음 4에 걸침) |

## 묶음 2 — 앱 플랫폼 (라이브러리·즐겨찾기·입력형 앱 빌더·단계·파일 입력·재개·기록·내보내기)

- 신규: `src/lib/apps/`(definition·catalog·home·chat-launch·work-launch·copy·pipeline·resume·resume-client·stream·history·export·markdown-text·attachment-context), `src/app/api/apps/{favorites,history,export}/route.ts`, `src/app/apps/{page,builder,run,history}`, `src/components/apps/*`, `src/components/work/WorkspaceIcon.tsx`
- 마이그레이션: `0042_app_favorites.sql`·`0043_form_apps.sql`·`0044_app_result_exports.sql`
- 수정(앱 정의가 비서 판에 들어가는 길): `src/lib/db.ts`(`Agent.app_definition`), `src/lib/agent-patch.ts`·`src/lib/agent-form.ts`, `src/app/api/agents/[id]/revert/route.ts`, `src/app/api/conversations/[id]/route.ts`(`app_definition`·`agent_version` 조회), `src/components/agents/AgentEditorModal.tsx`
- 수정(대화 실행기가 폼 입력·단계·재개를 받음): `src/lib/assistant/prepare.ts`·`stream.ts`·`persist.ts`·`types.ts`, `src/components/chat/ChatInterface.tsx`·`ChatHome.tsx`(앱 딥링크)·`useFileAttachments.ts`(파일 상한 인자)
- 수정(홈·탐색): `src/app/page.tsx`(`NEXT_PUBLIC_WORKSPACE_HOME=apps`면 앱 홈), `src/lib/config-public.ts`, `src/components/layout/Header.tsx`, `src/components/work/WorkShell.tsx`(업무 앱·앱 실행 기록 메뉴), `src/app/globals.css`(청록 토큰·hero)
- 시험: `tests/app-*.test.ts` 7개(2026-10-31 이후 세션에 `app-result-markdown` 추가), `tests/apps-*.test.ts` 2개, `tests/form-apps.test.ts`, 수정 `tests/agent-patch.test.ts`·`prepare-attachments.test.ts`·`prepare-preflight.test.ts`·`stream-turn.test.ts`
- 스크립트: `scripts/app-{export,pipeline,resume}-smoke.mjs`, `scripts/app-favorites-db-check.mjs`, `scripts/form-app-db-check.mjs`

디자인 변경(헤더·globals.css·WorkShell 아이콘)만 따로 떼면 묶음 2a(기능)·2b(디자인)로 나눌 수 있다. 다만 `WorkShell`의 메뉴 항목은 `/apps` 경로를 가리키므로 2b는 2a 뒤에 온다.

## 묶음 3 — 앱 설정·근거와 업무 작업 연결

- 신규: `src/lib/work/app-binding.ts`(작업 생성 때 비서 지침·모델·판 고정, `workModelOptions`), `src/lib/work/app-evidence.ts`·`evidence-access.ts`, `src/app/api/work/tasks/[id]/evidence/`(근거에서 원문 열기)
- 마이그레이션: `0036_work_app_snapshot.sql`
- 수정: `src/lib/work/types.ts`·`store/types.ts`·`store/pg.ts`·`services.ts`(`agentId`·`documentScope` 입력, `loadAppSnapshot`)·`server.ts`·`context.ts`, `src/lib/work/runs/executor.ts`(모델 옵션·근거 조회)·`currentize-op.ts`, `src/lib/work/generation/compose.ts`(`withAppInstruction`), `src/lib/work/workflows/{currentize,items,qa}/model.ts`(옵션 전달), `src/app/api/work/tasks/route.ts`, `src/app/tasks/new/page.tsx`(비서 선택 유지), `src/components/work/TaskWorkbench.tsx`·`types.ts`
- 시험: `tests/work-app-binding.test.ts`·`work-app-evidence.test.ts`·`work-app-rag-flow.test.ts`·`work-app-route-auth.test.ts`·`work-evidence-access.test.ts`·`work-evidence-open-route.test.ts`, 수정 `tests/work-core.test.ts`

## 묶음 4 — 업무 5종 추가 (문서 요약·문장 교정·번역·회의 안건·FAQ)

- 신규: `src/lib/work/workflows/document-apps.ts`(원자료 상한·대상 칸 정책), `workflows/faq/`, `workflows/rewrite/`
- 마이그레이션: `0037`~`0041`(workflow_key CHECK 확장)
- 수정: `src/lib/work/workflow-catalog.json`(+354줄), `workflows/index.ts`, `review.ts`(`FAQ_NEEDS_INFO`), `runs/executor.ts`(FAQ·숫자 보존 검증 — 묶음 3과 같은 파일)
- 시험: `tests/work-faq.test.ts`·`work-rewrite.test.ts`·`work-meeting-agenda.test.ts`, 수정 `tests/work-flow.test.ts`

## 묶음 5 — 규정 확인의 문서함 범위 제한

- 신규: `src/lib/work/workflows/regulations/scope.ts`
- 수정: `workflows/regulations/providers.ts`(선택 비서로 문서 검색 제한·기관 불일치 거부)·`evidence.ts`·`gather.ts`·`model.ts`
- 시험: `tests/work-document-scope.test.ts`·`work-provider-scope.test.ts`

## 묶음 6 — 문서·벤치마크·점검 스크립트

- `docs/CLAUDE_CODE_HANDOFF.md`·`docs/CLAUDE_CODE_PROMPTS.md`·`docs/2026-10-28-product-benchmark-review.md`·`docs/benchmarks/`(분석·검증 기록·증거)·이 문서
- `CLAUDE.md`·`README.md` 수정
- `scripts/legacy-app-audit.mjs`·`scripts/build-alli-benchmark-map.mjs`·`scripts/work-readiness.mjs`

`docs/benchmarks/allganize/evidence/`에는 실제 HWPX·JSON 증거가 들어 있다(약 2.7MB 규모의 바이너리 포함). 저장소에 둘지 따로 보관할지는 커밋 전에 정한다.

## 주의

- `executor.ts`·`route-auth.test.ts`·`work-llm-smoke.mjs`는 두 묶음에 걸친다. 묶음을 나누어 커밋하려면 해당 파일을 부분 스테이징(`git add -p`)해야 한다.
- 마이그레이션 0036~0044는 코드 배포 **전**에 적용해야 하는 종류다(CHECK 확장·컬럼·함수·인덱스). 적용 상태는 아래 DB 확인 결과를 따른다.
- 커밋 메시지는 기존 관례(`feat(work): …`·`fix(work): …`)를 따른다.

## 이후 세션에 더한 수정 (2026-10-31, 별도 커밋 권장)

UAT·P1 검증에서 찾은 결함 두 가지. 위 묶음과 섞지 않고 **묶음 2·4 뒤에 각각 `fix` 커밋**으로 두면 되돌리기 쉽다.

| 수정 | 파일 | 시험 |
| --- | --- | --- |
| 앱 결과 HWPX에 마크다운 기호가 그대로 찍힘 | 신규 `src/lib/apps/markdown-text.ts`, 수정 `src/lib/apps/export.ts` | 신규 `tests/app-result-markdown.test.ts`, 수정 `tests/app-result-export.test.ts` |
| 앱 파일 4개 이상 서버 거절 시험 누락 | — | 수정 `tests/prepare-preflight.test.ts` |
| 파일 첨부를 켠 앱은 파일 없이 실행해도 재개 불가(앱 단위 판정) | 수정 `src/lib/apps/resume.ts`(`isInputOnlyRun`)·`src/lib/assistant/prepare.ts`·`stream.ts`·`src/app/apps/run/page.tsx`, `APP_MANUAL_RESUME.md` | 수정 `tests/prepare-preflight.test.ts`·`tests/stream-turn.test.ts` |
| 업무 생성기의 응답 형식 오류 때 쓴 토큰이 사용 기록에서 빠짐 | 신규 `src/lib/work/generation/spent.ts`, 수정 `src/lib/work/runs/shared.ts`·`executor.ts`·`currentize-op.ts`·`generation/compose.ts`·`workflows/{items,qa,regulations,currentize}/model.ts`, `CLAUDE.md`(과금 규약 줄) | 신규 `tests/work-model-usage.test.ts`, 수정 `tests/work-flow.test.ts` |

`src/lib/apps/export.ts`는 묶음 2의 신규 파일이라 그 커밋에 마크다운 수정이 함께 들어간다(따로 떼려면 묶음 2 커밋 뒤에 `markdown-text.ts`를 더한다). `executor.ts`·`compose.ts`·`model.ts` 등은 이미 위 묶음의 미커밋 변경이 있어 같은 파일 안에서 부분 스테이징이 필요하다. 결과 기록은 [UAT_RESULT_2026-10-31.md](benchmarks/allganize/UAT_RESULT_2026-10-31.md).

## 로그인 브라우저 UAT(P1)를 막는 전제 (2026-10-31 확인)

- **Docker Desktop이 꺼져 있다.** 이전 세션이 만든 로컬 E2E 스택(`.claude/launch.json`의 `workon-e2e` → 이전 scratchpad `sb-workon/dev-e2e.cjs`, 로컬 Supabase 55321, 시험 계정 4개 `e2e-*@workon.test`)은 Docker 위의 로컬 Supabase가 있어야 돈다. 운영 DB에 붙는 `workon-dev`(3000)로 UAT를 하면 운영에 시험 데이터가 생기므로 쓰지 않는다.
- `documents` 버킷은 `file_size_limit`·`allowed_mime_types`가 모두 비어 있다(버킷 단위 상한 없음 → 프로젝트 전역 상한이 적용). 현행화 작년 파일 50MB(`MAX_PRIOR_BYTES`)·첨부 읽은 내용 30MB가 통과하려면 대시보드의 전역 업로드 상한이 50MB 이상이어야 한다 — API로는 전역 값을 읽지 못해 사용자가 확인한다. MIME 제한이 없으므로 `application/gzip`·xlsx 저장은 막히지 않는다.

