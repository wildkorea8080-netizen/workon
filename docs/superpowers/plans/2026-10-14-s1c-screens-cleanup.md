# S1-c 화면·정리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관리자와 직원이 세 단계 비서를 화면에서 만들고·고치고·되돌리고·올릴 수 있게 하고, 옛 칸(`is_personal`·`enabled_connectors`)과 옛 템플릿 편집을 걷어낸다.

**Architecture:** 판 설정(이름·지시문·모델·능력 등)은 관리자·직원 공통의 `AgentEditorModal` 하나가 다룬다(설정 · 양식 · 변경 기록 탭). 운영 값(노출·공개 범위·유형·주소)은 관리 화면에 남는다 — 데이터에서 두 갈래를 나눈 것과 같은 선이다. 화면 계산은 순수 함수(`src/lib/agent-form.ts`)로 빼서 시험한다. 마지막에 0027로 옛 칸을 지운다.

**Tech Stack:** Next.js 14 App Router · React 18 · TypeScript · Tailwind · next-auth/react `useSession` · vitest

**Spec:** `docs/superpowers/specs/2026-10-14-s1-agent-structure-and-executor-design.md` (6.2·6.4·6.6절)

**선행 조건:** S1-a·S1-b가 배포되어 있다.

## Global Constraints

- 디자인 기준: 정부 파란색 `#003087`, 모서리 `rounded-xl`, 글자 `text-sm`/`text-xs`, 기존 `AgentsManager`·`CreateAgentModal`의 클래스 관례를 따른다
- 모달은 휴대폰 폭에서도 쓸 수 있어야 한다: `w-full max-w-2xl`, `max-h-[90vh] overflow-y-auto`, 바깥 여백 `px-4`
- 화면 검사는 표시일 뿐이다. 권한·범위·상한은 서버가 다시 건다
- 판 설정 저장에는 반드시 `base_version`을 보낸다. 409 `reason: 'conflict'`면 충돌 안내를 띄운다
- 응답 규약 `{ ok, data }` / `{ ok: false, error: { message, details? } }`
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 배포 순서: 이 묶음의 코드 배포 → 확인 → `0027` 적용. 거꾸로 하면 옛 코드가 지워진 칸을 찾다 멈춘다

**번호 주의:** S1-b가 `0027`을 `doc_search` 재동기화에 쓰므로, 이 계획의 옛 칸 정리 마이그레이션은 실제로는 `0028_agent_tiers_cleanup.sql`이다(본문의 0027을 0028로 읽는다).

## Review Focus

- **부서원 둘이 편집 창을 열어 두고 차례로 저장한다** → 두 번째 사람은 충돌 안내와 '최신 내용 불러오기'를 본다. 자기 수정이 사라진다는 사실도 안다. Task 3이 화면에 넣고 Task 8 실측으로 본다.
- **기관이 쓰지 않는 연결을 직원 편집 창에 내놓는다** → 나만의·부서 비서 편집 창에는 `allowedForPersonal`인 연결만 보인다. 공식 비서는 전부 보인다. Task 1의 `connectorChoices` 테스트가 고정한다.
- **링크형 비서의 설정 창에 지시문·모델·능력이 보인다** → 링크형은 대화하지 않으므로 이름·설명·아이콘·카테고리만 보인다. Task 1의 `settingsToBody` 테스트가 고정한다.
- **되돌리기 목록에서 지금 판을 되돌리려 한다** → 지금 판과 판 번호가 없는 기록(단계 변경·문서)에는 되돌리기 버튼이 없다. Task 1의 `canRevertTo` 테스트가 고정한다.
- **0027 뒤에 옛 칸을 읽는 코드가 남아 있다** → 남으면 그 화면이 오류 없이 빈 값을 보이거나 조회가 실패한다. Task 7의 원본 검사가 `src/` 전체에서 옛 칸 이름을 찾는다.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `src/lib/agent-form.ts` (새) | 화면용 순수 함수 — 설정 값 ↔ 요청 본문, 기록 문장, 되돌리기 가능 여부, 연결 선택지 |
| `src/app/api/agents/[id]/route.ts` (고침) | `GET` 추가 — 편집 창이 최신 판을 다시 읽는다 |
| `src/components/agents/AgentEditorModal.tsx` (새) | 설정 · 양식 · 변경 기록 탭 |
| `src/components/agents/TemplatesPanel.tsx` (새) | 양식 목록·추가·빼기 |
| `src/components/agents/HistoryPanel.tsx` (새) | 변경 기록과 되돌리기 |
| `src/components/admin/AgentsManager.tsx` (고침) | 설정 창 연결 · 운영 칸만 직접 편집 · 단계 표시·거르기 · 신청자 |
| `src/components/chat/AgentSelector.tsx`, `AgentCard.tsx`, `CreateAgentModal.tsx`, `ChatInterface.tsx` (고침) | 부서 비서 탭 · 편집·올리기 · 단계·모델 선택 |
| `src/components/admin/PromptTemplateManager.tsx` (전체 교체) · `src/app/api/templates/**` (고침) | 옛 보고서 템플릿 읽기 전용 |
| `supabase/migrations/0027_agent_tiers_cleanup.sql` (새) | 옛 칸·맞춤 트리거 제거 |
| `tests/agent-form.test.ts`, `tests/legacy-columns.test.ts` (새) | 회귀 |

---

### Task 1: 화면용 순수 함수

**Files:**
- Create: `src/lib/agent-form.ts`
- Test: `tests/agent-form.test.ts`

