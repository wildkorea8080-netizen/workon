import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { APP_REPEAT_MAX, repeatsFiles, validateAppDefinition, type AppDefinition } from '@/lib/apps/definition';
import { runAppIntermediateSteps, type AppStepRecord } from '@/lib/apps/pipeline';
import { AppInputError, digestSystem, reduceSystem } from '@/lib/apps/long-input';
import AppStepEditor from '@/components/apps/AppStepEditor';
import AppStepResults from '@/components/apps/AppStepResults';

/** 파일마다 반복(2026-11-07) — 첨부 파일·문서함에서 고른 문서마다 중간 단계를 한 번씩, 결과는 파일 순서대로 */

const fields = [{ key: 'title', label: '제목', type: 'text' as const, required: false }];
const def: AppDefinition = {
  schemaVersion: 1, fields, output: 'paragraphs', attachments: { required: true },
  steps: [
    { name: '파일별 요약', instruction: '파일 내용을 요약하세요', repeat: { files: true } },
    { name: '종합', instruction: '요약을 모아 종합' },
  ],
};
const raw = (steps: unknown[], attachments: unknown = { required: true }) => ({ schemaVersion: 1, fields, output: 'paragraphs', steps, ...(attachments ? { attachments } : {}) });

describe('정의', () => {
  it('파일 받기를 켠 앱의 AI 중간 단계는 파일마다 반복할 수 있다', () => {
    const r = validateAppDefinition(raw(def.steps!));
    expect(r.ok && r.value?.steps?.[0].repeat).toEqual({ files: true });
    expect(repeatsFiles({ files: true })).toBe(true);
    expect(repeatsFiles({ field: 'x' })).toBe(false);
    expect(repeatsFiles(undefined)).toBe(false);
  });

  it('거절: 파일 받기가 꺼진 앱·마지막 단계·조회/분류 단계·꼴이 이상한 값', () => {
    expect(validateAppDefinition(raw(def.steps!, null))).toMatchObject({ ok: false, message: expect.stringContaining('파일 첨부 받기를 켜') });
    for (const steps of [
      [{ name: '앞', instruction: 'x' }, { name: '끝', instruction: '끝', repeat: { files: true } }],
      [{ name: 'a', instruction: '', lookup: { tool: 'law_search', query: '{{title}}' }, repeat: { files: true } }, { name: '끝', instruction: '끝' }],
      [{ name: 'a', instruction: 'x', classify: { options: ['예', '아니오'] }, repeat: { files: true } }, { name: '끝', instruction: '끝' }],
      [{ name: 'a', instruction: 'x', repeat: { files: 'yes' } }, { name: '끝', instruction: '끝' }],
      [{ name: 'a', instruction: 'x', repeat: { files: true, field: 'title' } }, { name: '끝', instruction: '끝' }],
    ]) expect(validateAppDefinition(raw(steps)).ok, JSON.stringify(steps).slice(0, 120)).toBe(false);
  });
});

