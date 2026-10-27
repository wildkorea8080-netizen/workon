import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID, createHash } from 'crypto';

/**
 * 업무 도메인 DB 시험 (0034) — 실제 PostgreSQL에서 제약·트리거·RPC를 본다.
 * WORK_TEST_DATABASE_URL이 있을 때만 돈다(`npm run work:testdb -- start`가 로컬 시험 DB를 띄우고 주소를 찍는다).
 * 운영 DB 주소를 넣지 않는다 — 시험이 행을 만들고 지운다.
 */
const url = process.env.WORK_TEST_DATABASE_URL;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe.skipIf(!url)('업무 도메인 DB (0034)', () => {
  let db: pg.Client;

  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => {
    await db?.end();
  });

  async function org(label: string) {
    const orgId = randomUUID();
    const deptId = randomUUID();
    const userId = randomUUID();
    await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, `기관${label}-${orgId.slice(0, 6)}`]);
    await db.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, `부서${label}`, `d-${deptId.slice(0, 8)}`, orgId]);
    await db.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
    return { orgId, deptId, userId };
  }

  async function task(o: { orgId: string; deptId: string; userId: string }) {
    const { rows } = await db.query(
      `INSERT INTO work_tasks (organization_id, department_id, owner_id, workflow_key, workflow_version, title)
       VALUES ($1, $2, $3, 'official-letter', '1', '시험 작업') RETURNING id`,
      [o.orgId, o.deptId, o.userId]
    );
    return rows[0].id as string;
  }

  async function code(p: Promise<unknown>): Promise<string | undefined> {
    try {
      await p;
      return undefined;
    } catch (e) {
      return (e as { code?: string }).code;
    }
  }

  const save = (taskId: string, orgId: string, base: number, runId: string | null = null, actor: string | null = null) =>
    db.query(`SELECT * FROM work_save_document_version($1, $2, $3, $4::jsonb, NULL, 'edit', '시험', $5, $6, NULL)`, [
      taskId,
      orgId,
      base,
      JSON.stringify([{ id: 'f1', value: `v${base + 1}` }]),
      actor,
      runId,
    ]);

  const enqueue = (taskId: string, orgId: string, userId: string, key: string, payload: object, max = 3) =>
    db.query(`SELECT (run).*, created FROM work_enqueue_run($1, $2, 'generate', $3, $4::jsonb, $5, 0, NULL, $6, $7)`, [
      taskId,
      orgId,
      key,
      JSON.stringify(payload),
      sha(JSON.stringify(payload)),
      userId,
      max,
    ]);

  it('작업의 기관은 부서의 기관과 같아야 한다 — 다른 기관 부서로는 만들 수 없다', async () => {
    const a = await org('A');
    const b = await org('B');
    expect(
      await code(
        db.query(
          `INSERT INTO work_tasks (organization_id, department_id, owner_id, workflow_key, workflow_version, title)
           VALUES ($1, $2, $3, 'report', '1', 'x')`,
          [a.orgId, b.deptId, a.userId]
        )
      )
    ).toBe('23514');
    const t = await task(a);
    expect(await code(db.query('UPDATE work_tasks SET organization_id = $1 WHERE id = $2', [b.orgId, t]))).toBeDefined();
  });

  it('자식 행은 작업과 같은 기관이어야 한다(복합 FK) · 구성원은 같은 기관 사용자만', async () => {
    const a = await org('A');
    const b = await org('B');
    const t = await task(a);
    expect(
      await code(
        db.query(
          `INSERT INTO work_sources (task_id, organization_id, uploaded_by, file_name, file_ext, storage_path)
           VALUES ($1, $2, $3, 'x.xlsx', 'xlsx', $4)`,
          [t, b.orgId, a.userId, `p/${randomUUID()}`]
        )
      )
    ).toBe('23503');
    expect(
      await code(db.query(`INSERT INTO work_task_members (task_id, organization_id, user_id, role) VALUES ($1, $2, $3, 'viewer')`, [t, a.orgId, b.userId]))
    ).toBe('23514');
    await db.query(`INSERT INTO work_task_members (task_id, organization_id, user_id, role) VALUES ($1, $2, $3, 'editor')`, [t, a.orgId, a.userId]);
  });

  it('문서 판 저장은 기준 판을 확인한다 — 늦은 저장은 WK409, 다른 기관 id로는 WK404', async () => {
    const a = await org('A');
    const b = await org('B');
    const t = await task(a);
    const v1 = (await save(t, a.orgId, 0)).rows[0];
    expect(v1.version).toBe(1);
    expect(await code(save(t, a.orgId, 0))).toBe('WK409');
    const v2 = (await save(t, a.orgId, 1)).rows[0];
    expect(v2.parent_version_id).toBe(v1.id);
    expect(await code(save(t, b.orgId, 2))).toBe('WK404');
    const { rows } = await db.query('SELECT current_document_version_id, revision FROM work_tasks WHERE id = $1', [t]);
    expect(rows[0].current_document_version_id).toBe(v2.id);
    expect(rows[0].revision).toBe(2);
  });

  it('다른 기관의 양식 판은 작업·문서 판에 묶을 수 없다', async () => {
    const a = await org('A');
    const b = await org('B');
    const t = await task(a);
    const { rows } = await db.query(
      `INSERT INTO work_template_versions (organization_id, source, storage_path, name, file_name, format, sha256)
       VALUES ($1, 'upload', $2, '양식', 'a.hwpx', 'hwpx', $3) RETURNING id`,
      [b.orgId, `t/${randomUUID()}`, sha(randomUUID())]
    );
    expect(await code(db.query('UPDATE work_tasks SET template_version_id = $1 WHERE id = $2', [rows[0].id, t]))).toBe('23514');
  });

  it('같은 키·같은 내용은 같은 실행, 다른 내용은 WK409, 새 키는 대기 중인 옛 실행을 superseded로', async () => {
    const a = await org('A');
    const t = await task(a);
    const first = (await enqueue(t, a.orgId, a.userId, 'key-00000001', { x: 1 })).rows[0];
    expect(first.created).toBe(true);
    const again = (await enqueue(t, a.orgId, a.userId, 'key-00000001', { x: 1 })).rows[0];
    expect(again.created).toBe(false);
    expect(again.id).toBe(first.id);
    expect(await code(enqueue(t, a.orgId, a.userId, 'key-00000001', { x: 2 }))).toBe('WK409');
    const second = (await enqueue(t, a.orgId, a.userId, 'key-00000002', { x: 2 })).rows[0];
    const { rows } = await db.query('SELECT id, status FROM work_runs WHERE task_id = $1 ORDER BY created_at', [t]);
    expect(rows.find((r: { id: string }) => r.id === first.id)?.status).toBe('superseded');
    expect((await db.query('SELECT current_run_id, status FROM work_tasks WHERE id = $1', [t])).rows[0]).toEqual({
      current_run_id: second.id,
      status: 'processing',
    });
  });

  it('두 작업자가 동시에 가져가도 한 실행은 한 곳만 · lease가 끝나면 다시 가져가고 시도를 센다', async () => {
    const a = await org('A');
    const t = await task(a);
    const run = (await enqueue(t, a.orgId, a.userId, `key-${randomUUID()}`, { y: 1 }, 2)).rows[0];
    const other = new pg.Client({ connectionString: url });
    await other.connect();
    try {
      const [r1, r2] = await Promise.all([
        db.query('SELECT * FROM work_claim_runs($1, 60, 5, $2)', ['w1', run.id]),
        other.query('SELECT * FROM work_claim_runs($1, 60, 5, $2)', ['w2', run.id]),
      ]);
      expect(r1.rowCount! + r2.rowCount!).toBe(1);
    } finally {
      await other.end();
    }
    // lease를 지난 것으로 만든다 — 작업자가 죽은 경우
    await db.query(`UPDATE work_runs SET lease_until = now() - interval '1 second' WHERE id = $1`, [run.id]);
    const re = await db.query('SELECT * FROM work_claim_runs($1, 60, 5, $2)', ['w3', run.id]);
    expect(re.rows[0].attempt).toBe(2);
    expect(re.rows[0].lease_owner).toBe('w3');
    // 시도를 다 쓴 채 또 죽으면 LEASE_EXPIRED로 닫는다
    await db.query(`UPDATE work_runs SET lease_until = now() - interval '1 second' WHERE id = $1`, [run.id]);
    expect((await db.query('SELECT * FROM work_claim_runs($1, 60, 5, $2)', ['w4', run.id])).rowCount).toBe(0);
    const closed = (await db.query('SELECT status, error FROM work_runs WHERE id = $1', [run.id])).rows[0];
    expect(closed.status).toBe('failed');
    expect(closed.error.code).toBe('LEASE_EXPIRED');
  });

  it('끝내기 — lease를 잃은 작업자는 lost, 다시 시도할 실패는 대기로, 현재 실행이 바뀐 성공은 superseded', async () => {
    const a = await org('A');
    const t = await task(a);
    const run = (await enqueue(t, a.orgId, a.userId, `key-${randomUUID()}`, { z: 1 })).rows[0];
    await db.query('SELECT * FROM work_claim_runs($1, 60, 1, $2)', ['w1', run.id]);
    expect((await db.query(`SELECT work_finish_run($1, 'w9', 'succeeded', NULL, NULL, 0) AS s`, [run.id])).rows[0].s).toBe('lost');
    const err = JSON.stringify({ code: 'LLM_UNAVAILABLE', safeMessage: '잠시 뒤', retryable: true });
    expect((await db.query(`SELECT work_finish_run($1, 'w1', 'failed', $2::jsonb, NULL, 0) AS s`, [run.id, err])).rows[0].s).toBe('requeued');
    await db.query('SELECT * FROM work_claim_runs($1, 60, 1, $2)', ['w2', run.id]);
    // 그 사이 새 실행이 들어와 현재 실행이 바뀜
    await enqueue(t, a.orgId, a.userId, `key-${randomUUID()}`, { z: 2 });
    // 옛 실행은 문서 판을 저장하지 못한다(WK410)
    expect(await code(save(t, a.orgId, 0, run.id))).toBe('WK410');
    expect((await db.query(`SELECT work_finish_run($1, 'w2', 'succeeded', NULL, '{}'::jsonb, 0) AS s`, [run.id])).rows[0].s).toBe('superseded');
  });

  it('anon·authenticated 역할은 새 표를 읽지도 쓰지도, RPC를 부르지도 못한다(RLS·EXECUTE 회수)', async () => {
    const a = await org('A');
    await task(a);
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE anon');
      const { rowCount } = await db.query('SELECT * FROM work_tasks');
      expect(rowCount).toBe(0);
      expect(await code(db.query('SELECT * FROM work_claim_runs($1, 60, 1, NULL)', ['anon']))).toBe('42501');
    } finally {
      await db.query('ROLLBACK');
    }
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE authenticated');
      expect(
        await code(
          db.query(
            `INSERT INTO work_tasks (organization_id, department_id, owner_id, workflow_key, workflow_version, title)
             VALUES ($1, $2, $3, 'report', '1', 'x')`,
            [a.orgId, a.deptId, a.userId]
          )
        )
      ).toBe('42501');
    } finally {
      await db.query('ROLLBACK');
    }
  });

  it('대화를 지워도 업무 작업·판·파일 기록은 남는다(A20)', async () => {
    const a = await org('A');
    const t = await task(a);
    const v = (await save(t, a.orgId, 0)).rows[0];
    await db.query(
      `INSERT INTO work_artifacts (organization_id, task_id, document_version_id, output_key, format, file_name, mime_type, size_bytes, sha256, storage_path)
       VALUES ($1, $2, $3, 'letter', 'hwpx', '공문.hwpx', 'application/hwp+zip', 10, $4, $5)`,
      [a.orgId, t, v.id, sha('x'), `work/${randomUUID()}.hwpx`]
    );
    const conv = randomUUID();
    await db.query('INSERT INTO conversations (id, department_id, user_id, title) VALUES ($1, $2, $3, $4)', [conv, a.deptId, a.userId, '대화']);
    await db.query('DELETE FROM conversations WHERE id = $1', [conv]);
    expect((await db.query('SELECT count(*)::int AS n FROM work_artifacts WHERE task_id = $1', [t])).rows[0].n).toBe(1);
  });

  it('같은 판·같은 산출물 키의 파일은 하나(다시 시도해도 두 벌이 안 생김)', async () => {
    const a = await org('A');
    const t = await task(a);
    const v = (await save(t, a.orgId, 0)).rows[0];
    const ins = () =>
      db.query(
        `INSERT INTO work_artifacts (organization_id, task_id, document_version_id, output_key, format, file_name, mime_type, size_bytes, sha256, storage_path)
         VALUES ($1, $2, $3, 'letter', 'hwpx', '공문.hwpx', 'application/hwp+zip', 10, $4, $5)`,
        [a.orgId, t, v.id, sha('x'), `work/${randomUUID()}.hwpx`]
      );
    await ins();
    expect(await code(ins())).toBe('23505');
  });
});
