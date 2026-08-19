/**
 * KOSIS 국가통계포털 커넥터 (통계청).
 *
 * API 계약 (kosis.kr OpenAPI + 실제 호출로 확인):
 *   통계표 검색  GET https://kosis.kr/openapi/statisticsSearch.do
 *                ?method=getList&apiKey=&format=json&jsonVD=Y&searchNm={키워드}
 *   통계 데이터  GET https://kosis.kr/openapi/Param/statisticsParameterData.do
 *                ?method=getList&apiKey=&format=json&jsonVD=Y
 *                &orgId=&tblId=&itmId=&objL1=&prdSe=&newEstPrdCnt=
 *
 * 오류는 HTTP 200에 { err, errMsg }로 온다 (예: err='11' 유효하지 않은 인증키).
 *
 * 데이터 조회는 orgId/tblId/itmId를 알아야 하므로 반드시 검색을 먼저 거쳐야 한다.
 * 이 흐름을 툴 description에 명시해 모델이 순서를 지키게 한다.
 */

import { CONNECTOR_LABELS } from '@/lib/connector-labels';
import { KOSIS_API_KEY } from '@/lib/config';
import {
  fetchJson,
  toArray,
  toolError,
  type Connector,
  type ToolDefinition,
  type ToolResult,
} from './types';

const SEARCH_URL = 'https://kosis.kr/openapi/statisticsSearch.do';
const DATA_URL = 'https://kosis.kr/openapi/Param/statisticsParameterData.do';
const PORTAL_URL = 'https://kosis.kr/statHtml/statHtml.do';

const MAX_SEARCH_RESULTS = 20;
const MAX_DATA_ROWS = 100;

interface KosisError {
  err?: string;
  errMsg?: string;
}

interface SearchRow {
  ORG_ID?: string;
  TBL_ID?: string;
  TBL_NM?: string;
  ORG_NM?: string;
  STAT_NM?: string;
  FULL_PATH_ID?: string;
}

interface DataRow {
  PRD_DE?: string;
  C1_NM?: string;
  ITM_NM?: string;
  DT?: string;
  UNIT_NM?: string;
  TBL_NM?: string;
}

function portalUrl(orgId: string, tblId: string) {
  return `${PORTAL_URL}?orgId=${encodeURIComponent(orgId)}&tblId=${encodeURIComponent(tblId)}`;
}

/** KOSIS는 HTTP 200에 { err, errMsg }로 오류를 싣는다 */
function kosisError(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const { err, errMsg } = payload as KosisError;
    if (err) return `KOSIS 오류(${err}): ${errMsg ?? '알 수 없는 오류'}`;
  }
  return null;
}

const tools: ToolDefinition[] = [
  {
    name: 'kosis_search_tables',
    description:
      'KOSIS 국가통계포털에서 통계표를 키워드로 검색한다. 인구, 물가, 고용, 주택 등 국가 공식 통계가 대상이다. ' +
      '실제 수치를 얻으려면 이 도구로 먼저 기관코드(orgId)와 통계표코드(tblId)를 찾은 뒤 kosis_get_data를 호출해야 한다.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색어 (예: 시도별 인구, 소비자물가지수)' },
        limit: {
          type: 'number',
          description: `가져올 건수 (기본 5, 최대 ${MAX_SEARCH_RESULTS})`,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'kosis_get_data',
    description:
      'KOSIS 통계표의 실제 수치를 가져온다. kosis_search_tables로 얻은 orgId와 tblId가 필요하다. ' +
      '기본으로 가장 최근 시점 자료를 가져오며, periods로 최근 N개 시점을 요청할 수 있다.',
    inputSchema: {
      type: 'object',
      properties: {
        orgId: { type: 'string', description: '기관 코드 (검색 결과의 ORG_ID)' },
        tblId: { type: 'string', description: '통계표 코드 (검색 결과의 TBL_ID)' },
        periods: {
          type: 'number',
          description: '가져올 최근 시점 수 (기본 1). 추이를 보려면 5~10을 쓴다.',
        },
        prdSe: {
          type: 'string',
          description: "수록주기: 'Y'(년), 'H'(반년), 'Q'(분기), 'M'(월). 기본 'Y'.",
        },
      },
      required: ['orgId', 'tblId'],
    },
  },
];

