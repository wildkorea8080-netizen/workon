/**
 * 국가법령정보 공동활용 커넥터 (법제처).
 *
 * API 계약은 실제 호출로 확인했습니다:
 *   검색  GET https://www.law.go.kr/DRF/lawSearch.do?OC={oc}&target=law&type=JSON&query=&display=
 *         → LawSearch.law[] { 법령명한글, 법령ID, 법령일련번호(MST), 법령구분명, 소관부처명, 시행일자 }
 *   본문  GET https://www.law.go.kr/DRF/lawService.do?OC={oc}&target=law&type=JSON&MST={mst}
 *         → 법령.기본정보 + 법령.조문.조문단위[] { 조문번호, 조문제목, 조문내용 }
 *
 * 인용 링크는 https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq={MST} 를 씁니다
 * (OC가 노출되지 않는 공개 페이지).
 */

import { LAW_API_OC } from '@/lib/config';
import {
  fetchJson,
  toArray,
  toolError,
  type Connector,
  type ToolDefinition,
  type ToolResult,
} from './types';

const SEARCH_URL = 'https://www.law.go.kr/DRF/lawSearch.do';
const DETAIL_URL = 'https://www.law.go.kr/DRF/lawService.do';
const PUBLIC_URL = 'https://www.law.go.kr/LSW/lsInfoP.do';

const MAX_SEARCH_RESULTS = 20;
/** 조문 전체를 그대로 넘기면 컨텍스트를 다 잡아먹는다 */
const MAX_ARTICLES = 60;

interface SearchRow {
  법령명한글?: string;
  법령ID?: string;
  법령일련번호?: string;
  법령구분명?: string;
  소관부처명?: string;
  시행일자?: string;
  공포일자?: string;
}

interface ClauseRow {
  호번호?: string;
  호내용?: string | string[];
}

interface ParagraphRow {
  항번호?: string;
  항내용?: string | string[];
  호?: ClauseRow | ClauseRow[];
}

interface ArticleRow {
  조문번호?: string;
  조문제목?: string;
  /** 조문 제목 줄만 담긴다. 실제 본문은 항/호에 있다. */
  조문내용?: string | string[];
  항?: ParagraphRow | ParagraphRow[];
  /** '조문'이면 실제 조문, '전문'이면 편/장/절 머리글 */
  조문여부?: string;
}

/**
 * 조문 한 건을 텍스트로 만든다.
 *
 * 주의: 조문내용에는 "제15조(개인정보의 수집·이용)" 같은 제목 줄만 들어 있고
 * 실제 규정 내용은 항 → 호 계층에 있다. 조문내용만 읽으면 제목만 나온다.
 */
function renderArticle(article: ArticleRow): string {
  const parts = [toArray(article.조문내용).join('\n').trim()];

  for (const paragraph of toArray(article.항)) {
    const body = toArray(paragraph.항내용).join('\n').trim();
    if (body) parts.push(body);

    for (const clause of toArray(paragraph.호)) {
      const clauseBody = toArray(clause.호내용).join('\n').trim();
      if (clauseBody) parts.push(`  ${clauseBody}`);
    }
  }

  return parts.filter(Boolean).join('\n');
}

function publicUrl(mst: string) {
  return `${PUBLIC_URL}?lsiSeq=${encodeURIComponent(mst)}`;
}

