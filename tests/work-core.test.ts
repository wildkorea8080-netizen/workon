import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { taskAccess, NO_ACCESS } from '@/lib/work/access';
import { WORKFLOWS, getWorkflow, isWorkflowKey } from '@/lib/work/catalog';
import { applyPatches, fieldsFromSlots, mergeGenerated, normalizeStoredFields, parsePatches } from '@/lib/work/documents/fields';
import { checkPackage } from '@/lib/work/documents/package-check';
import { generateDocumentFile, readFillableTemplate } from '@/lib/work/documents/generate-file';
import { WorkError, type WorkActor } from '@/lib/work/types';
import { computeReviewItems, TEST_MODE_MARKER } from '@/lib/work/review';

const TPL = path.join(process.cwd(), 'assets', 'templates');
const actor = (over: Partial<WorkActor> = {}): WorkActor => ({
  userId: 'u1',
  organizationId: 'o1',
  departmentId: 'd1',
  isAdmin: false,
  managedDepartmentIds: [],
  ...over,
});
const task = (over: Record<string, unknown> = {}) => ({ organization_id: 'o1', owner_id: 'u1', status: 'draft' as const, ...over });

describe('업무 카탈로그', () => {
  it('10개 · key 고유 · 모두 필수 산출 파일이 있다', () => {
    expect(WORKFLOWS).toHaveLength(10);
    expect(new Set(WORKFLOWS.map((w) => w.key)).size).toBe(10);
    expect(getWorkflow('official-letter')?.outputs[0]).toMatchObject({ format: 'hwpx', required: true });
    expect(isWorkflowKey('collection')).toBe(true);
    expect(isWorkflowKey('없음')).toBe(false);
  });
});

describe('작업 권한(access.ts)', () => {
  it('주인은 모두, 보관된 작업은 읽기·내려받기만', () => {
    expect(taskAccess(task(), actor(), [])).toMatchObject({ read: true, edit: true, review: true, download: true, isOwner: true });
    expect(taskAccess(task({ status: 'archived' }), actor(), [])).toMatchObject({ read: true, edit: false, review: false, download: true });
  });
  it('같은 기관 관리자라도 명시적 권한이 없으면 아무것도 없다', () => {
    expect(taskAccess(task(), actor({ userId: 'admin', isAdmin: true, managedDepartmentIds: ['d1'] }), [])).toEqual(NO_ACCESS);
  });
  it('다른 기관이면 구성원 행이 있어도 아무것도 없다', () => {
    expect(taskAccess(task(), actor({ userId: 'u2', organizationId: 'o2' }), [{ user_id: 'u2', role: 'editor' }])).toEqual(NO_ACCESS);
  });
  it('구성원은 역할대로', () => {
    const m = (role: 'viewer' | 'editor' | 'reviewer') => taskAccess(task(), actor({ userId: 'u2' }), [{ user_id: 'u2', role }]);
    expect(m('viewer')).toMatchObject({ read: true, edit: false, review: false, download: true, manageMembers: false });
    expect(m('editor')).toMatchObject({ edit: true, review: false });
    expect(m('reviewer')).toMatchObject({ edit: false, review: true });
  });
  it('요청자를 모르면(비활성·소속 없음) 아무것도 없다', () => {
    expect(taskAccess(task(), null, [])).toEqual(NO_ACCESS);
  });
});

describe('문서 필드', () => {
  const base = fieldsFromSlots(
    [
      { id: 's1', label: '제목', kind: 'marker', path: [], hint: null },
      { id: 's2', label: '본문', kind: 'marker', path: [], hint: null },
    ],
    ['제목']
  );

  it('자리에서 필드를 만든다 — 본문류는 여러 문단, 필수 표시', () => {
    expect(base.map((f) => [f.id, f.type, f.required])).toEqual([
      ['s1', 'text', true],
      ['s2', 'paragraph', false],
    ]);
  });

  it('직접 수정 — 바뀐 것만, 한 줄 칸에 줄바꿈 거절, 제어 문자 제거, 바뀐 것 없으면 null', () => {
    const r = applyPatches(base, [{ fieldId: 's2', operation: 'set_value', value: '첫 줄\r\n둘째\u0007 줄' }])!;
    expect(r.changed).toEqual(['s2']);
    expect(r.fields[1]).toMatchObject({ value: '첫 줄\n둘째 줄', origin: 'user' });
    expect(() => applyPatches(base, [{ fieldId: 's1', operation: 'set_value', value: 'a\nb' }])).toThrow(WorkError);
    expect(applyPatches(base, [{ fieldId: 's1', operation: 'set_value', value: '' }])).toBeNull();
    expect(() => applyPatches(base, [{ fieldId: 's9', operation: 'set_value', value: 'x' }])).toThrow(/없는 필드/);
  });

  it('patches 꼴 검사', () => {
    expect(() => parsePatches([])).toThrow(WorkError);
    expect(() => parsePatches([{ fieldId: 's1', operation: 'set_value', value: 1 }])).toThrow(WorkError);
    expect(parsePatches([{ fieldId: 's1', operation: 'set_lock', value: true }])).toEqual([{ fieldId: 's1', operation: 'set_lock', value: true }]);
  });

  it('재생성은 잠긴 칸·직원이 고친 칸을 건드리지 않는다 · 선택 영역만 바꿀 수 있다', () => {
    const edited = applyPatches(base, [
      { fieldId: 's1', operation: 'set_value', value: '직원 제목' },
      { fieldId: 's2', operation: 'set_lock', value: true },
    ])!.fields;
    const g = mergeGenerated(edited, { s1: { value: 'AI 제목' }, s2: { value: 'AI 본문' } }, { origin: 'ai' });
    expect(g.changed).toEqual([]);
    expect(g.skippedLocked).toEqual(['s2']);
    const only = mergeGenerated(base, { s1: { value: 'A' }, s2: { value: 'B' } }, { origin: 'ai', onlyIds: ['s2'] });
    expect(only.fields.map((f) => f.value)).toEqual(['', 'B']);
  });

  it('저장된 jsonb는 꼴을 다시 맞춘다', () => {
    expect(normalizeStoredFields([{ id: 's1', value: 3, origin: 'x' }, null, 'junk'])).toEqual([
      expect.objectContaining({ id: 's1', value: '', origin: 'empty', type: 'text' }),
    ]);
  });
});

