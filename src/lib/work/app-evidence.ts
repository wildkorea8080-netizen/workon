import { createHash } from 'crypto';
import type { WorkContext } from './context';
import { WorkError, type WorkTaskRow } from './types';
import type { RawEvidence } from './workflows/regulations/evidence';

/** 검색 근거는 첨부 파일 행과 구분해 문서 판의 content에 보관한다. */
export interface AppEvidenceSource { id: string; name: string; text: string; documentId?: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function appEvidenceSources(items: RawEvidence[]) {
  return items.filter((e) => e.text.trim()).slice(0, 24).map((e) => ({
    id: 'rag:' + createHash('sha256').update(JSON.stringify([e.documentId ?? null, e.title, e.location, e.text])).digest('hex').slice(0, 24),
    name: [e.title, e.location].filter(Boolean).join(' · '),
    text: e.text.slice(0, 1500),
    ...(e.kind === 'org_doc' && e.documentId && UUID.test(e.documentId) ? { documentId: e.documentId } : {}),
  }));
}
export async function retrieveAppEvidence(ctx: WorkContext, task: WorkTaskRow, query: string) {
  if (task.app_snapshot?.documentScope !== 'selected-agent') return { sources: [] };
  if (!ctx.regulations) throw new WorkError('SOURCE_UNAVAILABLE', '문서 검색을 사용할 수 없습니다.', 503);
  try {
    const result = await ctx.regulations.providers.orgDocuments({ organizationId: task.organization_id, organizationName: await ctx.store.getOrganizationName(task.organization_id), departmentId: task.department_id, agentId: task.app_snapshot.agentId }, query.slice(0, 2000));
    if (result.status !== 'ok') throw new Error('unavailable');
    const sources = appEvidenceSources(result.items);
    if (!sources.length) throw new Error('no evidence');
    return { sources };
  } catch {
    throw new WorkError('SOURCE_UNAVAILABLE', '선택한 비서의 문서 근거를 불러오지 못했습니다. 검색 범위와 자료를 확인해 주세요.', 503);
  }
}

export function storedAppEvidence(content: unknown): AppEvidenceSource[] {
  if (!content || typeof content !== 'object') return [];
  const rows = (content as { appEvidence?: unknown }).appEvidence;
  if (!Array.isArray(rows)) return [];
  return rows.filter((r): r is AppEvidenceSource => !!r && typeof r.id === 'string' && r.id.startsWith('rag:') && typeof r.name === 'string' && typeof r.text === 'string').slice(0, 24).map((r) => ({
    id: r.id, name: r.name, text: r.text,
    ...(typeof r.documentId === 'string' && UUID.test(r.documentId) ? { documentId: r.documentId } : {}),
  }));
}
