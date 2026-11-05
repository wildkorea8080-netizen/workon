// src/lib/source-original.ts
// 대화 근거 창의 '원본 열기'(2026-11-05) — 근거가 된 문서의 저장소 원본을 짧은 서명 주소로 연다.
// 비서 문서는 "그 문서를 볼 수 있고(문서 목록과 같은 공개 범위) 그 비서를 쓸 수 있는 사람"만,
// 공통 자료실 문서는 "그 기관 유형의 기관 사람"만. PDF는 근거의 쪽(`#page=N`)으로 열고, 그 밖은 원래 이름으로 내려받는다.
// 판정은 순수 함수로 두고 라우트 둘이 함께 쓴다.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { canUseAgent, type ActorScope, type AgentAccessInfo } from '@/lib/agent-permissions';
import { canReadDocument } from '@/lib/document-files';
import { isOrgType } from '@/lib/org-types';

export const ORIGINAL_URL_SECONDS = 60;
const MAX_PAGE = 100_000;

export const AGENT_ORIGINAL_COLUMNS = 'id, agent_id, organization_id, department_id, visibility, storage_path, file_name, file_type, noda_status';
export const COMMON_ORIGINAL_COLUMNS = 'id, org_type, storage_path, file_name, file_type, noda_status';

export interface AgentOriginalDoc {
  id: string;
  agent_id: string | null;
  organization_id: string | null;
  department_id: string;
  visibility: string | null;
  storage_path: string | null;
  file_name: string;
  file_type: string | null;
  noda_status: string | null;
}

export interface CommonOriginalDoc {
  id: string;
  org_type: string;
  storage_path: string | null;
  file_name: string;
  file_type: string | null;
  noda_status: string | null;
}

