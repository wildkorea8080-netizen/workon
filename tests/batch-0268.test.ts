import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 0268(큰 묶음) — 서버 전체를 훑어 오류를 받지 않는 DB 읽기를 찾은 것 중 실제 문제였던 넷.
// ① src/lib/forbidden-words.ts의 금지어 DB 함수 다섯(목록·더하기·켜고 끄기·지우기·통계)은 어디서도 쓰지 않는데
//    **공개 키(`@/lib/supabase`)로** 표를 읽고 썼다 — 0090 뒤로 공개 키에는 표 권한이 없어, 누가 부르면 조용히 실패한다
//    (목록은 빈 배열로 보임). 지우고, 공개 키로 표를 부르는 곳이 다시 생기지 않게 전체를 훑는다(공개 키는 로그인·가입의 auth만).
// ② 앱 실행 대화 제목 붙이기(run-as `retitle`): 제목을 못 읽으면 빈 제목으로 보아 '[예약] 앱 실행'으로 **덮어썼다**.
// ③ 기관 로고(/api/branding/logo): 기관·저장소를 못 읽어도 404(로고 없음)였다 — 이제 503(캐시하지 않음), 정말 없을 때만 404.
// ④ 기본 비서 갱신(install-presets `--update`): 이미 있는 비서를 못 읽으면 '없음'으로 보아 말없이 건너뛰었다 — 이제 까닭을 남긴다.

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(p) ? [p] : [];
  });
}

describe('공개 키로 표를 부르지 않는다', () => {
  it("'@/lib/supabase'를 가져오는 파일은 auth만 쓴다", () => {
    const offenders = files('src').filter((f) => {
      const s = readFileSync(f, 'utf8');
      return /from '@\/lib\/supabase'/.test(s) && /\bsupabase\s*\.\s*(from|rpc|storage)\b|\bawait supabase\s*\n\s*\.(from|rpc)\(/.test(s);
    });
    expect(offenders).toEqual([]);
  });

  it('금지어 도우미에는 맞추기 함수만 남는다', async () => {
    const mod = await import('@/lib/forbidden-words');
    expect(Object.keys(mod).sort()).toEqual(['containsForbiddenWords']);
    expect(readFileSync('src/lib/forbidden-words.ts', 'utf8')).not.toContain("from '@/lib/supabase'");
  });
});

describe('앱 실행 대화 제목', () => {
  it('제목을 못 읽으면 덮어쓰지 않는다', () => {
    const s = readFileSync('src/lib/apps/run-as.ts', 'utf8').replace(/\r\n/g, '\n');
    const i = s.indexOf('async retitle(');
    const body = s.slice(i, s.indexOf('\n    },', i));
    expect(body).toContain("const { data, error } = await supabaseAdmin.from('conversations').select('title')");
    expect(body).toContain('if (error || !data) return;');
  });
});

describe('기관 로고', () => {
  it('못 읽은 것은 503, 정말 없을 때만 404', () => {
    const s = readFileSync('src/app/api/branding/logo/route.ts', 'utf8');
    expect(s).toContain('if (orgError) return unavailable();');
    expect(s).toContain('if (error || !data) return isStorageNotFound(error) ? new NextResponse(null, { status: 404 }) : unavailable();');
    expect(s).toContain("'Cache-Control': 'no-store'");
  });
});

describe('기본 비서 갱신', () => {
  it('이미 있는 비서를 못 읽으면 까닭을 남긴다', () => {
    const s = readFileSync('src/lib/install-presets.ts', 'utf8');
    expect(s).toContain('const { data: existing, error: existingError } = await supabaseAdmin');
    expect(s).toContain("console.warn('[install-presets] 이미 있는 비서를 읽지 못해 갱신을 건너뜀', preset.name, existingError.code);");
  });
});
