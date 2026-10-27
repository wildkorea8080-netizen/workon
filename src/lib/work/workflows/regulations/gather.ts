// src/lib/work/workflows/regulations/gather.ts
import { WorkError } from '../../types';
import { normalizeDate, parseEnforcedDate, type RawEvidence } from './evidence';
import type { RegulationPlan } from './model';

/**
 * 근거 모으기. 제공자는 운영(providers.ts — NODA·공통 자료실·법제처)과 시험(가짜)이 같은 꼴이다.
 *
 *  - 'unavailable' = 쓸 수 없게 설정됨(키 없음 등) → 메모 '검토 범위'와 확인 사항에 적고 이어 간다
 *  - 던짐 = 설정은 됐는데 지금 실패(장애) → 실행을 다시 시도한다(SOURCE_UNAVAILABLE). 근거 일부가 빠진 메모를
 *    조용히 만들지 않는다(대화의 '문서를 못 부르면 답하지 않음'과 같은 원칙)
 */
export type ProviderResult = { status: 'ok'; items: RawEvidence[] } | { status: 'unavailable'; reason: string };

export interface RegulationScope {
  organizationId: string;
  organizationName: string | null;
  departmentId: string;
}

export interface RegulationProviders {
  /** 이 직원이 쓸 수 있는 공식 비서들의 참고 문서(NODA) */
  orgDocuments(scope: RegulationScope, query: string): Promise<ProviderResult>;
  /** 기관 유형의 공통 자료실(현재 판만) */
  common(scope: RegulationScope, query: string): Promise<ProviderResult>;
  /** 국가법령정보 — 법령(전국), 지방자치단체면 자치법규도 */
  laws(scope: RegulationScope, plan: RegulationPlan): Promise<ProviderResult>;
}

export interface GatherResult {
  raw: RawEvidence[];
  unavailable: string[];
}

const LABEL: Record<keyof RegulationProviders, string> = { orgDocuments: '기관 문서', common: '공통 기준 자료', laws: '국가법령정보' };

export async function gatherEvidence(
  providers: RegulationProviders,
  scope: RegulationScope,
  plan: RegulationPlan,
  uploads: { id: string; name: string; text: string }[]
): Promise<GatherResult> {
  const keys = ['orgDocuments', 'common', 'laws'] as const;
  const settled = await Promise.allSettled([
    providers.orgDocuments(scope, plan.searchQuery),
    providers.common(scope, plan.searchQuery),
    providers.laws(scope, plan),
  ]);
  const raw: RawEvidence[] = [];
  const unavailable: string[] = [];
  const failed: string[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'rejected') failed.push(LABEL[keys[i]]);
    else if (s.value.status === 'unavailable') unavailable.push(`${LABEL[keys[i]]}: ${s.value.reason}`);
    else raw.push(...s.value.items);
  });
  if (failed.length) {
    throw new WorkError('SOURCE_UNAVAILABLE', `${failed.join('·')}을(를) 지금 불러오지 못했습니다. 잠시 뒤 다시 시도합니다.`, 503, { failed });
  }
  for (const u of uploads) {
    if (!u.text.trim()) continue;
    raw.push({ kind: 'upload', title: u.name, location: null, effectiveDate: null, editionYear: null, issuer: null, text: u.text, url: null });
  }
  return { raw, unavailable };
}

// ── 법제처 결과 읽기(순수) ──────────────────────────────────────

export interface LawSearchRow {
  title: string;
  id: string;
  effectiveDate: string | null;
  /** 자치법규의 지자체 */
  issuer: string | null;
}

/** law_search 결과 글('1. 제목\n   시행일자: …\n   id: …')을 줄로 읽는다 — 글 꼴은 connectors/law.ts의 search가 정한다 */
export function parseLawSearch(content: string): LawSearchRow[] {
  const rows: LawSearchRow[] = [];
  for (const block of content.split(/\n(?=\d+\.\s)/)) {
    const title = /^\s*\d+\.\s+(.+)$/m.exec(block)?.[1]?.trim();
    const id = /^\s*id:\s*(\S+)\s*$/m.exec(block)?.[1];
    if (!title || !id) continue;
    rows.push({
      title,
      id,
      effectiveDate: normalizeDate(/시행일자:\s*([0-9-]{8,10})/.exec(block)?.[1] ?? null),
      issuer: /지자체:\s*([^/\n]+?)\s*(?:\/|$)/m.exec(block)?.[1]?.trim() || null,
    });
  }
  return rows;
}

export interface LawArticle {
  /** '제17조(숙박비)' — 본문에 실제로 적힌 머리 */
  heading: string;
  text: string;
}

/** law_get_content 본문을 조문으로 자른다. 첫 줄 '법령명 (시행 …)'은 머리라 뺀다 */
export function splitArticles(content: string): { enforced: string | null; articles: LawArticle[] } {
  const enforced = parseEnforcedDate(content.split('\n')[0] ?? '');
  const body = content.split('\n').slice(1).join('\n');
  const parts = body.split(/\n(?=\s*제\d+조(?:의\d+)?\s*(?:\(|\s|$))/);
  const articles: LawArticle[] = [];
  for (const p of parts) {
    const t = p.trim();
    const head = /^제\d+조(?:의\d+)?(?:\s*\([^)\n]{1,60}\))?/.exec(t);
    if (!head) continue;
    // 머리는 원문 그대로(띄어쓰기만 한 칸으로) — 위치는 실제 적힌 글이어야 한다
    articles.push({ heading: head[0].replace(/\s+/g, ' '), text: t });
  }
  return { enforced, articles };
}

/** 핵심어가 많이 나오는 조문 순 — 하나도 안 맞으면 고르지 않는다(관련 없는 조문을 근거로 싣지 않음) */
export function pickArticles(articles: LawArticle[], keywords: string[], max: number): LawArticle[] {
  const words = keywords.map((k) => k.trim()).filter((k) => k.length >= 2);
  if (!words.length) return [];
  return articles
    .map((a, i) => ({ a, i, score: words.reduce((n, w) => n + (a.text.includes(w) ? 1 + (a.heading.includes(w) ? 1 : 0) : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || x.i - y.i)
    .slice(0, max)
    .map((x) => x.a);
}