**Interfaces:**
- Consumes: `Agent` (`@/lib/db`)
- Produces:
  ```typescript
  export interface AgentSettingsValue { name: string; description: string; icon: string; category: string; usage_guide: string; starter_prompts: string; system_prompt: string; model_id: string; doc_search: boolean; image: boolean; connectors: string[] }
  export const TIER_LABELS: Record<'personal' | 'department' | 'official', string>;
  export function connectorIdsOf(capabilities: unknown): string[];
  export function settingsFromAgent(agent: Pick<Agent, 'name' | 'description' | 'icon' | 'category' | 'usage_guide' | 'starter_prompts' | 'system_prompt' | 'model_id' | 'capabilities'>): AgentSettingsValue;
  export function settingsToBody(value: AgentSettingsValue, opts: { isLink: boolean }): Record<string, unknown>;
  export interface HistoryItemLike { kind: string; version: number | null; detail: Record<string, unknown> }
  export function describeHistoryItem(item: HistoryItemLike): string;
  export function canRevertTo(item: HistoryItemLike, currentVersion: number): boolean;
  export interface ConnectorChoice { id: string; label: string; allowedForPersonal?: boolean }
  export function connectorChoices(all: ConnectorChoice[], tier: 'personal' | 'department' | 'official', current: string[]): ConnectorChoice[];
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// tests/agent-form.test.ts
import { describe, it, expect } from 'vitest';
import {
  settingsFromAgent,
  settingsToBody,
  describeHistoryItem,
  canRevertTo,
  connectorChoices,
  connectorIdsOf,
} from '@/lib/agent-form';

const agent = {
  name: '공문 비서', description: null, icon: '📨', category: '공공기관',
  usage_guide: null, starter_prompts: ['교육 안내', '자료 요청'], system_prompt: '공문을 씁니다',
  model_id: null, capabilities: { image: {}, public_data: { connectors: ['law'] } },
};

describe('설정 값', () => {
  it('비서에서 편집 값을 만든다', () => {
    expect(settingsFromAgent(agent as never)).toEqual({
      name: '공문 비서', description: '', icon: '📨', category: '공공기관', usage_guide: '',
      starter_prompts: '교육 안내\n자료 요청', system_prompt: '공문을 씁니다', model_id: '',
      doc_search: false, image: true, connectors: ['law'],
    });
  });

  it('대화형은 능력과 모델을 함께 보낸다', () => {
    const body = settingsToBody({ ...settingsFromAgent(agent as never), doc_search: true }, { isLink: false });
    expect(body.capabilities).toEqual({ doc_search: {}, image: {}, public_data: { connectors: ['law'] } });
    expect(body.model_id).toBeNull();
    expect(body.starter_prompts).toBe('교육 안내\n자료 요청');
  });

  it('연결을 다 끄면 공공데이터 능력을 뺀다', () => {
    const body = settingsToBody({ ...settingsFromAgent(agent as never), connectors: [] }, { isLink: false });
    expect(body.capabilities).toEqual({ image: {} });
  });

  it('링크형은 표시 정보만 보낸다', () => {
    // 링크형은 대화하지 않는다. 지시문·모델·능력을 보내면 의미 없는 판이 쌓인다.
    const body = settingsToBody(settingsFromAgent(agent as never), { isLink: true });
    expect(Object.keys(body).sort()).toEqual(['category', 'description', 'icon', 'name']);
  });

  it('깨진 능력 값에서도 연결 목록을 안전하게 읽는다', () => {
    expect(connectorIdsOf(null)).toEqual([]);
    expect(connectorIdsOf({ public_data: { connectors: 'law' } })).toEqual([]);
  });
});

describe('변경 기록 문장', () => {
  it('바뀐 칸을 사람 말로', () => {
    expect(describeHistoryItem({ kind: 'settings', version: 3, detail: { fields: ['model_id', 'system_prompt'] } }))
      .toBe('모델·지시문을 바꿈');
  });

  it('양식 추가·되돌리기·단계·문서', () => {
    expect(describeHistoryItem({ kind: 'settings', version: 4, detail: { template_added: '사업계획서', fields: ['template_ids'] } }))
      .toBe("양식 '사업계획서'을(를) 추가함");
    expect(describeHistoryItem({ kind: 'revert', version: 5, detail: { reverted_from: 2 } })).toBe('판 2로 되돌림');
    expect(describeHistoryItem({ kind: 'tier', version: null, detail: { from: 'personal', to: 'department' } }))
      .toBe('나만의 비서 → 부서 비서');
    expect(describeHistoryItem({ kind: 'document_added', version: null, detail: { file_name: '여비규정.hwp' } }))
      .toBe("문서 '여비규정.hwp'을(를) 올림");
    expect(describeHistoryItem({ kind: 'settings', version: 2, detail: { reason: 'auto_enable', fields: ['capabilities'] } }))
      .toBe('문서를 올려 참고 문서 찾기를 켬');
  });
});

describe('되돌리기 가능 여부', () => {
  it('판 번호가 있고 지금 판이 아닐 때만', () => {
    expect(canRevertTo({ kind: 'settings', version: 2, detail: {} }, 3)).toBe(true);
    expect(canRevertTo({ kind: 'settings', version: 3, detail: {} }, 3)).toBe(false);
    expect(canRevertTo({ kind: 'tier', version: null, detail: {} }, 3)).toBe(false);
    expect(canRevertTo({ kind: 'migrated', version: 1, detail: {} }, 3)).toBe(true);
  });
});

describe('연결 선택지', () => {
  const all = [
    { id: 'law', label: '법령', allowedForPersonal: true },
    { id: 'kosis', label: '통계', allowedForPersonal: false },
  ];

  it('공식 비서는 전부', () => {
    expect(connectorChoices(all, 'official', []).map((c) => c.id)).toEqual(['law', 'kosis']);
  });

  it('나만의·부서 비서는 기관이 쓰는 것만, 이미 켜 둔 것은 끌 수 있게 남긴다', () => {
    expect(connectorChoices(all, 'department', []).map((c) => c.id)).toEqual(['law']);
    expect(connectorChoices(all, 'personal', ['kosis']).map((c) => c.id)).toEqual(['law', 'kosis']);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/agent-form.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/agent-form"`

- [ ] **Step 3: 구현**

```typescript
// src/lib/agent-form.ts
import type { Agent } from '@/lib/db';

/**
 * 비서 편집 화면의 순수 계산. 화면 코드에 흩어 두면 관리자 화면과 직원
 * 화면이 다른 규칙을 갖게 된다(예전에 아이콘·카테고리가 직원 폼에만 있었다).
 */

export interface AgentSettingsValue {
  name: string;
  description: string;
  icon: string;
  category: string;
  usage_guide: string;
  /** 한 줄에 하나. 서버가 나눈다 */
  starter_prompts: string;
  system_prompt: string;
  /** '' = 기관 기본 모델 */
  model_id: string;
  doc_search: boolean;
  image: boolean;
  connectors: string[];
}

export const TIER_LABELS = {
  personal: '나만의 비서',
  department: '부서 비서',
  official: '공식 비서',
} as const;

const FIELD_LABELS: Record<string, string> = {
  name: '이름',
  description: '설명',
  icon: '아이콘',
  color: '색',
  category: '카테고리',
  usage_guide: '사용 방법',
  starter_prompts: '시작 예시',
  system_prompt: '지시문',
  model_id: '모델',
  capabilities: '능력',
  template_ids: '양식',
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function connectorIdsOf(capabilities: unknown): string[] {
  if (!isObject(capabilities) || !isObject(capabilities.public_data)) return [];
  const list = capabilities.public_data.connectors;
  return Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string') : [];
}

export function settingsFromAgent(
  agent: Pick<Agent, 'name' | 'description' | 'icon' | 'category' | 'usage_guide' | 'starter_prompts' | 'system_prompt' | 'model_id' | 'capabilities'>
): AgentSettingsValue {
  const caps = isObject(agent.capabilities) ? agent.capabilities : {};
  return {
    name: agent.name,
    description: agent.description ?? '',
    icon: agent.icon ?? '',
    category: agent.category ?? '',
    usage_guide: agent.usage_guide ?? '',
    starter_prompts: (agent.starter_prompts ?? []).join('\n'),
    system_prompt: agent.system_prompt ?? '',
    model_id: agent.model_id ?? '',
    doc_search: 'doc_search' in caps,
    image: 'image' in caps,
    connectors: connectorIdsOf(caps),
  };
}

export function settingsToBody(value: AgentSettingsValue, opts: { isLink: boolean }): Record<string, unknown> {
  const display = {
    name: value.name.trim(),
    description: value.description.trim() || null,
    icon: value.icon.trim() || null,
    category: value.category.trim() || null,
  };
  if (opts.isLink) return display;

  return {
    ...display,
    usage_guide: value.usage_guide.trim() || null,
    starter_prompts: value.starter_prompts,
    system_prompt: value.system_prompt.trim() || null,
    model_id: value.model_id || null,
    capabilities: {
      ...(value.doc_search ? { doc_search: {} } : {}),
      ...(value.image ? { image: {} } : {}),
      ...(value.connectors.length > 0 ? { public_data: { connectors: value.connectors } } : {}),
    },
  };
}

export interface HistoryItemLike {
  kind: string;
  version: number | null;
  detail: Record<string, unknown>;
}

export function describeHistoryItem(item: HistoryItemLike): string {
  const d = item.detail ?? {};
  switch (item.kind) {
    case 'created':
      return '만듦';
    case 'migrated':
      return '단계 도입 이전의 내용';
    case 'preset_update':
      return '기본 비서 내용 갱신';
    case 'revert':
      return `판 ${String(d.reverted_from)}로 되돌림`;
    case 'tier': {
      const from = TIER_LABELS[d.from as keyof typeof TIER_LABELS] ?? String(d.from);
      const to = TIER_LABELS[d.to as keyof typeof TIER_LABELS] ?? String(d.to);
      return `${from} → ${to}`;
    }
    case 'document_added':
      return `문서 '${String(d.file_name)}'을(를) 올림`;
    case 'document_removed':
      return `문서 '${String(d.file_name)}'을(를) 지움`;
    case 'deleted':
      return '지움';
    case 'settings': {
      if (d.reason === 'auto_enable') return '문서를 올려 참고 문서 찾기를 켬';
      if (typeof d.template_added === 'string') return `양식 '${d.template_added}'을(를) 추가함`;
      if (typeof d.template_removed === 'string') return `양식 '${d.template_removed}'을(를) 뺌`;
      const fields = Array.isArray(d.fields) ? (d.fields as string[]) : [];
      if (fields.length === 0) return '설정을 저장함';
      return `${fields.map((f) => FIELD_LABELS[f] ?? f).join('·')}을 바꿈`;
    }
    default:
      return item.kind;
  }
}

export function canRevertTo(item: HistoryItemLike, currentVersion: number): boolean {
  return item.version !== null && item.version !== currentVersion;
}

export interface ConnectorChoice {
  id: string;
  label: string;
  allowedForPersonal?: boolean;
}

/**
 * 편집 창에 내놓을 연결. 나만의·부서 비서는 기관이 공식 비서에서 쓰는 것만.
 * 이미 켜 둔 것은 기관이 그 뒤 껐더라도 목록에 남겨 끌 수 있게 한다.
 */
export function connectorChoices(
  all: ConnectorChoice[],
  tier: 'personal' | 'department' | 'official',
  current: string[]
): ConnectorChoice[] {
  if (tier === 'official') return all;
  return all.filter((c) => c.allowedForPersonal || current.includes(c.id));
}
```

