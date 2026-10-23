import { NODA_API_KEY, NODA_API_URL } from '@/lib/config';

/**
 * NODA(문서 읽기 서비스, https://api.readlayer.kr) 클라이언트.
 *
 * 이 코드베이스의 관례대로 SDK 없이 `fetch`로 직접 부른다(embeddings.ts·mailer.ts와 같다).
 * 응답 칸 이름은 https://api.readlayer.kr/openapi.json 을 따른다.
 *
 * 지키는 것:
 * - **키를 오류 글·로그에 싣지 않는다.** 요청 머리(Authorization)는 오류에 넣지 않고,
 *   서버 본문·네트워크 오류 글에 키가 섞여 오더라도 지운다.
 * - 보관함 이름은 **서버가 비서 id로만** 만든다(`nodaTenant`). 요청값으로 받지 않는다.
 * - 파일 이름은 `{문서 id}__{원래 이름}` — 원래 확장자를 그대로 둔다. NODA가 `.txt`·`.csv`·`.tsv`를
 *   확장자로 가려 직접 읽기 때문에, 이름을 바꾸거나 확장자를 붙이면 읽는 방식이 달라진다.
 */

/**
 * 근거 조각을 거르는 뜻 유사도 하한(`/context`의 `min_similarity`).
 *
 * 뜻 검색은 엉뚱한 질문에도 가장 가까운 조각을 돌려주므로, 하한이 없으면 요리 질문에도
 * 문서 조각이 근거로 붙는다. 이 하한이 '관련 문서 없음' 판단의 첫 겹이고, 둘째 겹은
 * 인용 규칙의 "근거에 답이 없으면 찾지 못했다고 답하라"(모델 판단)다.
 *
 * NODA 운영자 실측(정답 있는 질문 391개 · 엉뚱한 질문 480개, 2026-10):
 *
 * | 하한 | 정답 있는 질문의 근거가 남음 | (사람이 쓴 질문만) | 엉뚱한 질문이 걸러짐 |
 * |------|------|------|------|
 * | 0.80 | 99%  | 91%  | 53%  |
 * | 0.81 | 97%  | 89%  | 78%  |
 * | 0.82 | 94%  | 83%  | 94%  |
 *
 * 0.80을 고른 이유: 진짜 근거를 잃는 쪽이 더 비싸다(근거가 있는데 "없다"고 답하면 직원이 문서를
 * 다시 찾아야 한다). 엉뚱한 질문의 남은 47%는 모델 판단이 맡는다.
 * 감으로 바꾸지 말고 관련/무관 질문을 다시 재서 정할 것 — `tests/noda-client.test.ts`가 0.80~0.82 구간을 고정한다.
 */
export const NODA_MIN_SIMILARITY = 0.8;

/** `/context`가 돌려주는 근거 묶음의 글자 예산(NODA 기본값과 같다) */
export const NODA_CONTEXT_BUDGET = 4000;

