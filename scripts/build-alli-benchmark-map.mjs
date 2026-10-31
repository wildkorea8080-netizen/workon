/** Research reference only. Does not install apps, call a model, or change the runtime catalog. */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../docs/benchmarks/allganize/', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('app-catalog.json', root), 'utf8'));
const groups = [
  {
    key: 'text-form', label: '텍스트·입력 폼',
    ids: '039 013 055 052 017 036 043 011 028 034 005 041 022 80 086 020 058 012 105 048 107 074 081 035 044 075 076 087 042 014 099 053 091 031 040 090 083 024 038 030 077 071 088 070 094 009 029 047 006 007 072 065 032 023 051 015 049',
    reuse: ['agents', 'assistant', 'file_read', 'document'],
    missing: ['앱별 입력 스키마·검증', '용어·문체·출력 계약', '문서 출력이 필요하면 양식 판과 작업 연결'],
    acceptance: '입력 사실을 보존하고 모르는 값은 비운다. 코드·SQL·수식 제안은 실행 결과와 구분한다.',
  },
  {
    key: 'rag-evidence', label: '문서·근거 검색',
    ids: '004 098 019 018 026 046 062',
    reuse: ['doc_search', 'public_data', 'regulations', 'qa'],
    missing: ['앱별 지식/FAQ 범위', '최신 판·근거 위치', '답 없음·접근 거부·자료 장애 구분'],
    acceptance: '허용된 자료에서만 검색하고 근거를 표시한다. 자동 회신 발송은 별도 연동·승인 없이는 제공하지 않는다.',
  },
  {
    key: 'extract-review', label: '추출·비교·검토',
    ids: '059 079 092 033 060 095 106 056 102 089 068 064 002 003 084 097 066 008 050 085 027 061 103 001',
    reuse: ['file_read', 'doc_search', 'items', 'qa', 'regulations', 'work/review'],
    missing: ['항목별 추출 JSON 계약', '원문 대응·빠진 항목·변경 표', '검토 결정과 결과 파일 연결'],
    acceptance: '추출값과 근거를 대응시키고 원문에 없는 담당·기한·조항을 채우지 않는다. 적합성/인사/법률 판단은 보조 범위를 명시한다.',
  },
  {
    key: 'table-deterministic', label: '표 계산·대사',
    ids: '093 073 057',
    reuse: ['table-engine', 'table_merge', 'collection', 'settlement', 'xlsx-export'],
    missing: ['자료 열 대응', '결측·중복·단위·모집단 규칙', '이용 데이터·설문·청구/입금별 계산 규약'],
    acceptance: '집계·비율·대사는 프로그램이 수행하고 원본 대응·제외 이유·계산 근거를 남긴다.',
  },
  {
    key: 'research-multistep', label: '다단계 조사',
    ids: '025 108 045 109 021',
    reuse: ['doc_search', 'public_data', 'regulations', 'llm', 'work/runs'],
    missing: ['일반 웹 검색·본문 읽기', '조사 범위·계획·재탐색', '출처/기준일·비용·횟수 상한'],
    acceptance: '자료 범위와 기준일을 고정하고 출처를 남긴다. 검색 실패를 조사 완료로 처리하지 않는다.',
  },
  {
    key: 'multimodal-file', label: '멀티모달·파일 구성',
    ids: '054 096 078 082',
    reuse: ['image', 'file_read', 'doc-fill', 'work/documents'],
    missing: ['이미지 입력 정확도 평가', '출력 형식별 전용 생성·검사', 'PPTX는 신규 엔진·양식 설계'],
    acceptance: '이미지 판독·VBA 생성·DOCX 양식 구성·실제 PPTX 파일 생성을 서로 다른 기능으로 표시한다.',
  },
];
const core = new Set('006 007 040 090 083 024 020 005 015 023 009 061 027 001 062 004 046 106 085 003 056 079 092 103 057 073 043 094 082'.split(' '));
const redesign = new Set('089 002 066 050'.split(' '));
const lowRelevance = new Set('039 081 088 070 055'.split(' '));
const priorityLabels = { core: 'SaaS 우선 후보', later: '추후 검토', 'local-law-redesign': '국내 기준 재설계', 'low-relevance': '초기 우선순위 낮음' };
const byId = new Map();
for (const group of groups) {
  for (const id of group.ids.split(' ')) {
    if (byId.has(id)) throw new Error(`Duplicate family mapping: ${id}`);
    byId.set(id, group);
  }
}
const ids = catalog.apps.map((app) => app.vendor_app_id);
if (new Set(ids).size !== ids.length || ids.length !== catalog.observed_app_count) throw new Error('Invalid source catalog count/identity');
if (ids.length !== byId.size || ids.some((id) => !byId.has(id))) throw new Error('Family map must cover the catalog exactly');
for (const selected of [core, redesign, lowRelevance]) for (const id of selected) if (!byId.has(id)) throw new Error(`Unknown priority id: ${id}`);

