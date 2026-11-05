import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import AppApprovalPanel, { approvalState } from '@/components/apps/AppApprovalPanel';
import { appSummary } from '@/components/admin/AgentsManager';

/** 공식 앱 신청(2026-11-06) — 빌더에서 공식 비서 신청과 같은 길로, 지금 판 기준, 관리자 화면에 앱 표시 */

const agent = (over: Record<string, unknown> = {}) => ({ id: 'a1', tier: 'department', version: 7, approval_status: null, approval_version: null, approval_note: null, ...over });
const render = (a: ReturnType<typeof agent>, hasDraft = false) => renderToStaticMarkup(createElement(AppApprovalPanel, { agent: a, hasDraft, onRequested: () => {} }));

describe('신청 상태', () => {
  it('공식·신청 중(판 번호)·반려(사유)·없음', () => {
    expect(approvalState(agent({ tier: 'official' })).kind).toBe('official');
    expect(approvalState(agent({ approval_status: 'pending', approval_version: 6 })).text).toContain('판 6으로 신청함');
    expect(approvalState(agent({ approval_status: 'rejected', approval_note: '범위가 넓음' })).text).toContain('범위가 넓음');
    expect(approvalState(agent())).toEqual({ kind: 'none', text: '' });
  });
});

describe('화면', () => {
  it('신청 단추·지금 판 번호, 시험 판이 있으면 먼저 배포하라고 알린다', () => {
    const html = render(agent(), true);
    expect(html).toContain('공식 앱으로 신청');
    expect(html).toContain('지금 판(판 7) 기준');
    expect(html).toContain('배포하지 않은 시험 판이 있습니다');
    expect(render(agent())).not.toContain('배포하지 않은 시험 판');
  });

  it('신청 중이면 단추 없이 상태만, 반려면 다시 신청, 공식이면 아무것도 없음', () => {
    const pending = render(agent({ approval_status: 'pending', approval_version: 7 }));
    expect(pending).toContain('신청 중');
    expect(pending).not.toContain('공식 앱으로 신청</button>');
    expect(render(agent({ approval_status: 'rejected' }))).toContain('공식 앱으로 신청');
    expect(render(agent({ tier: 'official' }))).toBe('');
  });

  it('관리자 승인 카드 — 입력형 앱이면 항목·단계 수', () => {
    expect(appSummary({ fields: [{}, {}], steps: [{}] })).toBe('입력 항목 2개 · 처리 단계 1개');
    expect(appSummary({ fields: [{}] })).toBe('입력 항목 1개');
    expect(appSummary(null)).toBeNull();
    expect(appSummary([])).toBeNull();
  });
});

describe('연결 (원본)', () => {
  it('빌더가 신청 패널을 달고, 신청은 기존 공식 신청 길·메모 500자', () => {
    expect(readFileSync('src/app/apps/builder/page.tsx', 'utf8')).toContain('<AppApprovalPanel agent={agent} hasDraft={Boolean(draft)}');
    expect(readFileSync('src/components/apps/AppApprovalPanel.tsx', 'utf8')).toContain('/request-approval');
    expect(readFileSync('src/app/api/agents/personal/[id]/request-approval/route.ts', 'utf8')).toContain('body.note.trim().slice(0, 500)');
    expect(readFileSync('src/components/admin/AgentsManager.tsx', 'utf8')).toContain('입력형 앱 · {appSummary(agent.app_definition)}');
  });
});
