import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 2026-11-19 — 쓰지 않던 `POST /api/conversations`(새 대화 만들기)를 지웠다.
 * 어느 화면도 부르지 않았고, 받은 `agent_id`를 그 직원이 쓸 수 있는지 보지 않았으며, `conversations.department_id`(NOT NULL)를
 * 넣지 않아 늘 실패했다. 칸이 비어도 되게 바뀌는 순간 다른 기관·동료의 나만의 비서로 대화를 만들어 목록에서 그 비서 이름을 읽는 길이 된다.
 * 새 대화는 대화 실행기(`prepareTurn`)가 권한(`canUseAgent`)을 본 뒤 부서와 함께 만든다.
 */

const src = readFileSync('src/app/api/conversations/route.ts', 'utf8');

describe('대화 목록 라우트', () => {
  it('GET만 남았다', () => {
    expect(src).toMatch(/export async function GET\(/);
    expect(src).not.toMatch(/export (async )?function (POST|PUT|PATCH|DELETE)\b/);
  });
  it('화면 코드가 이 주소로 대화를 만들지 않는다', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) { if (!p.includes(join('app', 'api'))) walk(p); } else if (/\.(tsx?|jsx?)$/.test(n)) files.push(p);
      }
    };
    walk('src');
    for (const f of files) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/fetch\(\s*['"`]\/api\/conversations['"`]\s*,\s*\{[^}]*method:\s*['"]POST/);
    }
  });
  it('새 대화는 대화 실행기가 부서와 함께 만든다', () => {
    const p = readFileSync('src/lib/assistant/prepare.ts', 'utf8');
    expect(p).toContain('department_id: actor.departmentId,');
  });
});
