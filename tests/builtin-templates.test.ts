import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { BUILTIN_TEMPLATES, findBuiltinTemplate, loadBuiltinTemplate, BUILTIN_TEMPLATE_DIR } from '@/lib/builtin-templates';
import { readHwpxMarkers } from '@/lib/doc-fill/hwpx';

describe('기본 양식', () => {
  it('일곱 가지이고 ref로 찾는다', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.ref)).toEqual(['builtin:official_letter', 'builtin:report', 'builtin:minutes', 'builtin:regulation_memo', 'builtin:handover', 'builtin:reply', 'builtin:audit_response']);
    expect(findBuiltinTemplate('builtin:minutes')?.file).toBe('minutes.hwpx');
    expect(findBuiltinTemplate('builtin:없음')).toBeNull();
    expect(findBuiltinTemplate('3f1c…')).toBeNull();
  });

  it('파일이 없으면 null — 아직 준비 안 된 기본 양식', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tpl-'));
    expect(await loadBuiltinTemplate(BUILTIN_TEMPLATES[0], dir)).toBeNull();
    writeFileSync(path.join(dir, BUILTIN_TEMPLATES[0].file), 'x');
    expect((await loadBuiltinTemplate(BUILTIN_TEMPLATES[0], dir))?.toString()).toBe('x');
  });

  // 사용자가 한글로 만든 파일이 들어오면 설계 7.1의 표시를 다 갖췄는지 본다
  for (const t of BUILTIN_TEMPLATES) {
    const file = path.join(BUILTIN_TEMPLATE_DIR, t.file);
    it.skipIf(!existsSync(file))(`${t.file}에 표시가 다 있다`, async () => {
      const found = await readHwpxMarkers((await loadBuiltinTemplate(t))!);
      expect(t.markers.filter((m) => !found.includes(m))).toEqual([]);
    });
  }
});
