import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * 결과를 버리는 DB 쓰기 찾기(2026-11-17).
 *
 * Supabase는 실패를 던지지 않고 `{ error }`로 돌려준다. `await supabaseAdmin.from('t').update(…)`처럼 **문장으로 기다리고 결과를 버리면**
 * 실패가 조용히 사라진다(표가 없던 동안 보안 로그가 모두 버려진 0097, 로그인 실패 기록이 안 남아 잠금이 꺼질 수 있던 것).
 * 문장 머리가 `await supabaseAdmin`이고 그 문장 안에 `.from('표')…insert|update|upsert|delete(`가 있으면 잡는다.
 * 결과를 변수에 받거나(`const { error } = await …`) 식 안에 쓰면 잡지 않는다.
 */

export interface DiscardedWrite { file: string; line: number; table: string; op: string }

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
}

export function findDiscardedWrites(root = 'src'): DiscardedWrite[] {
  const files: string[] = [];
  walk(root, files);
  const found: DiscardedWrite[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*await supabaseAdmin\b/.test(lines[i])) continue;
      let stmt = '';
      for (let j = i; j < Math.min(i + 12, lines.length); j++) {
        stmt += `${lines[j]}\n`;
        if (/;\s*(\/\/.*)?$/.test(lines[j])) break;
      }
      const m = stmt.match(/\.from\('([a-z_]+)'\)[\s\S]*?\.(insert|update|upsert|delete)\(/);
      if (m) found.push({ file: file.split('\\').join('/'), line: i + 1, table: m[1], op: m[2] });
    }
  }
  return found;
}
