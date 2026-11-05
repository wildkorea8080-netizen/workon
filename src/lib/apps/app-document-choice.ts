// src/lib/apps/app-document-choice.ts
// 예약(0062)·외부 연동(0063)이 저장하는 '문서함에서 고른 문서' — 만들 때 검사와 실행 때 읽을 문서 행. 예약 만들기·연동 만들기·두 실행기가 함께 쓴다.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { ActorScope } from '@/lib/agent-permissions';
import { APP_MAX_FILES, type AppDefinition } from '@/lib/apps/definition';
import { LIBRARY_DOCUMENT_COLUMNS, parseLibraryIds, selectableLibraryDocuments, type LibraryDocumentRow } from '@/lib/apps/library-documents';

/**
 * 요청의 문서 고르기 검사(순수) — 꼴, 앱이 문서 고르기를 받는지, 파일이 필수인 앱이면 문서가 있는지, 3개 상한.
 * `noun`은 안내 글의 '예약'·'연동'
 */
export function appDocumentChoice(
  attachments: AppDefinition['attachments'],
  raw: unknown,
  noun: '예약' | '연동'
): { ok: true; ids: string[] } | { ok: false; message: string } {
  const ids = parseLibraryIds(raw);
  if (ids === null) return { ok: false, message: '고른 문서를 확인해 주세요.' };
  const library = attachments?.library === true;
  if (ids.length && !library) return { ok: false, message: '이 앱은 문서함에서 문서를 고를 수 없습니다.' };
  if (attachments?.required && !ids.length) {
    return {
      ok: false,
      message: library
        ? `파일이 필요한 앱은 문서함에서 문서를 골라야 ${noun}할 수 있습니다(올린 파일은 ${noun}에 쓸 수 없습니다).`
        : `파일 첨부가 필수인 앱은 ${noun}할 수 없습니다.`,
    };
  }
  if (ids.length > APP_MAX_FILES) return { ok: false, message: `${noun}에는 문서를 ${APP_MAX_FILES}개까지 고를 수 있습니다.` };
  return { ok: true, ids };
}

/** 그 비서의 문서 행(기관 한정) — 고를 수 있는지·지금 판을 가린다 */
export async function agentDocumentRows(agentId: string, organizationId: string): Promise<LibraryDocumentRow[]> {
  const { data, error } = await supabaseAdmin.from('documents').select(LIBRARY_DOCUMENT_COLUMNS).eq('agent_id', agentId).eq('organization_id', organizationId).limit(1000);
  if (error) throw new Error(`documents: ${error.message}`);
  return (data ?? []) as unknown as LibraryDocumentRow[];
}

/** 만들 때 — 고른 문서가 모두 지금 그 사람이 고를 수 있는 문서인가. 행을 못 읽으면 'error' */
export async function verifyChosenDocuments(agentId: string, actor: ActorScope, ids: string[]): Promise<'ok' | 'unavailable' | 'error'> {
  if (!ids.length) return 'ok';
  if (!actor.organizationId) return 'unavailable';
  let rows: LibraryDocumentRow[];
  try {
    rows = await agentDocumentRows(agentId, actor.organizationId);
  } catch {
    return 'error';
  }
  const selectable = new Set(selectableLibraryDocuments(rows, agentId, actor).map((d) => d.id.toLowerCase()));
  return ids.every((id) => selectable.has(id)) ? 'ok' : 'unavailable';
}

export const CHOSEN_DOCUMENTS_UNAVAILABLE = '고를 수 없는 문서가 있습니다. 문서 목록을 새로 열어 다시 골라 주세요.';
