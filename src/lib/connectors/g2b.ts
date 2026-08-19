/**
 * 조달청 나라장터 입찰공고 커넥터.
 *
 * API 계약 (공공데이터포털 + 실제 호출로 확인):
 *   GET https://apis.data.go.kr/1230000/ad/BidPublicInfoService/{오퍼레이션}
 *       ?serviceKey=&pageNo=&numOfRows=&type=json
 *       &inqryDiv=1&inqryBgnDt=YYYYMMDDHHmm&inqryEndDt=YYYYMMDDHHmm&bidNtceNm=
 *   → { response: { header: { resultCode, resultMsg },
 *                   body: { totalCount, items: [...] } } }
 *
 * 경로의 `ad/` 접두사 주의: 이게 없으면 NO_OPENAPI_SERVICE_ERROR가 난다.
 * (공공데이터포털 문서에는 End Point가 접두사 없이 적혀 있어 실제 호출로 확인했다.)
 *
 * 오퍼레이션이 업무구분(물품/용역/공사/외자)별로 나뉘어 있어 구분을 지정해야
 * 정상 응답을 받는다.
 */

import { CONNECTOR_LABELS } from '@/lib/connector-labels';
import { G2B_API_KEY } from '@/lib/config';
import {
  fetchJson,
  toArray,
  toolError,
  type Connector,
  type ToolDefinition,
  type ToolResult,
} from './types';

const BASE_URL = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService';

/** 업무구분별 오퍼레이션 — 전부 실제 호출로 존재를 확인했다 */
const OPERATIONS: Record<string, { op: string; label: string }> = {
  물품: { op: 'getBidPblancListInfoThngPPSSrch', label: '물품' },
  용역: { op: 'getBidPblancListInfoServcPPSSrch', label: '용역' },
  공사: { op: 'getBidPblancListInfoCnstwkPPSSrch', label: '공사' },
  외자: { op: 'getBidPblancListInfoFrgcptPPSSrch', label: '외자' },
};

const MAX_RESULTS = 30;
const DEFAULT_DAYS = 7;

interface BidRow {
  bidNtceNo?: string;
  bidNtceOrd?: string;
  bidNtceNm?: string;
  ntceInsttNm?: string;
  dminsttNm?: string;
  bidNtceDt?: string;
  bidClseDt?: string;
  presmptPrce?: string;
  bidNtceDtlUrl?: string;
  bidMethdNm?: string;
  cntrctCnclsMthdNm?: string;
}

interface G2BResponse {
  response?: {
    header?: { resultCode?: string; resultMsg?: string };
    body?: { totalCount?: number; items?: BidRow | BidRow[] };
  };
  /**
   * 게이트웨이 단계 오류는 전혀 다른 봉투로 온다 (HTTP 403 + 이 구조).
   * 이걸 인식하지 못하면 items가 없어 "결과 없음"으로 잘못 보고하게 된다.
   */
  OpenAPI_ServiceResponse?: {
    cmmMsgHeader?: { errMsg?: string; returnAuthMsg?: string; returnReasonCode?: string };
  };
}

/** 나라장터는 YYYYMMDDHHmm 형식을 쓴다 */
function toDateTime(date: Date, endOfDay = false) {
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `${ymd}${endOfDay ? '2359' : '0000'}`;
}

function formatMoney(value?: string) {
  const n = Number(value);
  if (!value || Number.isNaN(n) || n === 0) return null;
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}억원`;
  if (n >= 10_000) return `${Math.round(n / 10_000).toLocaleString()}만원`;
  return `${n.toLocaleString()}원`;
}

function formatDateTime(value?: string) {
  if (!value) return '-';
  // API는 'YYYY-MM-DD HH:mm:ss' 또는 'YYYYMMDDHHmm'을 섞어 준다
  if (value.includes('-')) return value.slice(0, 16);
  if (value.length >= 12) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)} ${value.slice(8, 10)}:${value.slice(10, 12)}`;
  }
  return value;
}

const tools: ToolDefinition[] = [
  {
    name: 'g2b_search_bids',
    description:
      '조달청 나라장터에서 공공기관 입찰공고를 검색한다. 물품·용역·공사·외자 구분별로 조회하며, ' +
      '공고명 키워드와 기간으로 좁힐 수 있다. 공고기관, 마감일시, 추정가격, 공고 원문 링크를 돌려준다.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: "업무구분: '물품' | '용역' | '공사' | '외자'. 기본값 '용역'.",
        },
        keyword: { type: 'string', description: '공고명에 포함된 키워드' },
        days: {
          type: 'number',
          description: `최근 며칠간의 공고를 볼지 (기본 ${DEFAULT_DAYS}일, 최대 30일)`,
        },
        limit: { type: 'number', description: `가져올 건수 (기본 10, 최대 ${MAX_RESULTS})` },
      },
      required: [],
    },
  },
];

