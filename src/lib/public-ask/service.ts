// src/lib/public-ask/service.ts
// 시민용 민원 상담 창(2026-11-27, 0136) — 로그인 없는 질문 한 번을 처리한다.
// 직원 실행기(prepareTurn/streamTurn — 대화·메시지·사용자 행이 필요)를 쓰지 않고, 사용자 없이 쓰는 가벼운 길을 엮는다:
// 설정·비서 확인 → 기관 예산 → 하루 횟수(DB 함수가 세고 넣음) → 개인정보·금지어 → 찾기(prepareLikeChat) → 모델(시민 전용 비서의 모델·지시문) → 숫자 확인 → 기록·사용 기록.
// **확인 못 하면 닫힘** — 읽기 실패는 던지고(라우트가 503) 기관 한도·금지어도 못 읽으면 묻지 않는다(직원 길의 '못 읽으면 허용'과 반대).
import { createHash } from 'crypto';
import type { LlmRequest, LlmStreamEvent, LlmUsage } from '@/lib/llm/types';
import type { RetrievedChunk } from '@/lib/db';
import { buildSystemPrompt } from '@/lib/assistant/prompt';
import { checkNumbers, numbersIn } from '@/lib/assistant/number-check';
import { sourceLocationLabel, sourceTitleLabel } from '@/components/chat/source-label';
import { kstDay, kstDayStart } from '@/lib/kst-time';
import {
  PUBLIC_ASK_ANSWER_MAX_TOKENS, PUBLIC_ASK_MESSAGES, PUBLIC_ASK_QUESTION_MAX, PUBLIC_ASK_STORED_ANSWER_MAX, PUBLIC_ASK_STORED_QUESTION_MAX,
  publicAskGuide, readContacts, type PublicAskConfig, type PublicAskContact, type PublicAskResult,
} from './spec';

export type PublicAskOrg = { id: string; name: string; status: string | null; logo_url: string | null; theme_color: string | null };
export type PublicAskSettingsRow = {
  enabled: boolean; agent_id: string | null; notice: string; faq: string[]; contacts: unknown; allowed_origins: string[];
  ip_daily_cap: number; org_daily_cap: number;
};
export type PublicAskAgent = {
  id: string; organization_id: string; department_id: string; tier: string; deleted_at: string | null; is_active: boolean;
  model_id: string | null; system_prompt: string | null;
};
export type LogPatch = { result: PublicAskResult; question?: string | null; answer?: string | null; sources?: string[]; model?: string | null; input_tokens?: number; output_tokens?: number };

/** 바깥(DB·NODA·모델)과의 이음매 — 읽기 실패는 던진다 */
export interface PublicAskDeps {
  loadOrg(slug: string): Promise<PublicAskOrg | null>;
  loadSettings(orgId: string): Promise<PublicAskSettingsRow | null>;
  loadAgent(agentId: string): Promise<PublicAskAgent | null>;
  /** 기관 예산(연간 정액·월 토큰)을 다 썼는가 — 한도 없음이면 false */
  orgBudgetExhausted(orgId: string): Promise<boolean>;
  claim(orgId: string, ipHash: string, dayStart: string, ipCap: number, orgCap: number): Promise<{ status: 'ok' | 'capped_ip' | 'capped_org'; id?: string }>;
  /** 개인정보·금지어 — 걸리면 false */
  passesFilter(departmentId: string, text: string): Promise<boolean>;
  prepare(agentId: string, orgId: string, query: string, previousQuestion?: string): Promise<{ chunks: RetrievedChunk[]; systemAddendum?: string } | null>;
  resolveModel(requested: string | null, orgId: string): Promise<string>;
  stream(req: LlmRequest): AsyncGenerator<LlmStreamEvent>;
  finishLog(id: string, patch: LogPatch): Promise<void>;
  logUsage(departmentId: string, agentId: string, usage: LlmUsage): Promise<void>;
  now(): number;
}

