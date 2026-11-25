// src/lib/library-shares.ts
// 공유 자료함(0116) 관리 — 기관 전체 관리자가 이름과 부서 목록을 정해 만들고 고치고 지운다.
// 파일은 자료함 쪽(src/lib/my-library.ts)이 다룬다. 여기서는 공유 자료함 자체와 부서 목록만.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { cleanShareName, LIBRARY_MAX_SHARES, LIBRARY_SHARE_MAX_DEPARTMENTS } from '@/lib/my-library-spec';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Failure = { ok: false; status: number; message: string };

export type ShareView = { id: string; name: string; departmentIds: string[]; files: number | null; created_at: string };
export const SHARE_NOT_FOUND = '그 공유 자료함을 찾을 수 없습니다.';
export const SHARE_RETRY = '공유 자료함을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.';

/** 입력 검사 — 만들기는 이름·부서 둘 다, 고치기는 보낸 것만. 부서는 겹치지 않게 1~50곳 */
export function parseShareInput(raw: Record<string, unknown>, partial: boolean): { ok: true; name?: string; departmentIds?: string[] } | Failure {
  const out: { name?: string; departmentIds?: string[] } = {};
  if (!partial || raw.name !== undefined) {
    const name = cleanShareName(raw.name);
    if (!name) return { ok: false, status: 400, message: '공유 자료함 이름을 1~40자로 적어 주세요.' };
    out.name = name;
  }
  if (!partial || raw.departmentIds !== undefined) {
    if (!Array.isArray(raw.departmentIds)) return { ok: false, status: 400, message: '함께 쓸 부서를 목록으로 보내 주세요.' };
    const ids = [...new Set(raw.departmentIds.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')))];
    if (ids.some((v) => !UUID.test(v))) return { ok: false, status: 400, message: '부서 id가 올바르지 않습니다.' };
    if (ids.length === 0) return { ok: false, status: 400, message: '함께 쓸 부서를 한 곳 이상 골라 주세요.' };
    if (ids.length > LIBRARY_SHARE_MAX_DEPARTMENTS) return { ok: false, status: 400, message: `부서는 ${LIBRARY_SHARE_MAX_DEPARTMENTS}곳까지 고를 수 있습니다.` };
    out.departmentIds = ids;
  }
  if (partial && out.name === undefined && out.departmentIds === undefined) return { ok: false, status: 400, message: '바꿀 이름이나 부서를 보내 주세요.' };
  return { ok: true, ...out };
}

/** DB에 닿는 일 — 시험이 바꿔 끼운다. 모두 못 읽거나 못 쓰면 던진다 */
export interface SharesDb {
  list(organizationId: string): Promise<{ id: string; name: string; created_at: string }[]>;
  departmentsOf(shareIds: string[]): Promise<{ share_id: string; department_id: string }[]>;
  /** 공유 자료함마다 파일 수 */
  fileCounts(shareIds: string[]): Promise<Map<string, number>>;
  /** 이 기관의 부서 중 고른 것 — 있는 id만 */
  orgDepartments(organizationId: string, ids: string[]): Promise<string[]>;
  insert(row: { organization_id: string; name: string; created_by: string }): Promise<{ id: string; name: string; created_at: string }>;
  rename(organizationId: string, id: string, name: string): Promise<boolean>;
  /** 부서 목록을 통째로 바꾼다 */
  setDepartments(shareId: string, departmentIds: string[]): Promise<void>;
  remove(organizationId: string, id: string): Promise<boolean>;
}

const isUnique = (e: unknown) => (e as { code?: string } | null)?.code === '23505';
const isFk = (e: unknown) => (e as { code?: string } | null)?.code === '23503';

/** 기관의 공유 자료함 — 이름 순, 부서 목록·파일 수와 함께(파일 수를 못 세면 null) */
export async function listShares(organizationId: string, db: SharesDb = sharesDb()): Promise<{ ok: true; shares: ShareView[] } | Failure> {
  try {
    const rows = await db.list(organizationId);
    const ids = rows.map((r) => r.id);
    const [links, counts] = await Promise.all([db.departmentsOf(ids), db.fileCounts(ids).catch(() => null)]);
    const shares = rows.map((r) => ({
      id: r.id, name: r.name, created_at: r.created_at,
      departmentIds: links.filter((l) => l.share_id === r.id).map((l) => l.department_id),
      files: counts ? counts.get(r.id) ?? 0 : null,
    })).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    return { ok: true, shares };
  } catch {
    return { ok: false, status: 503, message: SHARE_RETRY };
  }
}

async function checkDepartments(organizationId: string, ids: string[], db: SharesDb): Promise<Failure | null> {
  const found = await db.orgDepartments(organizationId, ids);
  return found.length === ids.length ? null : { ok: false, status: 400, message: '이 기관의 부서만 고를 수 있습니다(없어진 부서가 섞여 있습니다).' };
}

/** 만들기 — 기관마다 50개, 이름은 기관 안에서 하나 */
export async function createShare(organizationId: string, userId: string, raw: Record<string, unknown>, db: SharesDb = sharesDb()): Promise<{ ok: true; share: ShareView } | Failure> {
  const input = parseShareInput(raw, false);
  if (!input.ok) return input;
  try {
    const existing = await db.list(organizationId);
    if (existing.length >= LIBRARY_MAX_SHARES) return { ok: false, status: 409, message: `공유 자료함은 기관마다 ${LIBRARY_MAX_SHARES}개까지입니다.` };
    const bad = await checkDepartments(organizationId, input.departmentIds!, db);
    if (bad) return bad;
    let row: { id: string; name: string; created_at: string };
    try {
      row = await db.insert({ organization_id: organizationId, name: input.name!, created_by: userId });
    } catch (e) {
      if (isUnique(e)) return { ok: false, status: 409, message: '같은 이름의 공유 자료함이 이미 있습니다.' };
      throw e;
    }
    try {
      await db.setDepartments(row.id, input.departmentIds!);
    } catch {
      // 부서 없는 공유 자료함을 남기지 않는다
      await db.remove(organizationId, row.id).catch(() => false);
      return { ok: false, status: 503, message: '공유 자료함을 지금 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
    }
    return { ok: true, share: { ...row, departmentIds: input.departmentIds!, files: 0 } };
  } catch {
    return { ok: false, status: 503, message: '공유 자료함을 지금 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  }
}

/** 고치기 — 이름·부서 목록. 부서를 빼면 그 부서 사람은 더 못 본다(파일은 남는다) */
export async function updateShare(organizationId: string, id: string, raw: Record<string, unknown>, db: SharesDb = sharesDb()): Promise<{ ok: true; changed: string[] } | Failure> {
  if (!UUID.test(id)) return { ok: false, status: 404, message: SHARE_NOT_FOUND };
  const input = parseShareInput(raw, true);
  if (!input.ok) return input;
  try {
    const existing = (await db.list(organizationId)).find((s) => s.id.toLowerCase() === id.toLowerCase());
    if (!existing) return { ok: false, status: 404, message: SHARE_NOT_FOUND };
    const changed: string[] = [];
    if (input.departmentIds) {
      const bad = await checkDepartments(organizationId, input.departmentIds, db);
      if (bad) return bad;
    }
    if (input.name !== undefined && input.name !== existing.name) {
      try {
        if (!(await db.rename(organizationId, existing.id, input.name))) return { ok: false, status: 404, message: SHARE_NOT_FOUND };
      } catch (e) {
        if (isUnique(e)) return { ok: false, status: 409, message: '같은 이름의 공유 자료함이 이미 있습니다.' };
        throw e;
      }
      changed.push('name');
    }
    if (input.departmentIds) {
      await db.setDepartments(existing.id, input.departmentIds);
      changed.push('departments');
    }
    return { ok: true, changed };
  } catch {
    return { ok: false, status: 503, message: '공유 자료함을 지금 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  }
}

/** 지우기 — 파일이 남아 있으면 지우지 않는다(옮기거나 지운 뒤) */
export async function deleteShare(organizationId: string, id: string, db: SharesDb = sharesDb()): Promise<{ ok: true; name: string } | Failure> {
  if (!UUID.test(id)) return { ok: false, status: 404, message: SHARE_NOT_FOUND };
  try {
    const existing = (await db.list(organizationId)).find((s) => s.id.toLowerCase() === id.toLowerCase());
    if (!existing) return { ok: false, status: 404, message: SHARE_NOT_FOUND };
    const counts = await db.fileCounts([existing.id]);
    const files = counts.get(existing.id) ?? 0;
    if (files > 0) return { ok: false, status: 409, message: `파일 ${files}개가 남아 있어 지우지 않았습니다. 파일을 다른 자료함으로 옮기거나 지운 뒤 지워 주세요.` };
    try {
      if (!(await db.remove(organizationId, existing.id))) return { ok: false, status: 404, message: SHARE_NOT_FOUND };
    } catch (e) {
      // 확인과 지우기 사이에 파일이 담겼다(외래 키가 막음)
      if (isFk(e)) return { ok: false, status: 409, message: '그 사이 파일이 담겨 지우지 않았습니다. 파일을 옮기거나 지운 뒤 지워 주세요.' };
      throw e;
    }
    return { ok: true, name: existing.name };
  } catch {
    return { ok: false, status: 503, message: '공유 자료함을 지금 지우지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  }
}

export function sharesDb(): SharesDb {
  return {
    async list(organizationId) {
      const { data, error } = await supabaseAdmin.from('library_shares').select('id, name, created_at').eq('organization_id', organizationId).limit(LIBRARY_MAX_SHARES + 10);
      if (error) throw error;
      return (data ?? []) as { id: string; name: string; created_at: string }[];
    },
    async departmentsOf(shareIds) {
      if (!shareIds.length) return [];
      const { data, error } = await supabaseAdmin.from('library_share_departments').select('share_id, department_id').in('share_id', shareIds);
      if (error) throw error;
      return (data ?? []) as { share_id: string; department_id: string }[];
    },
    async fileCounts(shareIds) {
      const counts = new Map<string, number>();
      for (const id of shareIds) {
        const { count, error } = await supabaseAdmin.from('my_library_files').select('id', { count: 'exact', head: true }).eq('space', 'shared').eq('share_id', id);
        if (error) throw error;
        counts.set(id, count ?? 0);
      }
      return counts;
    },
    async orgDepartments(organizationId, ids) {
      const { data, error } = await supabaseAdmin.from('departments').select('id').in('id', ids).eq('organization_id', organizationId);
      if (error) throw error;
      return ((data ?? []) as { id: string }[]).map((d) => d.id);
    },
    async insert(row) {
      const { data, error } = await supabaseAdmin.from('library_shares').insert(row).select('id, name, created_at').single();
      if (error) throw error;
      return data as { id: string; name: string; created_at: string };
    },
    async rename(organizationId, id, name) {
      const { data, error } = await supabaseAdmin.from('library_shares').update({ name, updated_at: new Date().toISOString() }).eq('id', id).eq('organization_id', organizationId).select('id');
      if (error) throw error;
      return ((data ?? []) as unknown[]).length > 0;
    },
    async setDepartments(shareId, departmentIds) {
      // 뺄 것만 지우고 더할 것만 넣는다 — 도중에 실패해도 남은 부서는 그대로
      const { data, error } = await supabaseAdmin.from('library_share_departments').select('department_id').eq('share_id', shareId);
      if (error) throw error;
      const have = new Set(((data ?? []) as { department_id: string }[]).map((r) => r.department_id));
      const want = new Set(departmentIds);
      const drop = [...have].filter((d) => !want.has(d));
      const add = [...want].filter((d) => !have.has(d));
      if (drop.length) {
        const { error: delError } = await supabaseAdmin.from('library_share_departments').delete().eq('share_id', shareId).in('department_id', drop);
        if (delError) throw delError;
      }
      if (add.length) {
        const { error: insError } = await supabaseAdmin.from('library_share_departments').insert(add.map((department_id) => ({ share_id: shareId, department_id })));
        if (insError) throw insError;
      }
    },
    async remove(organizationId, id) {
      const { data, error } = await supabaseAdmin.from('library_shares').delete().eq('id', id).eq('organization_id', organizationId).select('id');
      if (error) throw error;
      return ((data ?? []) as unknown[]).length > 0;
    },
  };
}
