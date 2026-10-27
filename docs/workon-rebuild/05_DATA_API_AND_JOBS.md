# 05. 데이터·권한·API·작업 실행

이 문서는 신규 모델의 계약이다. 실제 마이그레이션 파일은 현재 스키마·적용 상태를 확인한 뒤 작성한다. 기존 마이그레이션을 덮어쓰지 않는다.

## 1. 권하는 신규 테이블

| 테이블 | 역할·핵심 제약 |
|---|---|
| `workflow_installations` | 기관별 workflow key → 기존 agent ID·승인 워크플로 버전. UNIQUE(organization_id,workflow_key). 표시와 권한 분리 |
| `work_tasks` | 작업 제목·workflow·소유자·현재 문서 버전·업무 상태·기한·기관·부서. 기본 비공개 |
| `work_task_members` | 작업별 명시적 viewer/editor/reviewer. 같은 기관만. 자료 접근 가능한 사람에게만 부여 |
| `work_sources` | 작업용 원자료의 파일 버전·해시·용도·권한·파싱 상태·저장 경로. 대화 첨부의 TTL과 분리 |
| `work_template_versions` | 양식 원본 또는 기존 agent_template 연결·불변 버전·해시·필드 manifest·검증 상태 |
| `work_document_versions` | 부모 버전·문서 내용·양식 버전·입력 스냅샷·작성 주체·버전 번호. UNIQUE(task_id,version) |
| `work_runs` | 생성·검토·미리보기 등 실행. idempotency·입력 버전·lease·attempt·상태·오류·기관 |
| `work_run_steps` | 실행 단계·입력 해시·체크포인트·재시도·출력 참조. run 내 순서와 uniqueness |
| `work_artifacts` | 실제 파일별 task·document version·해시·종류·저장 경로·크기·생성 run. 파일 내용 불변 |
| `work_review_items` | 버전별 확인할 문제·위치·근거·중요도·해결 기록. 버전 변경 시 재검증 |
| `work_evidence` | 근거 원자료 버전·쪽·셀·표·발언 구간·지지하는 필드. 실제로 아는 위치만 기록 |
| `work_events` | 작업 상태·수정·검토·권한·내려받기의 감사 이벤트. 본문·비밀정보는 기본 제외 |

공통 키는 UUID, 시간은 timestamptz(저장 UTC·표시 Asia/Seoul)로 한다. 날짜만 필요한 업무 기준일은 날짜 타입으로 분리한다. 새 테이블의 기관 ID는 서버가 현재 소속과 관련 부모 행에서 유도하고, 부모·자식의 기관 일치를 복합 FK 또는 제약/RPC로 보장한다. 서비스 role로 쓴다고 기관 ID를 클라이언트에서 믿지 않는다.

작업·버전·파일이 서로 다른 기관에 속할 수 없도록 제약을 둔다. 내용·표의 컬럼을 모두 무제한 JSON으로 숨기지 말고 버전·크기 제한·런타임 스키마를 가진 JSON 문서 모델을 사용한다. 금액·합계가 영속화될 때는 업무 규칙에 맞는 numeric/정확한 십진 계산을 검토한다. 기존 엔진을 바꾸면 기존 수치 회귀를 모두 확인한다.

## 2. 기존 데이터와 관계

기존 `agents`, `agent_templates`, `documents`, `common_documents`, `conversations`, `messages`, `generated_files`, `usage_logs`를 유지한다. 새 workflow는 기존 agent에 연결하지만 새 capability ID를 임의 추가해 저장 검증을 우회하지 않는다. 이미 있는 능력의 엔진을 서버 서비스로 호출하거나 명시적으로 확장한다.

작업과 대화의 연결은 선택적이다. 새 결과물은 `generated_files`의 대화 CASCADE에 의존하지 않는다. 옛 결과물을 가져오면 권한 확인 → 별도 경로에 복사 → 해시·메타데이터 저장 → 작업 참조를 만든다. 원본을 자동 이동·삭제하지 않는다. 기존 사용 기록은 다시 계산해 덮지 않는다.

작업 취합에 대화 첨부를 사용하려면 현재 소유권·기관·허용 용도를 확인한 뒤 작업 자료로 가져온다. 기존 첨부의 TTL 정리가 작업 원본을 삭제하지 않도록 저장 경로와 수명을 분리한다.

## 3. 접근 규칙

