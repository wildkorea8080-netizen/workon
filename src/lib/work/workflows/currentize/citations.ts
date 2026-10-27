// src/lib/work/workflows/currentize/citations.ts
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
const KEYWORD_NOUNS = 3;
/** 이 수 이하의 내용 낱말은 전부 있어야 같음, 넘으면 비율로 본다 */
const ALL_REQUIRED_MAX = 3;
const SAME_RATIO = 0.7;

/**
 * 조문 번호 바로 뒤에 붙는 연결 표현('제64조에 따라', '제3조의 규정에 의하여', '제5조에서 정한', '제2조상의').
 * 작년 문장의 내용은 이 뒤부터이고, 연결 표현은 법 본문에 없으므로 대조 전에 뗀다. 연결 표현 뒤의 쉼표도 함께 뗀다.
 */
const LEADING_CONNECTOR =
  /^(?:에\s*(?:따라서?|따른|따르면|의하여|의해서?|의한|의거하여|의거한|의거|근거하여|근거한|근거하면|규정된|규정한|정한|정하는)|의\s*규정에\s*(?:따라서?|의하여|의해서?|따른)|의\s*규정|에서\s*정(?:한|하는)|상의(?=\s|$))\s*[,，]?\s*/;

/** 낱말 끝에 붙어 남는 조사·어미 — 떼어도 두 글자 이상 남을 때만 뗀다 */
const TRAILING_SUFFIX = /(?:으로|에서|에게|한다|된다|이다|은|는|이|가|을|를|의|에|로|와|과|도|만)$/;
/** 낱말로 세지 않는 말(조사·접속·상투 어미) */
const STOP_WORDS = new Set(['및', '등', '또는', '그', '이', '가', '은', '는', '을', '를', '의', '에', '로', '으로', '와', '과', '있다', '한다', '된다', '하여', '하고', '하는']);

/** 글에서 내용 낱말을 뽑는다 — 한글·영숫자 덩어리 중 두 글자 이상이고 상투어가 아닌 것(끝의 조사는 뗀다) */
export function contentTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.normalize('NFC').match(/[가-힣A-Za-z0-9]+/g) ?? []) {
    let t = m;
    if (STOP_WORDS.has(t)) continue;
    const stripped = t.replace(TRAILING_SUFFIX, '');
    if (stripped.length >= 2) t = stripped;
    if (t.length < 2 || STOP_WORDS.has(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * 이름 비교용 — NFC, 「」, 괄호 속 글('(약칭…)')과 공백을 뗀다.
 * 같은 이름이어야만 같은 규정이다: 포함 관계로 보면 「지방공기업법」 인용이 「지방공기업법 시행령」의 같은 번호 조문과 맞대어진다
 */
function normName(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[「」『』]/g, '')
    .replace(/[(（][^)）]*[)）]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function sameTitle(title: string, name: string): boolean {
  const a = normName(title);
  return a.length >= 2 && a === normName(name);
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
  const { articles } = splitArticles(`\n${e.text}`);
  const hit = articles.find((a) => headingIs(a.heading, article));
  if (hit) return { ...base, text: hit.text };
  // 조문 구조가 없는 글(기관 문서 조각)은 그 조문 번호가 머리(글 첫머리나 줄머리)에 있을 때만 쓴다 — 본문에서 언급만 한 것은 그 조문이 아니다
  if (articles.length === 0 && new RegExp(String.raw`(?:^|\n)\s*${article}(?![0-9의])`).test(e.text)) return { ...base, text: e.text };
  return null;
}

/**
 * 인용 바로 뒤 30자 — 작년 문서가 그 조문을 어떻게 옮겼는지.
 * 다음 인용(「)이나 문장 끝(마침표)에서 끊는다: 「A」 제1조 및 「B」 제2조에 따라 …에서 B의 낱말이 A의 것으로 들어가면 안 된다
 */
function citedWindow(input: CitationInput): string {
  const w = input.segmentText.slice(input.finding.end, input.finding.end + WINDOW_CHARS);
  const cut = w.search(/「|[.。](?=\s|$)/);
  return (cut >= 0 ? w.slice(0, cut) : w).trim();
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

    // 이름이 같은 근거 가운데 이 조문이 있는 첫 번째(제공자 순서). 이름이 비슷한 다른 규정(시행령 등)으로 넘어가지 않는다
    const hit = (evidenceByName.get(name) ?? [])
      .filter((e) => sameTitle(e.title, name))
      .map((e) => ({ e, r: resolveArticle(e, article) }))
      .find((x) => x.r !== null);
    if (!hit?.r) return { segmentId: input.segmentId, cited, current: null, status: 'not_found' };

    const r = hit.r;
    const current = { kind: r.kind, title: r.title, article: r.article, text: r.text.slice(0, EVIDENCE_TEXT_MAX), enforced: r.enforced };
    // 연결 표현을 뗀 인용 뒤 문장의 내용 낱말이 현재 조문 글에 얼마나 있는가.
    // 낱말은 조문 글에 들어 있기만 하면 된다('편성' ↔ '편성하여' — 어미가 달라진 것은 바뀜이 아니다)
    const tokens = contentTokens(window.replace(LEADING_CONNECTOR, ''));
    const hay = r.text.normalize('NFC');
    const found = tokens.filter((t) => hay.includes(t)).length;
    // 숫자가 든 낱말(70, 3년)은 하나라도 조문에 없으면 바뀜 — 다른 낱말이 맞아 비율을 채워도 바뀐 수치를 덮지 못하게 한다
    const numbersHeld = tokens.filter((t) => /\d/.test(t)).every((t) => hay.includes(t));
    // 대조할 내용이 없으면 반박할 것도 없다(같음). 적으면 전부, 많으면 70% 이상
    const same = numbersHeld && (tokens.length === 0 || (tokens.length <= ALL_REQUIRED_MAX ? found === tokens.length : found / tokens.length >= SAME_RATIO));
    return { segmentId: input.segmentId, cited, current, status: same ? 'same' : 'changed' };
  });
}
