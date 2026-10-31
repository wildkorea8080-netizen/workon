# 실제 ReadLayer·LLM 회신 생성 검증

시험일: 2026-10-29 KST (실행 기록의 2026-10-28T20:45Z는 UTC).

## 확인한 결과

1. 실제 ReadLayer /health와 벡터 검색 활성 상태 확인.
2. 독립된 workon-check-* 보관함에 가상 출장 규정을 올려 관련 질문의 근거·위치 정보 확인. 무관한 질문에는 근거 없음. 삭제 뒤 목록에서 사라짐.
3. 별도 workon-smoke-* 보관함에 가상 주차장 운영 기준을 올림.
4. 실제 /context 결과를 WORKON sourcesToChunks와 isCleanMatch로 가상 문서 ID에 맞춰 검증하고 회신의 근거로 전달.
5. 실제 Claude Sonnet 4.6 1회 호출 → 질문 2개 분리·출처가 있는 답변 → 로컬 시험 PostgreSQL 저장 → 검증된 HWPX 생성.
6. 앱 설정 1판·ReadLayer 근거 1건 보존. 파일 상태 valid. 실행 약 7초, 기록 원가 약 13원(청구서가 아닌 usage_logs의 단가 계산).
7. 사용한 가상 문서를 삭제하고 목록에서 사라짐 확인. 임시 로컬 DB도 시험 후 정지.

실행 상세: [실제 결과 기록](REAL_RAG_SMOKE_RESULT.md).
검토 파일: [가상 회신 HWPX](evidence/real-rag-reply.hwpx).
SHA-256: bc294e9e94c204187f54d8e59dc97e2649dd0d91ccf75fe5f2fbf0dd5b54d47c.

## 구현한 검증 도구

- noda-check.mjs: --isolated로 실행별 보관함, --saas로 외부 LLM 사용을 SaaS 환경 정보로 표시. 기본 폐쇄망 점검의 실패 기준은 유지.
- work-llm-smoke.mjs: --app-rag로 가상 회신 한 건만 실행. 실제 ReadLayer·실제 모델을 연결하며 운영 Supabase는 비활성 주소로 대체한다. 로컬 시험 DB 호스트와 이름 접두사를 검사한다. 검색·생성 실패는 종료 코드에 반영하며 finally에서 시험 문서를 삭제한다.
- 실제 호출을 포함한 실행과 두 스크립트 구문·diff 공백 검사를 통과했다.

## 적용 범위와 한계

시험용 비서 설정 로더와 검색 제공자 연결을 사용했다. 운영 Supabase에서의 비서 권한 조회, 인증된 브라우저 UI, 서명 다운로드, 한글 프로그램의 시각적 문서 검증, 운영 배포는 아직 확인하지 않았다. 1건 성공을 모든 문서·질문에 대한 정확도나 성능 보장으로 해석하지 않는다.

ReadLayer health는 외부 LLM 사용 중으로 응답했다. 이는 SaaS 검증의 실패 원인은 아니지만 완전 폐쇄망 운영의 증거는 아니다. 시험 문서는 가상 자료이며 실제 기관 문서를 전송하지 않았다. API 키·운영 DB 자격증명은 결과에 기록하지 않았다.

