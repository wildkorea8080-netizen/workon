/**
 * 접속 IP 제한.
 *
 * 공공기관은 **근무지 외 사용 통제가 복무 규정 사항**입니다. "기관이 비용을
 * 내는 도구를 청사 밖에서 개인 용도로 쓰지 않는다"를 시스템으로 보이려면
 * 정책 문서가 아니라 실제 차단이 필요합니다.
 *
 * 이 파일에는 **순수 함수만** 둡니다. Edge Runtime(미들웨어)과 Node 런타임
 * (API 라우트) 양쪽에서 같은 판정을 써야 하기 때문입니다. 판정이 두 벌이면
 * 한쪽만 고쳐져 "화면은 막혔는데 API는 열린" 상태가 됩니다 — 이 기능을
 * 만들게 된 원인이 바로 그 종류의 반쪽 통제였습니다.
 */

/** 허용 목록 문자열(줄바꿈·쉼표 구분)을 항목 배열로 */
export function parseIpList(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 요청을 보낸 실제 클라이언트 IP.
 *
 * **여기가 이 기능에서 가장 틀리기 쉬운 자리입니다.** `x-forwarded-for`의
 * 첫 값을 그냥 믿으면 누구나 헤더 한 줄로 제한을 넘습니다 — 차단이 있는
 * 것처럼 보이지만 실제로는 없는, 정확히 우리가 없애려던 상태가 됩니다.
 *
 * 그래서 **플랫폼이 채워 주는 값을 먼저** 씁니다.
 * Vercel은 `x-vercel-forwarded-for`와 `x-real-ip`를 자기가 덮어써서 넣고,
 * Next.js는 그것을 `NextRequest.ip`로 노출합니다. 클라이언트가 보낸 값은
 * 이 과정에서 밀려납니다.
 *
 * `x-forwarded-for`는 **마지막 수단**이고, 그때도 목록의 **첫 항목**을
 * 씁니다 — Vercel은 이 헤더를 클라이언트 IP로 덮어쓰기 때문입니다.
 * 다른 곳에 직접 배포한다면 앞단 프록시가 이 헤더를 **덮어쓰는지**
 * (이어붙이는 것이 아니라) 반드시 확인하세요.
 */
export function clientIpFrom(
  headers: { get(name: string): string | null },
  platformIp?: string | null
): string | null {
  const candidates = [
    platformIp,
    headers.get('x-vercel-forwarded-for'),
    headers.get('x-real-ip'),
    headers.get('x-forwarded-for')?.split(',')[0],
  ];

  for (const raw of candidates) {
    const ip = normalizeIp(raw);
    if (ip) return ip;
  }
  return null;
}

/** 앞뒤 공백·대괄호·포트를 떼고 IPv4 매핑 형태를 IPv4로 되돌린다 */
export function normalizeIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let ip = value.trim();
  if (!ip) return null;

  // [2001:db8::1]:443 형태
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end > 0) ip = ip.slice(1, end);
  } else if (ip.includes('.') && ip.includes(':')) {
    // 1.2.3.4:5678 — IPv4에 포트가 붙은 경우만 떼어낸다.
    // IPv6는 콜론이 여러 개라 여기 걸리지 않는다.
    const parts = ip.split(':');
    if (parts.length === 2) ip = parts[0];
  }

  // ::ffff:1.2.3.4 는 IPv4다. 그대로 두면 IPv4 대역과 대조되지 않는다.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];

  return ip.toLowerCase();
}

/** IPv4 점 표기 → 4바이트. 형식이 아니면 null */
function ipv4Bytes(ip: string): Uint8Array | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    // '01' 같은 앞자리 0이나 빈 칸을 거른다. Number()는 ' 1'을 1로 받아들인다.
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

