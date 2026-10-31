/** 현재 기관·공개 범위·검색 능력으로 허용된 공식 비서만 입력한다. */
export function restrictDocumentAgents<T extends { id: string }>(eligible: T[], selectedId?: string): T[] {
  if (!selectedId) return eligible;
  const selected = eligible.find((a) => a.id === selectedId);
  if (!selected) throw new Error('Selected document vault is no longer available');
  return [selected];
}
