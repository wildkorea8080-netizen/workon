import { describe, it, expect } from 'vitest';

/**
 * 배치 삽입 시 컬럼 합집합 문제.
 *
 * PostgREST는 여러 행을 한 번에 넣을 때 모든 행의 컬럼을 합집합으로 맞추고,
 * 그 컬럼이 없는 행에는 **명시적 NULL**을 넣는다. 컬럼에 기본값이 있어도
 * 우회되므로 NOT NULL 컬럼이면 배치 전체가 실패한다.
 *
 * 실제로 이것 때문에 대화 메시지가 한 건도 저장되지 않았다. 답변은 이미
 * 스트리밍된 뒤라 사용자는 정상으로 보고, 새로고침하면 내용이 사라졌다.
 *
 * DB를 띄우지 않고 규칙만 고정한다 — 같은 실수를 코드 리뷰에서 잡을 수 있게.
 */

/** 배치로 넣을 행들이 같은 키 집합을 갖는지 */
function hasUniformKeys(rows: Record<string, unknown>[]): boolean {
  if (rows.length <= 1) return true;
  const keys = rows.map((row) => Object.keys(row).sort().join(','));
  return keys.every((k) => k === keys[0]);
}

describe('배치 삽입 — 행마다 키가 같아야 한다', () => {
  it('키가 어긋나면 잡아낸다', () => {
    // 실제로 실패했던 형태: 사용자 행에만 source_references가 없었다
    const rows = [
      { conversation_id: 'c1', role: 'user', content: '질문' },
      { conversation_id: 'c1', role: 'assistant', content: '답변', source_references: {} },
    ];
    expect(hasUniformKeys(rows)).toBe(false);
  });

  it('모든 행에 넣으면 통과한다', () => {
    const rows = [
      { conversation_id: 'c1', role: 'user', content: '질문', source_references: {} },
      { conversation_id: 'c1', role: 'assistant', content: '답변', source_references: {} },
    ];
    expect(hasUniformKeys(rows)).toBe(true);
  });

  it('한 행짜리 삽입은 기본값이 정상 적용되므로 문제없다', () => {
    expect(hasUniformKeys([{ a: 1 }])).toBe(true);
  });
});

describe('/api/chat의 메시지 삽입', () => {
  it('두 행이 같은 키를 갖는다', async () => {
    // 소스를 읽어 형태를 확인한다. DB 없이 회귀를 막는 가장 싼 방법이다.
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/app/api/chat/route.ts', 'utf8');

    const start = src.indexOf(".from('messages').insert([");
    expect(start, 'messages insert를 찾지 못했다').toBeGreaterThan(-1);

    const block = src.slice(start, src.indexOf(']);', start));
    const userRow = block.slice(0, block.indexOf("role: 'assistant'"));

    // 사용자 행에도 source_references가 있어야 한다
    expect(userRow).toContain('source_references');
  });

  it('저장 실패를 사용자에게 알린다', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/app/api/chat/route.ts', 'utf8');

    const start = src.indexOf('if (msgError)');
    expect(start).toBeGreaterThan(-1);

    // console.error만 찍고 넘어가면 사용자는 대화가 사라진 이유를 알 수 없다
    const block = src.slice(start, start + 500);
    expect(block).toContain("send('error'");
  });
});