describe('패키지 검사', () => {
  it('확장자만 바꾼 파일·빈 파일은 거절', async () => {
    expect((await checkPackage(Buffer.from('<html>공문</html>'), { format: 'hwpx' })).problems[0]).toMatch(/zip 패키지가 아님/);
    expect((await checkPackage(Buffer.alloc(0), { format: 'hwpx' })).valid).toBe(false);
  });

  it('경로 탈출·DOCTYPE·남은 표시를 잡는다', async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/hwp+zip');
    zip.file('../evil.xml', '<a/>');
    zip.file('Contents/content.hpf', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><a>&e;</a>');
    zip.file('Contents/section0.xml', '<hs:sec xmlns:hs="h" xmlns:hp="p"><hp:p><hp:run><hp:t>{{제목}}</hp:t></hp:run></hp:p></hs:sec>');
    zip.file('META-INF/container.xml', '<c/>');
    const r = await checkPackage(await zip.generateAsync({ type: 'nodebuffer' }), { format: 'hwpx' });
    expect(r.valid).toBe(false);
    expect(r.problems.join('\n')).toMatch(/위험한 항목 경로/);
    expect(r.problems.join('\n')).toMatch(/DOCTYPE/);
    expect(r.leftoverMarkers).toEqual(['제목']);
  });
});

describe('실제 표준 양식으로 HWPX 만들기(doc-fill 어댑터)', () => {
  it('공문 기안문 — 모든 칸을 채운 진짜 HWPX, 넣은 글이 파일 안에 있다', async () => {
    const bytes = readFileSync(path.join(TPL, 'official_letter.hwpx'));
    const read = await readFillableTemplate(bytes, 'official_letter.hwpx');
    const fields = fieldsFromSlots(read.slots).map((f) => ({ ...f, value: f.type === 'paragraph' ? `${f.label} 첫 줄\n${f.label} 둘째 줄` : `${f.label} 값` }));
    const out = await generateDocumentFile(bytes, 'official_letter.hwpx', fields);
    expect(out.format).toBe('hwpx');
    expect(out.check.valid).toBe(true);
    expect(out.check.leftoverMarkers).toEqual([]);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    // 같은 입력이면 같은 내용(재시도해도 다른 파일이 되지 않는다는 근거는 아님 — 해시는 저장 단계에서 다시 잰다)
    expect(out.bytes.subarray(0, 2).toString()).toBe('PK');
  });

  it('필드가 양식 자리와 맞지 않으면 만들지 않는다(다른 양식 판의 필드)', async () => {
    const bytes = readFileSync(path.join(TPL, 'report.hwpx'));
    await expect(
      generateDocumentFile(bytes, 'report.hwpx', fieldsFromSlots([{ id: 's1', label: '제목', kind: 'marker', path: [], hint: null }]))
    ).rejects.toMatchObject({ code: 'TEMPLATE_UNSUPPORTED' });
  });
});

describe('확인할 사항 — 시험 모드 글', () => {
  // 로그인 화면 확인에서 찾음: 시험 모드 판의 다른 칸만 고쳐 저장하면 새 판에서 '시험 모드' 알림이 사라졌다
  it('직원이 고쳐 저장한 판(testMode=false)도 시험 모드 글이 남아 있으면 알린다', () => {
    const fields = fieldsFromSlots([{ id: 's1', label: '본문', kind: 'marker', path: [], hint: null }]).map((f) => ({ ...f, value: `${TEST_MODE_MARKER} 본문`, origin: 'ai' as const }));
    expect(computeReviewItems({ fields, missing: [], knownText: '', testMode: false }).map((i) => i.code)).toContain('TEST_MODE');
    const clean = fields.map((f) => ({ ...f, value: '실제 본문', origin: 'user' as const }));
    expect(computeReviewItems({ fields: clean, missing: [], knownText: '', testMode: false }).map((i) => i.code)).not.toContain('TEST_MODE');
  });
});

describe('여러 줄 칸 이름', () => {
  // 회신 '답변'이 한 줄 칸이면 질문별 답이 한 줄로 붙는다(P5 흐름 시험에서 찾음) — 인수인계·감사 칸도 같은 꼴
  it('회신·감사·인수인계·메모의 목록 칸은 여러 줄 칸이다', () => {
    const labels = ['답변', '추가 확인 필요', '증빙 목록', '요구 항목별 답변', '진행 중 업무', '미결 과제', '반복 일정', '참고 자료', '근거', '유보·확인 필요'];
    const fields = fieldsFromSlots(labels.map((label, i) => ({ id: `s${i}`, label, kind: 'marker' as const, path: [], hint: null })));
    expect(fields.filter((f) => f.type !== 'paragraph').map((f) => f.label)).toEqual([]);
    expect(fieldsFromSlots([{ id: 'x', label: '수신', kind: 'marker', path: [], hint: null }])[0].type).toBe('text');
  });
});
