import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';

/**
 * 공통 자료실 운영자 API (S5 Task 6) — 경로·확인 검사(순수)와 라우트 원본.
 * DB·저장소는 가짜로 바꾼다(document-upload.test.ts와 같은 꼴).
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { from: () => ({}), storage: { from: () => ({}) } } }));

import { DOCUMENT_CONFIRM_WINDOW_MS } from '@/lib/document-upload';
import { checkCommonConfirm, commonStoragePath, parseCommonStoragePath } from '@/lib/common-upload';

const ID = '11111111-2222-3333-4444-555555555555';
const NOW = 1_800_000_000_000;

function validInput(over: Record<string, unknown> = {}) {
  return {
    storage_path: commonStoragePath({ orgType: '지방자치단체', now: NOW - 1000, id: ID, ext: 'pdf' }),
    file_name: '지방공무원 복무규정.pdf',
    file_type: 'application/pdf',
    org_type: '지방자치단체',
    title: '지방공무원 복무규정',
    edition_year: 2026,
    usage_terms: '공공누리 1유형 · 2026-10-25 확인',
    ...over,
  };
}

describe('공통 자료실 저장소 경로', () => {
  it('common/{열쇠}/{발급시각}-{id}.{ext} 꼴로 만들고 다시 읽는다', () => {
    const path = commonStoragePath({ orgType: '중앙행정기관', now: NOW, id: ID, ext: 'hwpx' });
    expect(path).toBe(`common/central/${NOW}-${ID}.hwpx`);
    expect(parseCommonStoragePath(path)).toEqual({ key: 'central', issuedAt: NOW, id: ID, ext: 'hwpx' });
  });

  it('거슬러 오르는 조각·다른 접두사·모양이 다른 경로는 null', () => {
    expect(parseCommonStoragePath(`common/../documents/${NOW}-${ID}.pdf`)).toBeNull();
    expect(parseCommonStoragePath(`common/central/../${NOW}-${ID}.pdf`)).toBeNull();
    expect(parseCommonStoragePath(`documents/central/${NOW}-${ID}.pdf`)).toBeNull();
    expect(parseCommonStoragePath(`common/central/${NOW}-${ID}`)).toBeNull();
    expect(parseCommonStoragePath(`common/central/x/${NOW}-${ID}.pdf`)).toBeNull();
    expect(parseCommonStoragePath(`common/Central/${NOW}-${ID}.pdf`)).toBeNull();
    expect(parseCommonStoragePath(42 as unknown as string)).toBeNull();
  });

  it('만들 때 표 밖 유형·잘못된 조각은 던진다', () => {
    expect(() => commonStoragePath({ orgType: '없는유형' as never, now: NOW, id: ID, ext: 'pdf' })).toThrow();
    expect(() => commonStoragePath({ orgType: '공공기관', now: NOW, id: '../x', ext: 'pdf' })).toThrow();
    expect(() => commonStoragePath({ orgType: '공공기관', now: NOW, id: ID, ext: 'P/F' })).toThrow();
  });
});

describe('공통 문서 확인 검사', () => {
  it('맞는 입력은 다듬어 돌려준다', () => {
    const r = checkCommonConfirm(validInput({ title: '  지방공무원 복무규정  ', usage_terms: ' 공공누리 1유형 ' }), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe('지방공무원 복무규정');
      expect(r.value.usage_terms).toBe('공공누리 1유형');
      expect(r.value.org_type).toBe('지방자치단체');
      expect(r.value.edition_year).toBe(2026);
      expect(r.value.replaces_id).toBeNull();
    }
  });

  it('replaces_id는 uuid여야 하고 없으면 null', () => {
    const ok = checkCommonConfirm(validInput({ replaces_id: ID }), NOW);
    expect(ok.ok && ok.value.replaces_id).toBe(ID);
    const bad = checkCommonConfirm(validInput({ replaces_id: 'abc' }), NOW);
    expect(bad).toMatchObject({ ok: false, status: 400 });
  });

  it.each([
    ['유형 밖', { org_type: '외계기관' }],
    ['이름 빈 글', { title: '   ' }],
    ['이름이 글이 아님', { title: 5 }],
    ['연도 1999', { edition_year: 1999 }],
    ['연도 2101', { edition_year: 2101 }],
    ['연도 소수', { edition_year: 2026.5 }],
    ['연도 글', { edition_year: '2026' }],
    ['이용 조건 공백', { usage_terms: '  \n ' }],
    ['파일 이름 없음', { file_name: '' }],
    ['경로 열쇠가 유형과 다름', { org_type: '공공기관' }],
    ['경로 모양', { storage_path: 'documents/a/b/1-x.pdf' }],
  ])('%s은 400', (_n, over) => {
    const r = checkCommonConfirm(validInput(over), NOW);
    expect(r).toMatchObject({ ok: false, status: 400 });
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
  });

  it('본문이 객체가 아니면 400', () => {
    expect(checkCommonConfirm(null, NOW)).toMatchObject({ ok: false, status: 400 });
    expect(checkCommonConfirm('x', NOW)).toMatchObject({ ok: false, status: 400 });
  });

  it('발급 10분이 지나면 410, 경계(정확히 10분)는 통과', () => {
    const old = validInput({ storage_path: commonStoragePath({ orgType: '지방자치단체', now: NOW - DOCUMENT_CONFIRM_WINDOW_MS - 1, id: ID, ext: 'pdf' }) });
    expect(checkCommonConfirm(old, NOW)).toMatchObject({ ok: false, status: 410 });
    const edge = validInput({ storage_path: commonStoragePath({ orgType: '지방자치단체', now: NOW - DOCUMENT_CONFIRM_WINDOW_MS, id: ID, ext: 'pdf' }) });
    expect(checkCommonConfirm(edge, NOW).ok).toBe(true);
  });

  it('미래 시각 경로는 400', () => {
    const future = validInput({ storage_path: commonStoragePath({ orgType: '지방자치단체', now: NOW + 120_000, id: ID, ext: 'pdf' }) });
    expect(checkCommonConfirm(future, NOW)).toMatchObject({ ok: false, status: 400 });
  });
});

describe('라우트 원본', () => {
  const read = (p: string) => readFileSync(p, 'utf8');
  const dir = 'src/app/api/super/common-documents';
  const files = {
    list: `${dir}/route.ts`,
    uploadUrl: `${dir}/upload-url/route.ts`,
    del: `${dir}/[id]/route.ts`,
    read: `${dir}/[id]/read/route.ts`,
  };

  it('다섯 핸들러 모두 첫 줄에서 getSuperAdminFromRequest로 막는다', () => {
    let handlers = 0;
    for (const f of Object.values(files)) {
      const src = read(f);
      const matches = src.match(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g) ?? [];
      handlers += matches.length;
      for (const m of matches) {
        const at = src.indexOf(m);
        const body = src.slice(at, at + 400);
        expect(body, `${f} ${m}`).toContain('getSuperAdminFromRequest(request)');
      }
    }
    expect(handlers).toBe(5);
    expect(read(files.list)).toMatch(/export async function GET/);
    expect(read(files.list)).toMatch(/export async function POST/);
  });

  it('401은 { ok:false, error:{ message } } 꼴', () => {
    for (const f of Object.values(files)) {
      expect(read(f)).toContain("'인증이 필요합니다.'");
    }
  });

  it('확인은 409 문구·super_admin_logs·저장소 크기·형식 검사를 갖는다', () => {
    const src = read(files.list);
    expect(src).toContain("같은 이름의 문서가 이미 있습니다 — '바꿀 옛 판'으로 고르세요");
    expect(src).toContain('409');
    expect(src).toContain("'common_document_uploaded'");
    expect(src).toContain("'common_document'");
    expect(src).toContain('checkCommonConfirm');
    expect(src).toContain('checkUploadFile');
    expect(src).toContain('commonNodaFilename');
    expect(src).toContain('startReadingFields');
    expect(src).toContain('uploaded_by: admin.sub');
    expect(src).toContain('MAX_UPLOAD_BYTES');
  });

  it('목록은 storage_path·noda_filename·시각 칸을 내보내지 않고 reconcileReading으로 맞춘다', () => {
    const src = read(files.list);
    expect(src).toContain('reconcileReading');
    expect(src).toContain('commonReadingDeps()');
    const m = /const PRIVATE_COLUMNS = \[([\s\S]*?)\] as const;/.exec(src);
    expect(m).not.toBeNull();
    for (const col of ['storage_path', 'noda_filename', 'noda_read_started_at', 'noda_last_attempt_at', 'noda_doc_id']) {
      expect(m![1]).toContain(`'${col}'`);
    }
    // 내보내는 행은 모두 toClientRow를 거친다
    expect(src).toContain('rows.map(toClientRow)');
  });

  it('읽기는 maxDuration 300과 readDocument(commonReadingDeps)', () => {
    const src = read(files.read);
    expect(src).toMatch(/export const maxDuration = 300/);
    expect(src).toContain('commonReadingDeps()');
    expect(src).toContain('readDocument');
  });

  it('삭제는 deleteCommonDocument와 502 문구, 성공 시 common_document_deleted 기록', () => {
    const src = read(files.del);
    expect(src).toContain('deleteCommonDocument');
    expect(src).toContain('문서 보관소에서 지우지 못했습니다. 잠시 뒤 다시 지워 주세요.');
    expect(src).toContain("'common_document_deleted'");
  });

  it('발급은 checkUploadFile 뒤 createSignedUploadUrl', () => {
    const src = read(files.uploadUrl);
    expect(src.indexOf('checkUploadFile')).toBeGreaterThan(-1);
    expect(src.indexOf('createSignedUploadUrl')).toBeGreaterThan(src.indexOf('checkUploadFile'));
    expect(src).toContain('commonStoragePath');
  });
});