참고: `describeHistoryItem`의 `fields` 문장은 `모델·지시문을 바꿈`처럼 '을'로 고정한다(받침 판정 없이 읽히는 형태). 테스트의 `'모델·지시문을 바꿈'`과 같다. `fields`는 0026이 알파벳순으로 정렬해 남기므로 `model_id`가 `system_prompt`보다 앞이다.

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/agent-form.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-form.ts tests/agent-form.test.ts
git commit -m "feat: 비서 편집 화면용 순수 함수

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 비서 하나 읽기

**Files:**
- Modify: `src/app/api/agents/[id]/route.ts` (GET 추가)
- Modify: `tests/agent-route-permissions.test.ts`

- [ ] **Step 1: 실패하는 테스트로 바꾼다** — `MUTATING` 배열의 `['src/app/api/agents/[id]/route.ts', ['PATCH', 'DELETE']]`를 `['src/app/api/agents/[id]/route.ts', ['GET', 'PATCH', 'DELETE']]`로 바꾼다.

Run: `npx vitest run tests/agent-route-permissions.test.ts`
Expected: FAIL — `GET 핸들러 없음`

- [ ] **Step 2: 구현** — 파일의 `PATCH` 위에 추가한다.

```typescript
/**
 * 편집 창이 최신 판을 다시 읽는다. 고칠 수 있는 사람만 — 지시문 전문이 들어 있다.
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canEditAgent(agent, actor)) return jsonError('이 비서를 볼 권한이 없습니다.', 403);

    const { data } = await supabaseAdmin.from('agents').select('*').eq('id', params.id).single();
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    console.error('[agents GET]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
```

- [ ] **Step 3: 통과 확인**

Run: `npx vitest run tests/agent-route-permissions.test.ts tests/route-auth.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/api/agents/[id]/route.ts tests/agent-route-permissions.test.ts
git commit -m "feat: 편집 창용 비서 하나 읽기

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 편집 창

**Files:**
- Create: `src/components/agents/AgentEditorModal.tsx`, `TemplatesPanel.tsx`, `HistoryPanel.tsx`

**Interfaces:**
- Consumes: Task 1·2, `GET/POST /api/agents/[id]/templates`, `DELETE /api/agents/[id]/templates/[templateId]`, `GET /api/agents/[id]/history`, `POST /api/agents/[id]/revert`, `PATCH /api/agents/[id]`, `/api/models`, `/api/connectors`, `/api/enhance-prompt`, `TEMPLATE_EXTENSIONS`·`MAX_TEMPLATES`
- Produces:
  ```typescript
  export default function AgentEditorModal(props: { agentId: string; categories?: string[]; onClose: () => void; onSaved?: (agent: Agent) => void }): JSX.Element;
  export default function TemplatesPanel(props: { agentId: string; version: number; onChanged: () => void }): JSX.Element;
  export default function HistoryPanel(props: { agentId: string; version: number; onReverted: () => void }): JSX.Element;
  ```

- [ ] **Step 1: `TemplatesPanel.tsx` 작성**

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { TEMPLATE_EXTENSIONS, MAX_TEMPLATES } from '@/lib/template-files';

type TemplateItem = { id: string; name: string; file_name: string; size_bytes: number; created_at: string };

/**
 * 양식 파일 — 결과를 채울 기관 서식(HWP·HWPX·DOCX). 채우는 일은 S2가 한다.
 * 바꿀 때마다 판이 오르므로 저장 뒤에는 부모가 비서를 다시 읽는다(onChanged).
 */
export default function TemplatesPanel({
  agentId,
  version,
  onChanged,
}: {
  agentId: string;
  version: number;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<TemplateItem[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/agents/${agentId}/templates`);
    const r = await res.json();
    if (r.ok) setItems(r.data.items);
    else setError(r.error?.message ?? '양식을 불러오지 못했습니다.');
  }, [agentId]);

  useEffect(() => {
    load();
  }, [load, version]);

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file || !name.trim()) {
      setError('양식 이름과 파일을 모두 넣어 주세요.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', name.trim());
      fd.append('base_version', String(version));
      const res = await fetch(`/api/agents/${agentId}/templates`, { method: 'POST', body: fd });
      const r = await res.json();
      if (!r.ok) {
        setError(r.error?.message ?? '양식을 올리지 못했습니다.');
        return;
      }
      setName('');
      if (fileRef.current) fileRef.current.value = '';
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: TemplateItem) => {
    if (!confirm(`'${item.name}' 양식을 뺄까요? 변경 기록에서 이전 판으로 되돌리면 다시 살아납니다.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/templates/${item.id}?base_version=${version}`, { method: 'DELETE' });
      const r = await res.json();
      if (!r.ok) setError(r.error?.message ?? '양식을 빼지 못했습니다.');
      else onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">
        결과를 채울 기관 서식을 올려 둡니다. 비서 하나에 {MAX_TEMPLATES}개까지, 양식마다 이름을 붙입니다.
        대화에서 &ldquo;사업계획서 양식으로 써 줘&rdquo;처럼 이름으로 고릅니다.
      </p>

      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 p-3 border border-slate-100 rounded-xl">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-800 truncate">{item.name}</p>
              <p className="text-[11px] text-slate-400 truncate">
                {item.file_name} · {Math.max(1, Math.round(item.size_bytes / 1024))}KB
              </p>
            </div>
            <button
              onClick={() => remove(item)}
              disabled={busy}
              className="px-3 py-1 text-xs border border-red-200 text-red-500 rounded-lg hover:bg-red-50 disabled:opacity-50"
            >
              빼기
            </button>
          </li>
        ))}
        {items.length === 0 && <li className="text-xs text-slate-400 py-4 text-center">올린 양식이 없습니다.</li>}
      </ul>

      {items.length < MAX_TEMPLATES && (
        <div className="border border-slate-200 rounded-xl p-3 space-y-2">
          <input
            type="text"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            placeholder="양식 이름 (예: 사업계획서)"
            className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#003087]/20"
          />
          <input
            ref={fileRef}
            type="file"
            accept={TEMPLATE_EXTENSIONS.map((e) => `.${e}`).join(',')}
            className="block w-full text-xs text-slate-500"
          />
          <button
            onClick={upload}
            disabled={busy}
            className="px-4 py-2 bg-[#003087] hover:bg-[#002070] disabled:bg-slate-300 text-white text-sm font-semibold rounded-xl"
          >
            {busy ? '올리는 중...' : '양식 올리기'}
          </button>
        </div>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: `HistoryPanel.tsx` 작성**

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { describeHistoryItem, canRevertTo } from '@/lib/agent-form';

type HistoryItem = {
  id: string;
  kind: string;
  version: number | null;
  changed_by_name: string | null;
  detail: Record<string, unknown>;
  created_at: string;
};

/** 누가 언제 무엇을 바꿨는지 + 이 판으로 되돌리기(설계 6.4) */
export default function HistoryPanel({
  agentId,
  version,
  onReverted,
}: {
  agentId: string;
  version: number;
  onReverted: () => void;
}) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/agents/${agentId}/history`);
    const r = await res.json();
    if (r.ok) setItems(r.data.items);
    else setError(r.error?.message ?? '변경 기록을 불러오지 못했습니다.');
  }, [agentId]);

  useEffect(() => {
    load();
  }, [load, version]);

  const revert = async (target: number) => {
    if (!confirm(`판 ${target}(으)로 되돌릴까요? 지금 내용은 기록에 남고, 되돌린 내용이 새 판이 됩니다.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: target, base_version: version }),
      });
      const r = await res.json();
      if (!r.ok) setError(r.error?.message ?? '되돌리지 못했습니다.');
      else onReverted();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.id} className="flex items-start gap-3 p-3 border border-slate-100 rounded-xl">
          <span
            className={`mt-0.5 px-1.5 py-0.5 text-[10px] font-semibold rounded ${
              item.version === version ? 'bg-[#003087] text-white' : 'bg-slate-100 text-slate-500'
            }`}
          >
            {item.version !== null ? `판 ${item.version}` : '기록'}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-slate-800">{describeHistoryItem(item)}</p>
            <p className="text-[11px] text-slate-400">
              {item.changed_by_name ?? '시스템'} · {new Date(item.created_at).toLocaleString('ko-KR')}
            </p>
          </div>
          {canRevertTo(item, version) && (
            <button
              onClick={() => revert(item.version as number)}
              disabled={busy}
              className="px-3 py-1 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600 disabled:opacity-50 flex-shrink-0"
            >
              이 판으로 되돌리기
            </button>
          )}
        </div>
      ))}
      {items.length === 0 && <p className="text-xs text-slate-400 py-4 text-center">기록이 없습니다.</p>}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: `AgentEditorModal.tsx` 작성**

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Agent } from '@/lib/db';
import {
  settingsFromAgent,
  settingsToBody,
  connectorChoices,
  TIER_LABELS,
  type AgentSettingsValue,
  type ConnectorChoice,
} from '@/lib/agent-form';
import TemplatesPanel from './TemplatesPanel';
import HistoryPanel from './HistoryPanel';

