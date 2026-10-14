# S1 — 비서 구조와 대화 실행기 설계

**작성일**: 2026-10-14
**상위 문서**: [WORKON 서비스 정의서](2026-10-14-workon-service-definition-design.md) 9절 S1
**상태**: 설계 확정 대기 (사용자 검토)

S1은 이후 모든 과제(S2~S6)가 올라설 바탕이다. 비서를 세 단계로 나누고, 바꿀 때마다 판을 남기며,
능력을 꺼내 주는 장치 하나와 한 턴을 처리하는 실행기 하나를 둔다.

---

## 1. 결정 기록

| # | 질문 | 결정 | 이유 |
|---|---|---|---|
| 1 | 단계를 올릴 때 옮기나 복사하나 | **옮긴다.** 그 비서 자체의 단계가 바뀐다 | 같은 비서가 여러 벌 생기면 어느 쪽이 최신인지 헷갈린다. 지금 공식 승인도 이 방식이다 |
| 2 | 직원이 대화 중 모델을 바꿀 수 있나 | **비서의 모델로 고정.** 대화 화면의 모델 선택을 없앤다 | 만든 사람이 업무에 맞는 모델을 안다. 직원 대부분은 모델 차이를 모른다. 비용이 비서 단위로 예측된다 |
| 3 | 되돌리기에 참고 문서도 포함하나 | **설정만 되돌리고 참고 문서는 기록만** | 문서는 S4에서 NODA로 옮긴다. 지금 복원 장치를 만들면 S4에서 다시 만든다 |
| 4 | 부서 비서를 누가 고치고 지우나 | **고치기는 주인 부서 소속 직원 누구나, 지우기는 처음 만든 사람과 관리자** | 지우기는 되돌릴 수 없다. 하위 부서까지 고치게 하면 책임 소재가 흐려진다 |
| 5 | 예전 Q&A·보고서 생성 | **걷어낸다** | 직원 화면에 들어가는 길이 없고, 새 구조에 대체 기능이 있다 (참고 문서 찾기 · S2 양식 채우기) |
| 6 | 비서당 양식 파일 수 | **여러 개, 10개까지.** 양식마다 이름을 붙인다 | 기관 보고서는 계획서·결과보고서·검토보고서처럼 종류가 여럿이다 |
| 7 | 현재 상태와 변경 기록 저장 방식 | **현재 행 + 판 전체 사본 (A안)** | 지금 `agents`를 읽는 코드 대부분이 그대로 돈다. 바뀐 칸만 기록하는 방식은 기록 하나만 빠져도 그 뒤가 전부 틀린다 |

정의서에 이미 있는 원칙은 그대로 따른다.
- 나만의·부서 비서가 켤 수 있는 능력은 기관이 공식 비서에서 쓰고 있는 것뿐이다.
- 모델은 어느 단계든 기관 허용 범위 안에서 고른다.

---

## 2. 비서 데이터

### 2.1 `agents`에 더하는 칸

| 칸 | 형 | 뜻 |
|---|---|---|
| `tier` | text, NOT NULL | `personal` · `department` · `official`. **단계의 유일한 근거** |
| `model_id` | text, NULL | 이 비서의 모델. NULL이면 기관 기본 모델 |
| `capabilities` | jsonb, NOT NULL, 기본 `{}` | 켜진 능력과 능력별 설정. 예: `{"public_data": {"connectors": ["law"]}, "image": {}}` |
| `version` | integer, NOT NULL, 기본 1 | 현재 판 번호 |

- 부서 비서는 `department_id`가 주인 부서다. 보이는 범위는 그 부서와 하위 부서로 고정한다.
  DB 제약으로 `tier='department'`이면 `visibility='department'`이게 한다.
- 지우기 권한의 '처음 만든 사람'은 기존 `created_by`를 쓴다.
- `enabled_connectors`의 값은 `capabilities.public_data.connectors`로 옮긴다.
- `is_personal`은 배포가 넘어가는 동안 트리거로 `tier`와 맞춰 둔다. 옛 코드가 `is_personal`만 바꿔도 `tier`가 따라가고, 새 코드가 `tier`를 바꾸면 `is_personal`이 따라간다. 0027에서 `enabled_connectors`와 함께 지운다.

