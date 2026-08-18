/**
 * 국가법령정보 공동활용 커넥터 (법제처).
 *
 * 같은 엔드포인트에서 target 파라미터만 바꾸면 법률뿐 아니라 자치법규(조례·규칙),
 * 행정규칙(훈령·예규·고시), 판례, 법령해석례를 모두 조회할 수 있습니다.
 * 공공기관 실무에서는 법률보다 조례·훈령·유권해석을 찾는 일이 더 잦아
 * 전 부서 도달률이 가장 높은 커넥터입니다.
 *
 * 모든 계약은 문서가 아니라 실제 호출로 확인했습니다.
 *   검색  GET /DRF/lawSearch.do?OC=&target=&type=JSON&query=&display=
 *   본문  GET /DRF/lawService.do?OC=&target=&type=JSON&{ID|MST}=
 *
 * target마다 응답 봉투 이름과 식별자 파라미터가 다릅니다 (RESOURCES 참조).
 * 판례는 검색만 되고 본문 조회는 OC=test로 거부됩니다.
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

const MAX_SEARCH_RESULTS = 20;
/** 조문 전체를 그대로 넘기면 컨텍스트를 다 잡아먹는다 */
const MAX_ARTICLES = 60;

interface ResourceSpec {
  /** API의 target 파라미터 */
  target: string;
  /** 검색 응답의 최상위 키 */
  searchEnvelope: string;
  /** 검색 응답에서 목록이 담긴 키 */
  listKey: string;
  /** 결과 표시에 쓸 필드들 */
  titleField: string;
  /** 본문 조회에 넘길 식별자 필드 */
  idField: string;
  /** 본문 조회 파라미터 이름 (target마다 다르다) */
  idParam: 'ID' | 'MST';
  /** 공개 인용 링크 */
  publicUrl: (id: string) => string;
  /** 본문 조회 지원 여부 */
  detail: boolean;
  /** 목록 한 건을 보조 설명으로 */
  describe: (row: Record<string, string | undefined>) => string[];
}

