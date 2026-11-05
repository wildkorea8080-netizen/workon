// src/lib/document-tag-vocabulary.ts
// 기관 태그 분류표(0061) 읽기 — 태그 저장(PATCH /api/documents/[id])·AI 초안(…/tag-suggest)·분류표 화면(/api/documents/tag-vocabulary)이 함께 쓴다.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { TagVocabulary } from '@/lib/document-tags';

export interface StoredTagVocabulary extends TagVocabulary {
  /** 마지막으로 고친 때 — 저장 때 기준으로 보낸다(다른 관리자가 그 사이 고쳤으면 409). 행이 없으면 null */
  updatedAt: string | null;
}

export const EMPTY_VOCABULARY: StoredTagVocabulary = { tags: [], restricted: false, updatedAt: null };

/** 기관의 분류표. 행이 없으면 빈 분류표. 읽지 못하면 던진다(부르는 쪽이 닫는다 — '분류표의 태그만'을 조용히 건너뛰지 않게) */
export async function loadTagVocabulary(organizationId: string): Promise<StoredTagVocabulary> {
  const { data, error } = await supabaseAdmin
    .from('document_tag_vocabularies')
    .select('tags, restricted, updated_at')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throw new Error(`tag vocabulary: ${error.code ?? error.message}`);
  if (!data) return EMPTY_VOCABULARY;
  const row = data as { tags: string[] | null; restricted: boolean | null; updated_at: string };
  return { tags: row.tags ?? [], restricted: row.restricted === true, updatedAt: row.updated_at };
}
