import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const session = { current: null as null | { user: { id: string } } };
vi.mock('@/lib/auth', () => ({ getServerAuthSession: () => Promise.resolve(session.current) }));

const files = {
  owned: null as null | { storage_path: string; file_name: string },
  url: 'https://signed/x' as string | null,
  lookups: [] as [string, string][],
};
vi.mock('@/lib/generated-files', () => ({
  findOwnedFile: (id: string, user: string) => {
    files.lookups.push([id, user]);
    return Promise.resolve(files.owned);
  },
  signedDownloadUrl: () => Promise.resolve(files.url),
}));

import { GET } from '@/app/api/files/[id]/route';

const ID = '3f1c2b9e-1d2c-4e5f-8a9b-0c1d2e3f4a5b';
const call = (id: string) => GET(new NextRequest(`http://localhost/api/files/${id}`), { params: { id } });

beforeEach(() => {
  session.current = { user: { id: 'u1' } };
  Object.assign(files, { owned: { storage_path: 'generated/o/c/f.hwpx', file_name: '회의록.hwpx' }, url: 'https://signed/x', lookups: [] });
});

describe('내려받기', () => {
  it('로그인하지 않으면 401', async () => {
    session.current = null;
    expect((await call(ID)).status).toBe(401);
  });

  it('id 꼴이 아니면 찾아보지도 않고 404', async () => {
    expect((await call('../etc')).status).toBe(404);
    expect(files.lookups).toEqual([]);
  });

  it('내 파일이 아니면 404 — 있다는 사실도 알리지 않는다', async () => {
    files.owned = null;
    const res = await call(ID);
    expect(res.status).toBe(404);
    expect(files.lookups).toEqual([[ID, 'u1']]);
  });

  it('내 파일이면 서명 주소로 넘긴다', async () => {
    const res = await call(ID);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://signed/x');
  });

  it('서명 주소를 못 만들면 500', async () => {
    files.url = null;
    const res = await call(ID);
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });
});