describe('실행', () => {
  const setup = (files: string[] | undefined, answers: string[] = []) => {
    const records: AppStepRecord[] = def.steps!.map((s) => ({ name: s.name, status: 'pending' }));
    const complete = vi.fn(async (_r: { system: string; messages: unknown }) => ({ text: answers.shift() ?? '답', usage: { model: 'm', input_tokens: 10, output_tokens: 3 } }));
    return { steps: def.steps!, records, model: 'm', system: 'S', messages: [{ role: 'user' as const, content: '원자료 전체' }], inputs: { title: '' }, files, usage: { model: 'm', input_tokens: 0, output_tokens: 0 }, guard: vi.fn(async () => {}), update: vi.fn(), complete };
  };

  it('파일마다 한 번씩(그 파일만 다루라는 지시, 원자료는 그대로) 부르고 결과를 파일 순서대로 이어 붙인다', async () => {
    const args = setup(['총무과 보고.hwpx', '기획과 보고.docx', '예산 지침(문서함)'], ['총무 요약', '기획 요약', '지침 요약']);
    const result = await runAppIntermediateSteps(args as never);
    expect(args.complete).toHaveBeenCalledTimes(3);
    expect(args.complete.mock.calls[1][0].system).toContain('이번 파일(2/3): 기획과 보고.docx');
    expect(args.complete.mock.calls[1][0].system).toContain('다른 파일은 다루지 마세요');
    expect(JSON.stringify(args.complete.mock.calls[2][0].messages)).toContain('원자료 전체');
    expect(args.guard).toHaveBeenCalledTimes(4);
    expect(args.records[0]).toMatchObject({ status: 'completed', repeated: 3, repeatedFiles: true, output: '### 1. 총무과 보고.hwpx\n총무 요약\n\n### 2. 기획과 보고.docx\n기획 요약\n\n### 3. 예산 지침(문서함)\n지침 요약' });
    expect(JSON.stringify(result.messages)).toContain('지침 요약');
  });

  it('파일이 없으면 모델을 부르지 않고 직원이 고칠 안내로 멈춘다', async () => {
    for (const files of [undefined, [], ['  ']]) {
      const args = setup(files);
      await expect(runAppIntermediateSteps(args as never)).rejects.toBeInstanceOf(AppInputError);
      await expect(runAppIntermediateSteps(setup(files) as never)).rejects.toThrow('반복할 파일이 없습니다');
      expect(args.complete).not.toHaveBeenCalled();
    }
    expect(APP_REPEAT_MAX).toBeGreaterThanOrEqual(3);
  });

  it('중간 파일의 결과가 비면 그 자리에서 멈추고 쓴 토큰은 남긴다', async () => {
    const args = setup(['가.txt', '나.txt', '다.txt'], ['가 요약', '']);
    await expect(runAppIntermediateSteps(args as never)).rejects.toThrow('2번째 파일');
    expect(args.usage.output_tokens).toBe(6);
  });
});

describe('연결·화면', () => {
  const read = (p: string) => readFileSync(p, 'utf8');

  it('실행 준비가 원자료와 같은 순서(올린 파일 → 문서함 문서)로 파일 이름을 넘기고, 실행기가 단계에 싣는다', () => {
    const prepare = read('src/lib/assistant/prepare.ts');
    expect(prepare).toContain('appFileNames = [...selected.map(a => a.fileName), ...libraryFiles.map(f => f.name)];');
    expect(prepare.indexOf('appFileNames = [')).toBeLessThan(prepare.indexOf('const material = appAttachmentMaterial') + 400);
    expect(read('src/lib/assistant/stream.ts')).toContain('files: turn.appFileNames,');
  });

  it('긴 첨부를 나눠 추릴 때도 파일 이름을 남기라고 지시한다(추린 글에서 파일을 찾을 수 있게)', () => {
    expect(digestSystem('S', 0, 2)).toContain('파일 이름을 함께 적으세요');
    expect(reduceSystem('S', 0, 2)).toContain('파일 이름을 그대로 두세요');
  });

  it('편집기 — 파일 받기를 켠 앱만 "첨부 파일마다"를 고를 수 있다, 결과에 파일 수', () => {
    const html = renderToStaticMarkup(createElement(AppStepEditor, { definition: def, onChange: () => {} }));
    expect(html).toContain('aria-label="단계 1 반복"');
    expect(html).toMatch(/<option value="#files" selected="">첨부 파일마다 \(문서함에서 고른 문서 포함\)<\/option>/);
    const noFiles = renderToStaticMarkup(createElement(AppStepEditor, { definition: { ...def, attachments: undefined, steps: [{ name: 'a', instruction: 'x' }, { name: '끝', instruction: '끝' }] }, onChange: () => {} }));
    expect(noFiles).toMatch(/aria-label="단계 1 반복" disabled=""/);
    expect(noFiles).not.toContain('value="#files"');
    expect(renderToStaticMarkup(createElement(AppStepResults, { steps: [{ name: '파일별 요약', status: 'completed', output: 'x', repeated: 2, repeatedFiles: true }] }))).toContain('· 반복 2개 파일');
  });
});
