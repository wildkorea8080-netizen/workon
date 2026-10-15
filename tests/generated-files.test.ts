// tests/generated-files.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

type Call = { table?: string; op: string; args: unknown[] };
const calls: Call[] = [];
const state = {
  uploadError: null as null | { message: string },
  insertError: null as null | { message: string },
  removeError: null as null | { message: string },
  selectRows: [] as { storage_path: string }[],
  owned: null as null | { storage_path: string; file_name: string },
  removeThrows: false,
  selectThrows: false,
};

vi.mock('@/lib/supabaseAdmin', () => {
  const chain = (table: string, result: () => unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'order']) {
      q[m] = (...args: unknown[]) => {
        calls.push({ table, op: m, args });
        return q;
      };
    }
    q.maybeSingle = () => Promise.resolve(result());
    q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return q;
  };
  return {
    supabaseAdmin: {
      from(table: string) {
        return {
          insert(row: unknown) {
            calls.push({ table, op: 'insert', args: [row] });
            return Promise.resolve({ error: state.insertError });
          },
          select(...args: unknown[]) {
            calls.push({ table, op: 'select', args });
            if (state.selectThrows) throw new Error('network down');
            return chain(table, () =>
              state.owned !== null || table !== 'generated_files'
                ? { data: state.owned, error: null }
                : { data: state.selectRows, error: null }
            );
          },
        };
      },
      storage: {
        from(bucket: string) {
          return {
            upload(path: string, _bytes: unknown, opts: unknown) {
              calls.push({ op: 'upload', args: [bucket, path, opts] });
              return Promise.resolve({ error: state.uploadError });
            },
            remove(paths: string[]) {
              calls.push({ op: 'remove', args: [bucket, paths] });
              if (state.removeThrows) return Promise.reject(new Error('network down'));
              return Promise.resolve({ error: state.removeError });
            },
            createSignedUrl(path: string, ttl: number, ...rest: unknown[]) {
              // 넘기지 않은 인자는 기록하지 않는다 — download 옵션 유무를 구분하기 위해
              calls.push({ op: 'sign', args: [path, ttl, ...rest] });
              return Promise.resolve({ data: { signedUrl: `https://signed/${path}` }, error: null });
            },
          };
        },
      },
    },
  };
});

const logged: unknown[] = [];
vi.mock('@/lib/logger', () => ({ logSystem: (p: unknown) => { logged.push(p); return Promise.resolve(); } }));

import {
  safeFileName,
  generatedStoragePath,
  saveGeneratedFile,
  findOwnedFile,
  signedDownloadUrl,
  deleteConversationFiles,
} from '@/lib/generated-files';

const input = {
  organizationId: 'org', departmentId: 'dept', userId: 'u1', agentId: 'a1', conversationId: 'c1',
  templateRef: 'builtin:minutes', templateName: '회의록', fileName: '주간 회의록.hwpx', extension: 'hwpx',
  mimeType: 'application/hwp+zip', bytes: Buffer.from('PKdata'),
};

beforeEach(() => {
  calls.length = 0;
  logged.length = 0;
  Object.assign(state, { uploadError: null, insertError: null, removeError: null, selectRows: [], owned: null, removeThrows: false, selectThrows: false });
});

describe('파일 이름', () => {
  it('쓸 수 없는 글자를 바꾸고 비면 기본 이름', () => {
    expect(safeFileName('  2026/10 주간:회의록?  ', 'hwpx')).toBe('2026 10 주간 회의록.hwpx');
    expect(safeFileName('<>|', 'hwpx')).toBe('문서.hwpx');
    expect(safeFileName('가'.repeat(200), 'hwpx')).toBe(`${'가'.repeat(80)}.hwpx`);
  });

  it('저장소 경로에는 한글 이름을 넣지 않는다', () => {
    expect(generatedStoragePath('org', 'c1', 'f1', 'hwpx')).toBe('generated/org/c1/f1.hwpx');
  });

  it('확장자는 소문자·숫자 1~8자만 받는다', () => {
    for (const bad of ['', '../x', 'HWPX', 'hw px', 'a'.repeat(9), 'hwpx/']) {
      expect(() => safeFileName('문서', bad)).toThrow('잘못된 확장자');
      expect(() => generatedStoragePath('org', 'c1', 'f1', bad)).toThrow('잘못된 확장자');
    }
    expect(safeFileName('문서', 'docx')).toBe('문서.docx');
  });
});