function formatDate(value?: string) {
  if (!value || value.length !== 8) return value ?? '';
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

/**
 * 조회 가능한 자료 종류.
 * 키가 곧 모델에게 노출되는 `type` 값이다.
 */
const RESOURCES: Record<string, ResourceSpec> = {
  법령: {
    target: 'law',
    searchEnvelope: 'LawSearch',
    listKey: 'law',
    titleField: '법령명한글',
    idField: '법령일련번호',
    idParam: 'MST',
    publicUrl: (id) => `https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=${encodeURIComponent(id)}`,
    detail: true,
    describe: (r) => [
      `법령구분: ${r.법령구분명 ?? '-'} / 소관부처: ${r.소관부처명 ?? '-'}`,
      `시행일자: ${formatDate(r.시행일자)} / 공포일자: ${formatDate(r.공포일자)}`,
    ],
  },
  자치법규: {
    target: 'ordin',
    searchEnvelope: 'OrdinSearch',
    listKey: 'law',
    titleField: '자치법규명',
    idField: '자치법규일련번호',
    idParam: 'MST',
    publicUrl: (id) => `https://www.law.go.kr/LSW/ordinInfoP.do?ordinSeq=${encodeURIComponent(id)}`,
    detail: true,
    describe: (r) => [
      `지자체: ${r.지자체기관명 ?? '-'} / 종류: ${r.자치법규종류 ?? '-'}`,
      `시행일자: ${formatDate(r.시행일자)} / 분야: ${r.자치법규분야명 ?? '-'}`,
    ],
  },
  행정규칙: {
    target: 'admrul',
    searchEnvelope: 'AdmRulSearch',
    listKey: 'admrul',
    titleField: '행정규칙명',
    idField: '행정규칙일련번호',
    idParam: 'ID',
    publicUrl: (id) => `https://www.law.go.kr/LSW/admRulInfoP.do?admRulSeq=${encodeURIComponent(id)}`,
    detail: true,
    describe: (r) => [
      `종류: ${r.행정규칙종류 ?? '-'} / 소관부처: ${r.소관부처명 ?? '-'}`,
      `시행일자: ${formatDate(r.시행일자)} / 발령일자: ${formatDate(r.발령일자)}`,
    ],
  },
  판례: {
    target: 'prec',
    searchEnvelope: 'PrecSearch',
    listKey: 'prec',
    titleField: '사건명',
    idField: '판례일련번호',
    idParam: 'ID',
    publicUrl: (id) => `https://www.law.go.kr/LSW/precInfoP.do?precSeq=${encodeURIComponent(id)}`,
    // 본문 조회는 API가 "일치하는 판례가 없습니다"로 거부한다(별도 권한 필요로 보임).
    // 검색 결과의 사건번호·법원·선고일자와 공개 링크로 안내한다.
    detail: false,
    describe: (r) => [
      `법원: ${r.법원명 ?? '-'} / 사건번호: ${r.사건번호 ?? '-'}`,
      `선고일자: ${formatDate(r.선고일자)} / ${r.사건종류명 ?? ''} ${r.판결유형 ?? ''}`.trim(),
    ],
  },
  법령해석례: {
    target: 'expc',
    searchEnvelope: 'Expc',
    listKey: 'expc',
    titleField: '안건명',
    idField: '법령해석례일련번호',
    idParam: 'ID',
    publicUrl: (id) => `https://www.law.go.kr/LSW/expcInfoP.do?expcSeq=${encodeURIComponent(id)}`,
    detail: true,
    describe: (r) => [
      `회신기관: ${r.회신기관명 ?? '-'} / 질의기관: ${r.질의기관명 ?? '-'}`,
      `회신일자: ${formatDate(r.회신일자)} / 안건번호: ${r.안건번호 ?? '-'}`,
    ],
  },
};

const RESOURCE_KEYS = Object.keys(RESOURCES);
const DETAIL_KEYS = RESOURCE_KEYS.filter((k) => RESOURCES[k].detail);

const tools: ToolDefinition[] = [
  {
    name: 'law_search',
    description:
      '국가법령정보에서 법령·자치법규·행정규칙·판례·법령해석례를 검색한다. ' +
      "type으로 종류를 고른다: '법령'(법률·시행령·시행규칙), '자치법규'(지자체 조례·규칙), " +
      "'행정규칙'(훈령·예규·고시), '판례', '법령해석례'(정부 유권해석). " +
      '원문이 필요하면 이 도구로 먼저 검색해 id를 얻은 뒤 law_get_content를 호출한다.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색어 (예: 개인정보 보호법, 정보공개 조례)' },
        type: {
          type: 'string',
          enum: RESOURCE_KEYS,
          description: `자료 종류. 기본값 '법령'`,
        },
        limit: { type: 'number', description: `가져올 건수 (기본 5, 최대 ${MAX_SEARCH_RESULTS})` },
      },
      required: ['query'],
    },
  },
  {
    name: 'law_get_content',
    description:
      'law_search로 얻은 id로 원문을 가져온다. ' +
      `본문 조회가 가능한 종류: ${DETAIL_KEYS.join(', ')}. ` +
      "type='법령'일 때는 article로 특정 조문만 지정할 수 있다. " +
      '판례는 본문 조회가 지원되지 않으니 검색 결과의 링크를 안내한다.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'law_search가 돌려준 id' },
        type: { type: 'string', enum: DETAIL_KEYS, description: `자료 종류. 기본값 '법령'` },
        article: {
          type: 'string',
          description: "조문 번호. 예: '15'. type='법령'에서만 쓰이고, 생략하면 전체를 가져온다.",
        },
      },
      required: ['id'],
    },
  },
];

// ── 검색 ─────────────────────────────────────────────────────

