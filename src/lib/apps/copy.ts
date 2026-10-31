import type { Agent } from '@/lib/db';
import { validateAppDefinition, type AppDefinition } from './definition';

export type AppCopyDraft = { name: string; description: string; category: string; instructions: string; definition: AppDefinition };

/** Receives an app from the current user's visible list. Copy settings by allowlist only. */
export function appCopyDraft(source: Agent): AppCopyDraft {
  if (!source.is_active || source.deleted_at || source.agent_type === 'link') throw new Error('현재 사용할 수 없는 앱입니다.');
  const definition = validateAppDefinition(source.app_definition ?? null);
  if (!definition.ok || !definition.value) throw new Error('입력형 앱만 복사할 수 있습니다.');
  const instructions = source.system_prompt?.trim() ?? '';
  if (!instructions || instructions.length > 12000) throw new Error('이 앱의 업무 지시문은 복사 편집을 지원하지 않습니다.');
  return {
    name: `${source.name.trim().slice(0, 74)} (복사)`,
    description: (source.description ?? '').slice(0, 500),
    category: (source.category || '문서 작성·정리').slice(0, 40),
    instructions,
    definition: definition.value,
  };
}