describe('저장', () => {
  it('저장소에 올리고 같은 id·경로로 기록한다', async () => {
    const ref = await saveGeneratedFile(input);
    const upload = calls.find((c) => c.op === 'upload')!;
    const insert = calls.find((c) => c.op === 'insert')!;
    const row = insert.args[0] as Record<string, unknown>;
    expect(upload.args[1]).toBe(`generated/org/c1/${ref.id}.hwpx`);
    expect(row).toMatchObject({
      id: ref.id, conversation_id: 'c1', user_id: 'u1', department_id: 'dept', agent_id: 'a1',
      template_ref: 'builtin:minutes', file_name: '주간 회의록.hwpx', size_bytes: 6, storage_path: upload.args[1],
    });
    expect(row).not.toHaveProperty('organization_id'); // 트리거가 채운다
    expect(ref).toEqual({ id: ref.id, file_name: '주간 회의록.hwpx', size_bytes: 6 });
  });

  it('기록이 실패하면 올린 파일을 지우고 던진다', async () => {
    state.insertError = { message: 'boom' };
    await expect(saveGeneratedFile(input)).rejects.toThrow('기록');
    expect(calls.some((c) => c.op === 'remove')).toBe(true);
  });

  it('되돌리기까지 실패해도 원래의 기록 오류를 던지고 고아 경로를 로그에 남긴다', async () => {
    state.insertError = { message: 'boom' };
    state.removeError = { message: 'denied' };
    await expect(saveGeneratedFile(input)).rejects.toThrow('기록');
    const path = calls.find((c) => c.op === 'upload')!.args[1] as string;
    expect(JSON.stringify(logged)).toContain(path);

    logged.length = 0;
    state.removeError = null;
    state.removeThrows = true;
    await expect(saveGeneratedFile(input)).rejects.toThrow('기록');
    expect(logged.length).toBe(1);
  });

  it('올리기가 실패하면 기록하지 않고 던진다', async () => {
    state.uploadError = { message: 'full' };
    await expect(saveGeneratedFile(input)).rejects.toThrow('저장');
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });
});

describe('조회·내려받기', () => {
  it('주인 조건으로만 찾는다', async () => {
    state.owned = { storage_path: 'p', file_name: 'n.hwpx' };
    expect(await findOwnedFile('f1', 'u1')).toEqual({ storage_path: 'p', file_name: 'n.hwpx' });
    const eqs = calls.filter((c) => c.op === 'eq').map((c) => c.args);
    expect(eqs).toContainEqual(['id', 'f1']);
    expect(eqs).toContainEqual(['user_id', 'u1']);
  });

  it('서명 주소는 60초, 원래 이름으로 받게 한다', async () => {
    const url = await signedDownloadUrl('generated/x.hwpx', '회의록.hwpx');
    // SDK의 download 옵션은 한글을 이중 인코딩하므로 넘기지 않고 직접 한 번만 붙인다
    expect(calls.find((c) => c.op === 'sign')!.args).toEqual(['generated/x.hwpx', 60]);
    expect(url).toBe('https://signed/generated/x.hwpx?download=%ED%9A%8C%EC%9D%98%EB%A1%9D.hwpx');
    expect(url!.endsWith(`download=${encodeURIComponent('회의록.hwpx')}`)).toBe(true);
    expect(url).not.toContain('%25');
  });

  it('서명 주소에 이미 질의가 있으면 &로 잇는다', async () => {
    const url = await signedDownloadUrl('generated/x.hwpx?token=t', 'a.hwpx');
    expect(url).toBe('https://signed/generated/x.hwpx?token=t&download=a.hwpx');
  });
});

describe('대화 삭제 때', () => {
  it('그 대화의 파일을 저장소에서 지운다', async () => {
    state.selectRows = [{ storage_path: 'generated/a.hwpx' }, { storage_path: 'generated/b.hwpx' }];
    await deleteConversationFiles('c1');
    expect(calls.find((c) => c.op === 'remove')!.args[1]).toEqual(['generated/a.hwpx', 'generated/b.hwpx']);
    expect(logged).toEqual([]);
  });

  it('저장소 삭제가 실패하면 남은 경로를 시스템 로그에 남기고 던지지 않는다', async () => {
    state.selectRows = [{ storage_path: 'generated/a.hwpx' }];
    state.removeError = { message: 'denied' };
    await expect(deleteConversationFiles('c1')).resolves.toBeUndefined();
    expect(JSON.stringify(logged)).toContain('generated/a.hwpx');
  });

  it('저장소·조회가 예외를 던져도 던지지 않고 로그를 남긴다', async () => {
    state.selectRows = [{ storage_path: 'generated/a.hwpx' }];
    state.removeThrows = true;
    await expect(deleteConversationFiles('c1')).resolves.toBeUndefined();
    expect(logged.length).toBe(1);

    logged.length = 0;
    state.removeThrows = false;
    state.selectThrows = true;
    await expect(deleteConversationFiles('c1')).resolves.toBeUndefined();
    expect(logged.length).toBe(1);
  });

  it('대화 삭제 라우트가 대화를 지우기 전에 부른다', () => {
    const src = readFileSync('src/app/api/conversations/[id]/route.ts', 'utf8');
    const del = src.slice(src.indexOf('export async function DELETE'));
    // 작업 사본은 CRLF일 수 있다(core.autocrlf) — 줄바꿈에 기대지 않는다
    const callAt = del.indexOf('deleteConversationFiles(');
    const deleteAt = del.search(/\.from\('conversations'\)\s*\.delete\(\)/);
    expect(callAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(-1);
    expect(callAt).toBeLessThan(deleteAt);
  });
});
