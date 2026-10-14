# 공공기관 업무지원 시스템 — NODA·REA를 쓰는 구축 계획

**작성일**: 2026-10-14
**근거**: 웍스AI 3.0 기능 페이지 · Alli Works 제품 페이지 · NODA 저장소(`D:\coding\NODA`,
W463 · `docs/api.md`·`rag.md`·`schema.md`·`deploy.md`·`mcp.md`) · NODA 운영 서버
(`https://noda.115.68.223.66.sslip.io`, 인천 SMILESERV, `/openapi.json` 실측) ·
REA 6.4.0(`morluto/rea`, npm `rea-agents`) · WORKON 코드(`eb0bf9d`)

> 이 문서는 **추정이 아니라 읽은 것**으로 썼다. 못 읽은 것은 「확인할 것」에 따로 적었다.

---

## 0. 전제 — 세 가지가 각각 무엇을 맡나

| | 역할 | 맡지 않는 것 |
|---|---|---|
| **WORKON** | 사용자·기관·부서·권한 · 비서 · 대화 · LLM 호출 · 한도·과금 · 감사 · 화면 | 문서 파싱 (NODA로 넘김) |
| **NODA** | 파일 → 글·표·구조 + **근거(파일·쪽·좌표)** · 보관·검색 · 근거 묶음 · **답 검증** | LLM · 업무 판단 · 개인정보 탐지 (NODA 규칙 4·9) |
| **REA** | 벤치마킹 대상(설치형 앱)의 **동작·구조 분석 도구**. 런타임 구성요소가 아니다 | 코드 복제 · SaaS 트래픽 관찰 |

**이 시스템은 WORKON이다.** 두 달간 쌓은 격리·한도·감사·커넥터를 버리고 새로 만들
이유가 없다. 바꾸는 것은 **문서를 읽고 찾는 층** 하나이고, 그 자리에 NODA가 들어간다.

---

## 1. 왜 NODA인가 — 벤치마크 두 곳의 핵심을 한 번에 가져온다

Alli Works가 차별점으로 내세우는 둘이 NODA에 **이미 있다**:

| Alli Works | NODA | WORKON 현재 |
|---|---|---|
| 원본 레이아웃 그라운딩 — 인용 위치를 원문 위에 하이라이트, 쪽 단위 출처 | `anchors`(쪽·bbox·칸 주소) + `GET /view` | 청크 텍스트만 인용 |
| 자기 검증 RAG — 답을 스스로 검증 | `POST /verify` — 근거에 없는 숫자·없는 인용을 짚음 | 인용 규칙을 프롬프트에 넣을 뿐, **검증 없음** |

웍스AI 3.0이 내세우는 **「요청·답변·로그가 국경을 넘지 않는다」(K-오픈웨이트)**에는
LLM을 바꾸지 않고도 상당 부분 답할 수 있다 — 아래 2절.

그리고 WORKON의 자체 파서 5종(`hwp.ts` · `spreadsheet.ts` · `pptx.ts` · `pdf-ocr.ts` ·
mammoth)이 NODA 하나로 대체된다. NODA는 코퍼스 1,477건과 3관문 평가 하네스로
정확도를 **재고 있고**, 우리 파서는 회귀 테스트만 있다.

---

## 2. 데이터 흐름 — 이 계획의 가장 큰 보안 이득

### 지금 (문서 본문이 해외로 나가는 경로 둘)

```
문서 ─▶ Voyage(미국)  임베딩          ← 본문 전체
스캔 ─▶ Anthropic(미국) OCR            ← 본문 전체
질문+청크 ─▶ Anthropic(미국)           ← 발췌
```

### NODA 이후

```
문서 ─▶ NODA(인천) 파싱·OCR·임베딩·보관·검색·검증   ← 본문은 국내에만
질문 ─▶ NODA /context ─▶ 발췌 ≤ budget자 ─▶ Anthropic(미국)   ← 발췌만
답   ─▶ NODA /verify (국내)
```

