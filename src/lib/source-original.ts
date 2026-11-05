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
