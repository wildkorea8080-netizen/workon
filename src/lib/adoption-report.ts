// src/lib/adoption-report.ts
// 월별 도입 현황 보고서(0056) — 순수 규칙. 화면과 라우트가 함께 쓴다(서버 모듈을 가져오지 않는다).
//
// 기록된 사실만 센다(채택·완료·재작업). '절약한 시간'·'생산성 n%' 같은 추정치는 만들지 않는다 —
// 실제 작업 시간을 재는 장치가 없는데 숫자를 만들면 보고서가 근거 없는 주장이 된다.
// (2026-11-10, 0083) 직원이 답변 평가에서 스스로 고른 '줄인 시간'(0082)의 합은 싣는다 — **자기 신고**라고 이름과 읽는 법에 밝힌다(추정치를 만들지 않는다).

export interface AdoptionStats {
  registered_users: number;
  active_users: number;
  regular_users: number;
  chat_messages: number;
  conversations: number;
  app_runs: number;
  apps_used: number;
  documents_generated: number;
  cost_krw: number;
  tasks_created: number;
  tasks_completed: number;
  artifacts: number;
  edit_versions: number;
  revision_requests: number;
  completed_versions: number;
  /** (0066) 그 달에 완료한 작업의 만들기~검토 완료 시간 중앙값(시간). 완료 작업이 없거나 DB에 0066이 없으면 null('—') */
  completed_median_hours: number | null;
  /** (0083) 직원이 고른 '줄인 시간'의 합(분)과 고른 답 수 — 자기 신고. DB에 0083이 없으면 null('—') */
  saved_minutes_reported: number | null;
  saved_reports: number | null;
}

const KEYS: (keyof AdoptionStats)[] = [
  'registered_users', 'active_users', 'regular_users', 'chat_messages', 'conversations', 'app_runs', 'apps_used',
  'documents_generated', 'cost_krw', 'tasks_created', 'tasks_completed', 'artifacts', 'edit_versions', 'revision_requests', 'completed_versions',
];

/** DB 함수 결과를 믿지 않고 숫자로 — 없거나 이상한 값은 0 */
export function readAdoptionStats(raw: unknown): AdoptionStats {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = {} as AdoptionStats;
  for (const k of KEYS) {
    const n = Number(o[k]);
    out[k] = Number.isFinite(n) && n >= 0 ? n : 0;
  }
  // 없으면 0이 아니라 모름 — 0시간으로 보이면 틀린 숫자다
  const hours = o.completed_median_hours;
  const h = hours === null || hours === undefined || hours === '' ? NaN : Number(hours);
  out.completed_median_hours = Number.isFinite(h) && h >= 0 ? h : null;
  for (const k of ['saved_minutes_reported', 'saved_reports'] as const) {
    const v = o[k] === null || o[k] === undefined || o[k] === '' ? NaN : Number(o[k]);
    out[k] = Number.isFinite(v) && v >= 0 ? v : null;
  }
  return out;
}

/** 'YYYY-MM'(2000~2100년) 또는 null */
export function parseMonth(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  return year >= 2000 && year <= 2100 ? raw : null;
}

/** 한국 시간 그 달의 시작·다음 달 시작(UTC ISO) */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1) - 9 * 3600e3).toISOString();
  const to = new Date(Date.UTC(y, m, 1) - 9 * 3600e3).toISOString();
  return { from, to };
}

export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** 한국 시간 이번 달 'YYYY-MM' */
export function currentMonth(nowMs: number): string {
  return new Date(nowMs + 9 * 3600e3).toISOString().slice(0, 7);
}