async function searchBids(input: Record<string, unknown>): Promise<ToolResult> {
  const categoryKey = String(input.category ?? '용역').trim();
  const operation = OPERATIONS[categoryKey];
  if (!operation) {
    return toolError(
      `업무구분은 ${Object.keys(OPERATIONS).join(', ')} 중 하나여야 합니다. (받은 값: ${categoryKey})`
    );
  }

  const limit = Math.min(Math.max(Number(input.limit) || 10, 1), MAX_RESULTS);
  const days = Math.min(Math.max(Number(input.days) || DEFAULT_DAYS, 1), 30);

  const today = new Date();
  const from = new Date(today.getTime() - days * 86400000);

  const params = new URLSearchParams({
    serviceKey: G2B_API_KEY,
    pageNo: '1',
    numOfRows: String(limit),
    type: 'json',
    inqryDiv: '1', // 1 = 공고게시일시 기준
    inqryBgnDt: toDateTime(from),
    inqryEndDt: toDateTime(today, true),
  });
  if (input.keyword) params.set('bidNtceNm', String(input.keyword).trim());

  let payload: G2BResponse;
  try {
    payload = await fetchJson(`${BASE_URL}/${operation.op}?${params}`);
  } catch (err: any) {
    return toolError(`나라장터 조회에 실패했습니다: ${err?.message ?? '알 수 없는 오류'}`);
  }

  const gateway = payload.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (gateway?.errMsg) {
    const detail = gateway.returnAuthMsg ?? gateway.errMsg;
    return toolError(
      `나라장터 접근 오류: ${detail}` +
        (gateway.errMsg === 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR'
          ? ' (G2B_API_KEY를 확인하세요. 공공데이터포털에서 이 서비스 활용신청이 승인돼야 합니다.)'
          : '')
    );
  }

  const header = payload.response?.header;
  if (header?.resultCode && header.resultCode !== '00') {
    return toolError(`나라장터 오류(${header.resultCode}): ${header.resultMsg ?? '알 수 없는 오류'}`);
  }

  const rows = toArray(payload.response?.body?.items);
  if (rows.length === 0) {
    return {
      content: `최근 ${days}일간 ${operation.label} 입찰공고 중 조건에 맞는 건이 없습니다.`,
      sources: [],
    };
  }

  const lines = rows.map((row, index) => {
    const price = formatMoney(row.presmptPrce);
    return [
      `${index + 1}. ${row.bidNtceNm ?? '(공고명 없음)'}`,
      `   공고기관: ${row.ntceInsttNm ?? '-'}${row.dminsttNm && row.dminsttNm !== row.ntceInsttNm ? ` / 수요기관: ${row.dminsttNm}` : ''}`,
      `   게시: ${formatDateTime(row.bidNtceDt)} / 마감: ${formatDateTime(row.bidClseDt)}`,
      price ? `   추정가격: ${price}` : null,
      row.cntrctCnclsMthdNm ? `   계약방법: ${row.cntrctCnclsMthdNm}` : null,
      `   공고번호: ${row.bidNtceNo ?? '-'}`,
    ]
      .filter(Boolean)
      .join('\n');
  });

  return {
    content: `${operation.label} 입찰공고 ${rows.length}건 (최근 ${days}일, 전체 ${payload.response?.body?.totalCount ?? rows.length}건)\n\n${lines.join('\n\n')}`,
    sources: rows
      .filter((row) => row.bidNtceDtlUrl)
      .map((row) => ({
        title: row.bidNtceNm ?? '입찰공고',
        url: row.bidNtceDtlUrl!,
      })),
  };
}

export const g2bConnector: Connector = {
  id: 'g2b',
  label: CONNECTOR_LABELS.g2b,
  tools,
  isConfigured: () => Boolean(G2B_API_KEY),
  execute(toolName, input) {
    switch (toolName) {
      case 'g2b_search_bids':
        return searchBids(input);
      default:
        return Promise.resolve(toolError(`알 수 없는 도구입니다: ${toolName}`));
    }
  },
};
