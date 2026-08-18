# BENCHMARK.md — wrks.ai 벤치마킹 분석

**작성일**: 2026-04-21  
**기준**: wrks.ai 핵심 기능 vs WORKON 현재 구현 상태

---

## 범례

| 기호 | 의미 |
|---|---|
| ✅ 구현됨 | 실제로 동작하는 기능 |
| 🔶 부분구현 | 코드는 있으나 누락된 요소 있음 |
| ❌ 미구현 | 코드 없거나 완전 플레이스홀더 |

---

## 1. 현재 구현된 페이지 목록

| 경로 | 페이지 | 주요 기능 |
|---|---|---|
| `/` | 메인 (랜딩 + 채팅) | 비로그인 시 랜딩, 로그인 시 ChatInterface |
| `/login` | 로그인 | Credentials 로그인, role 파라미터 분기 |
| `/signup` | 회원가입 | Supabase Auth 기반 가입 |
| `/admin` | 관리자 대시보드 | QuickStats 카드 + 메뉴 링크 |
| `/admin/agents` | 에이전트 관리 | CRUD (생성/수정/삭제/활성화 토글) |
| `/admin/documents` | 문서 관리 | PDF/DOCX 업로드, 목록, 삭제, RAG 테스터 |
| `/admin/users` | 사용자 관리 | 사용자 초대, 목록 조회 |
| `/admin/templates` | 템플릿 관리 | 보고서 템플릿 CRUD |
| `/admin/settings` | 설정 | 금지어 관리 + 보안 로그 조회 |
| `/admin/stats` | 통계 | Recharts 차트, 사용량 통계 |
| `/admin/logs` | 사용 로그 | 시스템 활동 로그 목록 |
| `/employee` | 직원 대시보드 | 요약 카드, 비서 목록, 최근 대화, 빠른 링크 |
| `/employee/qna` | AI Q&A | ChatInterface 연결 (에이전트 기반 RAG 채팅) |
| `/employee/reports` | 보고서 생성 | ReportWizard 연결 |
| `/employee/history` | 대화 히스토리 | 날짜/비서명/미리보기, 클릭 시 전체 내용 |

---

## 2. 현재 UI 컴포넌트 목록

### 채팅
| 컴포넌트 | 설명 |
|---|---|
| `ChatInterface` | 전체 채팅 레이아웃 (사이드바 + 에이전트 선택 + 메시지 영역) |
| `AgentSelector` | 에이전트 카드 그리드 선택 UI |
| `ConversationSidebar` | 대화 목록 사이드바 |
| `MessageBubble` | 마크다운 렌더링 + 코드 하이라이팅 메시지 버블 |
| `SourceCitation` | RAG 출처 문서 표시 |

### 관리자
| 컴포넌트 | 설명 |
|---|---|
| `AgentsManager` | 에이전트 CRUD + 활성화 토글 |
| `DocumentsManager` | 파일 업로드 + 목록 + 삭제 |
| `UsersManager` | 사용자 초대 + 목록 |
| `SettingsManager` | 금지어 CRUD + 보안 로그 |
| `StatsDashboard` | 통계 차트 및 지표 |
| `QuickStats` | 대시보드 요약 카드 (실제 API 연결) |
| `UsageChart` | Recharts 기반 사용량 차트 |
| `PromptTemplateManager` | AI 프롬프트 템플릿 관리 |
| `RAGSearchTester` | RAG 검색 디버그 도구 |

### 보고서
| 컴포넌트 | 설명 |
|---|---|
| `ReportWizard` | 다단계 보고서 생성 흐름 |
| `ReportForm` | 입력 폼 |
| `ReportGenerator` | AI 생성 중간 처리 |
| `TemplateSelector` | 템플릿 선택 UI |
| `ReportViewer` | 결과 미리보기 + 편집 + 복사/다운로드/저장 |

### 직원
| 컴포넌트 | 설명 |
|---|---|
| `EmployeeDashboard` | 요약 카드 + 비서 목록 + 최근 대화 + 빠른 링크 |
| `ConversationHistory` | 대화 목록 + 펼침 상세 보기 |

---

## 3. wrks.ai 기능 비교 분석

### 채팅 / 비서