type ModelOption = { id: string; label: string; note: string };
type Tab = 'settings' | 'templates' | 'history';

const input =
  'w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#003087]/20';
const label = 'block text-xs font-medium text-slate-500 mb-1';

/**
 * 비서 편집 창 — 관리자·직원 공통(설계 6.4).
 *
 * 판 설정만 다룬다. 노출·공개 범위·유형 같은 운영 값은 관리 화면에 있다.
 * 저장할 때 보고 있던 판 번호를 보낸다. 그 사이 다른 사람이 저장했으면
 * 서버가 거절하고, 여기서 충돌 안내를 띄운다.
 */
export default function AgentEditorModal({
  agentId,
  categories = [],
  onClose,
  onSaved,
}: {
  agentId: string;
  categories?: string[];
  onClose: () => void;
  onSaved?: (agent: Agent) => void;
}) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [value, setValue] = useState<AgentSettingsValue | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [connectors, setConnectors] = useState<ConnectorChoice[]>([]);
  const [tab, setTab] = useState<Tab>('settings');
  const [saving, setSaving] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/agents/${agentId}`);
    const r = await res.json();
    if (!r.ok) {
      setError(r.error?.message ?? '비서를 불러오지 못했습니다.');
      return;
    }
    setAgent(r.data);
    setValue(settingsFromAgent(r.data));
    setConflict(false);
  }, [agentId]);

  useEffect(() => {
    load();
    fetch('/api/models')
      .then((r) => r.json())
      .then((r) => r.ok && setModels(r.data ?? []))
      .catch(() => {});
    fetch('/api/connectors')
      .then((r) => r.json())
      .then((r) => r.ok && setConnectors(r.data ?? []))
      .catch(() => {});
  }, [load]);

  const patch = (p: Partial<AgentSettingsValue>) => setValue((v) => (v ? { ...v, ...p } : v));

  const save = async () => {
    if (!agent || !value) return;
    if (!value.name.trim()) {
      setError('비서 이름을 입력해 주세요.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/agents/${agent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...settingsToBody(value, { isLink: agent.agent_type === 'link' }),
          base_version: agent.version,
        }),
      });
      const r = await res.json();
      if (res.status === 409 && r.error?.details?.reason === 'conflict') {
        setConflict(true);
        return;
      }
      if (!r.ok) {
        setError(r.error?.message ?? '저장하지 못했습니다.');
        return;
      }
      setAgent(r.data);
      setValue(settingsFromAgent(r.data));
      setNotice(`판 ${r.data.version}로 저장했습니다.`);
      onSaved?.(r.data);
    } finally {
      setSaving(false);
    }
  };

  const enhance = async () => {
    if (!value?.system_prompt.trim()) return;
    setEnhancing(true);
    try {
      const res = await fetch('/api/enhance-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: value.system_prompt, type: 'agent' }),
      });
      const r = await res.json();
      if (r.ok) patch({ system_prompt: r.data.enhancedPrompt });
      else setError(r.error?.message ?? '지시문을 다듬지 못했습니다.');
    } finally {
      setEnhancing(false);
    }
  };

  const isLink = agent?.agent_type === 'link';
  const choices = agent && value ? connectorChoices(connectors, agent.tier, value.connectors) : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-slate-100 px-5 pt-4 z-10">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-base font-bold text-slate-900 truncate">
                {agent?.icon} {agent?.name ?? '비서'}
              </p>
              {agent && (
                <p className="text-[11px] text-slate-400">
                  {TIER_LABELS[agent.tier]} · 판 {agent.version}
                </p>
              )}
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none" aria-label="닫기">
              ×
            </button>
          </div>
          <div className="flex gap-4 mt-3 text-sm">
            {(
              [
                ['settings', '설정'],
                ...(isLink ? [] : [['templates', '양식']]),
                ['history', '변경 기록'],
              ] as [Tab, string][]
            ).map(([key, text]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`pb-2 border-b-2 ${tab === key ? 'border-[#003087] text-[#003087] font-semibold' : 'border-transparent text-slate-500'}`}
              >
                {text}
              </button>
            ))}
          </div>
        </div>

        <div className="p-5 space-y-4">
          {conflict && (
            <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800 space-y-2">
              <p>다른 분이 먼저 고쳤습니다. 최신 내용을 불러오면 지금 고친 내용은 사라집니다. 필요하면 복사해 두세요.</p>
              <button onClick={load} className="px-3 py-1 bg-amber-600 text-white rounded-lg font-semibold">
                최신 내용 불러오기
              </button>
            </div>
          )}

          {!agent || !value ? (
            <p className="text-sm text-slate-400">{error ?? '불러오는 중...'}</p>
          ) : tab === 'templates' ? (
            <TemplatesPanel agentId={agent.id} version={agent.version} onChanged={load} />
          ) : tab === 'history' ? (
            <HistoryPanel agentId={agent.id} version={agent.version} onReverted={load} />
          ) : (
            <>
              <div className="grid grid-cols-[84px_1fr] gap-3">
                <div>
                  <label className={label}>아이콘</label>
                  <input
                    value={value.icon}
                    maxLength={8}
                    onChange={(e) => patch({ icon: e.target.value })}
                    className={`${input} text-center text-lg`}
                  />
                </div>
                <div>
                  <label className={label}>이름</label>
                  <input value={value.name} onChange={(e) => patch({ name: e.target.value })} className={input} />
                </div>
              </div>

              <div>
                <label className={label}>설명</label>
                <input value={value.description} onChange={(e) => patch({ description: e.target.value })} className={input} />
              </div>

              <div>
                <label className={label}>카테고리</label>
                {categories.length > 0 ? (
                  <select value={value.category} onChange={(e) => patch({ category: e.target.value })} className={`${input} bg-white`}>
                    <option value="">(미분류)</option>
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={value.category} onChange={(e) => patch({ category: e.target.value })} className={input} />
                )}
              </div>

              {!isLink && (
                <>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-slate-500">지시문</label>
                      <button
                        onClick={enhance}
                        disabled={enhancing || !value.system_prompt.trim()}
                        className="text-xs text-[#003087] disabled:text-slate-300"
                      >
                        {enhancing ? '다듬는 중...' : '✨ 요술봉'}
                      </button>
                    </div>
                    <textarea
                      rows={6}
                      value={value.system_prompt}
                      onChange={(e) => patch({ system_prompt: e.target.value })}
                      className={`${input} resize-y`}
                    />
                  </div>

                  <div>
                    <label className={label}>모델</label>
                    <select value={value.model_id} onChange={(e) => patch({ model_id: e.target.value })} className={`${input} bg-white`}>
                      <option value="">기관 기본 모델</option>
                      {models.map((m) => (
                        <option key={m.id} value={m.id} title={m.note}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    {value.model_id && models.length > 0 && !models.some((m) => m.id === value.model_id) && (
                      <p className="mt-1 text-[11px] text-amber-600">
                        기관 허용 목록에 없는 모델이라 지금은 기본 모델로 동작합니다.
                      </p>
                    )}
                  </div>

                  <div className="border border-slate-200 rounded-xl p-3 space-y-2">
                    <p className="text-xs font-semibold text-slate-700">능력</p>
                    {(
                      [
                        ['doc_search', '참고 문서 찾기', '연결한 문서에서 근거를 찾아 출처와 함께 답합니다'],
                        ['image', '사진 읽기', '캡처·사진·도표를 첨부받아 읽습니다'],
                      ] as const
                    ).map(([key, text, hint]) => (
                      <label key={key} className="flex items-start gap-2.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={value[key]}
                          onChange={(e) => patch({ [key]: e.target.checked } as Partial<AgentSettingsValue>)}
                          className="mt-0.5 w-4 h-4 rounded border-slate-300 text-[#003087]"
                        />
                        <span>
                          <span className="block text-xs font-medium text-slate-800">{text}</span>
                          <span className="block text-[11px] text-slate-400">{hint}</span>
                        </span>
                      </label>
                    ))}
                    {choices.length > 0 && (
                      <div className="pt-2 border-t border-slate-100">
                        <p className="text-xs font-medium text-slate-800 mb-1">공공데이터 조회</p>
                        {choices.map((c) => (
                          <label key={c.id} className="flex items-center gap-2.5 cursor-pointer py-0.5">
                            <input
                              type="checkbox"
                              checked={value.connectors.includes(c.id)}
                              onChange={(e) =>
                                patch({
                                  connectors: e.target.checked
                                    ? [...value.connectors, c.id]
                                    : value.connectors.filter((id) => id !== c.id),
                                })
                              }
                              className="w-4 h-4 rounded border-slate-300 text-[#003087]"
                            />
                            <span className="text-xs text-slate-700">{c.label}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className={label}>사용 방법 (선택)</label>
                    <textarea
                      rows={2}
                      maxLength={500}
                      value={value.usage_guide}
                      onChange={(e) => patch({ usage_guide: e.target.value })}
                      className={`${input} resize-none`}
                    />
                  </div>

                  <div>
                    <label className={label}>대화 시작 예시 (한 줄에 하나, 최대 6개)</label>
                    <textarea
                      rows={3}
                      value={value.starter_prompts}
                      onChange={(e) => patch({ starter_prompts: e.target.value })}
                      className={`${input} resize-none`}
                    />
                  </div>
                </>
              )}

              {error && <p className="text-xs text-red-500">{error}</p>}
              {notice && <p className="text-xs text-green-600">{notice}</p>}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={save}
                  disabled={saving || conflict}
                  className="px-4 py-2 bg-[#003087] hover:bg-[#002070] disabled:bg-slate-300 text-white text-sm font-semibold rounded-xl"
                >
                  {saving ? '저장 중...' : '저장'}
                </button>
                <button onClick={onClose} className="px-4 py-2 border border-slate-200 rounded-xl text-sm text-slate-600">
                  닫기
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 확인**

Run: `npx tsc --noEmit`
Expected: 오류 0건 (`Agent.tier`·`version`·`model_id`·`capabilities`는 S1-a에서 타입에 들어갔다)

- [ ] **Step 5: Commit**

```bash
git add src/components/agents
git commit -m "feat: 비서 편집 창 — 설정·양식·변경 기록

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 관리자 비서 관리

