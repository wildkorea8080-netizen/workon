import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import type { ActorScope } from '@/lib/agent-permissions';
import { AttachmentReadError } from '@/lib/attachments/reader';
import { MAX_UPLOAD_BYTES } from '@/lib/file-types';
import { appAttachmentMaterial } from '@/lib/apps/attachment-context';
import { validateAppDefinition } from '@/lib/apps/definition';
import {
  libraryOption, loadLibraryDocuments, parseLibraryIds, selectableLibraryDocuments, type LibraryDeps, type LibraryDocumentRow,
} from '@/lib/apps/library-documents';
import { toggleLibraryPick } from '@/components/apps/AppLibraryPicker';

/**
 * 입력형 앱의 '문서함에서 고르기'(2026-11-05) — 그 앱 비서의 참고 문서를 골라 원자료로 쓴다.
 * 가장 비싼 오류: 다른 비서·볼 수 없는 문서·근거가 아닌 판(지난 판·시행일 전인 새 판)이 원자료로 들어가는 것.
 */

const AGENT = 'aaaaaaaa-0000-4000-8000-000000000001';
const D1 = '11111111-0000-4000-8000-000000000001';
const D2 = '11111111-0000-4000-8000-000000000002';
const D3 = '11111111-0000-4000-8000-000000000003';
const actor: ActorScope = { userId: 'u', isAdmin: false, departmentId: 'dept', organizationId: 'org', visibleDepartmentIds: ['dept'], managedDepartmentIds: [], managesWholeOrganization: false };

function row(over: Partial<LibraryDocumentRow>): LibraryDocumentRow {
  return {
    id: D1, agent_id: AGENT, department_id: 'dept', organization_id: 'org', visibility: 'organization', storage_path: `p/${over.id ?? D1}`,
    file_name: '여비규정.hwpx', file_type: 'hwpx', title: '여비 규정', noda_status: 'ready', replaces_id: null, effective_from: null, retired_at: null, ...over,
  };
}

describe('고를 수 있는 문서', () => {
  it('이 비서의 읽힌 현재 판 중 볼 수 있는 것만', () => {
    const rows = [
      row({ id: D1 }),
      row({ id: D2, agent_id: 'other-agent' }),
      row({ id: D3, noda_status: 'reading' }),
      row({ id: '11111111-0000-4000-8000-000000000004', noda_status: 'retired', retired_at: '2026-11-01T00:00:00Z' }),
      row({ id: '11111111-0000-4000-8000-000000000005', visibility: 'department', department_id: 'secret' }),
      row({ id: '11111111-0000-4000-8000-000000000006', organization_id: 'other-org' }),
      row({ id: '11111111-0000-4000-8000-000000000007', storage_path: null }),
    ];
    expect(selectableLibraryDocuments(rows, AGENT, actor, '2026-11-05').map((r) => r.id)).toEqual([D1]);
  });

  it('판·시행일 규칙 — 시행일 전인 새 판은 못 고르고 옛 판을 고른다, 시행일부터는 반대', () => {
    const rows = [row({ id: D1, title: '옛 판' }), row({ id: D2, title: '새 판', replaces_id: D1, effective_from: '2027-01-01' })];
    expect(selectableLibraryDocuments(rows, AGENT, actor, '2026-12-31').map((r) => r.title)).toEqual(['옛 판']);
    expect(selectableLibraryDocuments(rows, AGENT, actor, '2027-01-01').map((r) => r.title)).toEqual(['새 판']);
  });

  it('화면 한 줄에는 저장소 경로가 없다', () => {
    const o = libraryOption(row({ title: '  ', effective_from: '2026-01-01' }));
    expect(o).toEqual({ id: D1, title: '여비규정.hwpx', file_type: 'hwpx', effective_from: '2026-01-01' });
  });

  it('요청 값 — uuid 배열만, 겹치면 거절, 없으면 빈 배열', () => {
    expect(parseLibraryIds(undefined)).toEqual([]);
    expect(parseLibraryIds([D1.toUpperCase()])).toEqual([D1]);
    expect(parseLibraryIds([D1, D1])).toBeNull();
    expect(parseLibraryIds(['x'])).toBeNull();
    expect(parseLibraryIds(D1)).toBeNull();
  });
});

