import { describe, expect, it } from 'vitest';
import { getWorkflow } from '@/lib/work/catalog';
import { getWorkflowImpl } from '@/lib/work/workflows';
import { getDocumentAppPolicy, isDocumentAppTarget } from '@/lib/work/workflows/document-apps';
describe('회의 안건 초안 앱', () => {
  it('목적과 참고 자료가 필수이며 결정은 생성하지 않는다', () => {
    const def = getWorkflow('meeting-agenda')!;
    expect(def.inputs.find((i) => i.key === 'meetingPurpose')?.required).toBe(true);
    expect(def.inputs.find((i) => i.key === 'sourceFiles')?.required).toBe(true);
    expect(isDocumentAppTarget(def.key, '안건')).toBe(true);
    expect(isDocumentAppTarget(def.key, '논의 내용')).toBe(true);
    for (const label of ['결정 사항', '향후 계획', '작성자', '일시']) expect(isDocumentAppTarget(def.key, label)).toBe(false);
  });
  it('회의명에 초안을 표시하고 입력하지 않은 일시·참석자를 만들지 않는다', () => {
    const impl = getWorkflowImpl('meeting-agenda')!;
    expect(impl.prefill({ title: '운영 개선' }, { organizationName: null, departmentName: null, today: '2026-10-29' })).toMatchObject({ 회의명: '[안건 초안] 운영 개선', 일시: '', 장소: '', 참석자: '' });
  });
  it('참고 자료는 세 개·합계 12,000자로 제한하고 기존 문서 앱의 칸은 유지한다', () => {
    expect(getDocumentAppPolicy('meeting-agenda')).toMatchObject({ maxSources: 3, maxChars: 12000, mainLabel: '안건' });
    expect(isDocumentAppTarget('document-summary', '주요 내용')).toBe(true);
    expect(isDocumentAppTarget('document-summary', '안건')).toBe(false);
  });
});