**보안성 검토에서 할 수 있는 말이 바뀐다**: *"문서 전문은 국내에서만 처리되고,
질문에 필요한 발췌(기본 4,000자)만 해외 모델로 간다. 그 발췌가 무엇이었는지는
대화마다 기록된다."* 지금은 "본문이 두 미국 사업자에게 간다"가 사실이다.

NODA는 사용량 로그에 **「문서 내용은 한 글자도 안 쓴다」**(api.md). 이것도 그대로 소명 자료다.

**다만 문서가 두 곳에 있게 된다** — Supabase Storage(원본)와 NODA 보관함(파싱 결과·색인).
`docs/PUBLIC_SECTOR_PROCUREMENT.md`의 데이터 흐름도·위탁 관계도를 이에 맞춰 고쳐야
하고, 파기 경로가 **둘 다** 닫혀야 한다(5절 리스크).

---

## 3. 연결 설계 — NODA의 「세 길」 중 ②를 택한다

NODA `docs/rag.md`의 세 길:

| 길 | 뜻 | 판단 |
|---|---|---|
| ① `/chunk` → 우리 pgvector·Voyage | 파싱만 바꿈. 검색·격리는 우리 것 그대로 | 안전하지만 `/verify`·`/view`를 못 씀(보관함이 없으면 근거 대조 불가) |
| **② `/documents/upload` → `/context` → `/verify`** | NODA가 보관·검색·검증 | **채택.** 1절의 둘을 바로 얻고 2절의 흐름이 됨 |
| ③ `/answer llm:true` | NODA 게이트웨이가 LLM까지 | 제외. LLM·모델 정책·한도·감사는 WORKON의 것 |

### 3.1 테넌트 — 격리 단위를 어떻게 맞추나

NODA: 테넌트 = 색인 하나 = 경계(「색인이 곧 경계다」).
WORKON: 기관 → 부서(계층) → 비서(`visibility`) → 문서.

**테넌트 = `organization_id`**로 간다. 이유:
- 기관이 곧 격리 경계다(0014·0016). NODA 경계와 정확히 겹친다
- 비서 단위로 테넌트를 나누면 기관 공용 문서(`visibility=organization`)가 비서마다 중복 업로드된다

**비서 범위는 `ACL.json` + `principal`로 건다** (NODA 답 1번 · 2026-10-14).
`doc_ids` 필터는 넣지 않는다 — 상위 k를 뽑은 뒤 거르면 k가 새고 BM25의 IDF에 남의 문서가
배어드는 함정이 있어 NODA가 일부러 막아 둔 것이다(`acl.py`). ACL은 **허용된 파일만으로
색인을 따로 세우므로** 안 보이는 문서는 점수가 낮은 것이 아니라 없다.

WORKON 쪽 설계:

| | |
|---|---|
| `principal` | **`agent-{agent_id}`**. `/api/chat`이 지금도 비서에 연결된 문서만 보므로 이 의미를 그대로 지킨다. 부서 단위로 넓히면 비서별 문서 세트(입찰공고 비서 등)가 섞인다 |
| 규칙 | 문서마다 한 줄 — `{"files": "<정확한 파일명>", "allow": ["agent-A", "agent-B"]}`. 한 문서를 여러 비서에 연결해도 **한 번만 올리고** allow에 비서를 나열한다 |
| 파일명 | NODA는 경로를 떼고 이름 하나만 쓰고 같은 이름은 409다. **`{document_uuid}__{원래이름}`**으로 올려 다른 문서의 같은 이름 충돌을 막는다 |
| `default` | `[]` — 규칙에 없는 파일은 아무 비서에게도 안 보인다. 닫히는 쪽으로 |
| 갱신 시점 | 문서 업로드·삭제·비서 연결 변경 때마다 WORKON이 **테넌트 ACL 전체를 다시 생성**해 보낸다 |

**깨진 ACL은 전부 잠금이다**(`acl.py` — 오타 하나가 유출이 되지 않게). 그래서 WORKON은
보내기 전에 JSON을 검증하고, 테스트가 생성기를 고정한다(5절).

