// src/lib/agent-shares.ts
// 나만의 비서·앱 함께 쓰기(2026-11-26, 0128) — 주인이 같은 기관의 동료를 이메일로 골라(20명까지) 함께 쓰게 한다.
//
// - (0129) 그중 주인이 고른 사람은 **함께 고친다**(설정·문서·양식 — `canEditAgent`). 지우기·공유 바꾸기·부서 비서로 올리기·공식 신청은 주인만.
// - 함께 쓰는 사람은 **쓰기만** 한다(대화·앱 실행·예약·연동·일괄 실행 — 권한 판정 `canUseAgent` 한 곳). 고치기·지우기·공유 바꾸기·
//   부서 비서로 올리기는 주인만(`canEditAgent`·`canDeleteAgent`는 그대로). 비서의 지시문·문서함 문서도 그 비서를 쓰는 범위에서 보인다
//   (부서 비서를 하위 부서가 쓰는 것과 같은 판단).
// - 고를 수 있는 사람: 같은 기관 부서에 등록된 사용 중인 직원(탈퇴·사용 중지·슈퍼관리자·다른 기관 제외), 본인 제외. 모르는 이메일은 거절한다
//   (조용히 빼면 공유한 줄 안다).
// - (0130) 부서로도 함께 쓴다 — 고른 부서(20곳)와 그 하위 부서 사람 모두 쓰기만(`isSharedByDepartment`). 같은 기관 부서만.
// - 공유는 운영 값이라 판을 남기지 않는다. 바꿀 때마다 보안 로그 `agent_shared`(더한·뺀 사람 id만). 바꾸는 쪽은 조건부(주인·나만의 비서·지우지 않음).
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { loadAgentAccess } from '@/lib/agent-store';
import { logSecurityEvent } from '@/lib/security-log';
import type { ActorScope, AgentAccessInfo } from '@/lib/agent-permissions';

export const AGENT_SHARES_MAX = 20;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `role` — 쓰기만(viewer) 또는 함께 고치기(editor, 0129) */
export interface AgentShareView { id: string; email: string; name: string | null; department: string | null; role: 'viewer' | 'editor' }
type Fail = { ok: false; status: number; message: string };

/** 요청의 이메일 목록 — 다듬어 소문자, 겹친 것은 한 번, 20개까지. 아니면 null */
export function parseShareEmails(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > AGENT_SHARES_MAX * 2) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') return null;
    const e = v.normalize('NFC').trim().toLowerCase();
    if (!e) continue;
    if (e.length > 254 || !EMAIL.test(e)) return null;
    if (!out.includes(e)) out.push(e);
  }
  return out.length > AGENT_SHARES_MAX ? null : out;
}

/** 공유를 다룰 수 있는 사람 — 그 나만의 비서의 주인(같은 기관·지우지 않음) */
export function canManageShares(agent: AgentAccessInfo | null, actor: ActorScope): boolean {
  return Boolean(agent && !agent.deleted_at && agent.tier === 'personal' && agent.owner_id === actor.userId
    && actor.organizationId && agent.organization_id === actor.organizationId);
}

type UserRow = { id: string; email: string; full_name: string | null; is_active: boolean | null; deleted_at: string | null; is_super_admin: boolean | null; department_id: string | null };