**Files:**
- Modify: `src/components/admin/AgentsManager.tsx`

**Interfaces:**
- Consumes: `AgentEditorModal` (Task 3), `TIER_LABELS`·`connectorIdsOf` (Task 1)

- [ ] **Step 1: 운영 칸을 따로 뺀다** — `CatalogFields` 안의 '비서 유형' 블록(`<div><label className={label}>비서 유형</label> ... </div>`), 링크형 주소 블록, '공개 범위' 블록을 새 컴포넌트 `OperationalFields`로 옮긴다. `CatalogFields`는 생성 폼에서 계속 쓰므로 그 자리에서 `<OperationalFields form={form} idPrefix={idPrefix} onChange={onChange} />`를 렌더한다.

```tsx
/** 운영 값 — 판 사본에 들어가지 않는다(설계 2.4). 수정은 판 없이 바로 저장된다. */
function OperationalFields({
  form,
  idPrefix,
  onChange,
}: {
  form: Pick<AgentFormData, 'agent_type' | 'link_url' | 'visibility'>;
  idPrefix: string;
  onChange: (patch: Partial<AgentFormData>) => void;
}) {
  const input =
    'w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400';
  const label = 'block text-xs font-medium text-slate-500 mb-1';
  return (
    <>
      {/* 여기에 CatalogFields에서 옮긴 '비서 유형' 블록을 그대로 둔다 */}
      {/* form.agent_type === 'link' ? '연결할 주소' 블록 : '공개 범위' 블록 — 옮긴 JSX 그대로 */}
    </>
  );
}
```
옮긴 JSX는 한 글자도 바꾸지 않는다. 위 주석 두 줄을 옮긴 JSX로 채운다. `CatalogFields`의 남은 부분은 `form.agent_type === 'chat'`일 때 사용 방법·시작 예시·외부 도구 블록을 그린다.

- [ ] **Step 2: 수정 폼은 운영 값만** — `{editingAgent?.id === agent.id ? ( <div className="p-5"> <form onSubmit={handleUpdateAgent} ...> ... </form> </div> ) : (` 안의 `<form>` 본문을 다음으로 바꾼다:

