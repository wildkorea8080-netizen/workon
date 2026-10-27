import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import JSZip from 'jszip';
import { createPgWorkStore } from '@/lib/work/store/pg';
import { createLocalWorkFiles } from '@/lib/work/files';
import { unavailableRenderer } from '@/lib/work/documents/renderer';
import { mockGenerator } from '@/lib/work/generation/compose';
import type { WorkContext } from '@/lib/work/context';
import type { WorkStore } from '@/lib/work/store/types';
import type { WorkActor } from '@/lib/work/types';
import type { RegulationProviders } from '@/lib/work/workflows/regulations/gather';
import type { RegulationModel } from '@/lib/work/workflows/regulations/model';
import type { RawEvidence } from '@/lib/work/workflows/regulations/evidence';
import * as svc from '@/lib/work/services';
import { runWorker } from '@/lib/work/runs/worker';
import { checkPackage } from '@/lib/work/documents/package-check';

/**
 * 규정·지침 확인 흐름 — 실제 서비스·실행기·채우기 엔진·Postgres(0034)·실제 근거 검토 메모 양식(한글로 만든 HWPX).
 * 근거 제공자(NODA·법제처)와 모델만 가짜다. 시나리오 A16: 구규정(기준일 뒤 개정)·최신 규정·타 기관 규정.
 */
const url = process.env.WORK_TEST_DATABASE_URL;
const key = () => `k-${randomUUID()}`;

const ev = (over: Partial<RawEvidence>): RawEvidence => ({
  kind: 'law', title: '공무원 여비 규정', location: '제17조(숙박비)', effectiveDate: '2026-01-01', editionYear: null, issuer: null,
  text: '숙박비는 1박 70,000원 상한액 범위에서 실비로 지급한다.', url: 'https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=1', ...over,
});

class FakeProviders implements RegulationProviders {
  failLaws = 0;
  async orgDocuments() {
    return { status: 'ok' as const, items: [ev({ kind: 'org_doc', title: '가상기관 여비 지침', location: 'p.3 · 제2장 › 숙박', effectiveDate: null, url: null, text: '출장 숙박은 사전에 부서장 승인을 받는다.' })] };
  }
  async common() {
    return { status: 'ok' as const, items: [ev({ kind: 'common', title: '지방공기업 예산편성기준', location: 'p.40', effectiveDate: null, editionYear: 2026, url: null, text: '여비는 실비 정산을 원칙으로 한다.' })] };
  }
  async laws() {
    if (this.failLaws > 0) {
      this.failLaws -= 1;
      throw new Error('법제처 시간 초과');
    }
    return {
      status: 'ok' as const,
      items: [
        ev({}),
        ev({ title: '공무원 여비 규정(개정)', effectiveDate: '2027-01-01', text: '숙박비는 정액 90,000원으로 지급한다.' }),
        ev({ kind: 'ordinance', title: '다라시 공무원 여비 조례', issuer: '다라시', location: null, text: '(다른 지자체의 자치법규 — 본문을 가져오지 않음)', url: null }),
      ],
    };
  }
}

class FakeModel implements RegulationModel {
  plans = 0;
  reviews = 0;
  async plan() {
    this.plans += 1;
    return { plan: { searchQuery: '숙박비 상한 초과', lawQueries: ['여비'], keywords: ['숙박비'] }, usage: { model: 'claude-sonnet-4-6', input_tokens: 50, output_tokens: 20 }, mode: 'llm' as const };
  }
  async review() {
    this.reviews += 1;
    return {
      draft: {
        findings: [
          { text: '숙박비는 1박 70,000원 상한 범위에서 실비로 지급함', evidenceIds: ['E4'] },
          { text: '출장 숙박은 부서장 사전 승인이 필요함', evidenceIds: ['E1'] },
          // 기준일 뒤 개정(E5)·다른 지자체(E6)만 댄 판단, 근거 없는 판단 → 유보로 가야 한다
          { text: '정액 90,000원을 지급함', evidenceIds: ['E5'] },
          { text: '다라시 조례에 따라 초과분을 지급함', evidenceIds: ['E6'] },
          { text: '상한 초과분은 지급할 수 있음', evidenceIds: [] },
        ],
        reservations: [{ text: '상한 초과 차액의 예외 요건' }],
      },
      usage: { model: 'claude-sonnet-4-6', input_tokens: 400, output_tokens: 120 },
      mode: 'llm' as const,
    };
  }
}