**아직 안 닫힌 것 하나**: `ACL.json`은 테넌트 폴더의 사이드카이고 `/documents/upload`가
거부한다(`tenants.py:8`). WORKON이 HTTP로 쓸 길이 없다 → **NODA에 ACL 쓰기 엔드포인트**
(예: `PUT /documents/acl?tenant=`)가 필요하다. purge와 같은 종류의 `service/` 변경이다(6절).

### 3.2 WORKON 쪽 바뀌는 자리

| 자리 | 지금 | 이후 |
|---|---|---|
| `src/lib/noda.ts` (신규) | — | fetch 클라이언트. Bearer 키 · `503 + Retry-After` 재시도 · 업로드 시간 제한 5분(mcp.md 권고) · `X-Filename` 퍼센트 인코딩 |
| `config.ts` | — | `NODA_API_URL` · `NODA_API_KEY` (직접 `process.env` 금지) |
| `documents` 표 (0026) | 청크·임베딩 JSONB | + `noda_doc_id` · `noda_status`(readable/reason/chunks) · `noda_engine_version` · `schema_version` |
| `/api/upload` | 파싱 → Voyage → DB | 원본은 Storage에 그대로 → NODA `/documents/upload?tenant={org}` → 상태 저장. **파싱 코드는 NODA 응답 뒤로 물러남** |
| `/api/chat` | `search_agent_chunks` → 참고 자료 + 인용 규칙 | NODA `/context` → `context` 문자열을 **그대로** 참고 자료 자리에 → 기존 인용 규칙 유지 → 스트림 끝에 `/verify` → SSE `verify` 이벤트 |
| `/api/qna` | `search_document_chunks` | 같은 방식. 부서 범위는 `getVisibleDepartmentIds` → `doc_ids` |
| `messages.source_references` | `{chunks, links}` | + `verify: {grounded, unsupported[], unknown_refs}` — 감사에서 "그때 검증 결과"를 묻는다 |
| 문서 삭제 | DB + Storage | + NODA `DELETE /documents` — **캐시까지 함께 지우도록 NODA가 고친다**(답 2번 · NODA 단위) + ACL 재생성 |
| 비서 연결 변경 | `documents.agent_id` | + 테넌트 ACL 재생성 → NODA에 쓰기 |
| `src/lib/noda-acl.ts` (신규) | — | 기관의 문서·비서 연결에서 `ACL.json`을 **순수 함수**로 생성. 깨진 ACL=전부 잠금이라 생성기를 테스트로 고정 |
| `SourceCitation` | 문서명·청크 | 문서명·**쪽**·OCR 배지·`/view` 링크(PDF·그림일 때) |

**기존 Voyage·pgvector 경로는 Phase 1 동안 남긴다** — `organizations.rag_engine`
(`'native'` 기본 → `'noda'`)로 기관별 전환. 두 경로를 같은 질문으로 맞대어 본 뒤 뗀다.
한 번에 바꾸면 틀어진 것이 어느 쪽 때문인지 알 수 없다.

### 3.3 `/verify`를 어떻게 보여주나 — 이것이 Alli와 같아지는 자리

`unsupported`에 든 숫자는 **근거 어디에도 없는 수**다. CLAUDE.md에 적힌 「2,000톤」 사례
(문서에 '톤'이 없는데 단위를 붙임)가 정확히 이 검출 대상이다.

- 말풍선에 **「근거에 없는 숫자: 28, 1,200」** 배지. 그 숫자를 본문에서 표시
- OCR 조각(`extractors: ocr`)에서 온 숫자는 **「스캔 판독 — 확인 필요」** 배지.
  NODA 스캔 오차 0.19는 숨길 수치가 아니라 **화면에 적어야 할 수치**다
- 고치지 않는다. NODA도 「고쳐 주지 않는다」(mcp.md). 사람에게 보이는 것이 소비자의 몫

---

## 4. 단계

