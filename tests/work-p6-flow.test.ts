import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createPgWorkStore } from '@/lib/work/store/pg';
import { createLocalWorkFiles } from '@/lib/work/files';
import { unavailableRenderer } from '@/lib/work/documents/renderer';
import { mockGenerator } from '@/lib/work/generation/compose';
import type { WorkContext } from '@/lib/work/context';
import type { WorkActor } from '@/lib/work/types';
import * as svc from '@/lib/work/services';
import * as admin from '@/lib/work/admin';
import { BUILTIN_TEMPLATE_DIR } from '@/lib/builtin-templates';

/**
 * P6 — 기관 운영: 기관 양식 등록·시험 생성·관리자 확인 기록·사용 중지, 업무 비서 켜고 끄기, 업무 현황,
 * 대화 결과물(generated_files)·대화 첨부 가져오기(06 문서 M4), 기관 단위 사건 기록. 실제 Postgres(0034)·실제 채우기 엔진.
 */
const url = process.env.WORK_TEST_DATABASE_URL;

describe.skipIf(!url)('P6 기관 운영(실제 Postgres)', () => {
  let pool: pg.Pool;
  let ctx: WorkContext;
  let adminActor: WorkActor;
  let staff: WorkActor;
  let other: WorkActor;
  let orgId: string;
  let deptId: string;
  const root = mkdtempSync(path.join(tmpdir(), 'workon-p6-'));

  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    pool = new pg.Pool({ connectionString: url, max: 4 });
    ctx = {
      store: createPgWorkStore(pool),
      files: createLocalWorkFiles(root),
      generator: mockGenerator,
      generatorMode: 'mock',
      renderer: unavailableRenderer,
      resolveModel: async () => 'claude-sonnet-4-6',
      checkLimit: async () => ({ allowed: true }),
      log: async () => undefined,
      now: () => new Date('2026-10-27T01:00:00Z'),
    };
    orgId = randomUUID();
    deptId = randomUUID();
    const [a, s, o] = [randomUUID(), randomUUID(), randomUUID()];
    await pool.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '가상공공지원재단']);
    await pool.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '기획팀', `d-${deptId.slice(0, 8)}`, orgId]);
    await pool.query("INSERT INTO users (id, email, department_id, role) VALUES ($1, $2, $3, 'ADMIN'), ($4, $5, $3, 'USER'), ($6, $7, $3, 'USER')", [a, `${a}@t.local`, deptId, s, `${s}@t.local`, o, `${o}@t.local`]);
    await pool.query('INSERT INTO work_org_settings (organization_id, home_enabled, new_tasks_enabled) VALUES ($1, true, true)', [orgId]);
    adminActor = { userId: a, organizationId: orgId, departmentId: deptId, isAdmin: true, managedDepartmentIds: [deptId] };
    staff = { userId: s, organizationId: orgId, departmentId: deptId, isAdmin: false, managedDepartmentIds: [] };
    other = { userId: o, organizationId: orgId, departmentId: deptId, isAdmin: false, managedDepartmentIds: [] };
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('기관 양식 — 등록하면 시험 생성(패키지 검사)까지, 한글 검증이라 하지 않고, 관리자 확인은 메모와 함께만, 사용 중지하면 새 작업에서 못 고른다', async () => {
    const bytes = readFileSync(path.join(BUILTIN_TEMPLATE_DIR, 'report.hwpx'));
    await expect(admin.registerOrgTemplate(ctx, staff, { name: 'x', fileName: 'x.hwpx', bytes })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(admin.registerOrgTemplate(ctx, adminActor, { name: '이상한 파일', fileName: 'memo.docx', bytes: Buffer.from('not a zip') })).rejects.toMatchObject({ status: expect.any(Number) });
    await expect(admin.registerOrgTemplate(ctx, adminActor, { name: '옛 한글', fileName: 'old.hwp', bytes })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const t = await admin.registerOrgTemplate(ctx, adminActor, { name: '우리 기관 결과보고서', fileName: '결과보고서.hwpx', bytes });
    expect(t).toMatchObject({ status: 'mapped', source: 'upload', label: '자동 검사(시험 생성) 통과 · 한글 확인 전' });
    expect(t.slots.map((s) => s.label)).toContain('주요 내용');
    expect(t.fit.find((f) => f.key === 'report')!.missing).toEqual([]);
    expect(t.fit.find((f) => f.key === 'official-letter')!.missing).toEqual(expect.arrayContaining(['수신', '발신명의']));
    // 같은 파일을 다시 올리면 같은 판
    expect((await admin.registerOrgTemplate(ctx, adminActor, { name: '다시', fileName: 'again.hwpx', bytes })).id).toBe(t.id);

    await expect(admin.attestOrgTemplate(ctx, adminActor, t.id, '확인')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const attested = await admin.attestOrgTemplate(ctx, adminActor, t.id, '한글 2022에서 시험 파일을 열어 쪽 배치 확인');
    expect(attested).toMatchObject({ status: 'verified', label: '자동 검사 통과 · 관리자가 한글에서 확인함' });
    expect(attested.verification).toMatchObject({ kind: 'admin-attested', automated: false, by: adminActor.userId });

    // 직원 화면: 이 양식으로 보고서 작업을 만들 수 있다
    const task = await svc.createTask(ctx, staff, { workflowKey: 'report', title: '기관 양식 보고서', form: { reportType: '진행 현황', period: '2026년 3분기' }, templateVersionId: t.id });
    expect(task.template_version_id).toBe(t.id);
    expect((await svc.listTemplates(ctx, staff)).organization.map((o) => o.label)).toContain('자동 검사 통과 · 관리자가 한글에서 확인함');

    await admin.retireOrgTemplate(ctx, adminActor, t.id);
    await expect(svc.createTask(ctx, staff, { workflowKey: 'report', title: 'x', form: { reportType: '진행 현황', period: 'x' }, templateVersionId: t.id })).rejects.toMatchObject({ code: 'TEMPLATE_MISSING' });
    // 이미 만든 작업은 그대로 열린다
    expect((await svc.getTaskDetail(ctx, staff, task.id)).template?.id).toBe(t.id);
    // 기관 단위 사건은 작업 없이 남는다
    const { rows } = await pool.query("SELECT type FROM work_events WHERE organization_id = $1 AND task_id IS NULL ORDER BY id", [orgId]);
    expect(rows.map((r) => r.type)).toEqual(expect.arrayContaining(['template.registered', 'template.attested', 'template.retired']));
  });

  it('대화 비서의 기관 양식(agent_templates)을 업무 양식으로 가져온다 — 같은 기관 것만', async () => {
    const agentId = randomUUID();
    const tplId = randomUUID();
    await pool.query("INSERT INTO agents (id, department_id, organization_id, name, tier) VALUES ($1, $2, $3, '회의록 비서', 'official')", [agentId, deptId, orgId]);
    const storage = `agent-templates/${orgId}/${tplId}.hwpx`;
    const bytes = readFileSync(path.join(BUILTIN_TEMPLATE_DIR, 'minutes.hwpx'));
    await ctx.files.put(storage, bytes, 'application/hwp+zip');
    // 새 양식 행은 꺼진 채(retired_at = now())로 들어가고 비서 저장(save_agent)이 켠다 — 쓰는 중인 양식으로 넣는다
    await pool.query('INSERT INTO agent_templates (id, agent_id, name, storage_path, file_name, size_bytes, retired_at) VALUES ($1, $2, $3, $4, $5, $6, NULL)', [tplId, agentId, '기관 회의록', storage, '회의록.hwpx', bytes.length]);
    const before = await admin.listAdminTemplates(ctx, adminActor);
    expect(before.chatTemplates.find((c) => c.id === tplId)).toMatchObject({ imported: false, agentName: '회의록 비서' });
    const t = await admin.importAgentTemplate(ctx, adminActor, tplId);
    expect(t).toMatchObject({ source: 'agent_template', status: 'mapped' });
    expect((await admin.listAdminTemplates(ctx, adminActor)).chatTemplates.find((c) => c.id === tplId)!.imported).toBe(true);
    await expect(admin.importAgentTemplate(ctx, adminActor, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('업무 비서 끄기 — 목록에서 시작할 수 없고 새 작업은 막히지만 이미 만든 작업은 열린다. 현황은 숫자만', async () => {
    const existing = await svc.createTask(ctx, staff, { workflowKey: 'meeting', title: '끄기 전 회의', form: { meetingName: '끄기 전 회의' } });
    const after = await admin.setInstallation(ctx, adminActor, 'meeting', false);
    expect(after.find((w) => w.key === 'meeting')!.status).toBe('disabled');
    await expect(admin.setInstallation(ctx, staff, 'meeting', true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const list = await svc.listWorkflowsForActor(ctx, staff);
    expect(list.workflows.find((w) => w.key === 'meeting')).toMatchObject({ available: false, reason: expect.stringContaining('기관에서') });
    await expect(svc.createTask(ctx, staff, { workflowKey: 'meeting', title: 'x', form: { meetingName: 'x' } })).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    expect((await svc.getTaskDetail(ctx, staff, existing.id)).task.id).toBe(existing.id);
    await admin.setInstallation(ctx, adminActor, 'meeting', true);
    expect((await svc.listWorkflowsForActor(ctx, staff)).workflows.find((w) => w.key === 'meeting')!.available).toBe(true);

    const overview = await admin.workOverview(ctx, adminActor);
    expect(overview.find((o) => o.workflow_key === 'meeting')).toMatchObject({ name: '회의·위원회 정리', tasks: 1 });
    expect(JSON.stringify(overview)).not.toContain('끄기 전 회의'); // 제목·내용 없음
    await expect(admin.workOverview(ctx, staff)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('M4 — 대화에서 만든 파일·대화 첨부를 본인만 원자료로 가져오고, 원래 기록이 사라져도 원자료는 남는다', async () => {
    const convId = randomUUID();
    await pool.query('INSERT INTO conversations (id, department_id, user_id) VALUES ($1, $2, $3)', [convId, deptId, staff.userId]).catch(async () => {
      await pool.query('INSERT INTO conversations (id, department_id) VALUES ($1, $2)', [convId, deptId]);
    });
    const genId = randomUUID();
    const gpath = `generated/${orgId}/${convId}/${genId}.txt`;
    const text = Buffer.from('3분기 사업 실적: 집행액 1,850,000원', 'utf8');
    await ctx.files.put(gpath, text, 'text/plain');
    await pool.query(
      "INSERT INTO generated_files (id, conversation_id, user_id, department_id, organization_id, template_ref, template_name, file_name, mime_type, size_bytes, storage_path) VALUES ($1,$2,$3,$4,$5,'builtin:report','보고서','실적 요약.txt','text/plain',$6,$7)",
      [genId, convId, staff.userId, deptId, orgId, text.length, gpath]
    );
    const list = await svc.listLegacyFiles(ctx, staff);
    expect(list.map((f) => [f.kind, f.file_name])).toEqual([['generated', '실적 요약.txt']]);
    expect(await svc.listLegacyFiles(ctx, other)).toEqual([]);

    const task = await svc.createTask(ctx, staff, { workflowKey: 'report', title: '대화 결과로 보고서', form: { reportType: '진행 현황', period: '2026년 3분기' } });
    expect(task.status).toBe('draft');
    const otherTask = await svc.createTask(ctx, other, { workflowKey: 'report', title: '남의 것 가져오기', form: { reportType: '진행 현황', period: 'x' } });
    await expect(svc.importLegacyFile(ctx, other, otherTask.id, { kind: 'generated', id: genId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const src = await svc.importLegacyFile(ctx, staff, task.id, { kind: 'generated', id: genId });
    expect(src).toMatchObject({ status: 'ready', origin: { type: 'chat_generated_file', id: genId } });
    expect((await ctx.store.getTask(task.id, orgId))!.status).toBe('ready');
    // 같은 파일을 두 번 가져와도 하나
    expect((await svc.importLegacyFile(ctx, staff, task.id, { kind: 'generated', id: genId })).id).toBe(src.id);
    // 원래 대화 결과 기록·객체가 지워져도 이 작업의 원자료는 남는다(복사본)
    await pool.query('DELETE FROM generated_files WHERE id = $1', [genId]);
    await ctx.files.remove([gpath]);
    const d = await svc.getTaskDetail(ctx, staff, task.id);
    expect(d.sources.find((s) => s.id === src.id)?.status).toBe('ready');
    // 원래 기록이 사라진 뒤 다시 가져오기는 '없음'(06 문서 M4 — 원본이 지워지면 실패로 안내)
    await expect(svc.importLegacyFile(ctx, staff, task.id, { kind: 'generated', id: genId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(svc.importLegacyFile(ctx, staff, task.id, { kind: 'attachment', id: randomUUID() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
