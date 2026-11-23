import { readFileSync } from 'fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AppStepEditor from '@/components/apps/AppStepEditor';
import { validateAppDefinition, type AppDefinition } from '@/lib/apps/definition';

/**
 * 2026-11-20 — 앱 빌더가 선택지 목록을 못 읽은 것을 '고른 값이 없어졌다'로 알리지 않는다.
 * 빌더는 고른 값이 목록에 없으면 '회수됨·없어짐·쓸 수 없음'으로 보이고 바꾸라고 안내한다. 그런데 목록 읽기 실패도 빈 목록으로 보아:
 *  - 결과를 보낼 곳 → '(회수된 보낼 곳)'·'다른 곳을 고르거나 보내지 않음으로 바꾸세요', 받는 쪽 동작 → '(없어진 동작)'
 *  - 결과 한글 파일 양식 → '(지금 없는 양식)'·'표준 보고서로 만듭니다'
 *  - 조회 단계 → '이 기관에서 쓰지 않는 공공 데이터라 실행되지 않습니다'(문서 찾기 단계까지)·'고른 비서를 지금 쓸 수 없습니다'
 * 안내대로 바꿔 저장하면 멀쩡한 설정이 지워진다. 이제 못 읽었으면 고른 값을 그대로 두고 그렇다고 알린다.
 */

const OTHER = 'bbbbbbbb-2222-4222-8222-222222222222';
const checked = validateAppDefinition({
  schemaVersion: 1,
  fields: [{ key: 'topic', label: '주제', type: 'text', required: true }],
  output: 'bullets',
  steps: [
    { name: '법령', instruction: '', lookup: { tool: 'law_search', query: '{{topic}}' } },
    { name: '문서', instruction: '', lookup: { tool: 'doc_search', query: '{{topic}}', agent: OTHER } },
    { name: '정리', instruction: '찾은 근거로 정리하세요.' },
  ],
});
const definition = (checked as { value: AppDefinition }).value;
const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(AppStepEditor, { definition, onChange: () => {}, ...props } as never));

describe('조회 단계 편집 (그려 본다)', () => {
  it('정의가 유효하다', () => {
    expect(checked.ok).toBe(true);
  });

  it('목록을 읽었는데 없으면 예전처럼 쓸 수 없다고 알린다', () => {
    const html = render({ lookupTools: ['doc_search'], lookupAgents: [] });
    expect(html).toContain('이 기관에서 쓰지 않는 공공 데이터라 실행되지 않습니다');
    expect(html).toContain('고른 비서를 지금 쓸 수 없거나 문서 찾기가 꺼져 있습니다');
    expect(html).toContain('(지금 쓸 수 없는 비서)');
  });

  it('연결 목록을 못 읽었으면 쓰지 않는 공공 데이터라고 하지 않는다', () => {
    const html = render({ lookupTools: ['doc_search'], lookupAgents: [], lookupUnread: { tools: true } });
    expect(html).not.toContain('이 기관에서 쓰지 않는 공공 데이터라 실행되지 않습니다');
    expect(html).toContain('공공 데이터 연결 목록을 지금 불러오지 못해 이 조회를 쓸 수 있는지 확인하지 못했습니다');
    expect(html).toContain('(확인하지 못함)');
    expect(html).not.toContain('(기관에서 쓰지 않음)');
  });

  it('비서 목록을 못 읽었으면 쓸 수 없는 비서라고 하지 않는다', () => {
    const html = render({ lookupTools: ['doc_search', 'law_search'], lookupAgents: [], lookupUnread: { agents: true } });
    expect(html).not.toContain('고른 비서를 지금 쓸 수 없거나 문서 찾기가 꺼져 있습니다');
    expect(html).not.toContain('(지금 쓸 수 없는 비서)');
    expect(html).toContain('(고른 비서 — 그대로 둠)');
    expect(html).toContain('비서 목록을 지금 불러오지 못해 고른 비서를 쓸 수 있는지 확인하지 못했습니다');
  });

  it('읽혔고 목록에 있으면 아무 경고도 없다', () => {
    const html = render({ lookupTools: ['doc_search', 'law_search'], lookupAgents: [{ id: OTHER, name: '감사 비서', tier: 'official' }] });
    expect(html).not.toContain('실행되지 않습니다');
    expect(html).not.toContain('고른 비서를 지금 쓸 수 없거나');
    expect(html).not.toContain('(지금 쓸 수 없는 비서)');
    expect(html).not.toContain('불러오지 못해');
  });
});

describe('앱 빌더 (원본)', () => {
  const src = readFileSync('src/app/apps/builder/page.tsx', 'utf8').replace(/\r\n/g, '\n');

  it('연결 목록을 못 읽어도 문서 찾기는 고를 수 있고, 못 읽음을 넘긴다', () => {
    expect(src).toContain("const withoutConnector = (Object.keys(APP_LOOKUP_TOOLS) as AppLookupTool[]).filter(tool => APP_LOOKUP_TOOLS[tool].connector === null);");
    expect(src).toContain('if (!result.ok) { toolsUnread(); return; }');
    expect(src).toContain('if (!shared.ok || !personal.ok) setLookupUnread(u => ({ ...u, agents: true }));');
    expect(src).toContain('lookupUnread={lookupUnread} />');
  });

  it('결과를 보낼 곳 — 못 읽었으면 회수됨·없어진 동작으로 알리지 않고 고른 값을 그대로 둔다', () => {
    const picker = src.slice(src.indexOf('function DeliverEndpointPicker('), src.indexOf('function ExportTemplatePicker('));
    expect(picker).toContain('setUnread(!r.ok);');
    expect(picker).toContain('const missing = Boolean(value && endpoints && !unread && !endpoints.some(e => e.id === value));');
    expect(picker).toContain('const gone = Boolean(action && !unread && !actions.some(a => a.key === action));');
    expect(picker).toContain('{unread && value && <option value={value}>(고른 보낼 곳 — 그대로 둠)</option>}');
    expect(picker).toContain('{unread && action && <option value={action}>(고른 동작 {action} — 그대로 둠)</option>}');
    expect(picker).toContain('{DELIVER_LIST_UNREAD}');
  });

  it('결과 한글 파일 양식 — 못 읽었으면 지금 없는 양식으로 알리지 않는다', () => {
    const picker = src.slice(src.indexOf('function ExportTemplatePicker('));
    expect(picker).toContain('setUnread(!r.ok);');
    expect(picker).toContain('const missing = Boolean(value && templates && !unread && !templates.some(t => t.id === value));');
    expect(picker).toContain('{unread && value && <option value={value}>(고른 양식 — 그대로 둠)</option>}');
    expect(picker).toContain('양식 목록을 지금 불러오지 못했습니다');
  });
});
