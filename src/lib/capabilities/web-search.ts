// src/lib/capabilities/web-search.ts
// 웹 검색 능력(2026-11-26, 0124) — Anthropic 서버 도구(`web_search`)를 대화에 싣는다. 우리가 실행하지 않는다:
// 정의만 싣으면 모델이 필요할 때 찾고, 결과·인용은 같은 응답의 블록으로 온다(어댑터 anthropic.ts·실행기 stream.ts가 받아 출처로).
// 검색어가 기관 밖으로 나가므로 **기관이 켰을 때만**(organizations.web_search_enabled_at — 대화를 만들기 전에 읽음, 못 읽으면 꺼짐).
// 비서가 정한 찾을 곳(도메인)이 있으면 그곳만 찾는다. 한 번 답에 WEB_SEARCH_MAX_USES번까지(회당 $0.01 — 원가에 들어감).
import type { Capability, PreflightResult } from './types';
import { logSystem } from '@/lib/logger';
import { webSearchEnabled } from '@/lib/web-search-switch';
import { WEB_SEARCH_MAX_USES, WEB_SEARCH_OFF_ADDENDUM, webSearchAddendum } from '@/lib/web-search-spec';

export interface WebSearchDeps {
  enabled(organizationId: string): Promise<{ enabled: boolean; error?: string }>;
  report(organizationId: string, error: string): Promise<void>;
}

export const defaultWebSearchDeps: WebSearchDeps = {
  enabled: webSearchEnabled,
  async report(organizationId, error) {
    await logSystem({ level: 'warning', category: 'api', message: '기관 웹 검색 설정을 읽지 못해 이번 대화는 웹 검색 없이 답했습니다', details: { organization_id: organizationId, error }, orgId: organizationId }).catch(() => undefined);
  },
};

export function makeWebSearch(deps: WebSearchDeps = defaultWebSearchDeps): Capability {
  return {
    id: 'web_search',
    label: '웹 검색',
    description: '최신 정보·공개 자료를 웹에서 찾아 출처와 함께 답합니다(기관이 웹 검색을 켰을 때만).',
    isAvailable: () => true,
    // 대화를 만들기 전에 기관 스위치를 읽는다 — 거절하지는 않는다(웹 검색 없이 답함)
    async preflight(input): Promise<PreflightResult> {
      const got = await deps.enabled(input.organizationId);
      if (got.error) await deps.report(input.organizationId, got.error);
      return { ok: true, carry: got.enabled };
    },
    async prepare(ctx) {
      if (ctx.preflight.web_search !== true) return { systemAddendum: WEB_SEARCH_OFF_ADDENDUM };
      const domains = ctx.capabilities.web_search?.allowed_domains ?? [];
      return {
        systemAddendum: webSearchAddendum(domains),
        serverTools: { webSearch: { maxUses: WEB_SEARCH_MAX_USES, ...(domains.length ? { allowedDomains: domains } : {}) } },
      };
    },
  };
}

export const webSearch = makeWebSearch();