/** 쪽 번호 질의 값 — 1~100,000 정수 글만, 아니면 null(쪽 없이 연다) */
export function parsePage(raw: string | null | undefined): number | null {
  if (!raw || !/^[1-9]\d{0,5}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= MAX_PAGE ? n : null;
}

export function isPdfFile(fileName: string, fileType: string | null): boolean {
  return /pdf/i.test(fileType ?? '') || /\.pdf$/i.test(fileName);
}

/**
 * 서명 주소 → 열 주소. PDF는 브라우저 안에서 그 쪽으로(`#page=N` — 대부분의 PDF 보기가 따른다),
 * 그 밖은 원래 이름으로 내려받게 `download=`를 한 번만 인코딩해 붙인다(SDK 옵션은 한글 이름을 이중 인코딩한다).
 */
export function originalUrl(signedUrl: string, fileName: string, fileType: string | null, page: number | null): string {
  if (isPdfFile(fileName, fileType)) return page ? `${signedUrl}#page=${page}` : signedUrl;
  return `${signedUrl}${signedUrl.includes('?') ? '&' : '?'}download=${encodeURIComponent(fileName)}`;
}

/**
 * 비서 문서 원본을 열 수 있는가. 지우는 중(`deleting`)은 닫고, 지난 판(`retired`)은 연다 — 옛 답변의 근거였다.
 * 문서의 비서를 지금 쓸 수 없거나(숨김·비활성·남의 나만의 비서) 문서를 볼 수 없으면 닫는다.
 */
export function canOpenAgentOriginal(doc: AgentOriginalDoc | null, agent: AgentAccessInfo | null, actor: ActorScope): boolean {
  if (!doc || !doc.storage_path || !doc.agent_id || doc.noda_status === 'deleting') return false;
  if (!canReadDocument(doc, actor)) return false;
  if (!agent || agent.id !== doc.agent_id) return false;
  return canUseAgent(agent, actor);
}

/** 공통 문서 원본을 열 수 있는가 — 요청자 기관의 유형과 문서의 유형이 같을 때만. 지우는 중은 닫는다 */
export function canOpenCommonOriginal(doc: CommonOriginalDoc | null, organizationType: unknown): boolean {
  if (!doc || !doc.storage_path || doc.noda_status === 'deleting') return false;
  return isOrgType(organizationType) && doc.org_type === organizationType;
}

/** 저장소 원본의 짧은 서명 주소. 못 만들면 null */
export async function signOriginal(storagePath: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).createSignedUrl(storagePath, ORIGINAL_URL_SECONDS);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

// ── 원문 보기(2026-11-06) — 원본을 다시 읽어 글로 돌려준다(근거 위치 강조는 화면이 한다) ──

/** 원문 보기로 읽을 원본 크기 상한 — 문서 올리기 상한과 같다 */
export const ORIGINAL_TEXT_MAX_BYTES = 20 * 1024 * 1024;

class ScanSkipped extends Error {}

/**
 * 저장소 원본을 첨부 읽기와 같은 읽개로 글로 읽는다(한글·워드·엑셀·CSV·PDF·파워포인트·TXT). **스캔 PDF는 NODA로 보내지 않는다** —
 * 보기 한 번에 NODA를 부르지 않게(그 문서는 '원본 열기'로 본다). 본문은 첨부 읽기 상한(20만 자)까지
 */
export async function readOriginalText(storagePath: string, fileName: string): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; status: number; message: string }> {
  const { data: blob, error } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).download(storagePath);
  if (error || !blob) return { ok: false, status: 503, message: '원본을 지금 불러올 수 없습니다. 잠시 뒤 다시 시도해 주세요.' };
  if (blob.size > ORIGINAL_TEXT_MAX_BYTES) return { ok: false, status: 413, message: '원본이 커서 글로 보여 드릴 수 없습니다. \'원본 열기\'로 보세요.' };
  const bytes = Buffer.from(await blob.arrayBuffer());
  const { readAttachment, AttachmentReadError } = await import('@/lib/attachments/reader');
  try {
    const extract = await readAttachment(bytes, fileName, { parseScanned: async () => { throw new ScanSkipped(); } });
    const truncated = extract.warnings.some((w) => w.startsWith('본문이'));
    return { ok: true, text: extract.text, truncated };
  } catch (e) {
    if (e instanceof AttachmentReadError) {
      if (e.cause instanceof ScanSkipped) return { ok: false, status: 422, message: '글자 층이 없는 PDF(스캔본)라 글로 보여 드릴 수 없습니다. \'원본 열기\'로 보세요.' };
      return { ok: false, status: 422, message: e.message };
    }
    return { ok: false, status: 500, message: '원본을 읽지 못했습니다.' };
  }
}

/** 비서 문서 원본 찾기 — 기관 안에서, 열 수 있을 때만(원본 열기와 같은 판정). 못 읽으면 'error' */
export async function findAgentOriginal(id: string, actor: ActorScope, loadAgent: (agentId: string) => Promise<AgentAccessInfo | null>): Promise<AgentOriginalDoc | null | 'error'> {
  if (!actor.organizationId) return null;
  const { data, error } = await supabaseAdmin.from('documents').select(AGENT_ORIGINAL_COLUMNS).eq('id', id.toLowerCase()).eq('organization_id', actor.organizationId).maybeSingle();
  if (error) return 'error';
  const doc = (data ?? null) as AgentOriginalDoc | null;
  const agent = doc?.agent_id ? await loadAgent(doc.agent_id) : null;
  return doc && canOpenAgentOriginal(doc, agent, actor) ? doc : null;
}

/** 공통 문서 원본 찾기 — 요청자 기관 유형과 같을 때만. 못 읽으면 'error' */
export async function findCommonOriginal(id: string, organizationId: string): Promise<CommonOriginalDoc | null | 'error'> {
  const [org, doc] = await Promise.all([
    supabaseAdmin.from('organizations').select('type').eq('id', organizationId).maybeSingle(),
    supabaseAdmin.from('common_documents').select(COMMON_ORIGINAL_COLUMNS).eq('id', id.toLowerCase()).maybeSingle(),
  ]);
  if (org.error || doc.error) return 'error';
  const row = (doc.data ?? null) as CommonOriginalDoc | null;
  return row && canOpenCommonOriginal(row, (org.data as { type?: unknown } | null)?.type) ? row : null;
}