export type PublicAskRejection = { ok: false; status: number; code: string; message: string };
export type PublicAskEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; found: boolean; sources: string[]; unverified: string[]; contacts: PublicAskContact[] }
  | { type: 'error'; message: string };

export const ipHashOf = (ip: string | null): string => createHash('sha256').update(`public_ask:${ip ?? 'unknown'}`).digest('hex');

const reject = (status: number, code: string, message: string): PublicAskRejection => ({ ok: false, status, code, message });

/** 이 기관의 시민 상담 비서가 쓸 수 있는가 — 시민 전용·같은 기관·지우지 않음·켜짐 */
function usableAgent(agent: PublicAskAgent | null, orgId: string): agent is PublicAskAgent {
  return !!agent && agent.tier === 'public' && agent.organization_id === orgId && !agent.deleted_at && agent.is_active;
}

/** 공개 설정(GET) — 운영하지 않으면 거절 */
export async function loadPublicConfig(slug: string, deps: Pick<PublicAskDeps, 'loadOrg' | 'loadSettings'>): Promise<{ ok: true; config: PublicAskConfig; allowedOrigins: string[] } | PublicAskRejection> {
  const org = await deps.loadOrg(slug);
  if (!org) return reject(404, 'not_found', PUBLIC_ASK_MESSAGES.notFound);
  const settings = await deps.loadSettings(org.id);
  if (!settings?.enabled || org.status === 'suspended' || org.status === 'terminated') return reject(403, 'closed', PUBLIC_ASK_MESSAGES.closed);
  return {
    ok: true,
    allowedOrigins: settings.allowed_origins ?? [],
    config: {
      orgName: org.name,
      logoUrl: org.logo_url ? `/api/branding/logo?org=${org.id}` : null,
      themeColor: org.theme_color,
      notice: settings.notice ?? '',
      faq: settings.faq ?? [],
      contacts: readContacts(settings.contacts),
    },
  };
}

/**
 * 질문 하나 — 거절이면 상태 코드와 안내, 아니면 흘려 보낼 이벤트 열.
 * 하루 횟수를 차지한 뒤의 실패는 그 기록 줄을 '거절'·'답하지 못함'으로 마무리한다
 */
export async function askPublic(
  input: { slug: string; question: unknown; previousQuestion?: unknown; ip: string | null },
  deps: PublicAskDeps,
): Promise<PublicAskRejection | { ok: true; events: AsyncGenerator<PublicAskEvent> }> {
  const question = typeof input.question === 'string' ? input.question.normalize('NFC').trim() : '';
  if (!question || question.length > PUBLIC_ASK_QUESTION_MAX) return reject(400, 'bad_question', PUBLIC_ASK_MESSAGES.badQuestion);
  const previous = typeof input.previousQuestion === 'string' ? input.previousQuestion.normalize('NFC').trim().slice(0, PUBLIC_ASK_QUESTION_MAX) : '';

  const org = await deps.loadOrg(input.slug);
  if (!org) return reject(404, 'not_found', PUBLIC_ASK_MESSAGES.notFound);
  const settings = await deps.loadSettings(org.id);
  if (!settings?.enabled || org.status === 'suspended' || org.status === 'terminated') return reject(403, 'closed', PUBLIC_ASK_MESSAGES.closed);
  const agent = settings.agent_id ? await deps.loadAgent(settings.agent_id) : null;
  if (!usableAgent(agent, org.id)) return reject(503, 'not_ready', PUBLIC_ASK_MESSAGES.notReady);
  if (await deps.orgBudgetExhausted(org.id)) return reject(429, 'budget', PUBLIC_ASK_MESSAGES.budget);

  const contacts = readContacts(settings.contacts);
  const claim = await deps.claim(org.id, ipHashOf(input.ip), kstDayStart(kstDay(deps.now())).toISOString(), settings.ip_daily_cap, settings.org_daily_cap);
  if (claim.status === 'capped_ip') return reject(429, 'capped_ip', PUBLIC_ASK_MESSAGES.cappedIp);
  if (claim.status === 'capped_org' || !claim.id) return reject(429, 'capped_org', PUBLIC_ASK_MESSAGES.cappedOrg);
  const logId = claim.id;

  try {
    if (!(await deps.passesFilter(agent.department_id, question))) {
      // 거절한 질문은 글을 남기지 않는다
      await deps.finishLog(logId, { result: 'rejected_pii' });
      return reject(400, 'rejected', PUBLIC_ASK_MESSAGES.rejected);
    }
    const prepared = await deps.prepare(agent.id, org.id, question, previous || undefined);
    if (!prepared) {
      await deps.finishLog(logId, { result: 'unavailable', question: question.slice(0, PUBLIC_ASK_STORED_QUESTION_MAX) });
      return reject(503, 'unavailable', PUBLIC_ASK_MESSAGES.unavailable);
    }
    const model = await deps.resolveModel(agent.model_id, org.id);
    return { ok: true, events: answer({ org, agent, question, prepared, model, logId, contacts }, deps) };
  } catch (err) {
    await deps.finishLog(logId, { result: 'unavailable' }).catch(() => {});
    throw err;
  }
}