```tsx
                    <form onSubmit={handleUpdateAgent} className="space-y-3">
                      <p className="text-xs text-slate-500">
                        유형·연결 주소·공개 범위를 바꿉니다. 이름·지시문·모델·능력은 [설정]에서 바꾸고, 바꿀 때마다 판이 남습니다.
                      </p>
                      <OperationalFields form={editFormData} idPrefix={agent.id}
                        onChange={patch => setEditFormData(p => ({ ...p, ...patch }))} />
                      <div className="flex gap-2">
                        <button type="submit" disabled={submitting}
                          className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-xl disabled:bg-slate-300">
                          {submitting ? '저장 중...' : '저장'}
                        </button>
                        <button type="button" onClick={() => setEditingAgent(null)}
                          className="px-4 py-2 border border-slate-200 rounded-xl text-sm text-slate-600">취소</button>
                      </div>
                    </form>
```

`handleUpdateAgent`의 요청 본문을 운영 값만으로 바꾼다:
```typescript
        body: JSON.stringify({
          agent_type: editFormData.agent_type,
          link_url: editFormData.agent_type === 'link' ? editFormData.link_url.trim() : null,
          visibility: editFormData.visibility,
        }),
```
(S1-a에서 넣은 `base_version`과 409 처리는 이 요청에서 지운다 — 운영 값은 판이 없다.)

- [ ] **Step 3: 설정 창 연결 · 단계 표시 · 거르기**

상태 추가(다른 `useState` 옆):
```typescript
  const [settingsAgentId, setSettingsAgentId] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<'all' | 'official' | 'department'>('all');
```

`toFormData`의 `enabled_connectors: agent.enabled_connectors ?? [],`를 `enabled_connectors: connectorIdsOf(agent.capabilities),`로 바꾼다. import에 `import AgentEditorModal from '@/components/agents/AgentEditorModal';`와 `import { TIER_LABELS, connectorIdsOf } from '@/lib/agent-form';`를 더한다.

공식 비서 목록 `{agents.map(agent => (`를 `{agents.filter(a => tierFilter === 'all' || a.tier === tierFilter).map(agent => (`로 바꾸고, 그 목록 바로 위(`<div className="space-y-2">` 앞)에 거르기 단추를 둔다:
```tsx
          <div className="flex gap-2 mb-3">
            {([['all', '전체'], ['official', '공식 비서'], ['department', '부서 비서']] as const).map(([key, text]) => (
              <button key={key} onClick={() => setTierFilter(key)}
                className={`px-3 py-1 text-xs rounded-full border ${tierFilter === key ? 'bg-[#003087] text-white border-[#003087]' : 'border-slate-200 text-slate-500'}`}>
                {text}
              </button>
            ))}
          </div>
```

비서 이름 옆 뱃지들(`{agent.category && (` 앞)에 단계 뱃지를 더한다:
```tsx
                        {agent.tier === 'department' && (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-emerald-50 text-emerald-700">
                            {TIER_LABELS.department}
                          </span>
                        )}
```

행 단추 묶음을 다음 규칙으로 바꾼다 — 부서 비서는 운영 값이 없어 노출·운영 단추를 숨긴다:
```tsx
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {agent.tier === 'official' && (
                        /* 기존 노출 스위치 버튼 그대로 */
                      )}
                      {/* 기존 활성/비활성 버튼 — 공식 비서만 */}
                      <button onClick={() => setSettingsAgentId(agent.id)}
                        className="px-3 py-1 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600">설정</button>
                      {agent.tier === 'official' && (
                        <button onClick={() => { setEditingAgent(agent); setEditFormData(toFormData(agent)); }}
                          className="px-3 py-1 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600">운영</button>
                      )}
                      {/* 기존 삭제 버튼 그대로 */}
                    </div>
```
(주석 자리는 지금 파일의 그 버튼 JSX를 그대로 옮긴다. 노출·활성 버튼은 `agent.tier === 'official' && (...)`로 감싼다.)

컴포넌트 반환 JSX 끝(승인 모달 뒤)에 설정 창을 둔다:
```tsx
      {settingsAgentId && (
        <AgentEditorModal
          agentId={settingsAgentId}
          categories={categories.map(c => c.name)}
          onClose={() => setSettingsAgentId(null)}
          onSaved={updated => setAgents(prev => prev.map(a => (a.id === updated.id ? updated : a)))}
        />
      )}
```

- [ ] **Step 4: 신청 목록에 신청자와 단계** — `AgentWithOwner`에 `requester?: { id: string; email: string; full_name?: string | null } | null;`를 더한다. `ApprovalCard`의 신청자 줄을 다음으로 바꾼다:
```tsx
              <span>
                {TIER_LABELS[agent.tier]} · 신청자:{' '}
                <span className="text-slate-600 font-medium">
                  {agent.requester?.full_name || agent.requester?.email || agent.owner?.full_name || agent.owner?.email || '알 수 없음'}
                </span>
              </span>
```

- [ ] **Step 5: 확인**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 오류 0건, 전부 PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/admin/AgentsManager.tsx
git commit -m "feat: 관리자 비서 관리 — 설정 창·운영 값 분리·단계 표시

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 직원 화면

**Files:**
- Modify: `src/components/chat/AgentSelector.tsx`, `AgentCard.tsx`, `CreateAgentModal.tsx`, `ChatInterface.tsx`
- Modify: `src/app/api/conversations/[id]/route.ts`

**Interfaces:**
- Consumes: `AgentEditorModal`, `TIER_LABELS`·`connectorIdsOf`, `POST /api/agents/[id]/promote`, `POST /api/agents/personal` (`tier`·`model_id`)

- [ ] **Step 1: 부서 비서 탭** — `AgentSelector.tsx`의 `TABS`에서 `{ key: 'personal', label: '내 비서' },` 앞에 `{ key: 'dept', label: '부서 비서' },`를 더한다. `fetchAgents`의 주소 고르기에 `else if (tab === 'dept') url = '/api/agents?department=true';`를 `personal` 줄 앞에 더한다.

편집 창을 연결한다. 상태 `const [editingId, setEditingId] = useState<string | null>(null);`와 `const { data: session } = useSession();`(import `useSession` from `next-auth/react`), import `AgentEditorModal`을 더한다. `AgentCard`에 넘기는 속성에 다음을 더한다:
```tsx
                myDepartmentId={session?.user?.departmentId ?? null}
                onEdit={(a) => setEditingId(a.id)}
                onPromoted={() => fetchAgents(activeTab)}
```
반환 JSX 끝에:
```tsx
      {editingId && (
        <AgentEditorModal agentId={editingId} onClose={() => setEditingId(null)} onSaved={() => fetchAgents(activeTab)} />
      )}
```