const apps = catalog.apps.map((app) => {
  const group = byId.get(app.vendor_app_id);
  const priority = redesign.has(app.vendor_app_id) ? 'local-law-redesign' : lowRelevance.has(app.vendor_app_id) ? 'low-relevance' : core.has(app.vendor_app_id) ? 'core' : 'later';
  return {
    reference_id: app.id,
    vendor_app_id: app.vendor_app_id,
    analyst_title_ko: app.analyst_title_ko,
    official_detail_url: app.official_detail_url,
    family: group.key,
    priority,
    reuse_candidates: group.reuse,
    missing_dependencies: group.missing,
    proposed_acceptance: group.acceptance,
    public_sector_adaptation: app.analyst_public_sector_adaptation,
    implementation_status: 'design-reference-not-installed',
    vendor_output_guarantee: 'Only formats explicitly summarized in APP_CATALOG.md are documented; family classification is not evidence of a vendor file format.',
  };
});
const familyCounts = Object.fromEntries(groups.map((group) => [group.key, apps.filter((app) => app.family === group.key).length]));
const priorityCounts = Object.fromEntries(Object.keys(priorityLabels).map((key) => [key, apps.filter((app) => app.priority === key).length]));
await writeFile(new URL('app-implementation-map.json', root), JSON.stringify({
  research_date_kst: catalog.research_date_kst,
  source: 'app-catalog.json',
  scope: 'Analyst implementation proposals for every public catalog record; no vendor runtime or WORKON installed-app availability claim.',
  app_count: apps.length, family_counts: familyCounts, priority_counts: priorityCounts,
  apps,
}, null, 2) + '\n');