export interface AgentSharesIo {
  loadAgent(id: string): Promise<AgentAccessInfo | null>;
  usersByEmail(emails: string[]): Promise<UserRow[]>;
  usersById(ids: string[]): Promise<UserRow[]>;
  /** 부서 id → { 기관 id, 이름 } */
  departments(ids: string[]): Promise<Map<string, { organization_id: string; name: string }>>;
  /** 주인·나만의 비서·지우지 않음일 때만 바꾼다 — 바꿨으면 true. `editorIds`는 `ids` 안(0129) */
  save(agentId: string, ownerId: string, ids: string[], editorIds: string[]): Promise<boolean>;
  /** 이 기관의 부서(고를 거리, 0130) */
  orgDepartments(organizationId: string): Promise<Array<{ id: string; name: string; parent_id: string | null }>>;
  /** 함께 쓰는 부서를 바꾼다(0130) — 조건은 save와 같다 */
  saveDepartments(agentId: string, ownerId: string, departmentIds: string[]): Promise<boolean>;
  log(actor: ActorScope, details: Record<string, unknown>): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function owned(io: AgentSharesIo, actor: ActorScope, agentId: string): Promise<AgentAccessInfo | Fail> {
  if (!UUID.test(agentId)) return { ok: false, status: 404, message: '비서를 찾을 수 없습니다.' };
  let agent: AgentAccessInfo | null;
  try { agent = await io.loadAgent(agentId); } catch { return { ok: false, status: 503, message: '비서를 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }; }
  if (!agent || agent.organization_id !== actor.organizationId) return { ok: false, status: 404, message: '비서를 찾을 수 없습니다.' };
  if (!canManageShares(agent, actor)) return { ok: false, status: 403, message: '나만의 비서를 만든 사람만 함께 쓸 사람을 정할 수 있습니다.' };
  return agent;
}

async function views(io: AgentSharesIo, ids: string[], editorIds: string[]): Promise<AgentShareView[]> {
  if (!ids.length) return [];
  const editors = new Set(editorIds.map((id) => id.toLowerCase()));
  const users = await io.usersById(ids);
  const depts = await io.departments([...new Set(users.map((u) => u.department_id).filter((d): d is string => Boolean(d)))]);
  const byId = new Map(users.map((u) => [u.id.toLowerCase(), u]));
  return ids.flatMap((id) => {
    const u = byId.get(id.toLowerCase());
    return u ? [{ id: u.id, email: u.email, name: u.full_name, department: (u.department_id && depts.get(u.department_id)?.name) || null, role: editors.has(u.id.toLowerCase()) ? 'editor' as const : 'viewer' as const }] : [];
  });
}

/** 지금 함께 쓰는 사람 — 주인만 본다 */
export async function getAgentShares(io: AgentSharesIo, actor: ActorScope, agentId: string): Promise<{ ok: true; shares: AgentShareView[] } | Fail> {
  const agent = await owned(io, actor, agentId);
  if ('ok' in agent) return agent;
  try {
    return { ok: true, shares: await views(io, agent.shared_user_ids ?? [], agent.shared_editor_ids ?? []) };
  } catch {
    return { ok: false, status: 503, message: '함께 쓰는 사람을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  }
}

export type ShareDepartment = { id: string; name: string; parent_id: string | null };

/** 요청의 부서 id 목록 — uuid만, 소문자, 한 번, 20곳까지. 아니면 null */
export function parseShareDepartments(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > AGENT_SHARES_MAX * 2) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !UUID.test(v)) return null;
    const id = v.toLowerCase();
    if (!out.includes(id)) out.push(id);
  }
  return out.length > AGENT_SHARES_MAX ? null : out;
}

/** 함께 쓰는 부서와 고를 거리(이 기관 부서 전체) — 주인만 본다(0130) */
export async function getShareDepartments(io: AgentSharesIo, actor: ActorScope, agentId: string): Promise<{ ok: true; selected: ShareDepartment[]; choices: ShareDepartment[] } | Fail> {
  const agent = await owned(io, actor, agentId);
  if ('ok' in agent) return agent;
  let choices: ShareDepartment[];
  try { choices = await io.orgDepartments(actor.organizationId as string); } catch { return { ok: false, status: 503, message: '부서 목록을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }; }
  const want = new Set((agent.shared_department_ids ?? []).map((d) => d.toLowerCase()));
  return { ok: true, selected: choices.filter((d) => want.has(d.id.toLowerCase())), choices };
}

/** 함께 쓰는 부서를 통째로 정한다(0130) — 이 기관 부서만(아니면 400) */
export async function setShareDepartments(io: AgentSharesIo, actor: ActorScope, agentId: string, departmentIds: string[]): Promise<{ ok: true; selected: ShareDepartment[] } | Fail> {
  const agent = await owned(io, actor, agentId);
  if ('ok' in agent) return agent;
  let choices: ShareDepartment[];
  try { choices = await io.orgDepartments(actor.organizationId as string); } catch { return { ok: false, status: 503, message: '부서 목록을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }; }
  const byId = new Map(choices.map((d) => [d.id.toLowerCase(), d]));
  if (departmentIds.some((id) => !byId.has(id))) return { ok: false, status: 400, message: '이 기관의 부서만 고를 수 있습니다.' };
  let saved: boolean;
  try { saved = await io.saveDepartments(agent.id, actor.userId, departmentIds); } catch { return { ok: false, status: 503, message: '함께 쓸 부서를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }; }
  if (!saved) return { ok: false, status: 409, message: '그 사이 비서가 바뀌었습니다. 화면을 새로 고쳐 다시 시도해 주세요.' };
  const before = new Set((agent.shared_department_ids ?? []).map((d) => d.toLowerCase()));
  const after = new Set(departmentIds);
  await io.log(actor, {
    agent_id: agent.id,
    departments_added: departmentIds.filter((d) => !before.has(d)),
    departments_removed: [...before].filter((d) => !after.has(d)),
    department_count: departmentIds.length,
  }).catch(() => {});
  return { ok: true, selected: departmentIds.map((id) => byId.get(id)!) };
}

/** 함께 쓸 사람을 통째로 정한다(빈 목록이면 모두 뺌). `editorEmails`는 그중 함께 고칠 사람(0129 — `emails` 안이어야) */
export async function setAgentShares(io: AgentSharesIo, actor: ActorScope, agentId: string, emails: string[], editorEmails: string[] = []): Promise<{ ok: true; shares: AgentShareView[] } | Fail> {
  if (editorEmails.some((e) => !emails.includes(e))) return { ok: false, status: 400, message: '함께 고칠 사람은 함께 쓸 사람 가운데에서 골라 주세요.' };
  const agent = await owned(io, actor, agentId);
  if ('ok' in agent) return agent;
  let users: UserRow[];
  let depts: Map<string, { organization_id: string; name: string }>;
  try {
    users = emails.length ? await io.usersByEmail(emails) : [];
    depts = await io.departments([...new Set(users.map((u) => u.department_id).filter((d): d is string => Boolean(d)))]);
  } catch {
    return { ok: false, status: 503, message: '직원을 지금 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  }
  const usable = new Map<string, UserRow>();
  for (const u of users) {
    const org = u.department_id ? depts.get(u.department_id)?.organization_id : null;
    if (org && org === actor.organizationId && u.is_active !== false && !u.deleted_at && !u.is_super_admin) usable.set(u.email.toLowerCase(), u);
  }
  const unknown = emails.filter((e) => !usable.has(e));
  if (unknown.length) return { ok: false, status: 400, message: `이 기관에서 함께 쓸 수 있는 직원이 아닙니다: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ` 외 ${unknown.length - 5}명` : ''}` };
  const ids = emails.map((e) => usable.get(e)!.id);
  if (ids.some((id) => id.toLowerCase() === actor.userId.toLowerCase())) return { ok: false, status: 400, message: '본인은 이미 이 비서를 씁니다 — 다른 사람을 골라 주세요.' };
  const editorIds = editorEmails.map((e) => usable.get(e)!.id);
  let saved: boolean;
  try { saved = await io.save(agent.id, actor.userId, ids, editorIds); } catch { return { ok: false, status: 503, message: '함께 쓸 사람을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }; }
  if (!saved) return { ok: false, status: 409, message: '그 사이 비서가 바뀌었습니다. 화면을 새로 고쳐 다시 시도해 주세요.' };
  const before = new Set((agent.shared_user_ids ?? []).map((id) => id.toLowerCase()));
  const after = new Set(ids.map((id) => id.toLowerCase()));
  await io.log(actor, {
    agent_id: agent.id,
    added: ids.filter((id) => !before.has(id.toLowerCase())),
    removed: [...before].filter((id) => !after.has(id)),
    count: ids.length,
    editors: editorIds,
  }).catch(() => {});
  const byId = new Map(users.map((u) => [u.id, u]));
  const editorSet = new Set(editorIds);
  return { ok: true, shares: ids.map((id) => { const u = byId.get(id)!; return { id, email: u.email, name: u.full_name, department: (u.department_id && depts.get(u.department_id)?.name) || null, role: editorSet.has(id) ? 'editor' as const : 'viewer' as const }; }) };
}

export function defaultAgentSharesIo(): AgentSharesIo {
  const userCols = 'id, email, full_name, is_active, deleted_at, is_super_admin, department_id';
  return {
    loadAgent: loadAgentAccess,
    async usersByEmail(emails) {
      const { data, error } = await supabaseAdmin.from('users').select(userCols).in('email', emails);
      if (error) throw error;
      return (data ?? []) as UserRow[];
    },
    async usersById(ids) {
      const { data, error } = await supabaseAdmin.from('users').select(userCols).in('id', ids);
      if (error) throw error;
      return (data ?? []) as UserRow[];
    },
    async departments(ids) {
      if (!ids.length) return new Map();
      const { data, error } = await supabaseAdmin.from('departments').select('id, organization_id, name').in('id', ids);
      if (error) throw error;
      return new Map(((data ?? []) as Array<{ id: string; organization_id: string; name: string }>).map((d) => [d.id, { organization_id: d.organization_id, name: d.name }]));
    },
    async save(agentId, ownerId, ids, editorIds) {
      const { data, error } = await supabaseAdmin.from('agents').update({ shared_user_ids: ids, shared_editor_ids: editorIds })
        .eq('id', agentId).eq('owner_id', ownerId).eq('tier', 'personal').is('deleted_at', null).select('id');
      if (error) throw error;
      return Boolean(data?.length);
    },
    async orgDepartments(organizationId) {
      const { data, error } = await supabaseAdmin.from('departments').select('id, name, parent_id').eq('organization_id', organizationId).order('name').limit(1000);
      if (error) throw error;
      return (data ?? []) as ShareDepartment[];
    },
    async saveDepartments(agentId, ownerId, departmentIds) {
      const { data, error } = await supabaseAdmin.from('agents').update({ shared_department_ids: departmentIds })
        .eq('id', agentId).eq('owner_id', ownerId).eq('tier', 'personal').is('deleted_at', null).select('id');
      if (error) throw error;
      return Boolean(data?.length);
    },
    async log(actor, details) {
      await logSecurityEvent(actor.departmentId, actor.userId, 'agent_shared', details, 'low');
    },
  };
}
