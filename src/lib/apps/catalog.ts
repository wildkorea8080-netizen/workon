import type { Agent } from '@/lib/db';
import type { WorkflowSummaryDto } from '@/components/work/types';

export type AppKind = 'chat' | 'workflow' | 'link' | 'form';
export type AppScope = 'official' | 'department' | 'personal' | 'standard';

export interface AppEntry {
  id: string;
  name: string;
  description: string;
  icon: string;
  kind: AppKind;
  scope: AppScope;
  category: string;
  details: string[];
  href: string | null;
  unavailableReason: string | null;
}

export const APP_KIND_LABELS: Record<AppKind, string> = { chat: 'AI 비서', workflow: '업무 작업', link: '외부 연결', form: '입력형 앱' };
export const APP_SCOPE_LABELS: Record<AppScope, string> = { official: '기관 공식', department: '부서', personal: '내 비서', standard: '표준 업무' };

const WORKFLOW_CATEGORIES: Record<string, string> = {
  'document-summary': '문서 작성·정리', 'document-rewrite': '문서 작성·정리', 'document-translation': '번역',
  'meeting-agenda': '회의', meeting: '회의', 'document-faq': '민원·안내', reply: '민원·안내',
  report: '문서 작성·정리', 'official-letter': '문서 작성·정리', regulations: '법령·규정', settlement: '자료·표 분석',
  collection: '자료·표 분석', 'audit-response': '감사·요구자료', intake: '접수·업무 배분', handover: '문서 작성·정리',
};

export function favoriteAppIds(data: { agentIds: string[]; workflowKeys: string[] }): Set<string> {
  return new Set([...data.agentIds.map((id) => `agent:${id}`), ...data.workflowKeys.map((key) => `workflow:${key}`)]);
}

function safeExternalUrl(raw: string | null | undefined): string | null {
  try {
    const url = new URL(raw ?? '');
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** 목록은 기존 권한 API에서 받은 것만 사용한다. 비서와 업무의 실행 방식은 합치지 않는다. */
export function appEntries(agents: Agent[], workflows: WorkflowSummaryDto[], newTasksEnabled: boolean): AppEntry[] {
  const unique = new Map(agents.filter((a) => !a.deleted_at).map((a) => [a.id, a]));
  const chatApps = [...unique.values()].map((a): AppEntry => {
    const kind = a.agent_type === 'link' ? 'link' : a.app_definition ? 'form' : 'chat';
    const external = kind === 'link' ? safeExternalUrl(a.link_url) : null;
    const unavailableReason = !a.is_active ? '사용이 중지된 비서입니다.' : kind === 'link' && !external ? '연결 주소를 확인해 주세요.' : null;
    const rawCapabilities = a.capabilities;
    const caps = typeof rawCapabilities === 'object' && rawCapabilities !== null && !Array.isArray(rawCapabilities) ? rawCapabilities : {};
    const details = [
      ...('doc_search' in caps ? ['기관 문서 검색'] : []),
      ...('file_read' in caps ? ['첨부파일 읽기'] : []),
      ...('table_merge' in caps ? ['표 합치기·집계'] : []),
      ...('document' in caps ? ['문서 파일 만들기'] : []),
      ...('public_data' in caps ? ['공공데이터 조회'] : []),
      ...('image' in caps ? ['사진 읽기'] : []),
    ];
    return {
      id: `agent:${a.id}`, name: a.name, description: a.description || a.usage_guide || '비서를 골라 질문하거나 업무를 요청하세요.',
      icon: a.icon || '💬', kind, scope: a.tier, category: a.category || '기타',
      details: kind === 'link' ? ['외부 사이트에서 열립니다'] : [...(kind === 'form' ? ['입력 폼 · 텍스트 초안'] : []), ...details],
      href: unavailableReason ? null : external || `${kind === 'form' ? '/apps/run' : '/chat'}?agent=${encodeURIComponent(a.id)}`,
      unavailableReason,
    };
  });
  return chatApps.concat(workflows.map((w): AppEntry => {
    const unavailableReason = !w.available ? w.reason || '아직 준비 중입니다.' : !newTasksEnabled ? '이 기관은 새 업무 작업이 꺼져 있습니다.' : null;
    return {
      id: `workflow:${w.key}`, name: w.name, description: w.purpose, icon: '📋', kind: 'workflow', scope: 'standard', category: WORKFLOW_CATEGORIES[w.key] ?? '업무 자동화',
      details: w.outputs.filter((o) => o.required).map((o) => `${o.label} · ${o.format.toUpperCase()}`),
      href: unavailableReason ? null : `/tasks/new?workflow=${encodeURIComponent(w.key)}`,
      unavailableReason,
    };
  }));
}

export function filterApps(entries: AppEntry[], filters: { query: string; kind: AppKind | 'all'; scope: AppScope | 'all'; category?: string; favorites?: Set<string> }): AppEntry[] {
  const words = filters.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    if (filters.kind !== 'all' && entry.kind !== filters.kind) return false;
    if (filters.scope !== 'all' && entry.scope !== filters.scope) return false;
    if (filters.category && filters.category !== 'all' && entry.category !== filters.category) return false;
    if (filters.favorites && !filters.favorites.has(entry.id)) return false;
    const text = [entry.name, entry.description, entry.category, ...entry.details, APP_KIND_LABELS[entry.kind], APP_SCOPE_LABELS[entry.scope]].join(' ').toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}