### Phase 0 — 계약 검증 (1주) · 코드 변경 없음

목표: **붙이기 전에 잰다.** NODA 자신의 원칙("측정할 수 없으면 개선할 수 없다")을 따른다.

1. WORKON용 키 발급 — NODA `NODA_API_KEYS`에 `{"workon": "…"}`. `/usage`가 서비스별로 센다
2. 시험 문서 10~20건 — `D:\coding\DOC`에 **실제 농식품부·농어촌공사 공문·PDF·HWP**가 있다.
   넣기 전에 NODA `tools/intake_scan.py`로 개인정보를 거른다(NODA `pilot.md`가 W341에서 비싸게 배운 것)
3. 같은 질문 30건을 **두 경로**에 — 현재 Voyage(관련 0.41~0.49 / 무관 0.02~0.11)와 NODA `/context`.
   보는 것: 관련/무관 분리 · **쪽 번호가 맞는가** · `truncated` 빈도 · p95 지연
4. `/verify` 재현 — 「2,000톤」 케이스를 그대로 넣어 `unsupported`에 '톤'이 잡히는지
5. 3.1의 범위 좁히기 방법 결정 (`doc_ids` 필터 추가 여부)
6. 업로드 지연 실측 — 스캔 10쪽이 몇 초인지. **Vercel 함수 시간 제한**과 맞댄다(5절)
7. **비교 전에 `GET /health`로 뜻 벡터가 실제로 켜졌는지 본다.** NODA는 벡터가 기본 켜짐이지만
   모델·토크나이저 환경변수 **셋을 다 줘야** 켜지고, 하나라도 빠지면 낱말 검색으로 돌면서
   켜진 것처럼 보인다(NODA CLAUDE.md GD). 이걸 안 보면 Voyage와 맞댄 수치가 전부 헛것이다
8. `ACL.json` + `principal=agent-…`로 비서 범위가 실제로 닫히는지 — 다른 비서의 문서가 **한 조각도** 안 나오는지

산출: `docs/NODA_PHASE0_RESULTS.md` — 수치만. 통과 기준: 분리 구간이 현재보다 나쁘지 않고
쪽 정확도 ≥ 0.9, `/verify`가 「2,000톤」을 잡음(NODA 숫자 자는 두 글자부터 보므로 2,000은 걸린다 — 답 2번 뒤 메모),
비서 범위 교차 조각 0.

**Phase 0 입구 조건** (NODA 쪽 작업 단위 둘이 먼저 서야 한다):
- `DELETE /documents`가 파싱 캐시(zip 안 pdf를 풀어 둔 `-unpacked` 폴더 포함)까지 지움 — NODA가 다음 단위로 짓기로 함
- ACL 쓰기 엔드포인트 — 위 3.1

### Phase 1 — NODA 연결 (2주)

- `noda.ts` 클라이언트 + 0026 마이그레이션 + `rag_engine` 플래그
- `/api/upload` → NODA. **비동기**로: 202 + 상태 폴링(또는 Vercel `maxDuration` 상향). 스캔은 수십 초라 동기로 두면 끊긴다
- `/api/chat`·`/api/qna` → `/context`. 세 분기(찾음 / 문서 있는데 못 찾음 / 문서 없음)는 그대로 — `truncated`·`skipped`를 두 번째 분기의 근거로 쓴다
- `/verify` → SSE `verify` 이벤트 → `source_references.verify` 저장
- 삭제 → NODA delete + purge
- 테스트: `tests/noda.test.ts` — 클라이언트가 503을 재시도하는지 · 모든 문서 삭제 경로가 NODA 삭제를 부르는지(소스 전수) · `verify`가 저장되는지

### Phase 2 — 근거 화면 (1~2주)

- `SourceCitation`: 쪽 · OCR 배지 · `/view` 링크. HWPX·HWP·DOCX는 쪽 그림이 없어 좌표를 글자로만 낸다(NODA W163) — **왜 못 칠하는지 화면에 적는다**, 지어내지 않는다
- `MessageBubble`: `unsupported` 숫자 표시
- 감사 화면: 검증 결과 열 추가 (CSV 포함)

