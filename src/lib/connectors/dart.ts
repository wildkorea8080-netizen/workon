/**
 * 금융감독원 DART(전자공시) 커넥터.
 *
 * API 계약 (opendart.fss.or.kr 개발가이드 + 실제 호출로 확인):
 *   공시검색  GET https://opendart.fss.or.kr/api/list.json
 *             ?crtfc_key=&corp_code=&bgn_de=&end_de=&page_no=&page_count=
 *             → { status, message, list: [{ corp_name, corp_code, stock_code,
 *                  report_nm, rcept_no, flr_nm, rcept_dt, corp_cls }] }
 *   기업개황  GET https://opendart.fss.or.kr/api/company.json?crtfc_key=&corp_code=
 *
 * status='000'이 정상, 그 외는 오류 코드다 (예: '010' 등록되지 않은 인증키).
 *
 * 인용 링크는 https://dart.fss.or.kr/dsaf001/main.do?rcpNo={접수번호} 를 씁니다.
 */

import { DART_API_KEY } from '@/lib/config';
import {
  fetchJson,
  toArray,
  toolError,
  type Connector,
  type ToolDefinition,
  type ToolResult,
} from './types';

const LIST_URL = 'https://opendart.fss.or.kr/api/list.json';
const COMPANY_URL = 'https://opendart.fss.or.kr/api/company.json';
const VIEWER_URL = 'https://dart.fss.or.kr/dsaf001/main.do';

const MAX_RESULTS = 30;

const CORP_CLASS: Record<string, string> = {
  Y: '유가증권',
  K: '코스닥',
  N: '코넥스',
  E: '기타',
};

interface DartResponse<T> {
  status?: string;
  message?: string;
  total_count?: number;
  list?: T | T[];
}

interface DisclosureRow {
  corp_name?: string;
  corp_code?: string;
  stock_code?: string;
  corp_cls?: string;
  report_nm?: string;
  rcept_no?: string;
  flr_nm?: string;
  rcept_dt?: string;
}

