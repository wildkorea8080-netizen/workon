import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 0261 — 0259·0260에 이어 남은 화면 전체(문서·CSV 등록·금지어·보안 로그·답변 평가·기본 세트·검색 시험·통계·
// 비서 카드·비서 만들기·답변 평가 단추·근거로 고쳐 쓰기·앱 실행·앱 빌더·공통 자료실 등)의 오류 글도 actionErrorText로.
// `err instanceof Error ? err.message : …`는 서버가 안내 글 없이 실패하면 빈 글을 골라 아무것도 안 보였고,
// 응답 몸이 JSON이 아니면 영어 구문 오류 글('Unexpected token…'), 연결이 끊기면 'Failed to fetch'가 보였다.
// 화면 파일(.tsx)에 그 꼴이 다시 들어오면 이 시험이 막는다.

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

describe('화면의 오류 글', () => {
  it("화면 파일에 'x instanceof Error ? x.message' 꼴이 없다", () => {
    const offenders = [...tsxFiles('src/components'), ...tsxFiles('src/app')].filter((f) =>
      /(\w+) instanceof Error \? \1\.message/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('고친 화면은 ok-json에서 actionErrorText를 가져온다', () => {
    for (const f of [
      'src/components/admin/DocumentsManager.tsx',
      'src/components/admin/SettingsManager.tsx',
      'src/components/chat/AgentCard.tsx',
      'src/app/super/common-library/page.tsx',
      'src/app/apps/run/page.tsx',
    ]) {
      expect(readFileSync(f, 'utf8'), f).toMatch(/import \{[^}]*actionErrorText[^}]*\} from '@\/lib\/ok-json';/);
    }
  });
});