### Phase 3 — 벤치마크에서 가져올 것 (3~4주) — `WRKS_GAP_PLAN_2026-08-20.md`의 D단계 + 10월 분석

| 순서 | 항목 | 왜 |
|---|---|---|
| 1 | **업로드 결재** — 관리자가 켜면 결재자 승인 뒤에만 NODA로 넘어감 | 웍스 드라이브. 공공기관 결재 문화. `approval_status` 틀이 있음. **NODA 업로드 직전이 결재 지점** |
| 2 | **공공데이터 커넥터 6종** (한국은행 ECOS · 도로명주소 · 국회의안 · 공동주택실거래가 · 고용산재보험 · KISTI) | 웍스 21종 vs 우리 4종. 커넥터 틀 그대로 |
| 3 | **스마트 라우팅** — 난이도 판별 → 모델 선택 | 모델 4종 + 기관 정책 + 금액 한도 위에 판별 층만 |
| 4 | 텍스트 추출 → 엑셀 (D1) | NODA가 PNG·JPG·TIF OCR을 하므로 **이미지 20장 → NODA /parse → 항목 추출 → XLSX**로 짧아짐 |
| 5 | 문서 작성 목차 인식 (D2) | NODA `structure`(제목·조항 편장절관조)가 **목차를 이미 준다**(W463 outline_f1 0.906). 양식 올리면 목차가 나오는 것은 NODA 쪽에서 끝남 |
| 6 | 워크플로우 예약 (아침 브리핑·입찰 모니터링) | cron + 커넥터 |

4·5가 NODA로 인해 **크게 줄었다** — 8월 계획에서 "중간" 규모였던 것이 작아졌다.

### Phase 4 — 격리·파기·소명 문서 (Phase 1과 병행)

- `isolation:check`에 NODA 항목 추가: 기관 A 키·테넌트로 기관 B 문서가 **한 조각도** 안 나오는지 실측
- 파기: 문서 삭제 → Storage · DB · NODA 색인 · **NODA 캐시**까지. 네 곳이 한 번에
- `PUBLIC_SECTOR_PROCUREMENT.md`: 데이터 흐름도 · 위탁 관계도(Anthropic · NODA 서버 운영자 · Supabase)를 2절대로

### REA 트랙 — 벤치마킹 분석 (Phase 0부터 병행, 2~3주)

목적: 두 벤치마크의 **설치형 앱**이 실제로 어떻게 움직이는지 — 기능 소개 페이지가 아니라 **배포된 산출물**에서 — 확인해 Phase 3 우선순위와 보안 비교표의 근거로 삼는다.

| 대상 | REA 경로 | 알고 싶은 것 |
|---|---|---|
| 웍스AI Desk (Electron) | JavaScript/Electron 분석 — 모듈·IPC·라우트 | 로컬 파일을 어디까지 읽나 · 무엇이 기기 밖으로 나가나(「대화도 작업 기록도 이 컴퓨터에만」 주장 검증) · MCP 도구 연결 방식 · 결재·승인 UX |
| 알리 웍스 데스크톱 | 같음 (Electron이면) | 로컬 파일 처리·스케줄 실행 구조 |
| 두 앱의 패키지 | 패키지·리소스 인벤토리 | 포함된 파서·OCR 엔진 종류(우리 NODA와 비교) |

**경계** — 처음부터 적어 둔다:
- **0단계: 대상 앱의 약관(EULA)에 역공학 금지 조항이 있는지 먼저 본다.** 있으면 그 앱은 뺀다. 기능 페이지·공개 문서·직접 써 본 경험으로만 비교한다
- 분석 대상은 **정식으로 설치한 데스크톱 앱**에 한한다. SaaS 웹의 트래픽 관찰·스크래핑은 하지 않는다(약관)
- 얻는 것은 **동작·구조·데이터 흐름의 이해**다. 코드·자산을 꺼내 옮기지 않는다. 라이선스 검사 우회를 하지 않는다
- 산출은 `docs/BENCHMARK_OBSERVATIONS_<대상>.md` — 관찰·증거·우리 설계에의 시사점. 코드 인용 없음

