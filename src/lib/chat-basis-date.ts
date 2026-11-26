// src/lib/chat-basis-date.ts
// 대화의 '적용 기준일'(2026-11-26) — 직원이 입력창에서 날짜를 고르면 문서 찾기가 그날 시행 중인 판으로 근거를 고른다.
// 아무것도 import하지 않는다(화면·서버 공용 잎 파일).
//
// - 오늘(KST) 뒤의 날이면 그날 시행될 판(시행일을 예약한 새 판)이 근거, 옛 판은 아니다(`editionDayFor` — 업무 규정 확인과 같은 규칙)
// - 오늘 전의 날이면 새 판 찾기는 오늘 그대로(내린 옛 판은 문서 보관소에 사본이 없다)이고, 그날 시행 중이던 **지난 판**의 원본을
//   다시 읽어 질문 낱말이 든 문단을 근거로 더한다(업무 규정 확인의 `past-editions.ts`와 같은 규칙)
// - 답변 행 `source_references.basis_date`에 남겨 지난 대화에서도 무엇으로 찾았는지 보인다

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' 이고 있는 날(1948~2100)인가 */
export function isBasisDate(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = DAY.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1948 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** 요청의 `basis_date` — 없으면(undefined·null·빈 글) 오늘 기준. 꼴이 틀리면 거절(조용히 무시하면 기준일로 찾은 줄 안다) */
export function parseChatBasisDate(raw: unknown): { ok: true; date: string | null } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, date: null };
  if (!isBasisDate(raw)) return { ok: false, message: '적용 기준일은 2026-01-01처럼 있는 날짜로 골라 주세요.' };
  return { ok: true, date: raw };
}

/** 말풍선 위 표시 */
export function basisDateNote(date: string): string {
  return `적용 기준일 ${date}로 찾은 답`;
}

/** 모델에게 — 그날 기준으로 답하고 기준일을 밝히게 */
export function basisDatePromptLine(date: string, past: boolean): string {
  return past
    ? `- 직원이 적용 기준일 ${date}로 물었다. 그날 시행 중이던 판으로 답하고 답 첫머리에 기준일을 밝히세요. '지난 판' 근거가 그날의 판이고, 그 밖의 근거는 지금 판이라 기준일 뒤에 바뀐 내용일 수 있으니 구분해 밝히세요.`
    : `- 직원이 적용 기준일 ${date}로 물었다. 그날 시행 중인 판으로 찾은 근거입니다. 답 첫머리에 기준일을 밝히세요.`;
}
