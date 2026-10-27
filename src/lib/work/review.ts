// src/lib/work/review.ts
import { checkNumbers, numbersIn } from '@/lib/assistant/number-check';
import type { DocumentField } from './types';
import type { NewReviewItem } from './store/types';

/**
 * 확인할 사항 만들기 — 판마다 다시 계산한다(판이 바뀌면 재검증, 개편 05 문서 1절).
 *
 *  - REQUIRED_EMPTY(blocking): 필수 칸이 비었다 — '검토 완료'를 막는다
 *  - INFO_NEEDED(warning): AI가 정보가 없어 비워 둔 칸
 *  - UNVERIFIED_NUMBER(warning): AI가 쓴 칸의 숫자가 직원 입력·원자료 어디에도 없다(숫자 확인 규칙 재사용)
 *  - PLACEHOLDER(warning): '○○○'·'[확인 필요]' 같은 자리 표시가 남았다
 *  - TEST_MODE(info): 모델 없이 시험 모드로 만든 판
 * '확인할 사항 없음'은 이 검사 범위에서 없다는 뜻이지 사실 무오류 인증이 아니다 — 화면도 그렇게 적는다.
 */
const PLACEHOLDER = /○{2,}|O{3,}|X{3,}|\[\s*확인\s*필요[^\]]*\]|\(\s*내용\s*\)/;

export interface ReviewInput {
  fields: DocumentField[];
  missing: { fieldId: string; reason: string }[];
  /** 직원 입력 + 원자료 글 — 숫자 대조의 기준 */
  knownText: string;
  testMode: boolean;
}

export function computeReviewItems(input: ReviewInput): NewReviewItem[] {
  const items: NewReviewItem[] = [];
  const empty = new Set<string>();
  for (const f of input.fields) {
    if (f.required && !f.value.trim()) {
      empty.add(f.id);
      items.push({ severity: 'blocking', code: 'REQUIRED_EMPTY', message: `'${f.label}' 칸이 비어 있습니다. 내용을 넣어야 검토를 마칠 수 있습니다.`, field_ids: [f.id] });
    }
  }
  for (const m of input.missing) {
    if (empty.has(m.fieldId)) continue;
    const f = input.fields.find((x) => x.id === m.fieldId);
    if (!f || f.value.trim()) continue;
    items.push({ severity: 'warning', code: 'INFO_NEEDED', message: `'${f.label}': ${m.reason}`, field_ids: [f.id] });
  }
  const known = numbersIn(input.knownText);
  for (const f of input.fields) {
    if (f.origin !== 'ai' || !f.value) continue;
    const unverified = checkNumbers(f.value, known);
    if (unverified.length) {
      items.push({
        severity: 'warning',
        code: 'UNVERIFIED_NUMBER',
        message: `'${f.label}'의 숫자 ${unverified.slice(0, 5).join(' · ')}는 입력·원자료에서 확인되지 않았습니다. 직접 확인하세요.`,
        field_ids: [f.id],
      });
    }
    if (PLACEHOLDER.test(f.value)) {
      items.push({ severity: 'warning', code: 'PLACEHOLDER', message: `'${f.label}'에 채우지 않은 자리 표시가 남아 있습니다.`, field_ids: [f.id] });
    }
  }
  if (input.testMode) {
    items.push({ severity: 'info', code: 'TEST_MODE', message: '시험 모드로 만든 판입니다(AI를 부르지 않음). 실제 업무에 쓰지 마세요.', field_ids: [] });
  }
  return items;
}
