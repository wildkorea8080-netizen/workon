// tests/batch-0318.test.ts
// 입력형 앱 결과를 여러 곳에 보내기(2026-11-26) — 첫 보낼 곳 말고 2곳까지 더(곳마다 동작). 보내기 기록은 곳마다 하나.
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { APP_DELIVER_MORE_MAX, validateAppDefinition } from '@/lib/apps/definition';

const ep = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
const def = (extra: Record<string, unknown>) => validateAppDefinition({ schemaVersion: 1, fields: [{ key: 'topic', label: '주제', type: 'text', required: true }], output: 'bullets', ...extra });

describe('앱 정의 — 더 보낼 곳', () => {
  it('첫 보낼 곳이 있을 때 2곳까지, 소문자로, 동작은 곳마다', () => {
    const ok = def({ deliverEndpointId: ep(1), deliverMore: [{ endpointId: ep(2).toUpperCase(), action: 'notify' }, { endpointId: ep(3) }] });
    expect(ok.ok && ok.value?.deliverMore).toEqual([{ endpointId: ep(2), action: 'notify' }, { endpointId: ep(3) }]);
    expect(APP_DELIVER_MORE_MAX).toBe(2);
    const empty = def({ deliverEndpointId: ep(1), deliverMore: [] });
    expect(empty.ok && empty.value).not.toHaveProperty('deliverMore');
  });
  it('거절 — 3곳 이상·첫 곳 없이·같은 곳 두 번(첫 곳과도)·틀린 동작·모르는 칸', () => {
    expect(def({ deliverEndpointId: ep(1), deliverMore: [{ endpointId: ep(2) }, { endpointId: ep(3) }, { endpointId: ep(4) }] }).ok).toBe(false);
    expect(def({ deliverMore: [{ endpointId: ep(2) }] }).ok).toBe(false);
    expect(def({ deliverEndpointId: ep(1), deliverMore: [{ endpointId: ep(1).toUpperCase() }] })).toMatchObject({ ok: false, message: expect.stringContaining('같은 곳') });
    expect(def({ deliverEndpointId: ep(1), deliverMore: [{ endpointId: ep(2) }, { endpointId: ep(2) }] }).ok).toBe(false);
    expect(def({ deliverEndpointId: ep(1), deliverMore: [{ endpointId: ep(2), action: 'Bad!' }] }).ok).toBe(false);
    expect(def({ deliverEndpointId: ep(1), deliverMore: [{ endpointId: ep(2), url: 'https://x' }] }).ok).toBe(false);
    expect(def({ deliverEndpointId: ep(1), deliverMore: 'x' }).ok).toBe(false);
  });
  it('첫 보낼 곳이 없으면 빈 목록은 받되 남기지 않는다', () => {
    const none = def({ deliverMore: [] });
    expect(none.ok && none.value).not.toHaveProperty('deliverMore');
  });
});

describe('연결', () => {
  it('대화 준비가 시험 판이 아닐 때만 싣고, 빌더가 고르게 한다', () => {
    const prepare = readFileSync('src/lib/assistant/prepare.ts', 'utf8');
    expect(prepare).toContain('...(definition.value.deliverMore?.length ? { appDeliverMore: definition.value.deliverMore } : {})');
    const builder = readFileSync('src/app/apps/builder/page.tsx', 'utf8');
    expect(builder).toContain('<DeliverMoreList primary={value}');
    expect(builder).not.toMatch(/^export function DeliverMoreList/m);
    // 첫 곳을 비우면 더 보낼 곳도 비운다(저장 검사가 첫 곳 없는 더 보낼 곳을 거절)
    expect(builder).toContain('return endpointId ? { ...rest, deliverEndpointId: endpointId');
  });
});