### 2.2 `agent_templates` — 양식 파일

| 칸 | 뜻 |
|---|---|
| `id` · `agent_id` | |
| `name` | 양식 이름 (예: '사업계획서'). 대화에서 AI가 이 이름으로 양식을 고른다 |
| `storage_path` | 저장 경로. `templates/{organization_id}/{agent_id}/{uuid}` |
| `file_name` · `mime_type` · `size_bytes` | 원래 파일 정보. HWP · HWPX · DOCX |
| `created_by` · `created_at` | |
| `retired_at` | 교체하거나 뺀 시각. **행과 파일은 지우지 않는다** — 판을 되돌리면 다시 살아난다 |

쓰는 중인(`retired_at IS NULL`) 양식은 비서당 10개까지다. 애플리케이션에서 먼저 검사하고 DB에서도 막는다.
S1은 양식을 올리고 판으로 관리하는 자리만 만든다. 양식을 읽고 채우는 일은 S2가 한다.

### 2.3 `agent_history` — 비서 하나의 타임라인

| 칸 | 뜻 |
|---|---|
| `id` · `agent_id` · `created_at` | |
| `kind` | `settings` · `revert` · `tier` · `document_added` · `document_removed` · `preset_update` · `migrated` |
| `version` | `settings` · `revert` · `preset_update` · `migrated`일 때 그 판 번호. 나머지는 NULL |
| `snapshot` | 판의 설정 사본 (2.4). 판 번호가 있는 행에만 있다 |
| `changed_by` | 바꾼 사람. 기본 비서 갱신·이전 데이터는 NULL |
| `detail` | 종류별 부가 정보. 되돌린 원래 판 번호 · 단계 변경 전후 · 문서 파일명 · 바뀐 칸 목록 |

`(agent_id, version)`은 판 번호가 있는 행 안에서 유일하다.

| 종류 | 판 번호 | 사본 |
|---|---|---|
| 설정 변경 · 되돌리기 · 기본 비서 갱신 · 이전 데이터 | 올라감 | 있음 |
| 단계 변경 | 그대로 | 없음 — 누가 언제 어디서 어디로 |
| 참고 문서 올림 · 지움 | 그대로 | 없음 — 파일명만 |

### 2.4 판 사본에 담는 것

| 담는다 | 담지 않는다 |
|---|---|
| 이름 · 설명 · 아이콘 · 카테고리 · 사용 방법 · 시작 예시 · 지시문 · 모델 · 능력 · 쓰는 중인 양식 id 목록 | 노출 여부 · 정렬 · 공개 범위 · 사용 여부 · 단계 |

담지 않는 값은 운영자가 조정하는 값이다. 되돌리기가 이 값을 건드리면 안 된다(`seed:agents --update`와 같은 원칙).
되돌리기는 옛 사본을 현재로 다시 쓰고, 그것도 `revert` 종류의 새 판으로 남긴다. 되돌린 기록까지 남는다.

### 2.5 `save_agent` — 저장은 함수 하나로

Postgres 함수 `save_agent(agent_id, base_version, patch, actor, kind)`가 다음을 한 번에 한다.

1. 현재 `version`이 `base_version`과 다르면 거절한다 (동시 수정)
2. 설정을 바꾼다
3. `version`을 1 올린다
4. `agent_history`에 새 판과 사본을 남긴다

넷 중 일부만 되는 일이 없다. 표준 PostgreSQL 함수라 옮길 때도 문제없다.
`updated_by`도 함께 채운다 — 기본 비서 갱신이 '관리자가 고친 비서'를 알아보는 기존 근거다.

양식을 더하거나 바꾸거나 빼는 일도 판 사본에 들어가므로 `save_agent`를 거쳐 판을 올린다.
단계 변경은 판을 올리지 않지만 `tier` 변경과 이력 한 줄을 함께 남겨야 하므로 별도 함수 `change_agent_tier`로 한 번에 처리한다.
**권한 판정은 함수 밖(애플리케이션)에서 먼저 한다** — 함수는 판의 무결성만 책임진다.

