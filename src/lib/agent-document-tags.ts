// src/lib/agent-document-tags.ts
// 대화의 '문서 좁히기'(2026-11-23)가 보일 태그 — 이 비서가 근거로 쓰는(읽힌·지금 판) 문서에 붙은 태그와 문서 수.
// 대화 문서 찾기는 비서 보관함의 문서를 모두 찾으므로, 그 비서를 쓸 수 있는 사람에게 그 문서들의 태그를 보여도 된다(태그만 — 문서 이름 없음).

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { AgentDocTag } from '@/lib/chat-doc-tags';

export type { AgentDocTag };

/** 태그별 문서 수(많은 순, 같으면 가나다). 못 읽으면 던진다 — 부르는 쪽이 503으로 */
export async function agentDocumentTags(agentId: string): Promise<AgentDocTag[]> {
  // 비서당 문서는 50개가 상한(MAX_AGENT_DOCUMENTS)이라 API 상한(1,000행)에 닿지 않는다
  const { data, error } = await supabaseAdmin
    .from('documents')
    .select('tags')
    .eq('agent_id', agentId)
    .eq('noda_status', 'ready')
    .is('retired_at', null)
    .limit(1000);
  if (error) throw new Error(`documents: ${error.code ?? 'error'}`);
  const counts = new Map<string, { tag: string; count: number }>();
  for (const row of (data ?? []) as { tags: string[] | null }[]) {
    const seen = new Set<string>();
    for (const raw of row.tags ?? []) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const key = raw.toLocaleLowerCase('ko');
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = counts.get(key);
      if (hit) hit.count += 1;
      else counts.set(key, { tag: raw, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'ko'));
}