function formatDate(value?: string) {
  if (!value || value.length !== 8) return value ?? '';
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

const tools: ToolDefinition[] = [
  {
    name: 'law_search',
    description:
      '대한민국 법령을 이름으로 검색한다. 법률·시행령·시행규칙·대법원규칙 등이 대상이다. ' +
      '법령의 정확한 조문 내용이 필요하면 이 도구로 먼저 검색해 법령일련번호(mst)를 얻은 뒤 law_get_articles를 호출한다.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색할 법령명 (예: 개인정보 보호법)' },
        limit: {
          type: 'number',
          description: `가져올 최대 건수 (기본 5, 최대 ${MAX_SEARCH_RESULTS})`,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'law_get_articles',
    description:
      '법령의 조문 원문을 가져온다. law_search로 얻은 법령일련번호(mst)가 필요하다. ' +
      '특정 조문만 필요하면 article 인자로 조문 번호를 지정한다.',
    inputSchema: {
      type: 'object',
      properties: {
        mst: { type: 'string', description: 'law_search가 돌려준 법령일련번호' },
        article: {
          type: 'string',
          description: '조회할 조문 번호. 예: "15". 생략하면 전체 조문을 가져온다.',
        },
      },
      required: ['mst'],
    },
  },
];

async function search(input: Record<string, unknown>): Promise<ToolResult> {
  const query = String(input.query ?? '').trim();
  if (!query) return toolError('검색할 법령명이 필요합니다.');

  const limit = Math.min(Math.max(Number(input.limit) || 5, 1), MAX_SEARCH_RESULTS);

  const url =
    `${SEARCH_URL}?OC=${encodeURIComponent(LAW_API_OC)}&target=law&type=JSON` +
    `&query=${encodeURIComponent(query)}&display=${limit}`;

  let payload: { LawSearch?: { law?: SearchRow | SearchRow[]; totalCnt?: string } };
  try {
    payload = await fetchJson(url);
  } catch (err: any) {
    return toolError(`국가법령정보 검색에 실패했습니다: ${err?.message ?? '알 수 없는 오류'}`);
  }

  const rows = toArray(payload.LawSearch?.law);
  if (rows.length === 0) {
    return { content: `"${query}"에 해당하는 법령을 찾지 못했습니다.`, sources: [] };
  }

  const lines = rows.map((row, index) => {
    const mst = row.법령일련번호 ?? '';
    return [
      `${index + 1}. ${row.법령명한글 ?? '(이름 없음)'}`,
      `   법령구분: ${row.법령구분명 ?? '-'} / 소관부처: ${row.소관부처명 ?? '-'}`,
      `   시행일자: ${formatDate(row.시행일자)} / 공포일자: ${formatDate(row.공포일자)}`,
      `   법령일련번호(mst): ${mst}`,
    ].join('\n');
  });

  return {
    content: `"${query}" 검색 결과 ${rows.length}건 (전체 ${payload.LawSearch?.totalCnt ?? rows.length}건)\n\n${lines.join('\n\n')}`,
    sources: rows
      .filter((row) => row.법령일련번호)
      .map((row) => ({
        title: row.법령명한글 ?? '법령',
        url: publicUrl(row.법령일련번호!),
      })),
  };
}

async function getArticles(input: Record<string, unknown>): Promise<ToolResult> {
  const mst = String(input.mst ?? '').trim();
  if (!mst) return toolError('법령일련번호(mst)가 필요합니다. law_search로 먼저 조회하세요.');

  const articleFilter = input.article == null ? null : String(input.article).trim();

  const url =
    `${DETAIL_URL}?OC=${encodeURIComponent(LAW_API_OC)}&target=law&type=JSON` +
    `&MST=${encodeURIComponent(mst)}`;

  let payload: {
    법령?: {
      기본정보?: Record<string, unknown>;
      조문?: { 조문단위?: ArticleRow | ArticleRow[] };
    };
  };
  try {
    payload = await fetchJson(url);
  } catch (err: any) {
    return toolError(`법령 본문 조회에 실패했습니다: ${err?.message ?? '알 수 없는 오류'}`);
  }

  const law = payload.법령;
  if (!law?.조문) {
    return toolError(`법령일련번호 ${mst}에 해당하는 법령을 찾지 못했습니다.`);
  }

  const basic = law.기본정보 ?? {};
  const name = String(basic['법령명_한글'] ?? '법령');
  const enforcedAt = formatDate(String(basic['시행일자'] ?? ''));

  let articles = toArray(law.조문.조문단위).filter((a) => a.조문내용);

  if (articleFilter) {
    // 편/장/절 머리글(조문여부='전문')도 뒤따르는 조문과 같은 조문번호를 갖는다.
    // 특정 조문을 찾을 때는 실제 조문만 걸러야 머리글이 딸려오지 않는다.
    articles = articles.filter(
      (a) => String(a.조문번호 ?? '') === articleFilter && a.조문여부 === '조문'
    );
    if (articles.length === 0) {
      return toolError(`${name}에서 제${articleFilter}조를 찾지 못했습니다.`);
    }
  }

  const truncated = articles.length > MAX_ARTICLES;
  const shown = truncated ? articles.slice(0, MAX_ARTICLES) : articles;

  const body = shown.map(renderArticle).filter(Boolean).join('\n\n');

  const header = `${name} (시행 ${enforcedAt})`;
  const note = truncated
    ? `\n\n[조문이 많아 앞 ${MAX_ARTICLES}개만 표시했습니다. 특정 조문은 article 인자로 지정하세요.]`
    : '';

  return {
    content: `${header}\n\n${body}${note}`,
    sources: [{ title: name, url: publicUrl(mst) }],
  };
}

export const lawConnector: Connector = {
  id: 'law',
  label: '국가법령정보 (법제처)',
  tools,
  // OC는 기본값이 있어 항상 사용 가능하다. 운영에서는 자체 OC 발급을 권장한다.
  isConfigured: () => Boolean(LAW_API_OC),
  execute(toolName, input) {
    switch (toolName) {
      case 'law_search':
        return search(input);
      case 'law_get_articles':
        return getArticles(input);
      default:
        return Promise.resolve(toolError(`알 수 없는 도구입니다: ${toolName}`));
    }
  },
};