function formatDate(value?: string) {
  if (!value || value.length !== 8) return value ?? '';
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function toYmd(date: Date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function viewerUrl(receiptNo: string) {
  return `${VIEWER_URL}?rcpNo=${encodeURIComponent(receiptNo)}`;
}

/** DART는 HTTP 200에 status 코드로 오류를 싣는다 */
function statusError(payload: { status?: string; message?: string }): string | null {
  if (!payload.status || payload.status === '000') return null;
  if (payload.status === '013') return null; // 조회 결과 없음 — 오류가 아니다
  return `DART 오류(${payload.status}): ${payload.message ?? '알 수 없는 오류'}`;
}

const tools: ToolDefinition[] = [
  {
    name: 'dart_search_disclosures',
    description:
      '금융감독원 DART에서 상장사·비상장사의 공시 목록을 검색한다. ' +
      '사업보고서·감사보고서·주요사항보고서 등 제출된 공시를 접수일자 기준으로 조회한다. ' +
      '특정 회사의 공시를 보려면 dart_get_company로 고유번호(corp_code)를 먼저 확인한다.',
    inputSchema: {
      type: 'object',
      properties: {
        corp_code: {
          type: 'string',
          description: '회사 고유번호 8자리. 생략하면 전체 회사를 대상으로 한다.',
        },
        bgn_de: { type: 'string', description: '검색 시작일 YYYYMMDD. 생략 시 최근 30일.' },
        end_de: { type: 'string', description: '검색 종료일 YYYYMMDD. 생략 시 오늘.' },
        limit: { type: 'number', description: `가져올 건수 (기본 10, 최대 ${MAX_RESULTS})` },
      },
      required: [],
    },
  },
  {
    name: 'dart_get_company',
    description:
      'DART 고유번호(corp_code)로 기업 개황을 조회한다. 회사명, 종목코드, 대표자, 업종, 주소, 결산월 등을 돌려준다.',
    inputSchema: {
      type: 'object',
      properties: {
        corp_code: { type: 'string', description: '회사 고유번호 8자리' },
      },
      required: ['corp_code'],
    },
  },
];

async function searchDisclosures(input: Record<string, unknown>): Promise<ToolResult> {
  const limit = Math.min(Math.max(Number(input.limit) || 10, 1), MAX_RESULTS);

  const today = new Date();
  const monthAgo = new Date(today.getTime() - 30 * 86400000);
  const bgn = String(input.bgn_de ?? toYmd(monthAgo)).trim();
  const end = String(input.end_de ?? toYmd(today)).trim();

  const params = new URLSearchParams({
    crtfc_key: DART_API_KEY,
    bgn_de: bgn,
    end_de: end,
    page_no: '1',
    page_count: String(limit),
  });
  if (input.corp_code) params.set('corp_code', String(input.corp_code).trim());

  let payload: DartResponse<DisclosureRow>;
  try {
    payload = await fetchJson(`${LIST_URL}?${params}`);
  } catch (err: any) {
    return toolError(`DART 공시검색에 실패했습니다: ${err?.message ?? '알 수 없는 오류'}`);
  }

  const error = statusError(payload);
  if (error) return toolError(error);

  const rows = toArray(payload.list);
  if (rows.length === 0) {
    return { content: `${formatDate(bgn)} ~ ${formatDate(end)} 기간에 해당하는 공시가 없습니다.`, sources: [] };
  }

  const lines = rows.map((row, index) =>
    [
      `${index + 1}. ${row.report_nm ?? '(보고서명 없음)'}`,
      `   회사: ${row.corp_name ?? '-'} (${CORP_CLASS[row.corp_cls ?? ''] ?? '구분없음'}${row.stock_code ? `, ${row.stock_code}` : ''})`,
      `   접수일: ${formatDate(row.rcept_dt)} / 제출인: ${row.flr_nm ?? '-'}`,
      `   고유번호(corp_code): ${row.corp_code ?? '-'} / 접수번호: ${row.rcept_no ?? '-'}`,
    ].join('\n')
  );

  return {
    content: `공시 검색 결과 ${rows.length}건 (전체 ${payload.total_count ?? rows.length}건, ${formatDate(bgn)} ~ ${formatDate(end)})\n\n${lines.join('\n\n')}`,
    sources: rows
      .filter((row) => row.rcept_no)
      .map((row) => ({
        title: `${row.corp_name ?? ''} ${row.report_nm ?? ''}`.trim(),
        url: viewerUrl(row.rcept_no!),
      })),
  };
}

async function getCompany(input: Record<string, unknown>): Promise<ToolResult> {
  const corpCode = String(input.corp_code ?? '').trim();
  if (!corpCode) return toolError('회사 고유번호(corp_code)가 필요합니다.');

  const params = new URLSearchParams({ crtfc_key: DART_API_KEY, corp_code: corpCode });

  let payload: DartResponse<never> & Record<string, any>;
  try {
    payload = await fetchJson(`${COMPANY_URL}?${params}`);
  } catch (err: any) {
    return toolError(`DART 기업개황 조회에 실패했습니다: ${err?.message ?? '알 수 없는 오류'}`);
  }

  const error = statusError(payload);
  if (error) return toolError(error);

  const name = payload.corp_name ?? '(회사명 없음)';
  const fields: [string, unknown][] = [
    ['영문명', payload.corp_name_eng],
    ['종목코드', payload.stock_code],
    ['대표자', payload.ceo_nm],
    ['법인구분', CORP_CLASS[payload.corp_cls ?? ''] ?? payload.corp_cls],
    ['업종', payload.induty_code],
    ['설립일', formatDate(payload.est_dt)],
    ['결산월', payload.acc_mt ? `${payload.acc_mt}월` : undefined],
    ['주소', payload.adres],
    ['홈페이지', payload.hm_url],
  ];

  const body = fields
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');

  return {
    content: `${name}\n\n${body}`,
    sources: [
      {
        title: `${name} 전자공시`,
        url: `https://dart.fss.or.kr/dsab007/main.do?textCrpNm=${encodeURIComponent(name)}`,
      },
    ],
  };
}

export const dartConnector: Connector = {
  id: 'dart',
  label: '전자공시 DART (금융감독원)',
  tools,
  isConfigured: () => Boolean(DART_API_KEY),
  execute(toolName, input) {
    switch (toolName) {
      case 'dart_search_disclosures':
        return searchDisclosures(input);
      case 'dart_get_company':
        return getCompany(input);
      default:
        return Promise.resolve(toolError(`알 수 없는 도구입니다: ${toolName}`));
    }
  },
};