동시 수정이 거절되면 화면에 "다른 분이 먼저 고쳤습니다"와 최신 내용을 보여 준다. 부서원 둘이 같은 비서를 고칠 때 뒤에 저장한 사람이 앞사람의 작업을 모르고 덮는 것을 막는다.

### 2.6 메시지에 판 번호

`messages.agent_version`(integer, NULL)에 그 답을 만든 비서의 판 번호를 남긴다.
감사에서 "그때 이 비서가 어떤 지시문으로 답했나"를 물으면 그 판의 사본을 보여 줄 수 있다.
사용자 행과 비서 행 모두 같은 값을 넣는다 — 배치 삽입 키 집합 규칙(CLAUDE.md).

---

## 3. 권한 판정

### 3.1 한 곳에서 판정한다

`src/lib/agent-permissions.ts`는 **DB를 보지 않는 순수 함수**다. 비서 정보와 요청자 범위
(본인 id · 역할 · 부서 · 기관 · 볼 수 있는 부서 · 관리하는 부서)를 받아 판정만 돌려준다.
요청자 범위는 라우트가 기존 함수(`getVisibleDepartmentIds` · `getManagedDepartmentIds`)로 만들어 넘긴다.

| 함수 | 판정 |
|---|---|
| `canUseAgent` | 대화할 수 있는가 |
| `canEditAgent` | 고치기 · 되돌리기 · 양식 · 참고 문서 |
| `canDeleteAgent` | 지우기 |
| `canPromoteToDepartment` | 나만의 → 부서 |
| `canRequestOfficial` | 공식 등록 신청 |
| `canApproveOfficial` | 공식 등록 승인·반려 |

### 3.2 판정 표

| | 쓰기 | 고치기·되돌리기 | 지우기 |
|---|---|---|---|
| 나만의 | 본인 | 본인 | 본인 |
| 부서 | 주인 부서 + 하위 부서 직원 | 주인 부서 소속 직원 + 그 부서를 관리 범위에 둔 관리자 | 처음 만든 사람 + 그 부서를 관리 범위에 둔 관리자 |
| 공식 · 부서로 좁힘 | 지정 부서 + 하위 부서 직원 | 그 부서를 관리 범위에 둔 관리자 | 고치기와 같음 |
| 공식 · 기관 전체 | 같은 기관 전원 | 기관 전체를 관리하는 관리자 | 고치기와 같음 |

- 모든 판정은 같은 기관 안에서만 성립한다. 기관이 다르면 무엇도 허용하지 않는다.
- 노출 대기 중(`is_published=false`)인 공식 비서는 고칠 수 있는 관리자만 쓴다.
- 꺼진(`is_active=false`) 비서는 누구도 쓰지 못한다.
- 인사이동은 따로 처리하지 않는다. 판정이 매번 지금 소속으로 계산된다.

**지금과 달라지는 점**: 지금은 관리자면 누구나 공식 비서를 고칠 수 있다(`PATCH /api/agents/[id]`가 `role === 'ADMIN'`만 본다).
앞으로는 관리 범위 규칙을 비서에도 적용해, 과 단위 관리자는 기관 전체 비서를 고치지 못한다.

### 3.3 단계 이동

| 이동 | 누가 | 방식 |
|---|---|---|
| 나만의 → 부서 | 본인. **자기 부서로만** | 바로. `tier` 이력을 남긴다 |
| 나만의 · 부서 → 공식 | 그 비서를 고칠 수 있는 사람이 신청 | 관리자 승인 (지금 흐름) |
| 관리자가 직접 만듦 | 관리자 | 공식으로 생성, 노출 대기에서 시작 |

