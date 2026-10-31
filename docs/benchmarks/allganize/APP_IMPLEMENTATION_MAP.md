# 공개 앱 100개 → WORKON 구현 대응표

2026-10-28 · [원본 카탈로그](APP_CATALOG.md) · [구조화 데이터](app-implementation-map.json)

**아래는 독자적인 구현 제안이다. 앱을 설치하거나 실행한 목록이 아니다.** 기존 엔진은 재사용 후보이며 해당 앱이 이미 완성됐다는 뜻은 아니다. 공급자의 출력 형식 확인은 원본 카탈로그의 상세 표를 따른다.

100개 원본 항목을 정확히 한 번씩 대응했다. 별도 Coworker 템플릿 8개는 원본 카탈로그에 따로 기록되어 있고 여기의 100개에 합산하지 않는다.

## 실행 기능별 분류

| 기능 | 앱 수 | 재사용 후보 | 추가 구현 |
|---|---:|---|---|
| 텍스트·입력 폼 | 57 | agents · assistant · file_read · document | 앱별 입력 스키마·검증 · 용어·문체·출력 계약 · 문서 출력이 필요하면 양식 판과 작업 연결 |
| 문서·근거 검색 | 7 | doc_search · public_data · regulations · qa | 앱별 지식/FAQ 범위 · 최신 판·근거 위치 · 답 없음·접근 거부·자료 장애 구분 |
| 추출·비교·검토 | 24 | file_read · doc_search · items · qa · regulations · work/review | 항목별 추출 JSON 계약 · 원문 대응·빠진 항목·변경 표 · 검토 결정과 결과 파일 연결 |
| 표 계산·대사 | 3 | table-engine · table_merge · collection · settlement · xlsx-export | 자료 열 대응 · 결측·중복·단위·모집단 규칙 · 이용 데이터·설문·청구/입금별 계산 규약 |
| 다단계 조사 | 5 | doc_search · public_data · regulations · llm · work/runs | 일반 웹 검색·본문 읽기 · 조사 범위·계획·재탐색 · 출처/기준일·비용·횟수 상한 |
| 멀티모달·파일 구성 | 4 | image · file_read · doc-fill · work/documents | 이미지 입력 정확도 평가 · 출력 형식별 전용 생성·검사 · PPTX는 신규 엔진·양식 설계 |

## 우선순위

| 구분 | 앱 수 |
|---|---:|
| SaaS 우선 후보 | 29 |
| 추후 검토 | 62 |
| 국내 기준 재설계 | 4 |
| 초기 우선순위 낮음 | 5 |

우선 후보는 평가·설계 대상을 뜻한다. 29개를 동시에 출시하겠다는 약속이 아니며, 실제 기관 사용 사례에서 대표 앱을 골라 순차 검증한다.

## 전체 대응

