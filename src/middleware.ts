import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { clientIpFrom, isIpAllowed } from '@/lib/ip-access';

const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? '';

const PUBLIC_FILE = /\.(.*)$/;
const SUPER_COOKIE = 'super_token';

// 점검 모드 캐시 (Edge Runtime 모듈 레벨, 30초 TTL)
let maintenanceCache: { value: boolean; message: string; ts: number } | null = null;
const CACHE_TTL = 30_000;

async function checkMaintenance(): Promise<{ on: boolean; message: string }> {
  if (maintenanceCache && Date.now() - maintenanceCache.ts < CACHE_TTL) {
    return { on: maintenanceCache.value, message: maintenanceCache.message };
  }
  try {
    const url  = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key  = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return { on: false, message: '' };

    const res  = await fetch(
      `${url}/rest/v1/system_settings?key=in.(maintenance_mode,maintenance_message)&select=key,value`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!res.ok) return { on: false, message: '' };
    const data = await res.json() as { key: string; value: string }[];
    const map  = Object.fromEntries(data.map(r => [r.key, r.value]));
    const on   = map.maintenance_mode === 'true';
    const msg  = map.maintenance_message ?? '';
    maintenanceCache = { value: on, message: msg, ts: Date.now() };
    return { on, message: msg };
  } catch {
    return { on: false, message: '' };
  }
}

// ── 접속 IP 제한 (0023) ─────────────────────────────────────
//
// 판정 자체는 src/lib/ip-access.ts의 순수 함수가 한다. 여기서는 "이 사용자의
// 기관이 어떤 대역을 허용하는가"만 가져온다.
//
// 미들웨어는 요청마다 돈다. 그래서 **제한을 켠 기관이 하나라도 있는지**를
// 먼저 보고, 없으면 거기서 끝낸다 — 이 기능을 쓰지 않는 배포에서는 30초에
// 한 번 작은 조회 하나가 전부다.
let ipCache: { byDept: Map<string, string[]>; ts: number } | null = null;

async function allowedIpsForDepartment(departmentId: string | null): Promise<string[]> {
  if (!departmentId) return [];

  if (!ipCache || Date.now() - ipCache.ts >= CACHE_TTL) {
    ipCache = { byDept: await loadIpPolicy(), ts: Date.now() };
  }
  return ipCache.byDept.get(departmentId) ?? [];
}

async function loadIpPolicy(): Promise<Map<string, string[]>> {
  const byDept = new Map<string, string[]>();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return byDept;

  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  try {
    const orgRes = await fetch(
      `${url}/rest/v1/organizations?select=id,allowed_ips&allowed_ips=not.is.null`,
      { headers }
    );
    if (!orgRes.ok) return byDept;

    const orgs = (await orgRes.json()) as { id: string; allowed_ips: string[] | null }[];
    const active = orgs.filter((o) => (o.allowed_ips?.length ?? 0) > 0);
    // 아무 기관도 제한을 켜지 않았다. 부서를 조회할 이유가 없다.
    if (active.length === 0) return byDept;

    const ids = active.map((o) => o.id).join(',');
    const deptRes = await fetch(
      `${url}/rest/v1/departments?select=id,organization_id&organization_id=in.(${ids})`,
      { headers }
    );
    if (!deptRes.ok) return byDept;

    const depts = (await deptRes.json()) as { id: string; organization_id: string }[];
    const byOrg = new Map(active.map((o) => [o.id, o.allowed_ips ?? []]));
    for (const d of depts) {
      const list = byOrg.get(d.organization_id);
      if (list) byDept.set(d.id, list);
    }
  } catch {
    // 조회 실패는 "제한 없음"으로 떨어진다. 여기서 전부 막으면 DB가 잠깐
    // 흔들릴 때 기관 전체가 못 들어온다. IP 제한은 인증 위에 얹는 두 번째
    // 층이라, 근거를 못 얻었을 때는 인증만으로 통과시키는 편이 낫다.
    // (부서 범위·커넥터 범위는 반대로 닫는다 — 그쪽은 실패가 곧 타 기관
    //  자료 노출이라 위험의 종류가 다르다.)
    return byDept;
  }

  return byDept;
}

/**
 * Edge Runtime 호환 JWT 서명 검증 (Web Crypto API)
 */
const SUPER_JWT_FALLBACK = 'dev-fallback-super-secret-change-in-prod';