- 승인·반려할 수 있는 관리자는 **공식이 된 뒤 그 비서를 고칠 수 있는 관리자**다. 기관 전체로 공개하는 승인은 기관 전체를 관리하는 관리자만 한다.
- 내리는 방향(공식 → 부서, 부서 → 나만의)은 만들지 않는다.
- 공식이 되면 고칠 수 있는 사람이 관리자로 좁아진다. 지시문 · 능력 · 참고 문서는 그대로 가고, 만든 사람의 대화 기록은 그 사람 것으로 남는다(정의서 4.3).
- **신청 뒤에 내용이 바뀌면 승인을 막는다.** 신청할 때 판 번호를 기록하고, 승인할 때 판이 달라졌으면
  "신청 뒤 내용이 바뀌었습니다. 다시 확인해 주세요"라고 거절한다. 관리자가 검토한 판과 실제로 공식이 되는 판이 달라지면 안 된다.

### 3.4 능력 범위

나만의·부서 비서는 **기관이 공식 비서에서 쓰고 있는 능력만** 켤 수 있다. 지금의 `getPersonalConnectorIds`(`src/lib/connector-scope.ts`)를 능력 전체로 넓힌다.

| 언제 | 하는 일 |
|---|---|
| 저장할 때 | 범위 밖 능력을 켜려 하면 거절 |
| 대화할 때 | 범위 밖 능력은 도구에서 뺀다. 관리자가 나중에 기관에서 끈 능력을 거둬들이는 길이다 |

조회에 실패하면 아무 능력도 켜지 않는다. 실패가 권한을 넓히면 안 된다.

### 3.5 빠뜨림 막기

`tests/route-auth.test.ts`와 같은 방식의 원본 전수 검사를 하나 둔다.
비서를 바꾸는 라우트(수정 · 삭제 · 되돌리기 · 단계 변경 · 승인 · 양식 · 참고 문서)의 모든 핸들러가
`agent-permissions`의 판정 함수를 부르는지 본다.

---

## 4. 능력 장치

### 4.1 능력 하나 = 파일 하나

`src/lib/capabilities/`에 능력마다 파일을 두고 `index.ts`의 목록에 올린다. 능력을 더해도 실행기는 고치지 않는다.

```typescript
interface Capability {
  id: CapabilityId;
  label: string;                 // 관리 화면 표시
  description: string;
  isAvailable(): boolean;        // 쓸 준비가 됐는가 (키 등). false면 목록에서 빠진다
  validateSettings(settings: unknown): { ok: true; value: unknown } | { ok: false; message: string };
  prepare?(ctx: TurnContext): Promise<PrepareResult>;  // AI를 부르기 전에 할 일
  tools?(ctx: TurnContext): McpTool[];                 // 이번 턴에 꺼내 줄 도구 (MCP 형식)
  execute?(tool: string, input: unknown, ctx: TurnContext): Promise<ToolOutcome>;
}
```

### 4.2 AI가 정하는 것과 서버가 정하는 것

`TurnContext`는 **서버가 채운다** — 기관 · 부서 · 사용자 · 비서 · 판 · 양식 목록 · 능력 설정.
AI는 도구 입력값(검색어 · 법령명 등)만 정한다.

격리에 걸리는 값(기관 · NODA 보관함 이름 · 대상 문서)은 도구 입력 스키마에 넣지 않고 `ctx`에서만 꺼낸다.
NODA 도구는 보관함 이름을 인자로 받는데, 이를 AI에게 그대로 넘기면 다른 기관의 보관함 이름이 들어가는 순간
격리가 AI의 판단에 맡겨진다. 그래서 NODA를 쓰는 능력도 우리 도구로 감싸고 보관함은 서버가 정한다.

### 4.3 실행 결과의 모양

```typescript
interface ToolOutcome {
  ok: boolean;
  text: string;                     // AI에게 돌려줄 글 (실패면 사람이 읽는 이유)
  sources?: { chunks?: SourceChunk[]; links?: SourceLink[] };  // source_references로 이어진다
  files?: GeneratedFileRef[];       // S2·S3에서 쓴다
  usage?: LlmUsage[];               // 능력 안에서 AI를 불렀을 때. 실행기가 과금 규약대로 기록
}
```