1. 세션 확인 → 현재 활성 사용자·현재 기관·부서 재확인 → 기존 actor scope와 작업 정책 결합.
2. 개인 작업은 기본 소유자 전용. 기관 관리자라는 이유만으로 모든 문서 원문·파일을 열 수 있게 하지 않는다.
3. 명시적으로 공유된 동일 기관 구성원에게만 viewer/editor/reviewer 권한을 제공한다. 업무 자료의 공개 범위를 기관 공통 규정의 기본값과 혼동하지 않는다.
4. 파생 결과는 포함 원자료의 허용 범위보다 넓게 공유하지 않는다. 원문 자체 열람과 근거 메타데이터·발췌 열람도 각각 확인한다. 권한 변경·자료 철회 시 검색·미리보기·다운로드·진행 중 실행에 반영한다.
5. 목록·상세·검색·수정·실행·취소·복구·다운로드 모두 서버에서 검사한다. ID를 알아도 접근할 수 없으면 내용을 드러내지 않는 404/403 정책을 통일한다.
6. 새 RLS는 비서비스 접근의 추가 방어로 설계하되 service role 우회를 명시한다. 중앙 서버 정책과 교차 기관 통합 테스트가 필수다. 익명 토큰으로 새 테이블·버킷에 접근하지 못하게 검증한다.
7. 내부 작업자는 전용 제한 인증을 사용한다. 브라우저 세션이나 관리자 공용 비밀값을 큐 메시지에 넣지 않는다. 큐에는 ID와 입력 해시만 싣고 원문은 권한 확인 후 읽는다.

새 `work` 도메인의 `getWorkActorScope`, `canReadTask`, `canEditTask`, `canReviewTask`, `canDownloadArtifact` 같은 공통 정책을 둔다. 레거시 비서 권한을 복사해 독립적인 유사 구현을 만들지 않는다.

## 4. 상태

업무 상태와 실행 상태를 분리한다.

- 업무: `draft → ready → processing → needs_review → approved → completed`, 보관 상태 `archived`. 필수 자료가 없으면 draft. 생성 뒤 검토가 필요하면 needs_review. 승인 후 파일이 늦게 생성되면 completed로 앞서가지 않는다.
- 실행: `queued → running → succeeded | failed | canceled | superseded`. running에는 단계별 체크포인트. 재시도는 새 attempt를 기록한다.
- 파일: `pending → stored → validated`, 미리보기는 `pending | ready | failed | unsupported`. 구조 검증 통과와 한글에서의 시각 검증을 구분한다.

completed의 서버 조건은 필요한 파일이 실제 존재·검증되고 현재 문서 버전과 일치하며, 차단 문제 없고 필요한 검토가 완료된 것이다. 직원에게 내부 영문 상태값을 그대로 노출하지 않는다.

## 5. API 제안

기존 `{ok:true,data}` / `{ok:false,error:{code,message,details}}` 응답 규약을 유지한다. 목록은 커서 페이지네이션·서버 필터를 제공한다.

| 메서드·경로 | 계약 |
|---|---|
| GET `/api/workflows` | 현재 기관의 공개·사용 가능한 비서와 준비 상태. 근거·양식 없는 워크플로를 활성으로 꾸미지 않음 |
| POST/GET `/api/work/tasks` | 생성 또는 권한 범위의 목록. 생성 입력은 workflow key·제목·form 값. 기관·사용자는 서버 유도 |
| GET/PATCH `/api/work/tasks/[id]` | 상세/제목·기한 등 수정. 버전 조건과 필드 allowlist |
| POST `/api/work/tasks/[id]/sources/upload-url` | 형식·크기·개수·용도 검사 후 서명 업로드 준비 |
| POST `/api/work/tasks/[id]/sources/confirm` | 실제 객체·크기·해시·권한 확인, 자료 버전 생성 |
| POST `/api/work/tasks/[id]/runs` | `{operation,baseVersion,options}` + Idempotency-Key. 202 `{runId,statusUrl}` |
| GET `/api/work/tasks/[id]/runs/[runId]` | 단계·상태·현재 실행 여부·오류·결과 참조. 이 단계에서 임의 LLM 실행 금지 |
| POST `/api/work/tasks/[id]/runs/[runId]/cancel` | 취소 요청. 실제 취소 완료와 요청 접수를 구분 |
| PATCH `/api/work/tasks/[id]/document` | `{baseVersion,patches}`. 원자적 새 버전. 409 충돌 |
| POST `/api/work/tasks/[id]/revision-proposals` | 선택 범위·기준 버전·수정 요청 → AI 변경 후보 생성 run |
| POST `/api/work/tasks/[id]/revision-proposals/[proposalId]/apply` | 최신 버전·권한 재검사 후 변경 적용, 새 파일 생성 |
| GET `/api/work/tasks/[id]/versions` | 문서 버전·작성 주체·검증 상태 |
| POST `/api/work/tasks/[id]/versions/[versionId]/restore` | 과거 내용으로 새 버전 생성 |
| POST `/api/work/tasks/[id]/review` | 필수 확인 사항 해결·현재 버전 확정. stale 승인은 409 |
| GET `/api/work/artifacts/[id]/download` | 현재 권한·보존 정책 확인 후 짧은 수명 서명 URL |
| GET `/api/work/artifacts/[id]/preview` | 실제 파일 해시와 동일한 미리보기 manifest·권한 있는 이미지 URL |
| POST/GET `/api/admin/work-templates` | 관리자 범위의 양식 등록·목록 |
| POST `/api/admin/work-templates/[id]/verify` | 시험 생성·검증 기록. 관리자 단순 클릭만으로 실제 한글 검증을 수행한 것처럼 기록하지 않음 |