REA 설치는 터미널에서 에이전트 선택 대기 중이다. Claude Code에 등록하면 `reverse-engineer-anything` 스킬로 위 분석을 이 세션에서 바로 돌릴 수 있다.

---

## 5. 리스크 — 전부 읽은 문서에서 나온 것

| 리스크 | 근거 | 대응 |
|---|---|---|
| **Vercel 함수 시간 제한 vs NODA 파싱 수십 초** | mcp.md "스캔 여러 쪽은 수십 초" · Vercel 서버리스 기본 제한 | 업로드를 비동기로(202 + 폴링) 또는 `maxDuration` 상향. **Phase 0에서 실측 후 결정** |
| **NODA 단일 VM** (4 vCPU·4GB · `NODA_MAX_PARALLEL=2` · 가득 차면 503) | deploy.md | 클라이언트 재시도 + 사용자에게 「읽는 중」 표시. NODA가 내려가면 `/api/chat`은 **「문서 검색 결과 없음」 분기**로 — 조용히 빈 손을 주지 않는다 |
| **OCR 오차 0.19** | rag.md | 화면 배지 필수(3.3). 숨기면 「2,000톤」이 다시 난다 |
| **삭제해도 파싱 캐시에 글자가 남음** | `tenants.py:72` 응답이 스스로 "purge로 지우라"고 적음 · `retention.py purge`는 `register`로 장부를 적은 폴더에서만 돎 | **NODA가 `DELETE /documents`에서 캐시 열쇠(내용 해시+이름)를 짚어 함께 지우도록 고친다** — `service/` 안의 작은 변경, 엔진 무변경. 이것이 서야 "삭제 요구 시 즉시 삭제"를 말할 수 있다 |
| **깨진 ACL = 기관 전체 검색 잠금** | `acl.py` "규칙을 못 읽었는데 공개로 돌면 오타 하나가 유출" | 옳은 설계다. 대신 WORKON 생성기가 틀리면 그 기관의 비서 전부가 「문서 검색 결과 없음」이 된다 — 생성기를 순수 함수로 두고 테스트로 고정, 쓰기 전 JSON 검증, `/documents`로 되읽어 확인 |
| **뜻 벡터가 안 켜진 채 켜진 것처럼 보임** | NODA CLAUDE.md GD — 환경변수 셋 중 하나만 빠져도 낱말 검색으로 조용히 떨어짐 | Phase 0 7번. 운영에서도 `/health`를 주기적으로 보고 `vectors` 꺼짐을 경보 |
| 문서가 두 곳 | 2절 | 소명 문서 갱신 · 파기 네 곳 동시 |
| 격리가 두 시스템에 걸침 | 3.1 | `isolation:check` 확장(Phase 4). 우리 쪽 교훈: 격리는 정책이 아니라 실측으로 잡는다 |
| **NODA 서버가 CSAP인가** | deploy.md 73줄은 판정이 아니라 확인 항목. 스마일서브가 'KoreaV'로 CSAP를 받았다는 보도자료는 있으나 **등급(IaaS 등)·시점 미상** | **KISA 공식 인증 목록으로 확인**(사람이 할 일). 폐쇄망 설치(`docs/install.md`)면 CSAP 자체가 무관 — 온프레미스 제안의 근거 |
| `budget`은 글자, 우리 한도는 토큰·원 | rag.md | 기관 정책에 `context_budget` 상한. 발췌가 길수록 입력 토큰이 는다 |
| 스키마 변경 | schema.md "변경 시 ADR" | `schema_version`·`engine_version`을 문서마다 저장(NODA 자신의 권고). 엔진이 바뀌면 재색인 대상이 보인다 |
| HWPX·HWP·DOCX는 쪽 그림 없음 | api.md W163 | `/view` 하이라이트는 PDF·그림만. 나머지는 쪽·좌표 글자로. 기대치를 화면에 적는다 |