- [ ] **Step 2: 카드의 단계별 동작** — `AgentCard.tsx`:
- `AgentCardProps`에 `myDepartmentId?: string | null; onEdit?: (agent: Agent) => void; onPromoted?: () => void;`를 더하고 구조 분해에 넣는다.
- `{agent.is_personal && (`를 `{agent.tier !== 'official' && (`로, `{!agent.is_personal && (`를 `{agent.tier === 'official' && (`로 바꾼다. 공식 등록 신청은 나만의·부서 비서 모두 할 수 있다(S1-a).
- 이름 옆(`{agent.agent_type === 'link' && (` 앞)에 부서 뱃지:
```tsx
            {agent.tier === 'department' && (
              <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-emerald-50 text-emerald-700">부서</span>
            )}
```
- 승인 상태 영역의 `<div onClick={e => e.stopPropagation()}>` 바로 안쪽 맨 위에 동작 단추를 둔다. 고칠 수 있어 보이는지는 표시일 뿐이고 서버가 다시 판정한다:
```tsx
            <div className="flex gap-1.5 mt-1">
              {(agent.tier === 'personal' || agent.department_id === myDepartmentId) && onEdit && (
                <button onClick={() => onEdit(agent)}
                  className="flex-1 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
                  편집
                </button>
              )}
              {agent.tier === 'personal' && (
                <button
                  onClick={async () => {
                    if (!confirm('부서 비서로 올리면 부서원 누구나 함께 고치고 씁니다. 다시 나만의 비서로 되돌릴 수 없습니다. 올릴까요?')) return;
                    const res = await fetch(`/api/agents/${agent.id}/promote`, { method: 'POST' });
                    const r = await res.json();
                    if (!r.ok) alert(r.error?.message ?? '부서 비서로 올리지 못했습니다.');
                    else onPromoted?.();
                  }}
                  className="flex-1 py-1.5 text-xs font-semibold text-emerald-700 border border-emerald-200 rounded-lg hover:bg-emerald-50">
                  부서 비서로
                </button>
              )}
            </div>
```
- `RequestApprovalModal`의 안내 문장 `승인 시 부서 전체가 사용할 수 있는 공식 비서로 전환됩니다.`를 `승인되면 공식 비서가 되어 관리자가 관리합니다. 공개 범위는 관리자가 정합니다.`로 바꾼다.

- [ ] **Step 3: 만들기 창에 단계·모델** — `CreateAgentModal.tsx`:
- 상태 추가: `const [tier, setTier] = useState<'personal' | 'department'>('personal');`, `const [models, setModels] = useState<{ id: string; label: string }[]>([]);`, `const [modelId, setModelId] = useState('');`
- 기존 `/api/connectors`를 부르는 `useEffect` 안에 `fetch('/api/models').then(r => r.json()).then(r => { if (r.ok) setModels(r.data ?? []); }).catch(() => {});`를 더한다.
- 생성 요청 본문에 `tier,`와 `model_id: modelId || null,`를 더한다.
- '아이콘' 블록(`<label className="block text-sm font-medium text-slate-700 mb-2">아이콘</label>`이 든 div) 바로 앞에:
```tsx
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">어디에 만들까요</label>
              <div className="flex gap-2">
                {([
                  ['personal', '나만의 비서', '나만 씁니다'],
                  ['department', '부서 비서', '우리 부서와 하위 부서가 함께 쓰고, 부서원 누구나 고칩니다'],
                ] as const).map(([key, text, hint]) => (
                  <button key={key} type="button" onClick={() => setTier(key)}
                    className={`flex-1 px-3 py-2 rounded-xl border text-left ${tier === key ? 'border-[#003087] bg-blue-50 text-[#003087]' : 'border-slate-200 text-slate-500'}`}>
                    <span className="block text-xs font-semibold">{text}</span>
                    <span className="block text-[11px] opacity-70">{hint}</span>
                  </button>
                ))}
              </div>
            </div>
```
- '카테고리' 블록 다음에:
```tsx
            {models.length > 1 && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">모델</label>
                <select value={modelId} onChange={e => setModelId(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white">
                  <option value="">기관 기본 모델</option>
                  {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </div>
            )}
```

- [ ] **Step 4: 남은 옛 칸 읽기**
- `ChatInterface.tsx`의 `const connectorNames = (selectedAgent.enabled_connectors ?? []).map(connectorShortLabel);`를 `const connectorNames = connectorIdsOf(selectedAgent.capabilities).map(connectorShortLabel);`로 바꾸고 `import { connectorIdsOf } from '@/lib/agent-form';`를 더한다.
- `src/app/api/conversations/[id]/route.ts`의 `agent:agents(id, name, description, icon, color, system_prompt, is_personal, category)`에서 `is_personal`을 `tier`로 바꾼다.

- [ ] **Step 5: 확인**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 오류 0건, 전부 PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/chat src/app/api/conversations
git commit -m "feat: 직원 화면 — 부서 비서 탭·편집·부서로 올리기·단계 선택

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 옛 보고서 템플릿 읽기 전용

**Files:**
- Modify: `src/components/admin/PromptTemplateManager.tsx` (전체 교체)
- Modify: `src/app/api/templates/route.ts` (POST 제거), `src/app/api/templates/[id]/route.ts` (파일 제거)
- Modify: `src/components/admin/AdminNav.tsx`, `src/app/admin/page.tsx` (메뉴 이름)

- [ ] **Step 1: 쓰기 경로 제거** — `src/app/api/templates/route.ts`에서 `export async function POST` 핸들러 전체를 지운다. `src/app/api/templates/[id]/route.ts`는 PATCH·DELETE뿐이므로 파일을 지운다:
```bash
git rm -q "src/app/api/templates/[id]/route.ts"
```

- [ ] **Step 2: 화면 전체 교체**

```tsx
// src/components/admin/PromptTemplateManager.tsx
'use client';

import { useEffect, useState } from 'react';

type Template = { id: string; name: string; description: string | null; content: string; created_at: string };

/**
 * 옛 보고서 템플릿 — 읽기 전용(S1-c).
 *
 * 보고서 생성 화면은 S1-b에서 걷어냈다. 그 일은 비서의 지시문과 S2의
 * '양식 채우기'가 맡는다. 관리자가 써 둔 템플릿 내용을 잃지 않도록 보여 주고,
 * 비서 지시문으로 옮길 수 있게 복사 단추를 둔다.
 */
export default function PromptTemplateManager() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/templates')
      .then((r) => r.json())
      .then((r) => (r.ok ? setTemplates(r.data ?? []) : setError(r.error?.message ?? '불러오지 못했습니다.')))
      .catch(() => setError('불러오지 못했습니다.'));
  }, []);

  const copy = async (t: Template) => {
    await navigator.clipboard.writeText(t.content);
    setCopiedId(t.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  return (
    <div className="space-y-4">
      <div className="p-4 rounded-xl bg-blue-50 border border-blue-100 text-sm text-slate-700">
        보고서 생성 기능은 비서로 옮겨졌습니다. 아래 내용을 복사해 비서 관리 → [설정] → 지시문에 붙여 넣으세요.
        기관 서식은 [설정] → 양식 탭에 올립니다.
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {templates.map((t) => (
        <div key={t.id} className="bg-white border border-slate-100 rounded-xl p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900">{t.name}</p>
              {t.description && <p className="text-xs text-slate-500 mt-0.5">{t.description}</p>}
            </div>
            <button
              onClick={() => copy(t)}
              className="px-3 py-1 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600 flex-shrink-0"
            >
              {copiedId === t.id ? '복사됨' : '내용 복사'}
            </button>
          </div>
          <pre className="mt-3 p-3 bg-slate-50 rounded-lg text-xs text-slate-600 whitespace-pre-wrap font-sans border border-slate-100 max-h-48 overflow-y-auto">
            {t.content}
          </pre>
        </div>
      ))}

      {templates.length === 0 && !error && (
        <p className="text-center py-10 text-sm text-slate-400">남아 있는 템플릿이 없습니다.</p>
      )}
    </div>
  );
}
```

`/api/templates` GET이 돌려주는 칸에 `content`·`description`이 없으면 그 select에 더한다.

- [ ] **Step 3: 메뉴 이름** — `AdminNav.tsx`의 `/admin/templates` 항목 이름과 `src/app/admin/page.tsx`의 `/admin/templates` 카드 제목을 `옛 보고서 템플릿`으로 바꾼다.

- [ ] **Step 4: 확인**

Run: `npx tsc --noEmit && npx vitest run tests/route-auth.test.ts`
Expected: 오류 0건, PASS

- [ ] **Step 5: Commit**