| 원본 ID | 참고 앱 | 공통 실행 기능 | 우선순위 | 공공기관 적용 제안 |
|---|---|---|---|---|
| 039 | [격려 문구 상담](https://www.allganize.ai/ja/app-market/ja-app-markets/039) | 텍스트·입력 폼 | 초기 우선순위 낮음 | 업무 연관 낮음; 초기 범위 제외 |
| 059 | [전화 상담 코칭](https://www.allganize.ai/ja/app-market/ja-app-markets/059) | 추출·비교·검토 | 추후 검토 | 민원 상담 기록의 응대 품질 점검 후보 |
| 013 | [프롬프트 생성](https://www.allganize.ai/ja/app-market/ja-app-markets/013) | 텍스트·입력 폼 | 추후 검토 | 업무 비서 지시문 초안 구성 |
| 055 | [영업 역할 연습](https://www.allganize.ai/ja/app-market/ja-app-markets/055) | 텍스트·입력 폼 | 초기 우선순위 낮음 | 민원 응대 교육 시나리오로 전환 |
| 079 | [프로젝트 위험 검토](https://www.allganize.ai/ja/app-market/ja-app-markets/079) | 추출·비교·검토 | SaaS 우선 후보 | 사업계획의 위험·대응 목록 작성 |
| 052 | [일대일 면담 지원](https://www.allganize.ai/ja/app-market/ja-app-markets/052) | 텍스트·입력 폼 | 추후 검토 | 업무 면담 질문 초안 |
| 092 | [AI 문서 적합성 점검](https://www.allganize.ai/ja/app-market/ja-app-markets/092) | 추출·비교·검토 | SaaS 우선 후보 | ReadLayer 읽기 품질·구조 점검 화면 |
| 033 | [BANTC 항목 정리](https://www.allganize.ai/ja/app-market/ja-app-markets/033) | 추출·비교·검토 | 추후 검토 | 상담 메모의 정해진 항목 추출 방식 참고 |
| 017 | [엑셀 함수 도움말](https://www.allganize.ai/ja/app-market/ja-app-markets/017) | 텍스트·입력 폼 | 추후 검토 | 직원이 설명한 계산에 맞는 수식 제안 |
| 060 | [FAQ 유지관리](https://www.allganize.ai/ja/app-market/ja-app-markets/060) | 추출·비교·검토 | 추후 검토 | 문의 기록을 FAQ 후보로 정리 후 검토 |
| 004 | [FAQ 기반 응답](https://www.allganize.ai/ja/app-market/ja-app-markets/004) | 문서·근거 검색 | SaaS 우선 후보 | 기관 검증 FAQ를 근거로 질의응답 |
| 095 | [FAQ 정비](https://www.allganize.ai/ja/app-market/ja-app-markets/095) | 추출·비교·검토 | 추후 검토 | 유사·중복·저사용 FAQ 검토 목록 |
| 106 | [문서에서 FAQ 생성](https://www.allganize.ai/ja/app-market/ja-app-markets/106) | 추출·비교·검토 | SaaS 우선 후보 | 기관 매뉴얼을 검토 가능한 FAQ 초안으로 |
| 054 | [이미지 도표 분석](https://www.allganize.ai/ja/app-market/ja-app-markets/054) | 멀티모달·파일 구성 | 추후 검토 | 스캔 표 추출·원본 대조에 활용 |
| 098 | [IT 지식 검색·문제 해결](https://www.allganize.ai/ja/app-market/ja-app-markets/098) | 문서·근거 검색 | 추후 검토 | 기관 전산 매뉴얼 기반 직원 지원 |
| 108 | [LLM·웹 정보 응답](https://www.allganize.ai/ja/app-market/ja-app-markets/108) | 다단계 조사 | 추후 검토 | 기관 자료와 외부 공개 정보의 범위 구분 |
| 036 | [LLM 활용 제안](https://www.allganize.ai/ja/app-market/ja-app-markets/036) | 텍스트·입력 폼 | 추후 검토 | 업무 유형별 AI 사용 예시 안내 |
| 019 | [Mac 문제 해결](https://www.allganize.ai/ja/app-market/ja-app-markets/019) | 문서·근거 검색 | 추후 검토 | 기관 기기 정책에 맞는 전산 도움말 |
| 056 | [NDA 검토](https://www.allganize.ai/ja/app-market/ja-app-markets/056) | 추출·비교·검토 | SaaS 우선 후보 | 표준 계약 대비 조항 누락·차이 확인 |
| 043 | [OKR 설정](https://www.allganize.ai/ja/app-market/ja-app-markets/043) | 텍스트·입력 폼 | SaaS 우선 후보 | 확정 실적에 근거한 부서 목표 초안 |
| 025 | [PEST 분석](https://www.allganize.ai/ja/app-market/ja-app-markets/025) | 다단계 조사 | 추후 검토 | 정책·경제·사회·기술 환경 조사 |
| 096 | [발표자료 개요·VBA 생성](https://www.allganize.ai/ja/app-market/ja-app-markets/096) | 멀티모달·파일 구성 | 추후 검토 | 발표 개요 참고; 임의 VBA 실행은 초기 제외 |
| 011 | [PR 기사 초안](https://www.allganize.ai/ja/app-market/ja-app-markets/011) | 텍스트·입력 폼 | 추후 검토 | 확인된 사업자료로 보도자료 초안 |
| 103 | [RFP 작성 지원](https://www.allganize.ai/ja/app-market/ja-app-markets/103) | 추출·비교·검토 | SaaS 우선 후보 | 제안요청서·과업지시서 필수 항목 초안 |
| 102 | [SaaS 약관 검토](https://www.allganize.ai/ja/app-market/ja-app-markets/102) | 추출·비교·검토 | 추후 검토 | 서비스 이용약관의 확인 사항 추출 |
| 028 | [SPIN 질문 생성](https://www.allganize.ai/ja/app-market/ja-app-markets/028) | 텍스트·입력 폼 | 추후 검토 | 사업 수요조사·상담 질문으로 전환 |
| 049 | [SQL DDL·쿼리 작성](https://www.allganize.ai/ja/app-market/ja-app-markets/049) | 텍스트·입력 폼 | 추후 검토 | 읽기 전용 통계 질의 보조부터 검토 |
| 034 | [SWOT 분석](https://www.allganize.ai/ja/app-market/ja-app-markets/034) | 텍스트·입력 폼 | 추후 검토 | 기관·사업 환경의 근거 있는 분석 |
| 018 | [Windows 문제 해결](https://www.allganize.ai/ja/app-market/ja-app-markets/018) | 문서·근거 검색 | 추후 검토 | 기관 전산 FAQ와 연계한 직원 지원 |
| 005 | [메일 초안 작성](https://www.allganize.ai/ja/app-market/ja-app-markets/005) | 텍스트·입력 폼 | SaaS 우선 후보 | 직원이 확인한 사실로 안내 메일 작성 |
| 089 | [하도급법 적용 점검](https://www.allganize.ai/ja/app-market/ja-app-markets/089) | 추출·비교·검토 | 국내 기준 재설계 | 일본 법률 앱; 국내 기준을 따로 설계 |
| 068 | [사업 내용 산업 분류](https://www.allganize.ai/ja/app-market/ja-app-markets/068) | 추출·비교·검토 | 추후 검토 | 국내 분류체계 기반 후보 제안으로 전환 |
| 041 | [인사평가 피드백 문안](https://www.allganize.ai/ja/app-market/ja-app-markets/041) | 텍스트·입력 폼 | 추후 검토 | 확인된 평가 내용의 표현 보조만 검토 |
| 022 | [업무 진행 조언](https://www.allganize.ai/ja/app-market/ja-app-markets/022) | 텍스트·입력 폼 | 추후 검토 | 매뉴얼 기반 처리 절차 안내 |
| 80 | [기획서 개요 작성](https://www.allganize.ai/ja/app-market/ja-app-markets/80) | 텍스트·입력 폼 | 추후 검토 | 사업기획 목차·필요자료 초안 |
| 086 | [세미나 기획·모집 지원](https://www.allganize.ai/ja/app-market/ja-app-markets/086) | 텍스트·입력 폼 | 추후 검토 | 기관 행사 개요·제목·안내문 초안 |
| 026 | [회의 용어 검색](https://www.allganize.ai/ja/app-market/ja-app-markets/026) | 문서·근거 검색 | 추후 검토 | 기관 용어집·공개 자료 확인 |
| 020 | [회의 안건 작성](https://www.allganize.ai/ja/app-market/ja-app-markets/020) | 텍스트·입력 폼 | SaaS 우선 후보 | 이전 회의의 미결 안건을 다음 안건으로 |
| 058 | [보도자료 제목 생성](https://www.allganize.ai/ja/app-market/ja-app-markets/058) | 텍스트·입력 폼 | 추후 검토 | 확정 내용에서 제목 후보 생성 |
| 012 | [홍보 문구 작성](https://www.allganize.ai/ja/app-market/ja-app-markets/012) | 텍스트·입력 폼 | 추후 검토 | 기관 사업 안내 문구 초안 |
| 105 | [고객별 영업계획](https://www.allganize.ai/ja/app-market/ja-app-markets/105) | 텍스트·입력 폼 | 추후 검토 | 협력기관 현황·협업계획으로 전환 |
| 048 | [광고 문구 작성](https://www.allganize.ai/ja/app-market/ja-app-markets/048) | 텍스트·입력 폼 | 추후 검토 | 시민 대상 안내 제목 후보 |
| 082 | [문서 양식 구성](https://www.allganize.ai/ja/app-market/ja-app-markets/082) | 멀티모달·파일 구성 | SaaS 우선 후보 | 기관 승인 양식의 항목 설계 보조 |
| 107 | [페르소나 작성](https://www.allganize.ai/ja/app-market/ja-app-markets/107) | 텍스트·입력 폼 | 추후 검토 | 사업 대상자 유형의 가설 정리 |
| 074 | [코드 수정 지원](https://www.allganize.ai/ja/app-market/ja-app-markets/074) | 텍스트·입력 폼 | 추후 검토 | 전산 담당자 보조; 일반 직원 초기 범위 제외 |
| 081 | [구내식당 메뉴 제안](https://www.allganize.ai/ja/app-market/ja-app-markets/081) | 텍스트·입력 폼 | 초기 우선순위 낮음 | 핵심 업무 연관 낮음; 초기 제외 |
| 035 | [파이브 포스 분석](https://www.allganize.ai/ja/app-market/ja-app-markets/035) | 텍스트·입력 폼 | 추후 검토 | 산업 환경 조사 참고 |
| 045 | [뉴스레터 분석](https://www.allganize.ai/ja/app-market/ja-app-markets/045) | 다단계 조사 | 추후 검토 | 기관 소식지 반응·개선안 분석 |
| 064 | [계정과목 분류 지원](https://www.allganize.ai/ja/app-market/ja-app-markets/064) | 추출·비교·검토 | 추후 검토 | 회계 기준에 따른 후보 제시; 확정은 담당자 |
| 002 | [인지세 점검](https://www.allganize.ai/ja/app-market/ja-app-markets/002) | 추출·비교·검토 | 국내 기준 재설계 | 일본 세법 앱; 국내 기준 검증 없이는 미제공 |
| 044 | [미팅 요청 편지](https://www.allganize.ai/ja/app-market/ja-app-markets/044) | 텍스트·입력 폼 | 추후 검토 | 기관 간 협조·면담 요청 초안 |
| 075 | [리뷰 답변 생성](https://www.allganize.ai/ja/app-market/ja-app-markets/075) | 텍스트·입력 폼 | 추후 검토 | 기관 서비스 이용 의견 회신 초안 |
| 076 | [MECE 기획 검토](https://www.allganize.ai/ja/app-market/ja-app-markets/076) | 텍스트·입력 폼 | 추후 검토 | 사업계획 검토 항목 누락 점검 |
| 078 | [상품 이미지 홍보 문구](https://www.allganize.ai/ja/app-market/ja-app-markets/078) | 멀티모달·파일 구성 | 추후 검토 | 행사·시설 안내문 초안 후보 |
| 046 | [FAQ 검색 후 회신 작성](https://www.allganize.ai/ja/app-market/ja-app-markets/046) | 문서·근거 검색 | SaaS 우선 후보 | 기관 근거 검색과 민원 회신 초안 연결 |
| 062 | [문서 기반 질의응답](https://www.allganize.ai/ja/app-market/ja-app-markets/062) | 문서·근거 검색 | SaaS 우선 후보 | ReadLayer 기반 규정·매뉴얼 확인 |
| 087 | [일반 생성형 대화](https://www.allganize.ai/ja/app-market/ja-app-markets/087) | 텍스트·입력 폼 | 추후 검토 | 가벼운 질문과 작성의 공통 입구 |
| 093 | [챗봇 이용 데이터 분석](https://www.allganize.ai/ja/app-market/ja-app-markets/093) | 표 계산·대사 | 추후 검토 | 비서 미응답·반복 문의 개선 |
| 003 | [계약 조항 추출·비교](https://www.allganize.ai/ja/app-market/ja-app-markets/003) | 추출·비교·검토 | SaaS 우선 후보 | 계약 금액·기간·조건과 표준안 차이 대조 |
| 042 | [재교육 학습계획](https://www.allganize.ai/ja/app-market/ja-app-markets/042) | 텍스트·입력 폼 | 추후 검토 | 직무교육 계획 초안 |
| 084 | [정관 분석](https://www.allganize.ai/ja/app-market/ja-app-markets/084) | 추출·비교·검토 | 추후 검토 | 기관 정관의 권한·절차·요건 추출 |
| 014 | [불만 응대 문구](https://www.allganize.ai/ja/app-market/ja-app-markets/014) | 텍스트·입력 폼 | 추후 검토 | 확인 사실과 기관 지침에 맞는 회신 |
| 097 | [심리적 안전성 점검](https://www.allganize.ai/ja/app-market/ja-app-markets/097) | 추출·비교·검토 | 추후 검토 | 인사 판단 자동화는 제외; 검토 참고만 |
| 099 | [아이디어 대화](https://www.allganize.ai/ja/app-market/ja-app-markets/099) | 텍스트·입력 폼 | 추후 검토 | 기획 초안 검토와 질문 정리 |
| 053 | [채용 면접 질문](https://www.allganize.ai/ja/app-market/ja-app-markets/053) | 텍스트·입력 폼 | 추후 검토 | 공통 직무역량 질문 초안 |
| 091 | [페르미 추정](https://www.allganize.ai/ja/app-market/ja-app-markets/091) | 텍스트·입력 폼 | 추후 검토 | 가정 기반 기획 참고; 확정 실적으로 사용 금지 |
| 031 | [마케팅 계획](https://www.allganize.ai/ja/app-market/ja-app-markets/031) | 텍스트·입력 폼 | 추후 검토 | 공공사업 홍보계획 초안으로 전환 |
| 040 | [문법 점검](https://www.allganize.ai/ja/app-market/ja-app-markets/040) | 텍스트·입력 폼 | SaaS 우선 후보 | 공문·안내문 표현 교정 |
| 090 | [문장 교정](https://www.allganize.ai/ja/app-market/ja-app-markets/090) | 텍스트·입력 폼 | SaaS 우선 후보 | 기관명·날짜·용어 일관성 검토 |
| 083 | [표현 변환](https://www.allganize.ai/ja/app-market/ja-app-markets/083) | 텍스트·입력 폼 | SaaS 우선 후보 | 개조식·공문체·시민 안내체 전환 |
| 024 | [메일 문구 점검](https://www.allganize.ai/ja/app-market/ja-app-markets/024) | 텍스트·입력 폼 | SaaS 우선 후보 | 수신 대상에 맞는 표현 검토 |
| 038 | [신입 환영 문구](https://www.allganize.ai/ja/app-market/ja-app-markets/038) | 텍스트·입력 폼 | 추후 검토 | 신규 직원 안내·온보딩 자료 |
| 030 | [신사업 아이디어](https://www.allganize.ai/ja/app-market/ja-app-markets/030) | 텍스트·입력 폼 | 추후 검토 | 기관 목적과 근거 자료에 맞는 사업 후보 |
| 066 | [표시광고법 점검](https://www.allganize.ai/ja/app-market/ja-app-markets/066) | 추출·비교·검토 | 국내 기준 재설계 | 일본 법률 앱; 국내 법령으로 별도 평가 |
| 077 | [주주총회 예상 질문](https://www.allganize.ai/ja/app-market/ja-app-markets/077) | 텍스트·입력 폼 | 추후 검토 | 이사회·의회·평가 예상 질의 초안으로 전환 |
| 071 | [채용 제안 메일](https://www.allganize.ai/ja/app-market/ja-app-markets/071) | 텍스트·입력 폼 | 추후 검토 | 채용 안내 문안 보조 |
| 088 | [캐릭터 설정](https://www.allganize.ai/ja/app-market/ja-app-markets/088) | 텍스트·입력 폼 | 초기 우선순위 낮음 | 기관 홍보 아이디어 참고; 후순위 |
| 070 | [대화 시작 아이디어](https://www.allganize.ai/ja/app-market/ja-app-markets/070) | 텍스트·입력 폼 | 초기 우선순위 낮음 | 핵심 업무 연관 낮음; 후순위 |
| 094 | [채용공고 표현 점검](https://www.allganize.ai/ja/app-market/ja-app-markets/094) | 텍스트·입력 폼 | SaaS 우선 후보 | 직무와 무관한 표현·누락 항목 검토 |
| 009 | [채용공고 생성](https://www.allganize.ai/ja/app-market/ja-app-markets/009) | 텍스트·입력 폼 | SaaS 우선 후보 | 확정 채용 조건에서 공고 초안 |
| 008 | [채용조건·이력 대조](https://www.allganize.ai/ja/app-market/ja-app-markets/008) | 추출·비교·검토 | 추후 검토 | 채용 자격 증빙 대조 보조; 자동 선발 제외 |
| 029 | [교육 프로그램 제안](https://www.allganize.ai/ja/app-market/ja-app-markets/029) | 텍스트·입력 폼 | 추후 검토 | 기관 직무교육 구성 초안 |
| 109 | [사내 자료 Deep Research](https://www.allganize.ai/ja/app-market/ja-app-markets/109) | 다단계 조사 | 추후 검토 | 내부 근거와 공개 자료로 정책·사업 조사 |
| 047 | [조직 문제 해결 제안](https://www.allganize.ai/ja/app-market/ja-app-markets/047) | 텍스트·입력 폼 | 추후 검토 | 기관 현안의 대안·확인사항 정리 |
| 006 | [기안서 작성](https://www.allganize.ai/ja/app-market/ja-app-markets/006) | 텍스트·입력 폼 | SaaS 우선 후보 | 기관 양식에 맞춘 기안 초안과 파일 |
| 085 | [업무 관리표 작성](https://www.allganize.ai/ja/app-market/ja-app-markets/085) | 추출·비교·검토 | SaaS 우선 후보 | 요청사항·담당 확인·기한 관리표 |
| 073 | [설문 결과 분석](https://www.allganize.ai/ja/app-market/ja-app-markets/073) | 표 계산·대사 | SaaS 우선 후보 | 만족도 계산·의견 분류·개선안 |
| 007 | [번역](https://www.allganize.ai/ja/app-market/ja-app-markets/007) | 텍스트·입력 폼 | SaaS 우선 후보 | 기관 용어집·원문 대조가 있는 번역 |
| 050 | [약기법 점검](https://www.allganize.ai/ja/app-market/ja-app-markets/050) | 추출·비교·검토 | 국내 기준 재설계 | 일본 특수 규제 앱; 초기 범위 제외 |
| 072 | [스프레드시트 오류 해결](https://www.allganize.ai/ja/app-market/ja-app-markets/072) | 텍스트·입력 폼 | 추후 검토 | 취합 파일 수식·데이터 오류 안내 |
| 065 | [판매 제안 지원](https://www.allganize.ai/ja/app-market/ja-app-markets/065) | 텍스트·입력 폼 | 추후 검토 | 유관기관 수요 분석으로 전환 |
| 027 | [다수 일간·주간보고 요약](https://www.allganize.ai/ja/app-market/ja-app-markets/027) | 추출·비교·검토 | SaaS 우선 후보 | 부서 주간보고를 항목별 종합 |
| 061 | [문서 요약](https://www.allganize.ai/ja/app-market/ja-app-markets/061) | 추출·비교·검토 | SaaS 우선 후보 | 공문·보고서의 핵심과 요청사항 정리 |
| 032 | [해설형 블로그 초안](https://www.allganize.ai/ja/app-market/ja-app-markets/032) | 텍스트·입력 폼 | 추후 검토 | 정책 설명·기관 소식 초안 |
| 021 | [뉴스 요약·번역](https://www.allganize.ai/ja/app-market/ja-app-markets/021) | 다단계 조사 | 추후 검토 | 기관 관심 정책·사업 동향 요약 |
| 023 | [설문 질문 생성](https://www.allganize.ai/ja/app-market/ja-app-markets/023) | 텍스트·입력 폼 | SaaS 우선 후보 | 사업 평가·수요조사 설문 초안 |
| 057 | [청구·입금 대조](https://www.allganize.ai/ja/app-market/ja-app-markets/057) | 표 계산·대사 | SaaS 우선 후보 | 청구·수납·증빙 불일치 검토 |
| 051 | [강연 제목 생성](https://www.allganize.ai/ja/app-market/ja-app-markets/051) | 텍스트·입력 폼 | 추후 검토 | 교육·행사 제목 후보 |
| 001 | [회의록 작성](https://www.allganize.ai/ja/app-market/ja-app-markets/001) | 추출·비교·검토 | SaaS 우선 후보 | 결정·미결·후속조치 정리 |
| 015 | [발표자료 기획](https://www.allganize.ai/ja/app-market/ja-app-markets/015) | 텍스트·입력 폼 | SaaS 우선 후보 | 보고 발표 제목·목차 구성 |

## 대표 앱 20개의 구현 완료 기준

| 참고 ID | 앱 | 입력·처리·출력에서 확인할 것 |
|---|---|---|
| 062 | 기관 규정 Q&A | 허용된 최신 문서 범위, 근거 쪽/절, 답 없음과 서비스 장애를 구분 |
| 004 | FAQ 답변 | 승인된 질문·답변을 우선 사용하고 정책 판·수정 이력을 추적 |
| 046 | FAQ 기반 회신 | 질문별 응답 누락과 근거를 검사, 발송 없이 초안 제공부터 |
| 106 | 문서→FAQ | 질문·답변·근거의 구조화 추출, CSV 인코딩·수식 주입 방지, 검토 후 등록 |
| 095 | FAQ 정비 | 중복·유사·저사용을 분리, 통계 기간과 근거 표시, 자동 삭제하지 않음 |
| 003 | 계약 조항 비교 | 금액·기간·대상 항목의 원문 위치, 대응 불가·누락·상충을 표시 |
| 056 | NDA 조건 검토 | 비밀정보·대상·기간·예외를 구조화, 국내 검토 기준과 출처 별도 관리 |
| 103 | RFP 작성 | 목적·범위·일정·평가·제출 조건 입력, 누락 질문, 기관 양식 파일 검사 |
| 006 | 기안 | 직원 확정 칸과 생성 칸 분리, 양식 판 고정, 실제 파일 열기·수정 검증 |
| 001 | 회의록 | 결정·제안·조건·미결 구분, 원문 없는 담당·기한 비우기, 후속조치표 연결 |
| 027 | 다수 보고 종합 | 파일별 항목 대응·누락·중복 확인, 종합 문장에 원자료 근거 |
| 061 | 문서 요약 | 범위·분량 설정, 문서 밖 사실 생성 금지, 중요한 조건·예외 보존 |
| 085 | 업무 관리표 | 제안 작업과 원문 요구사항 구분, 확정 담당·기한과 제안값 구분 |
| 057 | 청구·입금 대조 | 일치키·부분 입금·취소·중복·과부족, 프로그램 계산과 원본 대응 |
| 073 | 설문 분석 | 질문 유형·모집단·무응답·다중선택 분모 명시, 평균·비율 프로그램 계산 |
| 092 | 문서 적합성 | 읽기 실패·표 잘림·OCR 불확실성 등 관찰 가능한 항목과 추정 평가 분리 |
| 090 | 문장 교정 | 원문·수정문 대조, 기관 용어집, 사실·금액·날짜 무단 변경 금지 |
| 007 | 번역 | 목표 언어·문체·용어집, 고유명·수치 보존, 원본 서식 지원 범위 명시 |
| 109 | 내부+웹 조사 | 자료/웹 허용 범위·기준일·계획·재탐색 예산·출처·취소·리포트 |
| 082 | 양식 구성 | 새 항목 구성과 기존 서식 채우기를 구분, 실제 DOCX/HWPX 생성 엔진별 검사 |

## 재생성·검사

`node scripts/build-alli-benchmark-map.mjs`는 원본 100개 ID의 중복·빠짐·알 수 없는 분류를 검사한 뒤 이 문서와 JSON을 다시 쓴다. 연구 데이터만 갱신하며 런타임 앱 카탈로그·DB·모델·외부 서비스는 건드리지 않는다.