async function search(input: Record<string, unknown>): Promise<ToolResult> {
  const query = String(input.query ?? '').trim();
  if (!query) return toolError('검색어가 필요합니다.');

  const typeKey = String(input.type ?? '법령').trim();
  const spec = RESOURCES[typeKey];
  if (!spec) {
    return toolError(`type은 ${RESOURCE_KEYS.join(', ')} 중 하나여야 합니다. (받은 값: ${typeKey})`);
  }

  const limit = Math.min(Math.max(Number(input.limit) || 5, 1), MAX_SEARCH_RESULTS);

  const url =
    `${SEARCH_URL}?OC=${encodeURIComponent(LAW_API_OC)}&target=${spec.target}&type=JSON` +
    `&query=${encodeURIComponent(query)}&display=${limit}`;

  let payload: Record<string, any>;
  try {
    payload = await fetchJson(url);
  } catch (err: any) {
    return toolError(`${typeKey} 검색에 실패했습니다: ${err?.message ?? '알 수 없는 오류'}`);
  }

  const body = payload[spec.searchEnvelope];
  if (!body) {
    return toolError(`${typeKey} 검색 응답을 해석할 수 없습니다.`);
  }

  const rows = toArray<Record<string, string | undefined>>(body[spec.listKey]);
  if (rows.length === 0) {
    return { content: `"${query}"에 해당하는 ${typeKey}을(를) 찾지 못했습니다.`, sources: [] };
  }

  const lines = rows.map((row, index) => {
    const id = row[spec.idField] ?? '';
    return [
      `${index + 1}. ${row[spec.titleField] ?? '(제목 없음)'}`,
      ...spec.describe(row).map((line) => `   ${line}`),
      `   id: ${id}`,
    ].join('\n');
  });

  const note = spec.detail ? '' : `\n\n(${typeKey}는 본문 조회가 지원되지 않습니다. 링크를 안내하세요.)`;

  return {
    content:
      `[${typeKey}] "${query}" 검색 결과 ${rows.length}건 (전체 ${body.totalCnt ?? rows.length}건)\n\n` +
      lines.join('\n\n') +
      note,
    sources: rows
      .filter((row) => row[spec.idField])
      .map((row) => ({
        title: `${row[spec.titleField] ?? typeKey}`,
        url: spec.publicUrl(row[spec.idField]!),
      })),
  };
}

// ── 본문 ─────────────────────────────────────────────────────

interface ClauseRow { 호번호?: string; 호내용?: string | string[] }
interface ParagraphRow { 항번호?: string; 항내용?: string | string[]; 호?: ClauseRow | ClauseRow[] }
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

/** 법령·자치법규는 조문 구조가 같다 */
function renderArticles(law: any, articleFilter: string | null, label: string) {
  let articles = toArray<ArticleRow>(law?.조문?.조문단위).filter((a) => a.조문내용);

  if (articleFilter) {
    // 편/장/절 머리글(조문여부='전문')도 뒤따르는 조문과 같은 조문번호를 갖는다.
    articles = articles.filter(
      (a) => String(a.조문번호 ?? '') === articleFilter && a.조문여부 === '조문'
    );
    if (articles.length === 0) return { error: `${label}에서 제${articleFilter}조를 찾지 못했습니다.` };
  }

  const truncated = articles.length > MAX_ARTICLES;
  const shown = truncated ? articles.slice(0, MAX_ARTICLES) : articles;
  const body = shown.map(renderArticle).filter(Boolean).join('\n\n');
  const note = truncated
    ? `\n\n[조문이 많아 앞 ${MAX_ARTICLES}개만 표시했습니다. 특정 조문은 article 인자로 지정하세요.]`
    : '';

  return { body: `${body}${note}` };
}