/** 고를 수 있는 달 — 이번 달부터 거꾸로 n개 */
export function recentMonths(nowMs: number, count = 12): string[] {
  const out = [currentMonth(nowMs)];
  while (out.length < count) out.push(previousMonth(out[out.length - 1]));
  return out;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

export type AdoptionUnit = 'people' | 'count' | 'krw' | 'percent' | 'average' | 'hours';

export interface AdoptionRow {
  key: string;
  group: '채택' | '사용' | '업무 작업' | '자기 신고' | '비용';
  label: string;
  unit: AdoptionUnit;
  value: number | null;
  previous: number | null;
  /** 읽는 법 — 숫자가 무엇을 세는지, 무엇은 아닌지 */
  note: string;
}

/** 보고서 줄 — 이번 달·전월. 비율은 분모가 0이면 null('—') */
export function adoptionRows(current: AdoptionStats, previous: AdoptionStats): AdoptionRow[] {
  const both = (f: (s: AdoptionStats) => number | null) => ({ value: f(current), previous: f(previous) });
  return [
    { key: 'registered_users', group: '채택', label: '등록 직원', unit: 'people', ...both((s) => s.registered_users), note: '지금 활성인 계정(탈퇴·슈퍼관리자 제외). 전월 칸도 지금 기준입니다.' },
    { key: 'active_users', group: '채택', label: 'AI를 쓴 직원', unit: 'people', ...both((s) => s.active_users), note: '그 달에 한 번이라도 AI 사용 기록이 있는 직원.' },
    { key: 'adoption_rate', group: '채택', label: '쓴 직원 비율', unit: 'percent', ...both((s) => ratio(s.active_users, s.registered_users)), note: 'AI를 쓴 직원 ÷ 등록 직원.' },
    { key: 'regular_users', group: '채택', label: '자주 쓴 직원(4일 이상)', unit: 'people', ...both((s) => s.regular_users), note: '그 달에 4일 이상(한국 날짜) 쓴 직원 — 한 번 써 본 사람과 업무에 쓰는 사람을 가릅니다.' },
    { key: 'chat_messages', group: '사용', label: 'AI 대화(질문 수)', unit: 'count', ...both((s) => s.chat_messages), note: '보낸 질문 수(입력형 앱 실행 포함).' },
    { key: 'conversations', group: '사용', label: '새 대화', unit: 'count', ...both((s) => s.conversations), note: '그 달에 시작한 대화.' },
    { key: 'app_runs', group: '사용', label: '입력형 앱 실행', unit: 'count', ...both((s) => s.app_runs), note: '입력형 앱으로 시작한 대화(시험 판 실행 포함).' },
    { key: 'apps_used', group: '사용', label: '쓰인 입력형 앱', unit: 'count', ...both((s) => s.apps_used), note: '한 번 이상 실행된 앱 수.' },
    { key: 'documents_generated', group: '사용', label: '대화에서 만든 파일', unit: 'count', ...both((s) => s.documents_generated), note: '양식 채우기(한글·Word)와 표 합치기(엑셀).' },
    { key: 'tasks_created', group: '업무 작업', label: '새 업무 작업', unit: 'count', ...both((s) => s.tasks_created), note: '업무 비서로 시작한 작업.' },
    { key: 'tasks_completed', group: '업무 작업', label: '검토 완료한 작업', unit: 'count', ...both((s) => s.tasks_completed), note: '그 달에 검토 완료로 승인된 작업(뒤에 다시 연 작업은 빠집니다).' },
    { key: 'artifacts', group: '업무 작업', label: '만든 결과 파일', unit: 'count', ...both((s) => s.artifacts), note: '업무 작업이 만든 한글·엑셀 파일.' },
    { key: 'edit_versions', group: '업무 작업', label: '사람이 고친 판', unit: 'count', ...both((s) => s.edit_versions), note: '직접 수정과 AI 수정 적용으로 만든 새 판 — 재작업의 크기입니다.' },
    { key: 'revision_requests', group: '업무 작업', label: 'AI 수정 요청', unit: 'count', ...both((s) => s.revision_requests), note: '작업실에서 AI에게 고쳐 달라고 한 횟수.' },
    { key: 'versions_per_completed', group: '업무 작업', label: '완료 작업당 판 수', unit: 'average', ...both((s) => ratio(s.completed_versions, s.tasks_completed)), note: '완료까지 만든 판의 평균(만들기 포함). 1에 가까울수록 처음 만든 그대로 완료했습니다.' },
    { key: 'completed_median_hours', group: '업무 작업', label: '완료까지 걸린 시간(중앙값)', unit: 'hours', ...both((s) => s.completed_median_hours), note: '그 달에 검토 완료한 작업의 만들기~검토 완료 사이 시간의 중앙값. 사람이 일한 시간이 아니라 기다린 시간도 들어 있습니다(추정치 아님).' },
    { key: 'saved_hours_reported', group: '자기 신고', label: '직원이 고른 줄인 시간', unit: 'hours', ...both((s) => (s.saved_minutes_reported === null ? null : s.saved_minutes_reported / 60)), note: "'도움됨'을 누른 직원이 '이 답으로 줄인 시간'(10분~반나절)을 스스로 고른 값의 합. 측정하거나 추정한 시간이 아닙니다." },
    { key: 'saved_reports', group: '자기 신고', label: '줄인 시간을 고른 답', unit: 'count', ...both((s) => s.saved_reports), note: '줄인 시간을 고른 답변 수(평가를 바꾼 때 기준).' },
    { key: 'cost_krw', group: '비용', label: 'AI 사용 금액', unit: 'krw', ...both((s) => s.cost_krw), note: '기록 시점 단가로 확정한 금액(옛 기록 중 금액 없는 것은 빠짐).' },
    { key: 'cost_per_active', group: '비용', label: '쓴 직원 1인당 금액', unit: 'krw', ...both((s) => ratio(s.cost_krw, s.active_users)), note: 'AI 사용 금액 ÷ AI를 쓴 직원.' },
  ];
}

/** 화면·CSV 표기 */
export function formatAdoptionValue(unit: AdoptionUnit, v: number | null): string {
  if (v === null) return '—';
  if (unit === 'percent') return `${(v * 100).toFixed(1)}%`;
  if (unit === 'average') return v.toFixed(2);
  if (unit === 'hours') return `${v.toFixed(1)}시간`;
  if (unit === 'krw') return `${Math.round(v).toLocaleString('ko-KR')}원`;
  return `${Math.round(v).toLocaleString('ko-KR')}${unit === 'people' ? '명' : '건'}`;
}

/**
 * 전월 대비 — 비율은 %p, 그 밖은 증감. 줄어든 것은 공공기관 표기대로 `△`(늘어난 것은 숫자만). 비교할 수 없으면 '—'.
 * `+`·`-`로 시작하지 않아 엑셀이 CSV 칸을 수식으로 읽지 않는다
 */
export function formatAdoptionChange(row: AdoptionRow): string {
  if (row.value === null || row.previous === null) return '—';
  const d = row.value - row.previous;
  const sign = (x: number) => (x < 0 ? '△' : '');
  if (row.unit === 'percent') { const p = Math.round(d * 1000) / 10; return p === 0 ? '0%p' : `${sign(p)}${Math.abs(p).toFixed(1)}%p`; }
  if (row.unit === 'average') { const a = Math.round(d * 100) / 100; return a === 0 ? '0' : `${sign(a)}${Math.abs(a).toFixed(2)}`; }
  // 시간은 크기로 반올림한다 — 줄어든 값(-6.25)도 화면 숫자의 차(26.3 → 20.0)와 맞게 △6.3
  if (row.unit === 'hours') { const h = (Math.sign(d) * Math.round(Math.abs(d) * 10)) / 10; return h === 0 ? '0시간' : `${sign(h)}${Math.abs(h).toFixed(1)}시간`; }
  const n = Math.round(d);
  if (n === 0) return '0';
  return `${sign(n)}${Math.abs(n).toLocaleString('ko-KR')}${row.unit === 'krw' ? '원' : ''}`;
}

/** CSV(엑셀에서 열리게 BOM) — 기관 보고에 그대로 붙인다 */
export function adoptionCsv(month: string, previous: string, rows: AdoptionRow[]): string {
  const cell = (s: string) => {
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const head = ['구분', '지표', `${month}`, `${previous}(전월)`, '전월 대비', '읽는 법'];
  const lines = rows.map((r) => [r.group, r.label, formatAdoptionValue(r.unit, r.value), formatAdoptionValue(r.unit, r.previous), formatAdoptionChange(r), r.note].map(cell).join(','));
  return `﻿${[head.join(','), ...lines].join('\n')}`;
}