| 기능 | 상태 | 비고 |
|---|---|---|
| 비서 선택 화면 (카드 그리드) | ✅ 구현됨 | `AgentSelector` — 카드 그리드, 선택 하이라이트 |
| 채팅 인터페이스 | 🔶 부분구현 | 기본 Send/Receive 동작하나 **스트리밍 미지원** (전체 응답 후 일괄 표시) |
| 대화 히스토리 | ✅ 구현됨 | `ConversationSidebar` + `/employee/history` 페이지 |
| 파일 첨부 기능 | ❌ 미구현 | 채팅 입력창에 파일 첨부 UI 없음 |
| 답변 복사 버튼 | ❌ 미구현 | `MessageBubble`에 복사 버튼 없음 |
| 답변 재생성 버튼 | ❌ 미구현 | `MessageBubble`에 재생성 버튼 없음 |

### 관리자

| 기능 | 상태 | 비고 |
|---|---|---|
| 비서 생성/수정/삭제 | ✅ 구현됨 | `AgentsManager` — 인라인 편집, 삭제, 활성 토글 |
| 문서 업로드 (PDF/DOCX) | ✅ 구현됨 | `DocumentsManager` — 최대 20MB, 자동 임베딩 처리 |
| 부서별 비서 접근 제한 | 🔶 부분구현 | 부서 단위 데이터 격리는 됨, **에이전트별 사용자/역할 접근 제한은 없음** |
| 사용자 초대/관리 | 🔶 부분구현 | 초대 UI/API 있으나 **이메일 발송 미구현** (임시 비밀번호만 응답) |
| 사용량 통계 대시보드 | ✅ 구현됨 | 문서/에이전트/대화/토큰 카운트 + Recharts 차트 |
| 금칙어 설정 | ✅ 구현됨 | `SettingsManager` — 금지어 CRUD + 보안 로그 조회 |

### 보고서

| 기능 | 상태 | 비고 |
|---|---|---|
| 템플릿 선택 | ✅ 구현됨 | `TemplateSelector` — 활성 템플릿 목록에서 선택 |
| 내용 입력 폼 | ✅ 구현됨 | `ReportForm` — 플레이스홀더 기반 입력 폼 |
| AI 생성 결과 미리보기 | ✅ 구현됨 | `ReportViewer` — 인라인 편집 가능, DB 저장 연동 |
| 복사 | ✅ 구현됨 | `ReportViewer` 복사 버튼 → `navigator.clipboard` |
| 다운로드 | 🔶 부분구현 | `.txt` 텍스트 파일 다운로드만 지원, **PDF/DOCX 미지원** |

---

## 4. 미구현 기능 우선순위 정리

### 🔴 UX에 직접 영향 — 우선 개선 권장

| 기능 | 이유 |
|---|---|
| **채팅 스트리밍** | 현재 응답 지연이 길면 사용자가 멈춘 것처럼 느낌. SSE 또는 ReadableStream 필요 |
| **답변 복사 버튼** | 채팅 결과를 외부에서 활용하는 핵심 UX. `MessageBubble`에 버튼 1개 추가 |
| **답변 재생성 버튼** | 불만족스러운 답변 재시도 불가 — 이탈 요인 |

### 🟠 운영에 필요한 기능

| 기능 | 이유 |
|---|---|
| **사용자 초대 이메일** | 현재 임시 비밀번호를 UI에서만 확인 가능 → 운영 불가. Resend API 연동 필요 |
| **보고서 PDF 내보내기** | txt 다운로드는 실사용에 부족. `@react-pdf/renderer` 또는 `puppeteer` 필요 |

### 🟡 고급 기능

| 기능 | 이유 |
|---|---|
| **파일 첨부 채팅** | 채팅창에서 직접 문서 업로드 후 즉시 질문 가능 (미리 업로드 불필요) |
| **에이전트별 사용자 접근 제한** | 특정 에이전트를 특정 역할/사용자에게만 노출 |
| **페이지네이션** | 대화/로그/사용자 목록이 전체 조회라 데이터 증가 시 성능 문제 |

---

## 5. 요약 스코어카드

| 영역 | wrks.ai 기능 수 | 구현됨 | 부분구현 | 미구현 |
|---|---|---|---|---|
| 채팅/비서 | 6 | 2 | 1 | 3 |
| 관리자 | 6 | 3 | 3 | 0 |
| 보고서 | 4 | 3 | 1 | 0 |
| **합계** | **16** | **8 (50%)** | **5 (31%)** | **3 (19%)** |

> **결론**: 관리자 기능과 보고서는 완성도가 높고, 채팅 UX(스트리밍·복사·재생성)가 가장 큰 격차 영역.