`prepare`의 결과는 시스템 프롬프트에 붙일 글과 출처다.
능력이 던진 예외는 실행기가 받아 `ok: false`로 바꾸고, 대화는 계속된다(정의서 7.5).

### 4.4 S1에서 들어가는 능력

| id | 능력 | 처리 |
|---|---|---|
| `public_data` | 공공데이터 조회 | 커넥터 4종을 감싼다. 설정은 쓸 커넥터 목록. `src/lib/connectors/`는 그대로 둔다 |
| `doc_search` | 참고 문서 찾기 | 지금의 자동 검색을 `prepare`로 옮긴다. '자료 인용 규칙'과 '검색 결과 없음' 세 갈래 프롬프트도 이 파일로 옮긴다. **동작은 바꾸지 않는다.** NODA 교체는 S4 |
| `image` | 사진 읽기 | 도구가 아니라 받을 수 있는 입력을 정한다. 꺼진 비서에 사진을 보내면 서버가 거절 |

파일 받아 읽기 · 표 합치기 · 양식 채우기 · 내보내기는 S2·S3에서 파일을 더할 때 목록에 올린다.
동작하지 않는 켜기 버튼을 미리 보여 주지 않는다.

### 4.5 기존 비서 옮기기

| 조건 | 켜는 능력 |
|---|---|
| 모든 대화형 비서 | `image` — 지금 모두 사진을 받는다 |
| 연결된 문서가 있는 비서 | `doc_search` |
| `enabled_connectors`가 비어 있지 않은 비서 | `public_data` (그 커넥터 목록으로) |

문서가 없던 비서는 `doc_search`가 꺼진 채로 옮겨진다. 이 비서에 나중에 문서를 올리면 그때 켠다
(문서 업로드가 `doc_search`를 함께 켠다 — 지금은 문서만 올리면 검색되므로 같은 동작을 유지한다).

---

## 5. 대화 실행기와 AI 연결부

### 5.1 AI 연결부 — `src/lib/llm/`

| 파일 | 내용 |
|---|---|
| `types.ts` | 업체에 묶이지 않는 공통 형식. 메시지 · 내용 블록(글 · 사진 · 도구 호출 · 도구 결과) · 도구(MCP 형식) · 사용량 · 스트림 이벤트 |
| `index.ts` | `streamChat()` · `complete()`. `models.ts`에 적힌 업체(`provider`)를 보고 어댑터를 고른다. 시험용 가짜 어댑터를 끼울 수 있다 |
| `anthropic.ts` | 지금 `claude.ts`의 내용. MCP 도구 → Anthropic 형식 변환, `input_json_delta` 조립, 라운드별 사용량 |

- `claude.ts`는 없어진다. 요술봉(`/api/enhance-prompt`)도 `complete()`를 쓴다.
- `models.ts`의 각 모델에 `provider` 칸을 더한다. 지금은 모두 `anthropic`.
- 기관 내부 모델을 붙일 때는 레지스트리 항목 하나와 어댑터 파일 하나를 더한다.

### 5.2 대화 실행기 — `src/lib/assistant/`

한 턴을 두 단계로 나눈다. 응답 규약(스트림 전 실패는 JSON, 스트림 뒤 실패는 SSE `error`)을 그대로 지키기 위해서다.

**`prepareTurn(input)`** — 거절이면 `{ status, message }`를 돌려주고 라우트가 JSON으로 답한다.

1. 비서 조회 → `canUseAgent`
2. 기관 상태 · 한도(`checkTokenLimit(departmentId, userId)`) → 금지어 → 사진(상한 + `image` 능력)
3. 모델 결정: `agent.model_id`가 기관 허용 목록(`getAllowedModelIds`) 안이면 그대로, 아니면 기본 모델로 바꾸고 표시
4. 대화 조회 또는 생성 · 직전 이력 20개
5. 능력 결정: 켜진 능력 중 쓸 준비가 안 됐거나 기관 범위 밖(나만의·부서)인 것을 빼고 `prepare` 실행

**`streamTurn(prepared)`** — `TurnEvent`를 하나씩 내보낸다.

