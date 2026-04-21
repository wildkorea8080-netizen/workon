// 금지어 관리 헬퍼 함수들
// 부서별 금지어 필터링 및 관리 기능

import { supabase } from '@/lib/supabase';
import type { ForbiddenWord } from '@/lib/db';

/**
 * 부서의 금지어 목록을 조회합니다.
 */
export async function getForbiddenWords(departmentId: string): Promise<ForbiddenWord[]> {
  const { data, error } = await supabase
    .from('forbidden_words')
    .select('*')
    .eq('department_id', departmentId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error('금지어 목록 조회 중 오류가 발생했습니다.');
  }

  return data || [];
}

/**
 * 새로운 금지어를 추가합니다.
 */
export async function addForbiddenWord(
  departmentId: string,
  word: string,
  context?: string
): Promise<ForbiddenWord> {
  // 중복 체크
  const { data: existing } = await supabase
    .from('forbidden_words')
    .select('id')
    .eq('department_id', departmentId)
    .eq('word', word.trim())
    .single();

  if (existing) {
    throw new Error('이미 등록된 금지어입니다.');
  }

  const { data, error } = await supabase
    .from('forbidden_words')
    .insert({
      department_id: departmentId,
      word: word.trim(),
      context: context?.trim() || null,
    })
    .select()
    .single();

  if (error) {
    throw new Error('금지어 추가 중 오류가 발생했습니다.');
  }

  return data;
}

/**
 * 금지어의 활성화 상태를 토글합니다.
 */
export async function toggleForbiddenWord(
  wordId: string,
  departmentId: string,
  isActive: boolean
): Promise<ForbiddenWord> {
  const { data, error } = await supabase
    .from('forbidden_words')
    .update({
      is_active: isActive,
      updated_at: new Date().toISOString(),
    })
    .eq('id', wordId)
    .eq('department_id', departmentId)
    .select()
    .single();

  if (error) {
    throw new Error('금지어 상태 변경 중 오류가 발생했습니다.');
  }

  return data;
}

/**
 * 금지어를 삭제합니다.
 */
export async function deleteForbiddenWord(wordId: string, departmentId: string): Promise<void> {
  const { error } = await supabase
    .from('forbidden_words')
    .delete()
    .eq('id', wordId)
    .eq('department_id', departmentId);

  if (error) {
    throw new Error('금지어 삭제 중 오류가 발생했습니다.');
  }
}

/**
 * 텍스트에 금지어가 포함되어 있는지 확인합니다.
 */
export function containsForbiddenWords(text: string, forbiddenWords: ForbiddenWord[]): {
  hasForbiddenWords: boolean;
  foundWords: string[];
} {
  const activeWords = forbiddenWords.filter(fw => fw.is_active);
  const foundWords: string[] = [];

  for (const fw of activeWords) {
    const regex = new RegExp(`\\b${fw.word}\\b`, 'gi');
    if (regex.test(text)) {
      foundWords.push(fw.word);
    }
  }

  return {
    hasForbiddenWords: foundWords.length > 0,
    foundWords,
  };
}

/**
 * 금지어 통계 정보를 조회합니다.
 */
export async function getForbiddenWordsStats(departmentId: string): Promise<{
  total: number;
  active: number;
  inactive: number;
}> {
  const words = await getForbiddenWords(departmentId);

  return {
    total: words.length,
    active: words.filter(w => w.is_active).length,
    inactive: words.filter(w => !w.is_active).length,
  };
}