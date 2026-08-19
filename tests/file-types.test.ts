import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  ALLOWED_UPLOAD_EXTENSIONS,
  UPLOAD_ACCEPT_ATTRIBUTE,
  UPLOAD_FORMATS_LABEL,
  hasAllowedUploadExtension,
} from '@/lib/file-types';

/**
 * 업로드 허용 형식.
 *
 * 목록이 서버 검증·accept 속성·화면 안내 네 곳에 흩어져 있어 두 번 어긋났다.
 * XLSX를 추가했을 때는 화면이 파일을 먼저 막았고, 그 전 HWP 때는 오류 문구만
 * 옛 목록으로 남았다. 정의가 한 곳으로 모였는지 여기서 고정한다.
 */

describe('허용 확장자 판정', () => {
  it('등록된 형식을 통과시킨다', () => {
    for (const ext of ALLOWED_UPLOAD_EXTENSIONS) {
      expect(hasAllowedUploadExtension(`문서${ext}`), ext).toBe(true);
    }
  });

  it('대문자 확장자도 통과시킨다', () => {
    // 윈도우에서 올라오는 파일은 대문자인 경우가 흔하다
    expect(hasAllowedUploadExtension('예산.XLSX')).toBe(true);
    expect(hasAllowedUploadExtension('공문.HWP')).toBe(true);
  });

  it('등록되지 않은 형식은 막는다', () => {
    for (const name of ['악성.exe', '보고서.pptx', '사진.png']) {
      expect(hasAllowedUploadExtension(name), name).toBe(false);
    }
  });
});

describe('파생 값', () => {
  it('accept 속성이 확장자 목록과 같다', () => {
    expect(UPLOAD_ACCEPT_ATTRIBUTE.split(',')).toEqual([...ALLOWED_UPLOAD_EXTENSIONS]);
  });

  it('안내 문구가 확장자 목록에서 만들어진다', () => {
    expect(UPLOAD_FORMATS_LABEL).toContain('XLSX');
    expect(UPLOAD_FORMATS_LABEL).toContain('HWP');
    expect(UPLOAD_FORMATS_LABEL).not.toContain('.');
  });
});

describe('목록이 한 곳에만 있는가', () => {
  const FILES = [
    'src/app/api/upload/route.ts',
    'src/components/admin/DocumentsManager.tsx',
    'src/components/chat/CreateAgentModal.tsx',
    'src/components/admin/SettingsManager.tsx',
  ];

  it('확장자 목록을 따로 적어 둔 곳이 없다', () => {
    for (const file of FILES) {
      const src = readFileSync(file, 'utf8');
      // '.pdf,.docx' 같은 하드코딩된 목록이 남아 있으면 또 어긋난다
      expect(src, `${file}에 하드코딩된 accept 목록`).not.toMatch(/\.pdf,\s*\.docx/);
      expect(src, `${file}에 하드코딩된 형식 안내`).not.toMatch(/PDF,\s*DOCX,\s*TXT/);
    }
  });
});
