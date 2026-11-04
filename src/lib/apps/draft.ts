// src/lib/apps/draft.ts
// 입력형 앱의 시험 판(0053) — 순수 규칙. 화면(빌더·실행)·라우트·대화 실행기가 함께 쓴다(아무 서버 모듈도 가져오지 않는다).
//
// - 부서·공식 앱은 고친 설정을 먼저 시험 판으로 둔다. 지금 쓰는 판(부서 사람들의 실행·예약·연동)은 그대로다.
// - 고칠 수 있는 사람(canEditAgent)만 시험 판을 보고 실행한다. 배포하면 save_agent로 판을 올리고 시험 판을 비운다.
// - 나만의 앱은 쓰는 사람이 본인뿐이라 지금처럼 바로 저장한다(시험 판을 둘 수는 있다).

import { validateAppDefinition, type AppDefinition } from './definition';

/** 시험 판에 담는 설정 — 빌더가 고치는 것만. 모델·양식·운영 값은 시험 판에 넣지 않는다(지금 판 그대로) */
export const APP_DRAFT_KEYS = ['name', 'description', 'category', 'system_prompt', 'app_definition', 'capabilities'] as const;
export type AppDraftKey = (typeof APP_DRAFT_KEYS)[number];

export interface AppDraftSettings {
  name: string;
  description: string | null;
  category: string | null;
  system_prompt: string | null;
  app_definition: AppDefinition;
  capabilities: Record<string, unknown>;
}

export interface AppDraft {
  settings: AppDraftSettings;
  /** 시험 판을 만든 기준 판 — 배포는 지금 판이 이 번호일 때만(그 사이 누가 배포했으면 409) */
  base_version: number;
  saved_by: string | null;
  /** 저장 시각(ISO) — 같은 시험 판인지 가리는 표. 덮어쓰기·실행·배포가 이 값으로 맞춰 본다 */
  saved_at: string;
}

const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const textOrNull = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** 저장된 칸을 믿지 않고 다시 읽는다 — 꼴이 틀리거나 입력 설정이 지금 규칙에 맞지 않으면 null(없는 것으로 친다) */
export function readAppDraft(raw: unknown): AppDraft | null {
  if (!object(raw) || !object(raw.settings) || typeof raw.base_version !== 'number' || !Number.isSafeInteger(raw.base_version) || typeof raw.saved_at !== 'string' || !Number.isFinite(Date.parse(raw.saved_at))) return null;
  const s = raw.settings;
  if (typeof s.name !== 'string' || !s.name.trim()) return null;
  const definition = validateAppDefinition(s.app_definition ?? null);
  if (!definition.ok || !definition.value) return null;
  return {
    settings: {
      name: s.name.trim(),
      description: textOrNull(s.description),
      category: textOrNull(s.category),
      system_prompt: textOrNull(s.system_prompt),
      app_definition: definition.value,
      capabilities: object(s.capabilities) ? s.capabilities : {},
    },
    base_version: raw.base_version,
    saved_by: typeof raw.saved_by === 'string' ? raw.saved_by : null,
    saved_at: raw.saved_at,
  };
}

/** 이 앱은 저장하면 시험 판으로 가는가 — 부서·공식 앱. 나만의 앱은 바로 저장 */
export function savesAsDraft(tier: string | null | undefined): boolean {
  return tier === 'department' || tier === 'official';
}

/** 시험 실행 때 실행기가 쓸 설정 — 지금 판의 행 위에 시험 판 값을 덮는다(판 번호·권한 칸은 그대로) */
export function withDraftSettings<T extends object>(row: T, draft: AppDraft): T {
  const s = draft.settings;
  return { ...row, name: s.name, system_prompt: s.system_prompt, app_definition: s.app_definition, capabilities: s.capabilities };
}

/** 배포할 때 save_agent에 넘길 값 — 시험 판 설정 중 지금 판과 다른 것만 고르는 일은 라우트(changedSettingKeys)가 한다 */
export function draftPatch(draft: AppDraft): Record<AppDraftKey, unknown> {
  const s = draft.settings;
  return { name: s.name, description: s.description, category: s.category, system_prompt: s.system_prompt, app_definition: s.app_definition, capabilities: s.capabilities };
}

/** 목록·실행 화면용으로 행에서 시험 판을 뗀다 — 고칠 수 없는 사람에게 배포 전 설정이 가지 않게 */
export function withoutAppDraft<T extends Record<string, unknown>>(row: T): Omit<T, 'app_draft'> {
  const { app_draft: _draft, ...rest } = row;
  return rest;
}