async function verifySuperTokenEdge(token: string): Promise<boolean> {
  try {
    const secret = process.env.SUPER_JWT_SECRET || SUPER_JWT_FALLBACK;

    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [header, payload, sig] = parts;

    // 서명 검증
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sigBytes = Uint8Array.from(
      atob(sig.replace(/-/g, '+').replace(/_/g, '/')),
      c => c.charCodeAt(0)
    );
    const data = new TextEncoder().encode(`${header}.${payload}`);
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, data);
    if (!valid) return false;

    // 만료 검증
    const decoded = JSON.parse(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    );
    return decoded.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ── 점검 모드 체크 (/super, /maintenance, /api/super, /api/system은 제외) ──
  const isExempt =
    pathname.startsWith('/super') ||
    pathname.startsWith('/maintenance') ||
    pathname.startsWith('/api/super') ||
    pathname.startsWith('/api/system') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api/auth') ||
    PUBLIC_FILE.test(pathname);

  if (!isExempt) {
    const { on: isMaintenance } = await checkMaintenance();
    if (isMaintenance) {
      // 슈퍼관리자 토큰 있으면 통과
      const superToken = req.cookies.get(SUPER_COOKIE)?.value;
      const isSuperAdmin = superToken ? await verifySuperTokenEdge(superToken) : false;
      if (!isSuperAdmin) {
        // API에 리디렉션을 주면 fetch가 점검 안내 HTML을 받아 "알 수 없는
        // 오류"가 된다. matcher에 /api를 넣으면서 이 경로가 처음으로
        // 점검 모드에 걸리게 됐으므로 함께 처리한다.
        if (pathname.startsWith('/api')) {
          return NextResponse.json(
            { ok: false, error: { message: '서비스 점검 중입니다. 잠시 후 다시 시도해주세요.' } },
            { status: 503 }
          );
        }
        return NextResponse.redirect(new URL('/maintenance', req.url));
      }
    }
  }

  // 정적 파일, Next.js 내부 경로 통과
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/api/super/auth') ||
    pathname.startsWith('/static') ||
    PUBLIC_FILE.test(pathname)
  ) {
    return NextResponse.next();
  }

  // ── 접속 IP 제한 (0023) ───────────────────────────────────
  //
  // 슈퍼관리자 경로는 제외한다. 관리자가 대역을 잘못 적어 기관 전체가
  // 잠겼을 때 **되돌릴 통로가 하나는 남아야** 하기 때문이다. 슈퍼관리자는
  // 별도 인증(super_token)을 쓰고 기관에 속하지 않는다.
  //
  // 인증되지 않은 요청도 제외한다. 소속 기관을 알 수 없어 판정할 근거가
  // 없고, 어차피 그다음 인증 검사에서 막힌다.
  if (!pathname.startsWith('/super') && !pathname.startsWith('/blocked')) {
    const ipToken = await getToken({ req, secret: NEXTAUTH_SECRET });
    const ipDeptId = (ipToken?.departmentId as string | null | undefined) ?? null;

    if (ipToken?.sub && ipDeptId) {
      const allowed = await allowedIpsForDepartment(ipDeptId);
      if (allowed.length > 0) {
        const ip = clientIpFrom(req.headers, req.ip);
        if (!isIpAllowed(ip, allowed)) {
          // API는 되돌려 보낼 화면이 없다. 리디렉션을 주면 fetch가 로그인
          // HTML을 받아 "알 수 없는 오류"가 된다.
          if (pathname.startsWith('/api')) {
            return NextResponse.json(
              {
                ok: false,
                error: {
                  message:
                    '기관이 허용한 네트워크에서만 이용할 수 있습니다. 기관 내부망에서 접속해주세요.',
                },
              },
              { status: 403 }
            );
          }
          const url = req.nextUrl.clone();
          url.pathname = '/blocked';
          url.search = '';
          if (ip) url.searchParams.set('ip', ip);
          return NextResponse.redirect(url);
        }
      }
    }
  }

  // ── 슈퍼관리자 경로 ───────────────────────────────────────
  if (pathname.startsWith('/super')) {
    // 로그인 페이지는 항상 통과 (pathname 헤더만 설정)
    if (pathname === '/super/login') {
      const res = NextResponse.next();
      res.headers.set('x-pathname', pathname);
      return res;
    }

    const superToken = req.cookies.get(SUPER_COOKIE)?.value;
    if (!superToken) {
      const url = req.nextUrl.clone();
      url.pathname = '/super/login';
      url.searchParams.set('redirect', pathname);
      return NextResponse.redirect(url);
    }

    const valid = await verifySuperTokenEdge(superToken);
    if (!valid) {
      const url = req.nextUrl.clone();
      url.pathname = '/super/login';
      url.searchParams.set('redirect', pathname);
      const res = NextResponse.redirect(url);
      // 만료된 쿠키 제거
      res.cookies.set({ name: SUPER_COOKIE, value: '', maxAge: 0, path: '/' });
      return res;
    }

    // pathname을 헤더로 전달 (layout에서 /super/login 제외 처리용)
    const res = NextResponse.next();
    res.headers.set('x-pathname', pathname);
    return res;
  }

  // ── 관리자 경로 ───────────────────────────────────────────
  if (pathname.startsWith('/admin')) {
    const token = await getToken({ req, secret: NEXTAUTH_SECRET });
    if (!token?.sub || token.role !== 'ADMIN') {
      const url = req.nextUrl.clone();
      url.pathname = '/login';
      url.searchParams.set('error', 'unauthorized');
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // ── 일반 인증 경로 ────────────────────────────────────────
  if (pathname.startsWith('/user')) {
    const token = await getToken({ req, secret: NEXTAUTH_SECRET });
    if (!token?.sub) {
      const url = req.nextUrl.clone();
      url.pathname = '/login';
      url.searchParams.set('error', 'unauthenticated');
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  // **`/api`를 반드시 포함한다.** 예전 matcher는 api를 빼고 있었다. 그대로
  // 두면 화면만 막히고 `/api/chat`은 밖에서 그대로 불린다 — 차단이 있는
  // 것처럼 보이지만 실제로는 없는, 이 기능을 만들게 된 바로 그 상태다.
  matcher: [
    '/admin/:path*',
    '/user/:path*',
    '/super/:path*',
    '/api/:path*',
    '/((?!_next|api|static|.*\..*).*)',
  ],
};