/** NODA 업로드 한 번의 시간 제한 — 큰 문서는 읽는 데 오래 걸린다 */
const UPLOAD_TIMEOUT_MS = 300_000;
/** 그 밖 호출 한 번의 시간 제한 */
const DEFAULT_TIMEOUT_MS = 30_000;
/** `/context` 한 번의 시간 제한 — 대화가 이만큼 넘게 멈추면 안 된다(설계 "10초쯤") */
const CONTEXT_TIMEOUT_MS = 8_000;
/** 재시도 사이 최소 대기 — `Retry-After: 0`이 와도 서버를 몰아치지 않는다 */
const MIN_RETRY_WAIT_MS = 1_000;
/** 업로드 재시도 창 */
const UPLOAD_RETRY_WINDOW_MS = 60_000;
/** 그 밖 호출 재시도 창(`/context` 포함 — 대화가 오래 멈추면 안 된다) */
const DEFAULT_RETRY_WINDOW_MS = 10_000;
const DEFAULT_RETRY_INTERVAL_MS = 3_000;
const CONTEXT_RETRY_INTERVAL_MS = 2_500;

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID_SOURCE}$`, 'i');
const FILENAME_PREFIX_RE = new RegExp(`^(${UUID_SOURCE})__`, 'i');
const STRIP_PREFIX_RE = new RegExp(`${UUID_SOURCE}__`, 'gi');

/**
 * 비서 id → NODA 보관함 이름(`workon-a` + 하이픈 뺀 32자).
 * uuid 꼴이 아니면 던진다 — 보관함 이름이 경로나 요청값에서 흘러들면 다른 비서의 문서를 건드릴 수 있다.
 */
export function nodaTenant(agentId: string): string {
  if (typeof agentId !== 'string' || !UUID_RE.test(agentId)) {
    throw new Error('보관함 이름은 비서 id(uuid)로만 만들 수 있습니다.');
  }
  return `workon-a${agentId.replace(/-/g, '').toLowerCase()}`;
}

/**
 * NODA에 올릴 파일 이름 = `{문서 id}__{원래 이름}`.
 * 경로 구분자와 제어 문자만 `_`로 바꾸고 확장자(대소문자 포함)는 그대로 둔다.
 */
export function nodaFilename(documentId: string, fileName: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = fileName.replace(/[\/\\\u0000-\u001f\u007f]/g, '_');
  return `${documentId}__${safe}`;
}

/** NODA 파일 이름에서 문서 id를 읽는다. 앞부분이 없으면 null */
export function documentIdFromNodaFilename(name: string): string | null {
  const m = FILENAME_PREFIX_RE.exec(name);
  return m ? m[1].toLowerCase() : null;
}

/** 모델·화면에 보이는 글에서 `{문서 id}__` 앞부분을 모두 뗀다 */
export function stripNodaPrefixes(text: string): string {
  return text.replace(STRIP_PREFIX_RE, '');
}

export class NodaError extends Error {
  status: number | null;
  code: 'missing_key' | 'http' | 'network' | 'timeout';
  /** 서버가 `Retry-After`로 알려 준 대기(밀리초). 재시도 판단에만 쓴다 */
  retryAfterMs: number | null;

  constructor(
    message: string,
    code: NodaError['code'],
    status: number | null = null,
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'NodaError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface NodaUploadResult {
  tenant: string;
  filename: string;
  bytes: number;
  stored: boolean;
  doc_id: string | null;
  readable: boolean;
  reason: string | null;
  chunks: number;
  cache_purged?: number;
}

export interface NodaListing {
  documents: { filename: string; doc_id?: string }[];
  receiving: { filename: string; seconds: number }[];
}

export interface NodaAnchor {
  page?: number;
  bbox?: unknown;
  cell_range?: string | null;
}

export interface NodaSource {
  n: number;
  chunk_id: string;
  doc_id: string;
  filename: string;
  kind?: string;
  path?: string;
  outline?: string | string[] | null;
  anchors?: NodaAnchor[];
  extractors?: string[];
  score?: number;
  similarity?: number;
  found_by?: string;
  chars?: number;
  cut?: boolean;
}

export interface NodaContextResult {
  context: string;
  sources: NodaSource[];
  dropped: number;
}

export interface NodaClient {
  uploadDocument(input: { tenant: string; filename: string; bytes: Uint8Array }): Promise<NodaUploadResult>;
  /**
   * `retry: false`면 한 번만 부른다(문서 목록 맞추기 — 화면이 NODA 장애에 오래 묶이지 않게).
   * `timeoutMs`는 그 한 번의 시간 제한(기본 30초)
   */
  listDocuments(tenant: string, opts?: { retry?: boolean; timeoutMs?: number }): Promise<NodaListing>;
  /** 404(이미 없음)는 `{ deleted: false }`로 끝난다 — 던지지 않는다 */
  deleteDocument(tenant: string, filename: string): Promise<{ deleted: boolean }>;
  getContext(input: { tenant: string; query: string }): Promise<NodaContextResult>;
  getHealth(): Promise<Record<string, unknown>>;
}

interface RetryOptions {
  windowMs: number;
  intervalMs: number;
}

function isRetryable(err: unknown): err is NodaError {
  if (!(err instanceof NodaError)) return false;
  if (err.code === 'network') return true;
  return err.code === 'http' && (err.status === 429 || err.status === 502 || err.status === 503);
}

/** `Retry-After`(초 숫자)를 밀리초로. 날짜 꼴이거나 읽지 못하면 null */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const s = Number(value.trim());
  if (!Number.isFinite(s) || s < 0) return null;
  return Math.round(s * 1000);
}

export function createNodaClient(deps: {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): NodaClient {
  const baseUrl = deps.baseUrl.replace(/\/+$/, '');
  const apiKey = deps.apiKey;
  const doFetch: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());

  /** 서버 본문·시스템 오류 글에 키가 섞여 와도 오류 글에 남기지 않는다 */
  function redact(text: string): string {
    return apiKey ? text.split(apiKey).join('***') : text;
  }

  /**
   * 429·502·503·네트워크 오류면 `Retry-After`(없으면 간격) 뒤 다시 시도한다.
   * 다음 시도가 창을 넘기면 기다리지 않고 마지막 오류를 던진다. 시간 제한(timeout)은 다시 시도하지 않는다.
   */
  async function withRetry<T>(attempt: () => Promise<T>, { windowMs, intervalMs }: RetryOptions): Promise<T> {
    const start = now();
    for (;;) {
      try {
        return await attempt();
      } catch (err) {
        if (!isRetryable(err)) throw err;
        const wait = Math.max(MIN_RETRY_WAIT_MS, err.retryAfterMs ?? intervalMs);
        if (now() - start + wait > windowMs) throw err;
        await sleep(wait);
      }
    }
  }

  /** 한 번의 요청. 2xx면 응답을 돌려주고, 아니면 NodaError를 던진다(404 처리는 부르는 쪽) */
  async function request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: {
      query?: Record<string, string>;
      headers?: Record<string, string>;
      body?: BodyInit;
      timeoutMs: number;
      allow404?: boolean;
    },
  ): Promise<Response> {
    if (!apiKey) {
      throw new NodaError('NODA 키가 설정되지 않았습니다.', 'missing_key');
    }
    const url = new URL(`${baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    let res: Response;
    try {
      res = await doFetch(url.toString(), {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, ...opts.headers },
        body: opts.body,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      const detail = redact(err instanceof Error ? err.message : String(err)).slice(0, 200);
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new NodaError(`NODA 응답 시간 초과 (${Math.round(opts.timeoutMs / 1000)}초)`, 'timeout');
      }
      throw new NodaError(`NODA 연결 실패: ${detail}`, 'network');
    }

    if (res.ok || (opts.allow404 && res.status === 404)) return res;

    let text = '';
    try {
      text = await res.text();
    } catch {
      // 본문을 못 읽어도 상태만으로 오류를 낸다
    }
    throw new NodaError(
      `NODA ${res.status}: ${redact(text).slice(0, 200)}`,
      'http',
      res.status,
      parseRetryAfter(res.headers.get('retry-after')),
    );
  }

  async function readJson(res: Response): Promise<Record<string, unknown>> {
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new NodaError(`NODA ${res.status}: 응답을 읽지 못했습니다.`, 'http', res.status);
    }
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  }

  return {
    async uploadDocument({ tenant, filename, bytes }) {
      return withRetry(
        async () => {
          const res = await request('POST', '/documents/upload', {
            // 항상 replace=1 — 같은 이름을 다시 올려도 안전하게 바꿔 넣는다(읽기 다시 걸기가 이에 기댄다)
            query: { tenant, replace: '1' },
            headers: {
              'X-Filename': encodeURIComponent(filename),
              'Content-Type': 'application/octet-stream',
            },
            body: bytes as unknown as BodyInit,
            timeoutMs: UPLOAD_TIMEOUT_MS,
          });
          const b = await readJson(res);
          return {
            tenant: String(b.tenant ?? tenant),
            filename: String(b.filename ?? filename),
            bytes: Number(b.bytes ?? bytes.byteLength),
            stored: b.stored === true,
            doc_id: typeof b.doc_id === 'string' ? b.doc_id : null,
            readable: b.readable === true,
            reason: typeof b.reason === 'string' ? b.reason : null,
            chunks: Number(b.chunks ?? 0) || 0,
            ...(typeof b.cache_purged === 'number' ? { cache_purged: b.cache_purged } : {}),
          } satisfies NodaUploadResult;
        },
        { windowMs: UPLOAD_RETRY_WINDOW_MS, intervalMs: DEFAULT_RETRY_INTERVAL_MS },
      );
    },

    async listDocuments(tenant, opts = {}) {
      const once = async (): Promise<NodaListing> => {
        const res = await request('GET', '/documents', { query: { tenant }, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
        const b = await readJson(res);
        const documents = (Array.isArray(b.documents) ? b.documents : [])
          .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
          .map((d) => ({
            filename: String(d.filename ?? ''),
            ...(typeof d.doc_id === 'string' ? { doc_id: d.doc_id } : {}),
          }));
        const receiving = (Array.isArray(b.receiving) ? b.receiving : [])
          .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
          .map((d) => ({ filename: String(d.filename ?? ''), seconds: Number(d.seconds ?? 0) || 0 }));
        return { documents, receiving };
      };
      if (opts.retry === false) return once();
      return withRetry(once, { windowMs: DEFAULT_RETRY_WINDOW_MS, intervalMs: DEFAULT_RETRY_INTERVAL_MS });
    },

    async deleteDocument(tenant, filename) {
      return withRetry(
        async () => {
          const res = await request('DELETE', '/documents', {
            query: { tenant, filename },
            timeoutMs: DEFAULT_TIMEOUT_MS,
            allow404: true,
          });
          if (res.status === 404) return { deleted: false };
          const b = await readJson(res).catch(() => ({}) as Record<string, unknown>);
          return { deleted: b.deleted !== false };
        },
        { windowMs: DEFAULT_RETRY_WINDOW_MS, intervalMs: DEFAULT_RETRY_INTERVAL_MS },
      );
    },

    async getContext({ tenant, query }) {
      return withRetry(
        async () => {
          const res = await request('POST', '/context', {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tenant,
              query,
              budget: NODA_CONTEXT_BUDGET,
              min_similarity: NODA_MIN_SIMILARITY,
            }),
            timeoutMs: CONTEXT_TIMEOUT_MS,
          });
          const b = await readJson(res);
          return {
            context: typeof b.context === 'string' ? b.context : '',
            sources: Array.isArray(b.sources) ? (b.sources as NodaSource[]) : [],
            dropped: Number(b.dropped ?? 0) || 0,
          };
        },
        { windowMs: DEFAULT_RETRY_WINDOW_MS, intervalMs: CONTEXT_RETRY_INTERVAL_MS },
      );
    },

    async getHealth() {
      return withRetry(
        async () => readJson(await request('GET', '/health', { timeoutMs: DEFAULT_TIMEOUT_MS })),
        { windowMs: DEFAULT_RETRY_WINDOW_MS, intervalMs: DEFAULT_RETRY_INTERVAL_MS },
      );
    },
  };
}

/** config 값으로 만든 기본 인스턴스 — 키가 비면 호출마다 NodaError('missing_key') */
export const noda: NodaClient = createNodaClient({ baseUrl: NODA_API_URL, apiKey: NODA_API_KEY });