async function getContent(input: Record<string, unknown>): Promise<ToolResult> {
  const id = String(input.id ?? '').trim();
  if (!id) return toolError('id가 필요합니다. law_search로 먼저 조회하세요.');

  const typeKey = String(input.type ?? '법령').trim();
  const spec = RESOURCES[typeKey];
  if (!spec) {
    return toolError(`type은 ${RESOURCE_KEYS.join(', ')} 중 하나여야 합니다. (받은 값: ${typeKey})`);
  }
  if (!spec.detail) {
    return toolError(
      `${typeKey}는 본문 조회가 지원되지 않습니다. 검색 결과의 링크로 안내하세요: ${spec.publicUrl(id)}`
    );
  }

  const url =
    `${DETAIL_URL}?OC=${encodeURIComponent(LAW_API_OC)}&target=${spec.target}&type=JSON` +
    `&${spec.idParam}=${encodeURIComponent(id)}`;

  let payload: Record<string, any>;
  try {
    payload = await fetchJson(url);
  } catch (err: any) {
    return toolError(`${typeKey} 본문 조회에 실패했습니다: ${err?.message ?? '알 수 없는 오류'}`);
  }

  // 조회 실패는 { "Law": "일치하는 …이 없습니다" } 형태의 문자열로 온다
  if (typeof payload.Law === 'string') {
    return toolError(`${typeKey} 본문 조회 실패: ${payload.Law.trim()}`);
  }

  const source = { title: typeKey, url: spec.publicUrl(id) };
  const articleFilter = input.article == null ? null : String(input.article).trim() || null;

  // ── 법령: 조문단위 → 항 → 호 계층 ──
  if (typeKey === '법령') {
    const law = payload['법령'];
    const basic = law?.['기본정보'] ?? {};
    const name = String(basic['법령명_한글'] ?? typeKey);
    const enforced = formatDate(String(basic['시행일자'] ?? ''));

    if (!law?.조문) return toolError(`${typeKey} 본문을 찾지 못했습니다. (id: ${id})`);

    const rendered = renderArticles(law, articleFilter, name);
    if ('error' in rendered) return toolError(rendered.error!);

    return {
      content: `${name}${enforced ? ` (시행 ${enforced})` : ''}\n\n${rendered.body}`,
      sources: [{ ...source, title: name }],
    };
  }

  // ── 자치법규: 구조가 법령과 다르다 ──
  // 조문은 `조문.조` 배열이고 항목은 { 조문번호, 조제목, 조내용 }이다.
  // 법령처럼 항/호로 나뉘지 않고 조내용에 전체 문장이 들어 있다.
  // 조문번호는 "000100"(제1조), "000300"(제3조)처럼 조4자리+항2자리 형식이다.
  if (typeKey === '자치법규') {
    const law = payload['LawService'];
    const basic = law?.['자치법규기본정보'] ?? {};
    const name = String(basic['자치법규명'] ?? typeKey);
    const enforced = formatDate(String(basic['시행일자'] ?? ''));

    let articles = toArray<any>(law?.['조문']?.['조']).filter((a) => a?.조내용);
    if (articles.length === 0) {
      return toolError(`${name}의 조문을 찾지 못했습니다.`);
    }

    if (articleFilter) {
      const wanted = Number(articleFilter);
      articles = articles.filter((a) => {
        const raw = toArray(a.조문번호)[0];
        return raw ? Number(String(raw).slice(0, 4)) === wanted : false;
      });
      if (articles.length === 0) {
        return toolError(`${name}에서 제${articleFilter}조를 찾지 못했습니다.`);
      }
    }

    const truncated = articles.length > MAX_ARTICLES;
    const shown = truncated ? articles.slice(0, MAX_ARTICLES) : articles;
    const body = shown
      .map((a) => toArray(a.조내용).join('\n').trim())
      .filter(Boolean)
      .join('\n\n');
    const note = truncated
      ? `\n\n[조문이 많아 앞 ${MAX_ARTICLES}개만 표시했습니다. 특정 조문은 article 인자로 지정하세요.]`
      : '';

    return {
      content: `${name}${enforced ? ` (시행 ${enforced})` : ''}\n\n${body}${note}`,
      sources: [{ ...source, title: name }],
    };
  }

  // ── 행정규칙 ──
  if (typeKey === '행정규칙') {
    const svc = payload['AdmRulService'] ?? {};
    const basic = svc['행정규칙기본정보'] ?? {};
    const name = String(basic['행정규칙명'] ?? typeKey);

    const sections = toArray<any>(svc['조문']?.['조문단위'] ?? svc['조문내용']);
    const body = sections
      .map((s) => (typeof s === 'string' ? s : toArray(s?.조문내용).join('\n')))
      .join('\n')
      .trim();

    const attachments = toArray<any>(svc['별표']?.['별표단위'])
      .map((b) => `[별표] ${b?.별표제목 ?? ''}\n${toArray(b?.별표내용).flat().join('\n')}`)
      .join('\n\n');

    const content = [body, attachments].filter(Boolean).join('\n\n');
    if (!content) return toolError(`${name}의 본문을 추출하지 못했습니다.`);

    return { content: `${name}\n\n${content}`, sources: [{ ...source, title: name }] };
  }

  // ── 법령해석례 ──
  const expc = payload['ExpcService'] ?? {};
  const title = String(expc['안건명'] ?? typeKey);
  const content = [
    `안건번호: ${expc['안건번호'] ?? '-'} / 회신일자: ${formatDate(String(expc['해석일자'] ?? ''))}`,
    `회신기관: ${expc['해석기관명'] ?? '-'} / 질의기관: ${expc['질의기관명'] ?? '-'}`,
    '',
    '[질의요지]',
    toArray(expc['질의요지']).flat().join('\n'),
    '',
    '[회답 이유]',
    toArray(expc['이유']).flat().join('\n'),
  ]
    .join('\n')
    .trim();

  return { content: `${title}\n\n${content}`, sources: [{ ...source, title }] };
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
      case 'law_get_content':
        return getContent(input);
      default:
        return Promise.resolve(toolError(`알 수 없는 도구입니다: ${toolName}`));
    }
  },
};
