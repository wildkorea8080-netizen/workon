import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

/**
 * 모델 호출은 AI 연결부(src/lib/llm/) 한 곳으로 모은다(설계 5.1).
 * 다른 곳에서 업체 주소를 직접 부르면 기관 내부 모델로 바꿀 때 그 자리가 남는다.
 */
const files = execSync('find src -name "*.ts" -o -name "*.tsx"', { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean);

/** 모델 호출이 아니라 키가 유효한지만 보는 곳. 이유와 함께 둔다. */
const ALLOWED = new Map<string, string>([
  ['src/app/api/super/api-keys/verify/route.ts', '슈퍼관리자가 등록한 API 키의 유효성 확인. 대화가 아니다'],
  ['src/app/api/super/organizations/[id]/verify-key/route.ts', '기관 API 키의 유효성 확인. 대화가 아니다'],
]);

describe('AI 연결부 경계', () => {
  it('Anthropic 주소는 llm/ 밖에서 쓰지 않는다', () => {
    const offenders = files.filter(
      (f) => !f.startsWith('src/lib/llm/') && !ALLOWED.has(f) && readFileSync(f, 'utf8').includes('api.anthropic.com')
    );
    expect(offenders).toEqual([]);
  });

  it('예외 목록은 이유가 있고 실제로 있는 파일이다', () => {
    for (const [file, reason] of ALLOWED) {
      expect(existsSync(file), file).toBe(true);
      expect(reason.length).toBeGreaterThan(5);
    }
  });

  it('옛 claude.ts는 없다', () => {
    expect(existsSync('src/lib/claude.ts')).toBe(false);
    expect(files.filter((f) => readFileSync(f, 'utf8').includes("from '@/lib/claude'"))).toEqual([]);
  });
});
