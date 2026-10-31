export interface FaqSource { id: string; name: string; text: string }
export interface FaqItem { question: string; answer: string; sourceId: string | null; quote: string; status: 'grounded' | 'needs_info' }
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
/** 각 답변의 인용이 지정된 원자료에 실제로 있는지 확인한다. 의미 일치 검증과는 다르다. */
export function verifyFaq(text: string, sources: FaqSource[], maxItems: number): FaqItem[] {
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 8) throw new Error('FAQ count limit');
  const raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')) as { items?: unknown };
  if (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > maxItems) throw new Error('FAQ count');
  const seen = new Set<string>();
  return raw.items.map((row: unknown) => {
    if (!row || typeof row !== 'object') throw new Error('FAQ shape');
    const item = row as Record<string, unknown>;
    if (typeof item.question !== 'string' || !item.question.trim() || item.question.length > 300 || seen.has(squash(item.question))) throw new Error('FAQ question');
    seen.add(squash(item.question));
    if (item.status === 'needs_info') return { question: item.question.trim(), answer: '[확인 필요] 자료에서 답을 확인할 수 없습니다.', sourceId: null, quote: '', status: 'needs_info' };
    const source = sources.find((s) => s.id === item.sourceId);
    if (item.status !== 'grounded' || !source || typeof item.quote !== 'string' || !item.quote.trim() || item.quote.length > 300 || !squash(source.text).includes(squash(item.quote)) || typeof item.answer !== 'string' || !item.answer.trim() || item.answer.length > 1500) throw new Error('FAQ evidence');
    return { question: item.question.trim(), answer: item.answer.trim(), sourceId: source.id, quote: item.quote.trim(), status: 'grounded' };
  });
}
export function formatFaq(items: FaqItem[], sources: FaqSource[]): string {
  return items.map((item, index) => `Q${index + 1}. ${item.question}\nA. ${item.answer}${item.sourceId ? `\n근거: ${sources.find((s) => s.id === item.sourceId)!.name} — ${item.quote}` : ''}`).join('\n\n');
}
