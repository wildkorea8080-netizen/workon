// src/lib/work/workflows/currentize/citations.ts
import { squash } from '@/lib/table-engine/combine';
import { EVIDENCE_TEXT_MAX, assessEvidence, isUsable, type EvidenceKind, type RawEvidence } from '../regulations/evidence';
import { gatherEvidence, splitArticles, type RegulationProviders, type RegulationScope } from '../regulations/gather';
import type { RegulationPlan } from '../regulations/model';
import type { Finding } from './classify';

/**
 * 작년 문서가 인용한 규정·조문을 지금 조문과 맞댄다(S6-1). 법제처 연혁 API는 쓰지 않는다 —
 * '옛 글'은 작년 문단에 적힌 인용 문장 그대로이고, '새 글'은 규정 확인의 제공자가 가져온 현재 판이다.
 * 이 파일은 맞대기만 한다(글을 고치지 않는다).
 */
export interface CitationPair {
  segmentId: string;
  /** 작년 문단에서 읽은 인용. text = 조문 번호 바로 뒤 30자(앞뒤 공백 뗌) */
  cited: { name: string; article: string | null; text: string };
  /** 지금 판에서 찾은 근거. 쓸 수 있는 근거가 없으면 null */
  current: { kind: EvidenceKind; title: string; article: string | null; text: string; enforced: string | null } | null;
  status: 'same' | 'changed' | 'not_found';
}

export interface CitationInput {
  segmentId: string;
  /** 인용이 든 문단의 글 — 인용 뒤 문장(30자)을 떼는 데 쓴다 */
  segmentText: string;
  finding: Finding;
}

/** 인용 뒤에서 떼는 글자 수 */
const WINDOW_CHARS = 30;
/** 이보다 짧은 문장은 '그대로 있다'는 말이 아무것도 보장하지 못한다(예: '에 따라') */
const MIN_COMPARABLE = 6;
const KEYWORD_NOUNS = 3;

/** 이름 비교용 — 공백·「」·괄호를 빼고 소문자로 */
function normName(s: string): string {
  return s.normalize('NFC').replace(/[\s「」『』()（）·]/g, '').toLowerCase();
}

function titleScore(title: string, name: string): number {
  const a = normName(title);
  const b = normName(name);
  if (a.length < 2 || b.length < 2) return 0;
  if (a === b) return 2;
  return a.includes(b) || b.includes(a) ? 1 : 0;
}

/** 조문 머리가 이 조문인가 — '제76조'는 '제76조의2'가 아니다 */
function headingIs(heading: string, article: string): boolean {
  if (!heading.startsWith(article)) return false;
  return !/^[0-9의]/.test(heading.slice(article.length));
}

interface Resolved {
  kind: EvidenceKind;
  title: string;
  article: string | null;
  /** 비교에 쓰는 전체 글 */
  text: string;
  enforced: string | null;
}

/** 근거 하나에서 이 조문의 글을 가려낸다. 조문이 없는 인용이면 근거 글 전체. 그 조문이 없으면 null */
function resolveArticle(e: RawEvidence, article: string | null): Resolved | null {
  const base = { kind: e.kind, title: e.title, article, enforced: e.effectiveDate };
  if (!article) return { ...base, text: e.text };
  // 앞에 빈 줄을 붙인다 — splitArticles는 첫 줄을 '법령명 (시행 …)' 머리로 보고 버리는데,
  // 제공자가 준 조문 글은 머리 없이 '제64조(…)'로 시작한다
  const { enforced, articles } = splitArticles(`\n${e.text}`);
  const hit = articles.find((a) => headingIs(a.heading, article));
  if (hit) return { ...base, text: hit.text, enforced: e.effectiveDate ?? enforced };
  // 조문 구조가 없는 글(기관 문서 조각)은 그 조문 번호가 글 안에 있을 때만 쓴다
  if (articles.length === 0 && squash(e.text).includes(article)) return { ...base, text: e.text };
  return null;
}