1. 도구 루프. `MAX_TOOL_ROUNDS`(4) 상한. 상한에 걸리면 도구 정의는 유지하고 `tool_choice='none'`으로 마무리 호출
2. 저장. 메시지 두 행(같은 키 집합, `agent_version` 포함) · `usage_logs` 한 행
   (`model` · 토큰 · `cost_usd` · `cost_krw` · `agent_id`, 라운드와 능력 사용량을 합산)
3. 첫 턴이면 제목 생성

이벤트는 지금과 같다 — `meta · delta · tool_start · tool_end · tool_limit · error · done`.
`ChatInterface`의 스트림 처리는 바뀌지 않는다.

| 파일 | 역할 |
|---|---|
| `prepare.ts` | `prepareTurn` |
| `stream.ts` | `streamTurn` · 도구 루프 |
| `prompt.ts` | 시스템 프롬프트 조립 (비서 지시문 + 능력의 `prepare` 결과) |
| `history.ts` | 이력 조회 · user로 시작하도록 다듬기 |
| `persist.ts` | 메시지 · 사용 로그 저장 |
| `types.ts` | `TurnContext` · `TurnEvent` · `PreparedTurn` |

**`/api/chat`은 얇아진다** — 인증 → 요청자 범위 → `prepareTurn` → 거절이면 JSON, 통과면 `streamTurn`을 SSE로 흘린다.

### 5.3 화면

| 어디 | 바뀌는 것 |
|---|---|
| 대화 화면 | 모델 선택을 없애고 입력창 근처에 이 비서의 모델 이름을 작게 보여 준다 |
| 비서 편집 | 기관 허용 목록에서 모델을 고른다. 허용 목록에서 빠진 모델이면 '허용 목록에 없어 기본 모델로 동작 중' |

---

## 6. 정리 · 이전 · 검증

### 6.1 배포 순서

| 순서 | 내용 | 옛 코드가 도는가 |
|---|---|---|
| ① `0026_agent_tiers.sql` | 2절의 칸 · 테이블 · 제약 · 트리거 · `save_agent` · 기존 비서 옮기기(4.5) · 모든 비서에 `migrated` 판 1 | 예 — 옛 칸을 지우지 않는다 |
| ② 코드 배포 | 실행기 · 권한 모듈 · 능력 · 화면 | — |
| ③ `0027_agent_tiers_cleanup.sql` | 배포 확인 뒤 `is_personal` · `enabled_connectors` · 맞춤 트리거 제거 | 옛 코드가 모두 내려간 뒤 |

0026에서 단계는 결정 1대로 채운다: `is_personal=true` → `personal`, 나머지 → `official`. 부서 비서는 처음에 없다.

### 6.2 걷어내는 것

- `/api/qna` · `/api/report` · `/employee/*` · `src/components/report/` · `EmployeeDashboard` · `src/lib/claude.ts` · 대화 화면의 모델 선택
- **템플릿 관리**(`/admin/templates`)는 읽기 전용으로 돌린다. 내용 복사 버튼을 두어 비서 지시문으로 옮길 수 있게 하고, `report_templates` 테이블은 남긴다. 완전 삭제는 고객이 옮긴 뒤 별도로 한다
- 과거 `usage_logs`의 Q&A·보고서 사용 내역은 그대로 둔다. 감사 자료다
- 경로가 줄면 `route-auth` 공개 목록과 한도·과금 규약 전수 검사의 대상 목록을 함께 줄인다

### 6.3 기본 비서 세트

- `agent-presets.ts`의 각 비서에 단계(`official`) · 모델 · 능력을 적는다
- `installPresetAgents`가 판 1을 남긴다
- `seed:agents --update`는 `save_agent`를 거쳐 `preset_update` 판으로 기록한다. `updated_by`가 비어 있는 비서만 갱신한다는 기존 원칙은 그대로다

### 6.4 화면