const lines = [
  '# 공개 앱 100개 → WORKON 구현 대응표', '',
  '2026-10-28 · [원본 카탈로그](APP_CATALOG.md) · [구조화 데이터](app-implementation-map.json)', '',
  '**아래는 독자적인 구현 제안이다. 앱을 설치하거나 실행한 목록이 아니다.** 기존 엔진은 재사용 후보이며 해당 앱이 이미 완성됐다는 뜻은 아니다. 공급자의 출력 형식 확인은 원본 카탈로그의 상세 표를 따른다.', '',
  '100개 원본 항목을 정확히 한 번씩 대응했다. 별도 Coworker 템플릿 8개는 원본 카탈로그에 따로 기록되어 있고 여기의 100개에 합산하지 않는다.', '',
  '## 실행 기능별 분류', '', '| 기능 | 앱 수 | 재사용 후보 | 추가 구현 |', '|---|---:|---|---|',
  ...groups.map((g) => `| ${g.label} | ${familyCounts[g.key]} | ${g.reuse.join(' · ')} | ${g.missing.join(' · ')} |`), '',
  '## 우선순위', '', '| 구분 | 앱 수 |', '|---|---:|',
  ...Object.entries(priorityLabels).map(([key, label]) => `| ${label} | ${priorityCounts[key]} |`), '',
  '우선 후보는 평가·설계 대상을 뜻한다. 29개를 동시에 출시하겠다는 약속이 아니며, 실제 기관 사용 사례에서 대표 앱을 골라 순차 검증한다.', '',
  '## 전체 대응', '', '| 원본 ID | 참고 앱 | 공통 실행 기능 | 우선순위 | 공공기관 적용 제안 |', '|---|---|---|---|---|',
  ...apps.map((app) => `| ${app.vendor_app_id} | [${app.analyst_title_ko}](${app.official_detail_url}) | ${byId.get(app.vendor_app_id).label} | ${priorityLabels[app.priority]} | ${app.public_sector_adaptation.replaceAll('|', '/')} |`), '',
  '## 대표 앱 20개의 구현 완료 기준', '',
  '| 참고 ID | 앱 | 입력·처리·출력에서 확인할 것 |', '|---|---|---|',
  '| 062 | 기관 규정 Q&A | 허용된 최신 문서 범위, 근거 쪽/절, 답 없음과 서비스 장애를 구분 |',
  '| 004 | FAQ 답변 | 승인된 질문·답변을 우선 사용하고 정책 판·수정 이력을 추적 |',
  '| 046 | FAQ 기반 회신 | 질문별 응답 누락과 근거를 검사, 발송 없이 초안 제공부터 |',
  '| 106 | 문서→FAQ | 질문·답변·근거의 구조화 추출, CSV 인코딩·수식 주입 방지, 검토 후 등록 |',
  '| 095 | FAQ 정비 | 중복·유사·저사용을 분리, 통계 기간과 근거 표시, 자동 삭제하지 않음 |',
  '| 003 | 계약 조항 비교 | 금액·기간·대상 항목의 원문 위치, 대응 불가·누락·상충을 표시 |',
  '| 056 | NDA 조건 검토 | 비밀정보·대상·기간·예외를 구조화, 국내 검토 기준과 출처 별도 관리 |',
  '| 103 | RFP 작성 | 목적·범위·일정·평가·제출 조건 입력, 누락 질문, 기관 양식 파일 검사 |',
  '| 006 | 기안 | 직원 확정 칸과 생성 칸 분리, 양식 판 고정, 실제 파일 열기·수정 검증 |',
  '| 001 | 회의록 | 결정·제안·조건·미결 구분, 원문 없는 담당·기한 비우기, 후속조치표 연결 |',
  '| 027 | 다수 보고 종합 | 파일별 항목 대응·누락·중복 확인, 종합 문장에 원자료 근거 |',
  '| 061 | 문서 요약 | 범위·분량 설정, 문서 밖 사실 생성 금지, 중요한 조건·예외 보존 |',
  '| 085 | 업무 관리표 | 제안 작업과 원문 요구사항 구분, 확정 담당·기한과 제안값 구분 |',
  '| 057 | 청구·입금 대조 | 일치키·부분 입금·취소·중복·과부족, 프로그램 계산과 원본 대응 |',
  '| 073 | 설문 분석 | 질문 유형·모집단·무응답·다중선택 분모 명시, 평균·비율 프로그램 계산 |',
  '| 092 | 문서 적합성 | 읽기 실패·표 잘림·OCR 불확실성 등 관찰 가능한 항목과 추정 평가 분리 |',
  '| 090 | 문장 교정 | 원문·수정문 대조, 기관 용어집, 사실·금액·날짜 무단 변경 금지 |',
  '| 007 | 번역 | 목표 언어·문체·용어집, 고유명·수치 보존, 원본 서식 지원 범위 명시 |',
  '| 109 | 내부+웹 조사 | 자료/웹 허용 범위·기준일·계획·재탐색 예산·출처·취소·리포트 |',
  '| 082 | 양식 구성 | 새 항목 구성과 기존 서식 채우기를 구분, 실제 DOCX/HWPX 생성 엔진별 검사 |', '',
  '## 재생성·검사', '',
  '`node scripts/build-alli-benchmark-map.mjs`는 원본 100개 ID의 중복·빠짐·알 수 없는 분류를 검사한 뒤 이 문서와 JSON을 다시 쓴다. 연구 데이터만 갱신하며 런타임 앱 카탈로그·DB·모델·외부 서비스는 건드리지 않는다.', '',
];
await writeFile(new URL('APP_IMPLEMENTATION_MAP.md', root), lines.join('\n'));
console.log(JSON.stringify({ apps: apps.length, familyCounts, priorityCounts, output: fileURLToPath(root) }));
