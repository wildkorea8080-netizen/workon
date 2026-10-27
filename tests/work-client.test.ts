import { describe, it, expect } from 'vitest';
import { checkSourceFile } from '@/lib/work/client';
import { MAX_PRIOR_BYTES } from '@/lib/work/workflows/currentize/limits';
import { MAX_ATTACHMENT_BYTES } from '@/lib/attachments/limits';

const MB = 1024 * 1024;
const priorMb = Math.round(MAX_PRIOR_BYTES / MB);
const attachMb = Math.round(MAX_ATTACHMENT_BYTES / MB);

describe('checkSourceFile — 작년 파일(prior)', () => {
  it('HWPX 40MB는 통과', () => {
    expect(checkSourceFile({ name: '작년 보고서.hwpx', size: 40 * MB }, 'prior')).toBeNull();
  });
  it('HWPX 51MB는 상한 문구(상수에서 계산)', () => {
    const m = checkSourceFile({ name: '작년.hwpx', size: 51 * MB }, 'prior');
    expect(m).toBe(`파일이 너무 큽니다. ${priorMb}MB 이하로 올려 주세요.`);
    expect(m).toContain('50MB');
  });
  it('DOCX는 HWPX 안내', () => {
    expect(checkSourceFile({ name: '작년.docx', size: 1 * MB }, 'prior')).toBe('작년 파일은 HWPX여야 합니다. 한글에서 HWPX로 저장해 올려 주세요.');
  });
  it('빈 파일은 거절', () => {
    expect(checkSourceFile({ name: '작년.hwpx', size: 0 }, 'prior')).toBe('빈 파일입니다.');
  });
});

describe('checkSourceFile — 일반 원자료', () => {
  it('엑셀 11MB는 기존 10MB 문구', () => {
    expect(checkSourceFile({ name: '표.xlsx', size: 11 * MB }, 'data')).toBe(`파일이 너무 큽니다. ${attachMb}MB 이하로 올려 주세요.`);
  });
  it('HWPX 1MB는 통과', () => {
    expect(checkSourceFile({ name: '자료.hwpx', size: 1 * MB }, 'reference')).toBeNull();
  });
});
