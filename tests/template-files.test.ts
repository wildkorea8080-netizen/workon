import { describe, it, expect } from 'vitest';
import { validateTemplateFile, templateStoragePath, MAX_TEMPLATES } from '@/lib/template-files';
import { MAX_UPLOAD_BYTES } from '@/lib/file-types';

describe('양식 파일', () => {
  it('한글·워드만 받는다', () => {
    expect(validateTemplateFile('기안문.hwpx', 1000)).toBeNull();
    expect(validateTemplateFile('기안문.HWP', 1000)).toBeNull();
    expect(validateTemplateFile('양식.docx', 1000)).toBeNull();
    expect(validateTemplateFile('양식.pdf', 1000)).toBe('양식은 HWP·HWPX·DOCX 파일만 올릴 수 있습니다.');
  });

  it('업로드 상한을 따른다', () => {
    expect(validateTemplateFile('a.hwpx', MAX_UPLOAD_BYTES + 1)).toContain('MB');
  });

  it('저장 경로는 기관·비서 아래, 원래 이름은 쓰지 않는다', () => {
    // 원래 파일명을 경로에 넣으면 '../' 같은 이름으로 경로를 거슬러 오를 수 있다
    const path = templateStoragePath('org', 'agent', 'f1', '../../x.hwpx');
    expect(path).toBe('templates/org/agent/f1.hwpx');
  });

  it('상한은 10개', () => {
    expect(MAX_TEMPLATES).toBe(10);
  });
});
