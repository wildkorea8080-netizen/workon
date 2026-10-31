import { numbersIn } from '@/lib/assistant/number-check';
/** 원문의 숫자 표기를 개수까지 대조한다. 의미·이름·조건 검증을 대신하지 않는다. */
export function rewriteNumbersPreserved(source: string, output: string): boolean {
  const counts = (text: string) => {
    const result = new Map<string, number>();
    for (const match of text.matchAll(/[-−]?\d+(?:[.,:/-]\d+)*(?:%|원|명|건|년|월|일|시|분)?/g)) result.set(match[0], (result.get(match[0]) ?? 0) + 1);
    return result;
  };
  const before = counts(source), after = counts(output);
  return before.size === after.size && [...before].every(([key, count]) => after.get(key) === count);
}

/** 번역은 단위 언어·쉼표·날짜 구분자가 바뀔 수 있어 숫자값과 등장 개수를 비교한다. */
export function translationNumbersPreserved(source: string, output: string): boolean {
  const counts = (text: string) => {
    const result = new Map<number, number>();
    for (const value of numbersIn(text)) result.set(value, (result.get(value) ?? 0) + 1);
    return result;
  };
  const before = counts(source), after = counts(output);
  return before.size === after.size && [...before].every(([value, count]) => after.get(value) === count);
}
