// src/lib/department-adoption.ts
// 부서별 도입 현황(0065) — 순수 규칙. 화면과 라우트가 함께 쓴다(서버 모듈을 가져오지 않는다).
// 부서마다 자기 부서의 기록만 센다(하위 부서를 올려 더하지 않는다). 기록된 숫자만 — 추정치는 없다.

export interface DepartmentAdoption {
  departmentId: string;
  name: string;
  registered_users: number;
  active_users: number;
  regular_users: number;
  chat_messages: number;
  app_runs: number;
  documents_generated: number;
  tasks_completed: number;
  cost_krw: number;
  /** (0085) 직원이 답변 평가에서 고른 '줄인 시간'의 합(분) — 자기 신고, 측정·추정 아님. 0085 전이면 0 */
  saved_minutes: number;
}

type NumberKey = Exclude<keyof DepartmentAdoption, 'departmentId' | 'name'>;

/** 표·CSV의 열 — 화면과 CSV가 같은 표를 본다 */
export const DEPARTMENT_COLUMNS: { key: NumberKey; label: string; krw?: true }[] = [
  { key: 'registered_users', label: '등록 직원' },
  { key: 'active_users', label: '쓴 직원' },
  { key: 'regular_users', label: '4일 이상 쓴 직원' },
  { key: 'chat_messages', label: '질문' },
  { key: 'app_runs', label: '앱 실행' },
  { key: 'documents_generated', label: '만든 파일' },
  { key: 'tasks_completed', label: '업무 작업 완료' },
  { key: 'cost_krw', label: '사용 금액(원)', krw: true },
  { key: 'saved_minutes', label: '줄인 시간(분·자기 신고)' },
];

const NUMBER_KEYS = DEPARTMENT_COLUMNS.map((c) => c.key);

/** DB 함수 결과를 믿지 않고 꼴을 다시 만든다 — 배열이 아니면 빈 목록, 이상한 숫자는 0, 이름 없는 부서는 '(이름 없음)' */
export function readDepartmentAdoption(raw: unknown): DepartmentAdoption[] {
  if (!Array.isArray(raw)) return [];
  const out: DepartmentAdoption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.department_id !== 'string') continue;
    const row = { departmentId: o.department_id, name: typeof o.name === 'string' && o.name.trim() ? o.name : '(이름 없음)' } as DepartmentAdoption;
    for (const k of NUMBER_KEYS) {
      const n = Number(o[k]);
      row[k] = Number.isFinite(n) && n >= 0 ? (k === 'cost_krw' ? Math.round(n) : n) : 0;
    }
    out.push(row);
  }
  return out;
}

/** 합계 — 한 사람은 한 부서에만 들어 사람 수도 더하면 된다 */
export function departmentTotals(rows: DepartmentAdoption[]): Record<NumberKey, number> {
  const total = Object.fromEntries(NUMBER_KEYS.map((k) => [k, 0])) as Record<NumberKey, number>;
  for (const row of rows) for (const k of NUMBER_KEYS) total[k] += row[k];
  return total;
}

/** 기록이 하나도 없는 부서(등록 직원 외 모두 0)는 화면에서 접어 둘 수 있게 가른다 */
export function hasActivity(row: DepartmentAdoption): boolean {
  return NUMBER_KEYS.some((k) => k !== 'registered_users' && row[k] > 0);
}

function csvCell(s: string): string {
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV(엑셀에서 한글이 깨지지 않게 BOM) — 부서 이름은 수식 주입을 막는다. 끝 줄은 합계 */
export function departmentAdoptionCsv(month: string, rows: DepartmentAdoption[]): string {
  const head = ['부서', ...DEPARTMENT_COLUMNS.map((c) => c.label)];
  const lines = rows.map((r) => [r.name, ...DEPARTMENT_COLUMNS.map((c) => String(r[c.key]))].map(csvCell).join(','));
  const total = departmentTotals(rows);
  lines.push(['합계', ...DEPARTMENT_COLUMNS.map((c) => String(total[c.key]))].map(csvCell).join(','));
  return `﻿${month} 부서별 도입 현황\n${head.join(',')}\n${lines.join('\n')}`;
}