| 어디 | 바뀌는 것 |
|---|---|
| 비서 편집 (관리자·직원 공통 양식) | 모델 선택 · 능력 켜기(능력 목록에서 자동으로 그림) · 양식 파일(이름 붙여 10개까지) · **변경 기록 탭**(누가·언제·무엇을 + '이 판으로 되돌리기') · 동시 수정 충돌 안내 |
| 직원 비서 목록 | '부서 비서' 묶음 · 나만의 비서에 '부서 비서로 올리기' · 부서 비서 편집 진입 |
| 관리자 비서 관리 | 단계 표시·필터 · 승인 시 '신청 뒤 바뀜' 안내 |

### 6.5 검증

| 장치 | 보는 것 |
|---|---|
| `npm test` (추가) | 권한 판정 표 전체 · 능력 목록(도구 이름 중복 · 설정 검사) · 실행기(가짜 어댑터: 상한 라운드의 `tool_choice='none'` · 라운드별 사용량 누적 · 도구 실패 후 계속 · 저장 두 행 키 집합 · 허용 밖 모델 대체) |
| 원본 검사 (추가) | Anthropic 주소는 `src/lib/llm/`에서만 부른다 · 비서 변경 라우트는 `agent-permissions`를 거친다 · 능력은 격리 값을 `ctx`에서만 꺼낸다 |
| `npm run db:test-agents` (새로) | `save_agent`의 저장 · 되돌리기 · 동시 수정 거절 · 양식 10개 상한을 **실제 DB에서** 확인. 트랜잭션 안에서 돌리고 `ROLLBACK`하므로 아무것도 남지 않는다. `db:migrate`처럼 `DATABASE_URL`을 쓴다 |
| `npm run db:check` (추가) | 모든 비서에 현재 판의 기록이 있는가 · `tier`와 `is_personal`이 맞는가(0027 전까지) · 능력 id와 모델 id가 등록된 것인가 · 부서 비서의 공개 범위가 `department`인가 |
| `npm run isolation:check` (추가) | 부서 비서의 주인 부서와 비서의 기관이 일치하는가 |

### 6.6 끝났다고 말할 수 있는 기준

1. 기존 비서가 옮긴 뒤에도 똑같이 답한다 — 참고 문서 · 커넥터 · 사진 포함
2. 부서원 둘이 같은 부서 비서를 고치고, 충돌 안내를 보고, 이전 판으로 되돌릴 수 있다
3. 나만의 → 부서 → 공식 신청·승인이 3.2·3.3 표대로 동작한다
4. 6.5의 검증 장치가 모두 통과한다

### 6.7 구현 묶음

| 묶음 | 내용 | 배포 |
|---|---|---|
| S1-a 데이터·권한 | 0026 · `save_agent` · `agent-permissions` · 비서 라우트 전환 · `db:test-agents` | 0026 적용 후 배포 |
| S1-b AI 연결부·실행기 | `llm/` · `capabilities/` · `assistant/` · `/api/chat` 전환 · Q&A·보고서 제거 | 배포 |
| S1-c 화면·정리 | 편집 화면 · 변경 기록 탭 · 부서 비서 목록 · 템플릿 읽기 전용 · 0027 | 배포 후 0027 |

---

## 7. S4로 넘기는 것 (NODA 연결 안내 기준, 2026-10-14)

NODA가 운영 주소(`https://api.readlayer.kr`)와 MCP 도구 8개를 내놓았다. S1에는 4.2의 원칙만 반영하고 나머지는 S4에서 정한다.

- 키 하나로 보관함 `workon`과 `workon-…`을 쓸 수 있다 → **기관마다 보관함**(`workon-{기관}`) 계획이 그대로 된다
- `ACL.json`은 여전히 API로 넣거나 지울 수 없다 → 비서별 문서 범위를 ACL 대신 무엇으로 할지(예: 비서마다 보관함) S4에서 비교한다
- 문서를 빼도 파싱 캐시가 남는다 → 정의서 10.2의 NODA 쪽 작업으로 남는다
- `noda_read_file`은 보관하지 않으므로 S2·S3에서 바로 쓸 수 있다
- 키는 `.env.local`에만 두고 `config.ts`를 거쳐 읽는다. 채팅·저장소·`.env.example`에 남기지 않는다