async function searchTables(input: Record<string, unknown>): Promise<ToolResult> {
  const query = String(input.query ?? '').trim();
  if (!query) return toolError('검색어가 필요합니다.');

  const limit = Math.min(Math.max(Number(input.limit) || 5, 1), MAX_SEARCH_RESULTS);

  const params = new URLSearchParams({
    method: 'getList',
    apiKey: KOSIS_API_KEY,
    format: 'json',
    jsonVD: 'Y',
    searchNm: query,
  });

  let payload: SearchRow[] | KosisError;
  try {
    payload = await fetchJson(`${SEARCH_URL}?${params}`);
  } catch (err: any) {
    return toolError(`KOSIS 통계표 검색에 실패했습니다: ${err?.message ?? '알 수 없는 오류'}`);
  }

  const error = kosisError(payload);
  if (error) return toolError(error);

  const rows = toArray(payload as SearchRow[]).slice(0, limit);
  if (rows.length === 0) {
    return { content: `"${query}"에 해당하는 통계표를 찾지 못했습니다.`, sources: [] };
  }

  const lines = rows.map((row, index) =>
    [
      `${index + 1}. ${row.TBL_NM ?? '(이름 없음)'}`,
      `   통계명: ${row.STAT_NM ?? '-'} / 기관: ${row.ORG_NM ?? '-'}`,
      `   orgId: ${row.ORG_ID ?? '-'} / tblId: ${row.TBL_ID ?? '-'}`,
    ].join('\n')
  );

  return {
    content: `"${query}" 통계표 검색 결과 ${rows.length}건\n\n${lines.join('\n\n')}`,
    sources: rows
      .filter((row) => row.ORG_ID && row.TBL_ID)
      .map((row) => ({
        title: row.TBL_NM ?? 'KOSIS 통계표',
        url: portalUrl(row.ORG_ID!, row.TBL_ID!),
      })),
  };
}

async function getData(input: Record<string, unknown>): Promise<ToolResult> {
  const orgId = String(input.orgId ?? '').trim();
  const tblId = String(input.tblId ?? '').trim();
  if (!orgId || !tblId) {
    return toolError('orgId와 tblId가 필요합니다. kosis_search_tables로 먼저 조회하세요.');
  }

  const periods = Math.min(Math.max(Number(input.periods) || 1, 1), 30);
  const prdSe = String(input.prdSe ?? 'Y').trim().toUpperCase();

  const params = new URLSearchParams({
    method: 'getList',
    apiKey: KOSIS_API_KEY,
    format: 'json',
    jsonVD: 'Y',
    orgId,
    tblId,
    // ALL을 쓰면 항목·분류를 미리 몰라도 조회할 수 있다
    itmId: 'ALL',
    objL1: 'ALL',
    prdSe,
    newEstPrdCnt: String(periods),
  });

  let payload: DataRow[] | KosisError;
  try {
    payload = await fetchJson(`${DATA_URL}?${params}`);
  } catch (err: any) {
    return toolError(`KOSIS 통계 데이터 조회에 실패했습니다: ${err?.message ?? '알 수 없는 오류'}`);
  }

  const error = kosisError(payload);
  if (error) return toolError(error);

  const rows = toArray(payload as DataRow[]);
  if (rows.length === 0) {
    return toolError(`orgId=${orgId}, tblId=${tblId}에서 데이터를 찾지 못했습니다.`);
  }

  const truncated = rows.length > MAX_DATA_ROWS;
  const shown = truncated ? rows.slice(0, MAX_DATA_ROWS) : rows;
  const tableName = shown[0]?.TBL_NM ?? '통계표';

  const lines = shown.map((row) => {
    const parts = [row.PRD_DE, row.C1_NM, row.ITM_NM].filter(Boolean).join(' / ');
    const unit = row.UNIT_NM ? ` ${row.UNIT_NM}` : '';
    return `${parts}: ${row.DT ?? '-'}${unit}`;
  });

  const note = truncated
    ? `\n\n[행이 많아 앞 ${MAX_DATA_ROWS}개만 표시했습니다.]`
    : '';

  return {
    content: `${tableName}\n\n${lines.join('\n')}${note}`,
    sources: [{ title: tableName, url: portalUrl(orgId, tblId) }],
  };
}

export const kosisConnector: Connector = {
  id: 'kosis',
  label: CONNECTOR_LABELS.kosis,
  tools,
  isConfigured: () => Boolean(KOSIS_API_KEY),
  execute(toolName, input) {
    switch (toolName) {
      case 'kosis_search_tables':
        return searchTables(input);
      case 'kosis_get_data':
        return getData(input);
      default:
        return Promise.resolve(toolError(`알 수 없는 도구입니다: ${toolName}`));
    }
  },
};
