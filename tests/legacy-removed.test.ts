import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * S4-b — 옛 검색(Voyage 임베딩·pgvector)·자체 업로드 파서·업로드 OCR을 걷어 냈다.
 * 참고 문서의 읽기·OCR·검색은 NODA가 하고, 스캔 판정은 attachments/scan.ts에 있다.
 * 다시 들어오면 어떤 코드가 지워진 길을 부르는지 모르게 되므로 파일과 import를 고정한다.
 */

const DEAD_FILES = [
  'src/lib/embeddings.ts',
  'src/lib/rag.ts',
  'src/lib/document-processor.ts',
  'src/lib/pdf-ocr.ts',
  'src/lib/spreadsheet.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p.split('\\').join('/'));
  }
  return out;
}

describe('옛 검색·임베딩·업로드 OCR 제거', () => {
  it('옛 파일이 없다', () => {
    for (const f of DEAD_FILES) expect(existsSync(f), f).toBe(false);
  });

  it('src·scripts 어디에도 VOYAGE_API_KEY·옛 모듈 import가 없다', () => {
    // 슈퍼관리자 키 화면의 'voyage' 글자는 키 보관 화면이라 대상이 아니다(판정 R2)
    const banned = [
      '@/lib/embeddings',
      '@/lib/rag',
      '@/lib/document-processor',
      '@/lib/pdf-ocr',
      '@/lib/spreadsheet',
      'VOYAGE_API_KEY',
    ];
    const files = [...walk('src'), ...walk('scripts')].filter((f) => /\.(ts|tsx|mjs|js)$/.test(f));
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const b of banned) {
        // '@/lib/rag'는 '@/lib/rag-…'(다른 모듈)와 구분한다 — 뒤가 낱말 글자·하이픈이 아닐 때만 센다
        let at = text.indexOf(b);
        while (at >= 0) {
          const next = text[at + b.length] ?? '';
          if (!b.startsWith('@/') || !/[A-Za-z0-9_-]/.test(next)) {
            hits.push(`${f}: ${b}`);
            break;
          }
          at = text.indexOf(b, at + 1);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('테스트 환경 설정과 .env.example에 VOYAGE 키가 없다', () => {
    expect(readFileSync('vitest.config.ts', 'utf8')).not.toMatch(/VOYAGE_API_KEY/);
    expect(readFileSync('.env.example', 'utf8')).not.toMatch(/VOYAGE/i);
  });
});