---

## 6. 확인한 것 — NODA 답 (2026-10-14)

| 물음 | 답 | 남은 것 |
|---|---|---|
| `/context`를 문서 id로 좁히기 | **못 한다**(`context.py:66`). `principal` + `ACL.json`으로 — 허용 집합마다 색인을 따로 세움. `doc_ids`는 뒤에서 거르는 함정이라 일부러 없음 | **ACL 쓰기 엔드포인트** — 업로드 API가 `ACL.json`을 거부해 WORKON이 쓸 길이 없음(3.1) |
| purge 원격 호출 | **없다.** `DELETE`는 파일만 지움 | **NODA 단위**: `DELETE`가 캐시까지 지우도록 — NODA 쪽에서 짓기로 |
| SMILESERV CSAP | 저장소에 근거 없음. 'KoreaV' CSAP 보도자료는 있으나 등급·시점 미상 | **KISA 목록 확인** |
| `/verify`가 보관함 없이 되나 | ②길이므로 불필요 | — |
| 키 하나로 테넌트 여럿 | 키=소비자, 테넌트=폴더로 별개 | Phase 0에서 실측 |

**NODA의 조심 사항 하나**(답에 덧붙여진 것): 뜻 벡터는 환경변수 셋이 다 있어야 켜진다 → Phase 0 7번.

---

## 7. 결정이 필요한 것

| # | 결정 | 상태 (2026-10-14) |
|---|---|---|
| 1 | ②길 채택 | **확정.** ADR-0047 그대로, `/verify`가 짝 |
| 2 | 테넌트 = 기관 | **확정.** 테넌트 폴더 전체로 색인 |
| 3 | 범위 = `principal` + `ACL.json` (`doc_ids` 아님) | **확정.** `doc_ids`는 ACL로 안 되는 사례가 실제로 나올 때 |
| 4 | 기존 Voyage·pgvector 이중 운용 | **확정** (NODA와 무관한 WORKON 결정). 비교 전 `/health` 벡터 확인 필수 |
| 5 | 업로드 비동기화 방식 | Phase 0 실측 뒤. 수십 초면 202+폴링 |
| 6 | REA 분석 범위 | **설치형 앱만**, 코드 복제 없음. **대상 앱 약관의 역공학 금지 조항을 먼저 본다** |
| 7 | NODA 호스팅 주체·CSAP | KISA 확인 뒤. 공공 납품 전 확정 |

---

## 8. 성공 기준 (숫자로)

| 항목 | 기준 |
|---|---|
| 검색 분리 | 관련/무관 구간이 현재(0.41~0.49 / 0.02~0.11)보다 나쁘지 않음 |
| 출처 쪽 정확도 | ≥ 0.9 (시험 30문항) |
| `/verify` | 「2,000톤」 재현 케이스 검출 · 거짓 양성 ≤ 10% |
| 지연 | `/context` p95 < 2초 · 업로드는 비동기라 사용자 체감 없음 |
| 격리 | NODA 교차 테넌트 조각 **0** (실측) |
| 파기 | 삭제 후 Storage·DB·NODA 색인·캐시 **4곳 모두** 부재 (실측) |
| 테스트 | `npm test`에 NODA 클라이언트·삭제 경로 전수·verify 저장 추가 |

---

## 진행 기록

| 단계 | 상태 |
|---|---|
| Phase 0 계약 검증 | 결정 1~4 확정. **입구 대기**: NODA 단위 둘(DELETE 캐시 삭제 · ACL 쓰기) + KISA 확인 |
| Phase 1 NODA 연결 | 대기 |
| Phase 2 근거 화면 | 대기 |
| Phase 3 벤치마크 기능 | 대기 |
| Phase 4 격리·파기·소명 | 대기 |
| REA 트랙 | REA 6.4.0 설치 완료 · Claude Code MCP 연결됨 · **대상 앱 약관 확인 전** |