```bash
git add -A src/components/admin/PromptTemplateManager.tsx src/app/api/templates src/components/admin/AdminNav.tsx src/app/admin/page.tsx
git commit -m "refactor: 옛 보고서 템플릿을 읽기 전용으로

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 옛 칸 걷어내기 (0027)

**Files:**
- Create: `supabase/migrations/0027_agent_tiers_cleanup.sql`
- Create: `tests/legacy-columns.test.ts`
- Modify: `src/lib/db.ts`, `scripts/db-check.mjs`, 그리고 원본 검사가 짚는 모든 파일

- [ ] **Step 1: 실패하는 원본 검사 작성**

```typescript
// tests/legacy-columns.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

/**
 * 0027이 지우는 칸을 코드가 읽거나 쓰지 않는다.
 * 남아 있으면 조회가 실패하거나, 화면이 오류 없이 빈 값을 보인다.
 */
const LEGACY = /\bis_personal\b|\benabled_connectors\b/;

describe('옛 칸', () => {
  it('src와 scripts 어디에도 없다', () => {
    const files = execSync('find src scripts -name "*.ts" -o -name "*.tsx" -o -name "*.mjs"', { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
    const offenders = files.filter((f) => LEGACY.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/legacy-columns.test.ts`
Expected: FAIL — 남은 파일 목록이 나온다 (예: `src/lib/db.ts`, `scripts/db-check.mjs`, `src/components/admin/AgentsManager.tsx`)

- [ ] **Step 3: 남은 참조를 고친다** — 목록의 파일마다:
  - `src/lib/db.ts`: `Agent` 타입에서 `is_personal: boolean;` 줄과 `enabled_connectors?: string[];` 줄(과 그 주석)을 지운다
  - `src/components/admin/AgentsManager.tsx`: 폼의 상태 이름 `enabled_connectors`를 `connectors`로 바꾼다(`AgentFormData`·`EMPTY_FORM`·`toFormData`·`toRequestBody`·`CatalogFields`의 체크박스). `toRequestBody`의 `form.enabled_connectors`도 `form.connectors`로
  - `scripts/db-check.mjs`: `['0013', 'agents.enabled_connectors', ...]` 줄을 지우고, 비서 카탈로그 블록의 `is_personal`을 `tier`로(`select`의 `is_personal` → `tier`, `!a.is_personal` → `a.tier !== 'personal'`), '비서 단계와 판' 블록의 `mismatch` 항목과 `is_personal` select를 지운다
  - 그 밖에 짚인 파일은 `is_personal` → `tier === 'personal'`, `enabled_connectors` → `capabilities.public_data.connectors`(`connectorIdsOf`)로 바꾼다

- [ ] **Step 4: 마이그레이션 작성**

```sql
-- =============================================================
-- 0027_agent_tiers_cleanup.sql
-- 옛 칸 제거 (S1-c)
--
-- **S1-c 코드가 배포되고 확인된 뒤에만 적용한다.** 옛 코드가 돌고 있는데
-- 적용하면 그 코드가 지워진 칸을 찾다 비서 조회가 멈춘다(0013의 교훈).
-- =============================================================

DROP TRIGGER IF EXISTS trg_agents_sync_legacy ON agents;
DROP FUNCTION IF EXISTS agents_sync_legacy_columns();
DROP FUNCTION IF EXISTS agent_capability_connectors(jsonb);

-- 0005의 owner 인덱스는 남는다. is_personal을 쓰던 인덱스는 없다.
ALTER TABLE agents
  DROP COLUMN IF EXISTS is_personal,
  DROP COLUMN IF EXISTS enabled_connectors;

-- ── 확인 ─────────────────────────────────────────────────────
SELECT column_name
  FROM information_schema.columns
 WHERE table_name = 'agents' AND column_name IN ('is_personal', 'enabled_connectors');
-- 0행이어야 한다
```

- [ ] **Step 5: 확인**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: 전부 PASS(`legacy-columns` 포함), tsc 오류 0건, 빌드 성공

- [ ] **Step 6: Commit**

```bash
git add -A src scripts supabase/migrations/0027_agent_tiers_cleanup.sql tests/legacy-columns.test.ts
git commit -m "refactor: 옛 칸(is_personal·enabled_connectors) 참조 제거와 0027

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 실측 · 배포 · 완료 확인

**Files:**
- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-10-14-workon-service-definition-design.md` (S1 완료 표시)

- [ ] **Step 1: 코드 배포 요청** — 사용자에게 푸시·배포를 요청한다. **0027은 아직 적용하지 않는다.**

- [ ] **Step 2: 화면 실측 (preview, 휴대폰 폭 포함)** — 사용자가 직원 계정 두 개(같은 부서)와 관리자 계정으로 로그인한다. `resize_window` mobile 프리셋으로 편집 창을 한 번 더 본다.

설계 6.6의 완료 기준을 하나씩 확인한다:
  1. **기존 비서가 똑같이 답한다** — 문서가 연결된 공식 비서(출처 표시), 법령 커넥터 비서(링크 출처), 사진 첨부
  2. **부서원 둘이 함께 고치고, 충돌 안내를 보고, 되돌린다**
     - 직원 A: 만들기 → '부서 비서' → 저장 → 부서 비서 탭에 보임
     - 직원 B(같은 부서): 부서 비서 탭에 보임, [편집] 가능
     - A와 B가 편집 창을 함께 열고 A 저장 → B 저장 → B에게 충돌 안내
     - 변경 기록 탭에서 판 1로 되돌리기 → 새 판이 생기고 내용이 판 1과 같다
     - 하위 부서 직원 C: 부서 비서가 보이지만 [편집]을 누르면 서버가 거절한다
  3. **나만의 → 부서 → 공식 신청·승인**
     - 직원 A: 나만의 비서 → [부서 비서로] → 부서 비서 탭으로 옮겨감
     - [공식 등록 신청] → 관리자 승인 대기 탭에 단계·신청자가 보임
     - 신청 뒤 직원 B가 지시문을 고침 → 관리자 승인 시 "신청 뒤 내용이 바뀌었습니다"
     - 다시 신청 → 승인 → 공식 비서 목록에 노출 대기로 나타남
  4. **양식** — 설정 → 양식 탭에서 HWPX 하나 올림 → 판이 오름 → 빼기 → 이전 판으로 되돌리면 다시 보임
  5. **관리자** — 과 단위 관리자 계정으로 기관 전체 공식 비서의 [설정] 저장 → 거절(관리 범위 규칙)

- [ ] **Step 3: DB 실측**

```bash
npm run db:check
npm run isolation:check
npm run db:test-agents
```
Expected: 모두 통과. `부서 비서 기관 일치` OK.

- [ ] **Step 4: 0027 적용 요청** — 위가 모두 통과한 뒤 사용자가 실행한다.

```bash
npm run db:migrate -- 0027
```
Expected: 확인 쿼리 0행. 이어서 `npm run db:check`가 통과하고 화면 실측 1번을 한 번 더 한다.

- [ ] **Step 5: 문서 갱신**
  - `CLAUDE.md` 마이그레이션 표에 `| 0027 | 옛 칸(is_personal·enabled_connectors)과 맞춤 트리거 제거 |`, '비서 단계와 판' 절의 0027 관련 문장을 "0027에서 제거됐다"로 바꾼다. '비서 카탈로그' 절에 "편집 화면은 `AgentEditorModal` 하나다. 판 설정은 여기서만 바꾸고, 운영 값은 관리 화면의 [운영]에서 바꾼다"를 더한다
  - 서비스 정의서 9절 S1 행 끝에 `✅ 2026-10 완료`를 더한다

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-10-14-workon-service-definition-design.md
git commit -m "docs: S1 완료 — 화면·0027 반영

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
