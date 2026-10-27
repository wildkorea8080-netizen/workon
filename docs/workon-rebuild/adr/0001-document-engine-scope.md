# ADR 0001 — 문서 엔진 지원 범위 (D1·D2만, D3 보류)

- 날짜: 2026-10-27 · 상태: 채택 · 관련: 04_DOCUMENT_ENGINE.md 5절

## 결정

1. 업무 작업의 HWPX 생성은 기존 `src/lib/doc-fill`(readTemplate·fillTemplate)을 **감싸서** 쓴다(`src/lib/work/documents/generate-file.ts`). XML을 새로 짜 맞추지 않는다.
2. 지원 수준은 **D1(기존 자리·문단·표 칸 글)·D2(칸별 직접 수정·잠금·판 복구·칸 단위 AI 수정)**. D3(반복 표 행 추가·이미지·차트 삽입)는 검증된 양식이 없어 **구현하지 않고 타입에도 넣지 않았다**(필드는 text·paragraph만). 양식 판의 `supported`에 `repeatRows:false, imageInsert:false`로 남긴다.
3. 파일은 매번 **원본 양식 + 그 판의 필드 값**으로 새로 만든다. 앞서 만든 파일에 덧대지 않는다(누적 손상 방지).
4. 양식을 그대로 채울 수 없으면(옛 HWP·자리 없음·표시 없는 DOCX) 업무 작업은 `TEMPLATE_UNSUPPORTED`로 멈춘다. 기존 대화 기능의 '표준 보고서로 대신 만들기'는 업무 작업에서 자동으로 하지 않는다 — 직원이 대체를 고르는 화면(기록 포함)은 후속(P6).
5. 필드 id는 그 양식 판(sha256) 안의 자리 번호(s1…)다. 양식 파일이 판과 다르면(해시 불일치) 만들지 않는다(`TEMPLATE_MISSING`).

## 계약 초안과 다른 점

- `contracts/domain.ts`의 `paragraph` 값은 `string[]`이지만 실제로는 글 하나(줄바꿈으로 문단)다 — doc-fill이 그 꼴을 받는다.
- table·image 필드 타입은 넣지 않았다(D3 보류).

## 검증

- 단위: `tests/work-core.test.ts`(실제 표준 양식으로 HWPX 생성·패키지 검사), `tests/work-flow.test.ts`(판·파일 흐름).
- 실제 한글: `npm run work:template-verify` — 한글 2018(10.0.0.11808) COM 자동화로 열기·넣은 글 확인·편집·다시 저장·다시 열기·PDF. 세 표준 양식 모두 통과(2026-10-27). **사람의 시각 검토는 아직 없음.**