/** IPv6 → 16바이트. `::` 축약과 끝의 IPv4 표기를 함께 처리한다 */
function ipv6Bytes(ip: string): Uint8Array | null {
  if (!ip.includes(':')) return null;

  let head = ip;
  let tailV4: Uint8Array | null = null;

  // 2001:db8::1.2.3.4 형태
  const lastColon = ip.lastIndexOf(':');
  const maybeV4 = ip.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    tailV4 = ipv4Bytes(maybeV4);
    if (!tailV4) return null;
    head = ip.slice(0, lastColon);
  }

  const halves = head.split('::');
  if (halves.length > 2) return null;

  const toGroups = (s: string) => (s ? s.split(':') : []);
  const left = toGroups(halves[0]);
  const right = halves.length === 2 ? toGroups(halves[1]) : [];

  const groupsNeeded = 8 - (tailV4 ? 2 : 0);
  const explicit = left.length + right.length;

  let groups: string[];
  if (halves.length === 2) {
    if (explicit > groupsNeeded) return null;
    groups = [...left, ...Array(groupsNeeded - explicit).fill('0'), ...right];
  } else {
    if (explicit !== groupsNeeded) return null;
    groups = left;
  }

  const out = new Uint8Array(16);
  for (let i = 0; i < groups.length; i += 1) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const n = parseInt(groups[i], 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  if (tailV4) out.set(tailV4, 12);
  return out;
}

interface ParsedIp {
  bytes: Uint8Array;
  /** 4 = IPv4, 16 = IPv6. 서로 다른 계열은 비교하지 않는다 */
  size: 4 | 16;
}

function parseIp(value: string): ParsedIp | null {
  const ip = normalizeIp(value);
  if (!ip) return null;

  const v4 = ipv4Bytes(ip);
  if (v4) return { bytes: v4, size: 4 };

  const v6 = ipv6Bytes(ip);
  if (v6) return { bytes: v6, size: 16 };

  return null;
}

/**
 * IP 하나가 대역 하나에 드는지.
 *
 * 대역은 `203.0.113.0/24`, `2001:db8::/32` 형태이고, 접두 길이가 없으면
 * 주소 하나(`/32`, `/128`)로 봅니다.
 */
export function matchesCidr(ip: string, pattern: string): boolean {
  const [network, prefixText] = pattern.trim().split('/');

  const target = parseIp(ip);
  const net = parseIp(network);
  if (!target || !net) return false;

  // IPv4 규칙에 IPv6 주소를 맞대면 안 된다. 우연히 통과하면 안 되는 자리다.
  if (target.size !== net.size) return false;

  const maxBits = net.size * 8;
  let prefix = maxBits;
  if (prefixText !== undefined) {
    if (!/^\d{1,3}$/.test(prefixText)) return false;
    prefix = Number(prefixText);
    if (prefix > maxBits) return false;
  }

  const fullBytes = prefix >> 3;
  for (let i = 0; i < fullBytes; i += 1) {
    if (target.bytes[i] !== net.bytes[i]) return false;
  }

  const restBits = prefix & 7;
  if (restBits === 0) return true;

  const mask = (0xff << (8 - restBits)) & 0xff;
  return (target.bytes[fullBytes] & mask) === (net.bytes[fullBytes] & mask);
}

/**
 * 허용 목록에 드는가.
 *
 * **목록이 비어 있으면 허용합니다.** 설정하지 않은 기관을 잠그면 안 됩니다 —
 * 이 기능을 켠 적이 없는 기관까지 못 쓰게 되기 때문입니다.
 *
 * **IP를 알 수 없으면 허용합니다.** 판정할 근거가 없을 때 막으면, 헤더를
 * 다르게 주는 환경 하나가 기관 전체를 잠급니다. IP 제한은 인증 위에 얹는
 * 두 번째 층이지 인증 자체가 아니므로, 근거 없는 차단보다 통과가 낫습니다.
 * 판정 불능은 호출한 쪽이 로그로 남깁니다.
 */
export function isIpAllowed(ip: string | null, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  if (!ip) return true;
  return patterns.some((p) => matchesCidr(ip, p));
}

/** 관리자가 입력한 대역이 형식에 맞는지. 저장 전에 본다. */
export function isValidIpPattern(pattern: string): boolean {
  const [network, prefixText] = pattern.trim().split('/');
  const net = parseIp(network);
  if (!net) return false;
  if (prefixText === undefined) return true;
  if (!/^\d{1,3}$/.test(prefixText)) return false;
  return Number(prefixText) <= net.size * 8;
}