describe('고른 문서 읽기', () => {
  const texts: Record<string, string> = { [`p/${D1}`]: '일비 20,000원', [`p/${D2}`]: '숙박비 실비' };
  const deps = (rows: LibraryDocumentRow[], over: Partial<LibraryDeps> = {}): LibraryDeps & { read: ReturnType<typeof vi.fn> } => ({
    documentsOf: vi.fn(async (agentId: string, org: string) => rows.filter((r) => r.agent_id === agentId && r.organization_id === org)),
    download: vi.fn(async (p: string) => (texts[p] ? new TextEncoder().encode(texts[p]) : null)),
    read: vi.fn(async (b: Buffer) => ({ kind: 'document' as const, text: b.toString('utf8'), tables: [], warnings: [] })),
    ...over,
  }) as LibraryDeps & { read: ReturnType<typeof vi.fn> };

  it('고른 순서대로 읽어 첨부 원자료와 같은 꼴로 돌려준다(이름은 문서 제목)', async () => {
    const out = await loadLibraryDocuments([D2, D1], AGENT, actor, deps([row({ id: D1 }), row({ id: D2, title: '숙박 기준' })]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.files.map((f) => [f.name, f.extract.text])).toEqual([['숙박 기준', '숙박비 실비'], ['여비 규정', '일비 20,000원']]);
    expect(out.refs).toEqual([{ id: D2, title: '숙박 기준' }, { id: D1, title: '여비 규정' }]);
    // 첨부와 같은 원자료 자리에 들어간다
    const material = appAttachmentMaterial(out.files);
    expect(material.context).toContain('일비 20,000원');
  });

  it('하나라도 고를 수 없는 문서면 아무것도 읽지 않는다', async () => {
    const d = deps([row({ id: D1 }), row({ id: D2, noda_status: 'failed' })]);
    expect(await loadLibraryDocuments([D1, D2], AGENT, actor, d)).toMatchObject({ ok: false, status: 400 });
    expect(d.download).not.toHaveBeenCalled();
    // 다른 비서의 문서 id를 넣어도
    expect(await loadLibraryDocuments([D1], 'aaaaaaaa-0000-4000-8000-000000000009', actor, deps([row({ id: D1 })]))).toMatchObject({ ok: false, status: 400 });
  });

  it('원본이 없거나 크거나 읽지 못하면 문서 이름과 함께 거절한다', async () => {
    expect(await loadLibraryDocuments([D3], AGENT, actor, deps([row({ id: D3 })]))).toEqual({ ok: false, status: 404, message: '여비 규정: 원본 파일을 찾을 수 없습니다.' });
    const big = deps([row({ id: D1 })], { download: vi.fn(async () => new Uint8Array(MAX_UPLOAD_BYTES + 1)) });
    expect(await loadLibraryDocuments([D1], AGENT, actor, big)).toMatchObject({ ok: false, status: 413 });
    const broken = deps([row({ id: D1 })], { read: vi.fn(async () => { throw new AttachmentReadError('파일에서 읽을 글이 없습니다.'); }) });
    expect(await loadLibraryDocuments([D1], AGENT, actor, broken)).toEqual({ ok: false, status: 400, message: '여비 규정: 파일에서 읽을 글이 없습니다.' });
  });

  it('읽기 경고가 있는 문서는 첨부처럼 원자료에서 거절된다(일부만 읽힌 자료를 숨기지 않음)', async () => {
    const warned = deps([row({ id: D1 })], { read: vi.fn(async () => ({ kind: 'document' as const, text: '글', tables: [], warnings: ['글자 인식(OCR)으로 읽었습니다'] })) });
    const out = await loadLibraryDocuments([D1], AGENT, actor, warned);
    expect(out.ok).toBe(true);
    if (out.ok) expect(() => appAttachmentMaterial(out.files)).toThrow('읽기 경고');
  });

  it('없으면 아무것도 부르지 않는다', async () => {
    const d = deps([]);
    expect(await loadLibraryDocuments([], AGENT, actor, d)).toEqual({ ok: true, files: [], refs: [] });
    expect(d.documentsOf).not.toHaveBeenCalled();
  });
});

describe('앱 설정', () => {
  const base = { schemaVersion: 1, fields: [{ key: 'q', label: '질문', type: 'text', required: true }], output: 'paragraphs' };
  it('문서 고르기 허용은 참거짓만, 거짓이면 칸을 두지 않는다', () => {
    const on = validateAppDefinition({ ...base, attachments: { required: true, library: true } });
    expect(on.ok && on.value?.attachments).toEqual({ required: true, library: true });
    const off = validateAppDefinition({ ...base, attachments: { required: false, library: false } });
    expect(off.ok && off.value?.attachments).toEqual({ required: false });
    expect(validateAppDefinition({ ...base, attachments: { required: false, library: 'yes' } }).ok).toBe(false);
  });
});

describe('연결 (원본)', () => {
  const prepare = readFileSync('src/lib/assistant/prepare.ts', 'utf8');
  const stream = readFileSync('src/lib/assistant/stream.ts', 'utf8');
  const persist = readFileSync('src/lib/assistant/persist.ts', 'utf8');
  const route = readFileSync('src/app/api/apps/library/route.ts', 'utf8');
  const run = readFileSync('src/app/apps/run/page.tsx', 'utf8');

  it('새 앱 실행에서 앱이 허용할 때만, 대화를 만들기 전에 읽는다', () => {
    expect(prepare).toContain("if (libraryIds.length && (!appStepInputs || !definition.value?.attachments?.library || conversation_id))");
    expect(prepare.indexOf('await loadLibraryDocuments(')).toBeGreaterThan(0);
    expect(prepare.indexOf('await loadLibraryDocuments(')).toBeLessThan(prepare.indexOf('// ── 대화 ──'));
    // 비서·기관으로 한정해 문서 행을 읽는다
    expect(prepare).toContain(".eq('agent_id', agentId)\n          .eq('organization_id', organizationId)");
  });

  it('올린 파일과 합쳐 앱 상한, 필수면 둘 중 하나 이상, 고른 문서가 있으면 이어 실행하지 않는다', () => {
    expect(prepare).toContain('if (sentIds.length + libraryIds.length > APP_MAX_FILES)');
    expect(prepare).toContain('!sentIds.length && !libraryIds.length');
    expect(prepare).toContain('attachment_ids.length : 0) + libraryIds.length)');
    expect(stream).toContain('turn.ctx.attachments.length + (turn.appDocuments?.length ?? 0)');
  });

  it('답변 행에는 고른 문서의 id·이름만 남긴다', () => {
    expect(persist).toContain("...(input.appDocuments?.length ? { app_documents: input.appDocuments } : {}),");
  });

  it('목록 주소 — 로그인·앱 사용 권한·허용 확인 뒤 이 비서·기관의 문서만', () => {
    expect(route).toContain('getServerAuthSession');
    expect(route).toContain('canUseAgent(row, actor)');
    expect(route).toContain("if (!allowed) return jsonError('이 앱은 문서함에서 문서를 고를 수 없습니다.', 400)");
    expect(route).toContain(".eq('agent_id', row.id)\n      .eq('organization_id', actor.organizationId)");
    expect(route).toContain('.map(libraryOption)');
  });

  it('실행 화면 — 고른 문서를 보내고, 고르면 이어 실행을 막는다', () => {
    expect(run).toContain('...(pickedDocs.length ? { app_document_ids: pickedDocs } : {})');
    expect(run).toContain("|| pickedDocs.length > 0;");
  });

  it('고르기 — 남은 자리까지만 더하고, 다시 누르면 뺀다', () => {
    expect(toggleLibraryPick([], 'a', 1)).toEqual(['a']);
    expect(toggleLibraryPick(['a'], 'b', 1)).toEqual(['a']);
    expect(toggleLibraryPick(['a', 'b'], 'a', 3)).toEqual(['b']);
  });
});
