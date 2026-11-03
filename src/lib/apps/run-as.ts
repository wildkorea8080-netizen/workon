// src/lib/apps/run-as.ts
// 사람 없이 입력형 앱을 '그 직원으로' 한 번 실행한다 — 예약 실행(schedules.ts)과 외부 연동(webhooks.ts)이 함께 쓴다.
// 그 직원의 세션 꼴(id·역할·부서)을 만들어 대화 실행기(prepareTurn·streamTurn)를 손 실행과 같은 본문으로 태운다.
// 그래서 앱 사용 권한(canUseAgent)·기관 한도·모델 정책·금지어 검사·사용 기록·대화 저장이 손으로 실행할 때와 같다.
import type { Session } from 'next-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { prepareTurn } from '@/lib/assistant/prepare';
import { streamTurn } from '@/lib/assistant/stream';
import type { PrepareOutcome, PreparedTurn, SendEvent } from '@/lib/assistant/types';

export type RunAsInput = { userId: string; departmentId: string; agentId: string; appVersion: number; inputs: Record<string, string> };
export type RunAsUser = { id: string; email: string | null; role: string | null; department_id: string | null; is_active: boolean | null; deleted_at: string | null };

export type RunAsOutcome =
  | { kind: 'completed'; conversationId: string | null }
  /** 계정이 없거나 비활성·탈퇴 */
  | { kind: 'user_unavailable' }
  /** 만들 때와 소속 부서가 다르다 — 권한 범위가 바뀌었을 수 있어 실행하지 않는다 */
  | { kind: 'department_changed' }
  /** 대화 실행기가 시작 전에 거절(409 앱 판 바뀜·403/404 앱을 쓸 수 없음·429 한도·400 입력 검사 등) */
  | { kind: 'rejected'; status: number; message: string }
  /** 시작했지만 끝까지 가지 못함(모델 오류·응답 끊김) — 대화는 남았을 수 있다 */
  | { kind: 'failed'; error: string; conversationId: string | null };

export interface RunAsIo {
  loadUser(userId: string): Promise<RunAsUser | null>;
  prepare(session: Session, body: Record<string, unknown>): Promise<PrepareOutcome>;
  stream(turn: PreparedTurn, send: SendEvent): Promise<void>;
  /** 대화 제목 앞에 표시(`[예약] `·`[연동] `)를 붙인다 — 앱 실행 기록에서 사람이 돌린 실행과 가르게 */
  retitle(conversationId: string, prefix: string): Promise<void>;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message.slice(0, 300) : '알 수 없는 오류');

export async function runAppAs(input: RunAsInput, titlePrefix: string, io: RunAsIo = defaultRunAsIo()): Promise<RunAsOutcome> {
  const user = await io.loadUser(input.userId);
  if (!user || user.is_active === false || user.deleted_at) return { kind: 'user_unavailable' };
  if (!user.department_id || user.department_id !== input.departmentId) return { kind: 'department_changed' };
  const session = {
    user: { id: user.id, email: user.email ?? undefined, role: user.role === 'ADMIN' ? 'ADMIN' : 'USER', departmentId: user.department_id },
    expires: new Date(Date.now() + 5 * 60_000).toISOString(),
  } as Session;
  const prepared = await io.prepare(session, { agent_id: input.agentId, message: '앱 실행', app_inputs: input.inputs, app_version: input.appVersion });
  if (!prepared.ok) return { kind: 'rejected', status: prepared.status, message: prepared.message };
  let conversationId: string | null = null; let error: string | null = null; let done = false;
  try {
    await io.stream(prepared.turn, (event) => {
      if (event.event === 'meta') conversationId = event.data.conversation_id;
      else if (event.event === 'error') error = error ?? event.data.message;
      else if (event.event === 'done') done = true;
    });
  } catch (failure) { error = error ?? errorText(failure); }
  if (error) return { kind: 'failed', error, conversationId };
  if (!done) return { kind: 'failed', error: '응답이 끝나지 않았습니다.', conversationId };
  if (conversationId) {
    try { await io.retitle(conversationId, titlePrefix); } catch { /* 제목은 표시일 뿐 — 실행 결과를 바꾸지 않는다 */ }
  }
  return { kind: 'completed', conversationId };
}

export function defaultRunAsIo(): RunAsIo {
  return {
    async loadUser(userId) {
      const { data, error } = await supabaseAdmin.from('users').select('id, email, role, department_id, is_active, deleted_at').eq('id', userId).maybeSingle();
      if (error) throw new Error(`users: ${error.message}`);
      return (data as RunAsUser | null) ?? null;
    },
    prepare: prepareTurn,
    stream: (turn, send) => streamTurn(turn, send),
    async retitle(conversationId, prefix) {
      const { data } = await supabaseAdmin.from('conversations').select('title').eq('id', conversationId).maybeSingle();
      const title: string = data?.title ?? '';
      if (title.startsWith(prefix)) return;
      await supabaseAdmin.from('conversations').update({ title: `${prefix}${title || '앱 실행'}`.slice(0, 200) }).eq('id', conversationId);
    },
  };
}