describe.skipIf(!url)('규정·지침 확인 흐름(실제 Postgres·실제 메모 양식)', () => {
  let pool: pg.Pool;
  let store: WorkStore;
  let ctx: WorkContext;
  let providers: FakeProviders;
  let model: FakeModel;
  let actor: WorkActor;
  let orgId: string;
  const filesRoot = mkdtempSync(path.join(tmpdir(), 'workon-reg-'));

  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    pool = new pg.Pool({ connectionString: url, max: 5 });
    store = createPgWorkStore(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    providers = new FakeProviders();
    model = new FakeModel();
    orgId = randomUUID();
    const deptId = randomUUID();
    const userId = randomUUID();
    await pool.query('INSERT INTO organizations (id, name, type) VALUES ($1, $2, $3)', [orgId, '가나시청', '지방자치단체']);
    await pool.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '총무과', `d-${deptId.slice(0, 8)}`, orgId]);
    await pool.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
    await pool.query('INSERT INTO work_org_settings (organization_id, home_enabled, new_tasks_enabled) VALUES ($1, true, true)', [orgId]);
    actor = { userId, organizationId: orgId, departmentId: deptId, isAdmin: false, managedDepartmentIds: [] };
    ctx = {
      store,
      files: createLocalWorkFiles(filesRoot),
      generator: mockGenerator,
      generatorMode: 'llm',
      renderer: unavailableRenderer,
      regulations: { providers, model },
      resolveModel: async () => 'claude-sonnet-4-6',
      checkLimit: async () => ({ allowed: true }),
      log: async (p) => { if (p.level === 'error') console.error('[work-log]', JSON.stringify(p.details)); },
      now: () => new Date('2026-10-27T01:00:00Z'),
    };
  });

  const form = { question: '출장 숙박비가 상한을 넘으면 차액을 지급할 수 있는가', basisDate: '2026-10-27', scope: '국내 출장 여비' };

  async function generated() {
    const task = await svc.createTask(ctx, actor, { workflowKey: 'regulations', title: '숙박비 상한 초과 지급 검토', form });
    expect(task.status).toBe('ready');
    const r = await svc.requestGenerate(ctx, actor, task.id, { baseVersion: 0, idempotencyKey: key() });
    return { task, runId: r.run.id };
  }

  it('A16 — 기준일 뒤 개정·다른 지자체 근거는 빼고 유보로, 위치는 자료 정보로만 쓴 메모 HWPX를 만든다', async () => {
    const { task, runId } = await generated();
    await runWorker(ctx, { workerId: 'w1', runId });
    const d = await svc.getTaskDetail(ctx, actor, task.id);
    expect(d.task.status).toBe('needs_review');
    const reg = d.version!.regulations!;
    expect(reg.evidence.map((e) => [e.id, e.kind, e.applicability])).toEqual([
      ['E1', 'org_doc', 'date_unknown'],
      ['E2', 'common', 'applicable'],
      ['E3', 'law', 'applicable'],
      ['E4', 'law', 'after_basis'],
      ['E5', 'ordinance', 'other_org'],
    ]);
    // FakeModel은 번호를 한 칸씩 밀어 댔다(E4=개정·E5=다른 지자체·E6=없음) — 프로그램이 판정대로 거른다
    expect(reg.findings.map((f) => f.text)).toEqual(['출장 숙박은 부서장 사전 승인이 필요함']);
    expect(reg.reservations.map((r) => r.text)).toEqual([
      '숙박비는 1박 70,000원 상한 범위에서 실비로 지급함',
      '정액 90,000원을 지급함',
      '다라시 조례에 따라 초과분을 지급함',
      '상한 초과분은 지급할 수 있음',
      '상한 초과 차액의 예외 요건',
    ]);
    const field = (label: string) => d.version!.fields.find((f) => f.label === label)!;
    expect(field('검토 의견').value).toBe('○ 출장 숙박은 부서장 사전 승인이 필요함 [E1] (시행일 확인 필요)');
    expect(field('검토 의견').origin).toBe('ai');
    expect(field('근거').origin).toBe('system');
    // 근거·유보는 여러 줄 칸이다(한 줄 칸이면 목록이 한 줄로 붙는다 — 로그인 화면 확인에서 찾음)
    expect(field('근거').type).toBe('paragraph');
    expect(field('근거').value.split('\n').length).toBe(5);
    expect(field('유보·확인 필요').value.split('\n').length).toBe(5);
    expect(field('근거').value).toContain('[E1] 가상기관 여비 지침 · p.3 · 제2장 › 숙박 (기관 문서, 시행일 확인 필요)');
    expect(field('근거').value).toMatch(/\[E4\] 공무원 여비 규정\(개정\) .* — 제외: 시행일\(2027-01-01\)/);
    expect(field('근거').value).toContain('[E5] 다라시 공무원 여비 조례 (자치법규, 시행 2026-01-01) — 제외: 다른 지자체의 자치법규입니다(다라시)');
    expect(field('작성부서').value).toBe('총무과');
    expect(field('작성일').value).toBe('2026. 10. 27.');
    expect(field('적용 기준').value).toBe('적용 기준일 2026-10-27 · 범위: 국내 출장 여비');
    expect(d.review.map((i) => i.code)).toEqual(expect.arrayContaining(['RESERVED', 'EFFECTIVE_DATE_UNKNOWN', 'EVIDENCE_EXCLUDED']));
    expect(d.review.some((i) => i.severity === 'blocking')).toBe(false);

    // 결과 파일 — 한글로 만든 메모 양식에 채운 진짜 HWPX, 위치 글이 그대로 들어감
    const art = d.currentArtifacts[0];
    expect(art).toMatchObject({ format: 'hwpx', validation_status: 'valid' });
    const bytes = readFileSync(path.join(filesRoot, ...((await store.getArtifact(art.id, orgId))!.storage_path.split('/'))));
    expect((await checkPackage(bytes, { format: 'hwpx' })).valid).toBe(true);
    const zip = await JSZip.loadAsync(bytes);
    const section = await zip.file('Contents/section0.xml')!.async('string');
    expect(section).toContain('제17조(숙박비)');
    expect(section).toContain('부서장 사전 승인');
    expect(section).not.toContain('{{');

    // 과금 규약 — 모델 두 번(찾을 말·의견 초안) 모두 모델·토큰·원가·단계
    const { rows } = await pool.query("SELECT details FROM usage_logs WHERE resource_id = $1 AND action = 'work_generate' ORDER BY created_at", [runId]);
    expect(rows.map((r) => r.details.stage)).toEqual(['plan', 'review']);
    expect(rows.every((r) => r.details.model === 'claude-sonnet-4-6' && typeof r.details.cost_krw === 'number')).toBe(true);
  });

  it('법제처가 실패하면 근거 일부로 메모를 만들지 않고 다시 시도한다 — 끝난 단계(찾을 말 정하기)는 모델을 다시 부르지 않는다', async () => {
    providers.failLaws = 1;
    const { task, runId } = await generated();
    const first = await runWorker(ctx, { workerId: 'w1', runId });
    expect(first[0]).toMatchObject({ finish: 'requeued', error: { code: 'SOURCE_UNAVAILABLE', retryable: true } });
    expect((await svc.getTaskDetail(ctx, actor, task.id)).version).toBeNull();
    await pool.query('UPDATE work_runs SET available_at = now() WHERE id = $1', [runId]);
    await runWorker(ctx, { workerId: 'w2', runId });
    const d = await svc.getTaskDetail(ctx, actor, task.id);
    expect(d.version?.regulations?.evidence).toHaveLength(5);
    expect(model.plans).toBe(1);
    expect(model.reviews).toBe(1);
  });

  it('직원이 의견을 고쳐 저장해도 그 판의 근거 판정(유보·제외)은 확인 사항으로 다시 걸린다', async () => {
    const { task, runId } = await generated();
    await runWorker(ctx, { workerId: 'w1', runId });
    const d = await svc.getTaskDetail(ctx, actor, task.id);
    const opinion = d.version!.fields.find((f) => f.label === '검토 의견')!;
    const s = await svc.saveDocument(ctx, actor, task.id, { baseVersion: 1, patches: [{ fieldId: opinion.id, operation: 'set_value', value: '○ 부서장 사전 승인 필요 [E1]' }] });
    await runWorker(ctx, { workerId: 'w1', runId: s.run!.id });
    const after = await svc.getTaskDetail(ctx, actor, task.id);
    expect(after.version!.version).toBe(2);
    expect(after.version!.regulations!.reservations.length).toBe(5);
    expect(after.review.map((i) => i.code)).toEqual(expect.arrayContaining(['RESERVED', 'EVIDENCE_EXCLUDED']));
    expect(after.currentArtifacts[0]).toMatchObject({ validation_status: 'valid' });
  });

  it('필수 입력(기준일)이 없으면 만들 준비가 안 된다', async () => {
    const task = await svc.createTask(ctx, actor, { workflowKey: 'regulations', title: '기준일 없음', form: { question: 'q', scope: 's' } });
    expect(task.status).toBe('draft');
    await expect(svc.requestGenerate(ctx, actor, task.id, { baseVersion: 0, idempotencyKey: key() })).rejects.toMatchObject({ code: 'REQUIRED_INPUT_MISSING' });
  });
});