업로드 바이트와 큰 결과 파일은 Vercel 함수 본문을 경유하지 않고 기존 서명 Storage 방식으로 처리한다. 서명 URL은 로그·이벤트·분석 도구에 남기지 않는다. 다운로드 URL은 권한 철회 후 만료까지 접근 가능한 제한이 있으므로 짧은 수명 정책과 기관의 즉시 철회 요구를 구분해 설계한다.

## 6. 내구성 있는 작업 실행

긴 문서·OCR·다중 파일·렌더링은 브라우저나 단일 요청 생존에 의존하지 않는다. 현재 NODA 비동기 넣기는 재사용하지만 범용 업무 작업 큐가 이미 있다고 가정하지 않는다.

초기 권고는 PostgreSQL에 실행·단계·outbox를 기록하고 별도 작업자 프로세스가 claim·lease·heartbeat로 처리하는 구성이다. 이미 운영 가능한 내구성 있는 실행 서비스가 있으면 같은 계약으로 대체할 수 있다. 새 외부 큐 계정이 반드시 필요한 것처럼 임의 가입하지 않는다. 작업자 실제 배포·주기 실행·장애 감시는 명세와 함께 완성해야 한다.

브라우저가 상태 조회를 안 해도 작업이 진행되어야 한다. HTTP 응답 후 호출을 흘려보내는 방식이나 타이머만으로 내구성을 주장하지 않는다. Vercel 플랜·설정별 실행 제한은 구현 시 공식 문서로 재확인한다. 고정된 오래된 시간 숫자를 설계에 박지 않는다.

중복 요청: UNIQUE(기관,작업,operation,idempotency key). 같은 key에 다른 payload hash면 409. 요청 생성과 outbox는 같은 DB 트랜잭션. 같은 작업의 새 버전 실행은 이전 실행의 현재 포인터 갱신 권한을 없앤다.

worker 죽음: lease 만료 후 재수행 가능. 단계별 생성 산출물 키와 완료 포인터는 멱등 처리한다. 업로드 성공·DB 실패의 고아 파일은 실행별 임시 경로와 정리 장부로 관리한다. 재시작이 다른 기관·다른 버전 자료를 쓰지 못하게 입력 snapshot을 고정한다.

사용량: 기존 `models.ts`와 persist 경계를 사용하고 모델·입력/출력 토큰·기록 시점 비용·기관·사용자·run/attempt를 저장한다. 실제로 두 번 호출했다면 두 소비를 기록하고 같은 응답 이벤트의 중복 기록은 막는다. 응답 손실로 과금 여부가 불명확하면 추정 0원이나 이중 확정을 하지 말고 미확인 상태·대조 경로를 둔다. 단계별 예상 비용·한도 예약으로 동시 실행의 한도 우회를 막는다.

## 7. 보관·삭제

업무 보관과 법정 기록물 관리는 동일한 개념으로 표시하지 않는다. 제품 보관 기간은 기관 정책으로 정하고 원본·파생본·미리보기·NODA 사본·캐시를 함께 관리한다. 최종본을 기록관리 시스템에 등록하는 연계는 별도 범위다.

작업 보관/휴지통/영구 삭제를 구분한다. 실제 삭제는 종속 파일·작업·외부 사본의 정리 순서·실패 재개를 구현한다. 감사에 필요한 최소 이벤트는 기관 정책에 맞춰 남긴다. 대화 삭제는 새 업무 결과물 삭제를 촉발하지 않는다.