/** 인용 바로 뒤 30자 — 작년 문서가 그 조문을 어떻게 옮겼는지 */
function citedWindow(input: CitationInput): string {
  return input.segmentText.slice(input.finding.end, input.finding.end + WINDOW_CHARS).trim();
}

function planFor(name: string, articles: string[], windows: string[]): RegulationPlan {
  const nouns: string[] = [];
  for (const w of windows) for (const n of w.match(/[가-힣]{2,}/g) ?? []) if (!nouns.includes(n)) nouns.push(n);
  return {
    searchQuery: [name, ...articles].join(' '),
    lawQueries: [name],
    keywords: [...articles, ...nouns.slice(0, KEYWORD_NOUNS)].slice(0, 8),
  };
}

export async function compareCitations(
  findings: CitationInput[],
  providers: RegulationProviders,
  scope: RegulationScope,
  basisDate: string
): Promise<CitationPair[]> {
  // 이름마다 한 번만 가져온다(같은 규정을 여러 번 인용해도 제공자는 한 번)
  const groups = new Map<string, CitationInput[]>();
  for (const f of findings) {
    const name = f.finding.detail?.name?.trim();
    if (!name) continue;
    groups.set(name, [...(groups.get(name) ?? []), f]);
  }
  const evidenceByName = new Map<string, RawEvidence[]>();
  for (const [name, group] of groups) {
    const articles = [...new Set(group.map((g) => g.finding.detail?.article).filter((a): a is string => !!a))];
    const plan = planFor(name, articles, group.map(citedWindow));
    // 제공자가 던지면 SOURCE_UNAVAILABLE이 그대로 올라간다(실행기가 다시 시도). 'unavailable'은 근거가 없는 것과 같다
    const { raw } = await gatherEvidence(providers, scope, plan, []);
    const usable = raw.filter((e) => isUsable(assessEvidence(e, { basisDate, organizationName: scope.organizationName }).applicability));
    evidenceByName.set(name, usable);
  }

  return findings.map((input): CitationPair => {
    const name = input.finding.detail?.name?.trim() ?? '';
    const article = input.finding.detail?.article ?? null;
    const window = citedWindow(input);
    const cited = { name, article, text: window };

    // 이름이 가장 잘 맞는(같음 > 포함) 근거 가운데 이 조문이 있는 것 — 같은 점수면 제공자 순서
    const hit = (evidenceByName.get(name) ?? [])
      .map((e, i) => ({ e, i, score: titleScore(e.title, name) }))
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score || x.i - y.i)
      .map((x) => ({ e: x.e, r: resolveArticle(x.e, article) }))
      .find((x) => x.r !== null);
    if (!hit?.r) return { segmentId: input.segmentId, cited, current: null, status: 'not_found' };

    const r = hit.r;
    const current = { kind: r.kind, title: r.title, article: r.article, text: r.text.slice(0, EVIDENCE_TEXT_MAX), enforced: r.enforced };
    const now = squash(r.text);
    const sentence = squash(window);

    let same: boolean;
    if (sentence.length >= MIN_COMPARABLE) {
      same = now.includes(sentence);
    } else if (sentence.length === 0) {
      // 인용 뒤에 대조할 문장이 없다. 조문 번호가 있으면 그 조문 글이 달라졌는지 알 수 없어 사람이 보게 'changed'로 두고,
      // 조문 번호도 없으면 규정이 지금 있다는 것밖에 확인할 게 없어 'same'
      same = article === null;
    } else {
      // 6자 미만의 짧은 문장은 어느 글에나 있어 의미가 없다 — 인용 자체(조문 번호, 없으면 규정 이름)가 현재 글에 있는지만 본다
      same = article ? now.includes(squash(article)) : titleScore(r.title, name) > 0;
    }
    return { segmentId: input.segmentId, cited, current, status: same ? 'same' : 'changed' };
  });
}