async function* answer(
  run: { org: PublicAskOrg; agent: PublicAskAgent; question: string; prepared: { chunks: RetrievedChunk[]; systemAddendum?: string }; model: string; logId: string; contacts: PublicAskContact[] },
  deps: PublicAskDeps,
): AsyncGenerator<PublicAskEvent> {
  const { org, agent, question, prepared, model, logId, contacts } = run;
  const system = buildSystemPrompt(agent.system_prompt, [prepared.systemAddendum, publicAskGuide(org.name)]);
  let text = '';
  let usage: LlmUsage | null = null;
  try {
    for await (const ev of deps.stream({ model, system, messages: [{ role: 'user', content: question }], maxTokens: PUBLIC_ASK_ANSWER_MAX_TOKENS })) {
      if (ev.type === 'text') {
        text += ev.text;
        yield { type: 'delta', text: ev.text };
      } else if (ev.type === 'done') {
        usage = ev.usage;
      }
    }
  } catch {
    // 쓴 토큰을 알 수 없으면 기록만 마무리한다
    await deps.finishLog(logId, { result: 'unavailable', question: question.slice(0, PUBLIC_ASK_STORED_QUESTION_MAX), answer: text.slice(0, PUBLIC_ASK_STORED_ANSWER_MAX) || null, model }).catch(() => {});
    yield { type: 'error', message: PUBLIC_ASK_MESSAGES.unavailable };
    return;
  }
  const found = prepared.chunks.length > 0;
  const sources = Array.from(new Set(prepared.chunks.map((c) => {
    // 위치(쪽·절)만 — 위치가 없으면 '청크 N' 대신 제목만
    const where = sourceLocationLabel(c);
    return where && !where.startsWith('청크 ') ? `${sourceTitleLabel(c)} · ${where}` : sourceTitleLabel(c);
  })));
  // 본 숫자 = 시스템 프롬프트(근거 묶음)·질문의 숫자 — 직원 대화의 숫자 확인과 같은 대조
  const unverified = found ? checkNumbers(text, [...numbersIn(system), ...numbersIn(question)]) : [];
  const result: PublicAskResult = found ? 'answered' : 'no_source';
  if (usage) await deps.logUsage(agent.department_id, agent.id, usage);
  await deps.finishLog(logId, {
    result, question: question.slice(0, PUBLIC_ASK_STORED_QUESTION_MAX), answer: text.slice(0, PUBLIC_ASK_STORED_ANSWER_MAX),
    sources, model: usage?.model ?? model, input_tokens: usage?.input_tokens ?? 0, output_tokens: usage?.output_tokens ?? 0,
  });
  yield { type: 'done', found, sources, unverified, contacts };
}
