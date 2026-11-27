import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { containsForbiddenWord, stripInvisible } from '@/lib/forbidden-match';
import { logSystem } from '@/lib/logger';

// 보안 로그는 한 곳(security-log.ts)에서 쓴다 — 예전 이름으로도 부를 수 있게 다시 내보낸다
export { logSecurityEvent, type SecurityEventType } from '@/lib/security-log';
import { logSecurityEvent, type SecurityEventType } from '@/lib/security-log';

/** 금액·수량 단위 — 이 단위가 바로 뒤에 붙은 긴 숫자는 개인정보(계좌번호)가 아니라 값으로 본다 */
const AMOUNT_UNITS = '(?:천원|만원|백만원|천만원|억원|조원|원|억|조|만|천|명|건|개|톤|㎡|평|%|퍼센트|회|대|가구|kg|km)';
const LONG_NUMBER = new RegExp(`(?<![\\w,.])\\d{9,15}(?![\\w,.])(?!\\s*${AMOUNT_UNITS})`, 'g');

// 금지어 맞추기 규칙은 한 곳(forbidden-match.ts) — 금지어 도우미(forbidden-words.ts)도 같은 규칙을 쓴다
export { containsForbiddenWord } from '@/lib/forbidden-match';

// 개인정보 패턴 (한국어 포함)
const PERSONAL_INFO_PATTERNS = [
  /\b\d{6}-\d{7}\b/g, // 주민등록번호
  // 휴대전화 번호(010·011·016·017·018·019)만 막는다(2026-11-06, 사용자 결정). 사무실·기관 대표 번호(02-…·031-…·070-…)는
  // 공문 초안의 담당자 연락처에 늘 들어가 막지 않는다 — 예전 두 규칙은 모든 지역 번호를 막았다
  /(?<!\d)01[016789][-\s]?\d{3,4}[-\s]?\d{4}(?!\d)/g, // 휴대전화 번호(하이픈·띄어쓰기·붙여 쓰기)
  /\b\d{4}-\d{4}-\d{4}-\d{4}\b/g, // 신용카드 번호
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN (미국)
  // 계좌번호 등 긴 숫자(9~15자리) — 뒤에 금액·수량 단위가 붙은 숫자(예산 150000000원)와 쉼표·소수점에 붙은 숫자는 빼고 본다(2026-11-06).
  // 예전에는 단위가 붙은 큰 금액도 막혀 예산 질문이 거절됐다. 9자리(미국 EIN)도 이 규칙으로 합쳤다
  LONG_NUMBER,
  // 이메일은 막지 않는다(2026-11-06, 사용자 결정) — 담당자 업무 메일이 공문·안내문에 늘 들어간다.
  // '미국 전화번호'(3-3-4) 규칙도 뺐다 — 031-123-4567 같은 국내 지역 번호를 막았다
  /\b\d{2}\.\d{2}\.\d{2}-\d{3}\.\d{3}\b/g, // 사업자등록번호
  // 외국인등록번호는 주민등록번호와 같은 꼴이라 맨 위 규칙이 잡는다(같은 규칙을 한 번 더 두면 한 번 걸릴 때 사건이 두 번 남는다)
  /\b[가-힣]{2,4}\s*\d{1,2}년\s*\d{1,2}월\s*\d{1,2}일\s*생\b/g, // 생년월일 (한글)
  /\b\d{4}년\s*\d{1,2}월\s*\d{1,2}일\b/g, // 생년월일 (숫자)
  /\b[가-힣]+시\s*[가-힣]+구\s*[가-힣]+동\s*\d+(-\d+)?\b/g, // 주소 패턴
  /\b\d{3}-\d{2}-\d{5}\b/g, // 미국 ITIN
];

/**
 * 꼴만으로는 가를 수 없어 **값을 한 번 더 보는** 개인정보 규칙(2026-11-18). 위 규칙은 하이픈으로 쓴 꼴만 잡아
 * - 띄어 쓴 주민등록번호(`900101 1234567`·`900101 - 1234567`)
 * - 붙여 쓰거나 띄어 쓴 카드번호(`1234567890123456`·`1234 5678 9012 3456` — 16자리는 긴 숫자 규칙(9~15자리)에도 안 걸렸다)
 * 가 그대로 통과했다. 넓히기만 하면 `2023 2024 2025 2026`(연도 넷)·`500000 1200000`(금액 둘) 같은 업무 글이 막히므로
 * 주민등록번호는 앞 여섯 자리가 날짜이고 뒤 첫 자리가 1~8일 때만, 카드번호는 발급사 첫 자리(3·4·5·6·9)이고 검증식(Luhn)이 맞을 때만 본다.
 */
const SPACED_RESIDENT_NUMBER = /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\s*[-–—\s]\s*[1-8]\d{6}(?!\d)/g;
const LOOSE_CARD_NUMBER = /(?<![\d-])\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}(?![\d-])/g;

/** 카드번호 검증식(Luhn) — 아무 16자리 숫자의 열에 하나만 통과한다 */
export function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

const CHECKED_PATTERNS: Array<{ kind: string; pattern: RegExp; accept: (match: string) => boolean }> = [
  { kind: 'resident_number_spaced', pattern: SPACED_RESIDENT_NUMBER, accept: () => true },
  {
    kind: 'card_number',
    pattern: LOOSE_CARD_NUMBER,
    accept: (match) => {
      const digits = match.replace(/\D/g, '');
      return digits.length === 16 && '34569'.includes(digits[0]) && passesLuhn(digits);
    },
  },
];

export interface FilterResult {
  isValid: boolean;
  blockedWords: string[];
  blockedPatterns: string[];
  filteredText: string;
  securityEvents: SecurityEvent[];
}

export interface SecurityEvent {
  type: SecurityEventType;
  details: Record<string, any>;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * 대화 입력 필터. `options.departmentIds`(직원 부서 + 상위 부서 — `ActorScope.visibleDepartmentIds`)를 주면 그 부서들의 켜진 금지어를 건다
 * (2026-11-12 — 기관 직속 부서 관리자가 넣은 금지어가 하위 부서 직원에게도 걸리게, `forbidden-words-scope.ts`). 없으면 직원 부서 것만.
 */
const FILTER_GAP_REPORT_INTERVAL_MS = 10 * 60 * 1000;
const lastFilterGapReport = new Map<string, number>();

/** 시험용 — 알림 간격 기억을 비운다 */
export function resetFilterGapReports(): void {
  lastFilterGapReport.clear();
}

/**
 * 금지어를 읽지 못해 금지어 검사 없이 통과시킨 것을 운영 기록에(2026-11-18) — 예전엔 `console.warn` 한 줄뿐이라
 * DB가 이상한 동안 금지어 통제가 꺼져도 운영자가 몰랐다. 대화마다 남기면 장애 중 기록이 쏟아지므로 부서마다 10분에 한 번.
 */
async function reportFilterGap(departmentId: string, code: string): Promise<void> {
  const now = Date.now();
  const last = lastFilterGapReport.get(departmentId);
  if (last !== undefined && now - last < FILTER_GAP_REPORT_INTERVAL_MS) return;
  lastFilterGapReport.set(departmentId, now);
  await logSystem({
    level: 'error',
    category: 'security',
    message: '금지어를 읽지 못해 금지어 검사 없이 대화를 통과시켰습니다',
    details: { department_id: departmentId, code },
  }).catch(() => {});
}

export async function filterUserInput(departmentId: string, text: string, userId?: string, options: { departmentIds?: string[]; /** 시민 상담 창(0136) — 금지어를 못 읽으면 건너뛰지 않고 던진다(로그인 없는 창이라 닫힘) */ failClosed?: boolean } = {}): Promise<FilterResult> {
  const result: FilterResult = {
    isValid: true,
    blockedWords: [],
    blockedPatterns: [],
    filteredText: text,
    securityEvents: [],
  };

  // 금지어 확인 — 직원 부서 + 상위 부서(받았으면)
  const departmentIds = options.departmentIds && options.departmentIds.length > 0
    ? Array.from(new Set([departmentId, ...options.departmentIds]))
    : [departmentId];
  const { data: forbiddenWords, error } = await supabaseAdmin
    .from('forbidden_words')
    .select('word')
    .in('department_id', departmentIds)
    .eq('is_active', true);

  if (error && options.failClosed) throw new Error('forbidden_words_unavailable');
  if (error) {
    // 금지어를 못 읽으면 금지어 검사만 건너뛴다(대화를 막지는 않는다) — **개인정보 패턴 검사는 그대로 한다.**
    // 예전에는 여기서 바로 돌아가, DB가 이상한 동안 주민등록번호·카드번호 검사까지 함께 꺼졌다(그 검사는 DB가 필요 없다).
    console.warn('[filter] 금지어 조회 실패, 금지어 검사만 건너뜀:', error.message);
    await reportFilterGap(departmentId, (error as { code?: string }).code ?? 'error');
  } else if (forbiddenWords) {
    const seen = new Set<string>();
    for (const fw of forbiddenWords) {
      // 상위·하위 부서에 같은 금지어가 있으면 한 번만
      if (typeof fw.word !== 'string' || seen.has(fw.word)) continue;
      seen.add(fw.word);
      if (containsForbiddenWord(text, fw.word)) {
        result.isValid = false;
        result.blockedWords.push(fw.word);
        result.securityEvents.push({
          type: 'forbidden_word_detected',
          details: { word: fw.word, context: text.substring(0, 100) },
          severity: 'high',
        });
      }
    }
  }

  // 개인정보 패턴 확인 — 보이지 않는 글자를 끼워(900101\u200B-1234567) 피하지 못하게 뺀 글로 본다
  const visible = stripInvisible(text);
  for (const pattern of PERSONAL_INFO_PATTERNS) {
    const matches = visible.match(pattern);
    if (matches) {
      result.isValid = false;
      result.blockedPatterns.push(...matches);
      result.securityEvents.push({
        type: 'personal_info_detected',
        details: { pattern: pattern.source, matches: matches.length },
        severity: 'critical',
      });
    }
  }

  // 값을 한 번 더 보는 규칙 — 위 규칙이 이미 잡은 글(하이픈으로 쓴 카드번호 등)은 다시 세지 않는다
  for (const rule of CHECKED_PATTERNS) {
    const matches = (visible.match(rule.pattern) ?? []).filter((m) => rule.accept(m) && !result.blockedPatterns.includes(m));
    if (matches.length > 0) {
      result.isValid = false;
      result.blockedPatterns.push(...matches);
      result.securityEvents.push({
        type: 'personal_info_detected',
        details: { pattern: rule.kind, matches: matches.length },
        severity: 'critical',
      });
    }
  }
  // 같은 글이 두 규칙에 걸려도 한 번만 알린다
  result.blockedPatterns = Array.from(new Set(result.blockedPatterns));

  // 보안 이벤트가 발생한 경우 로그 기록
  if (result.securityEvents.length > 0 && userId) {
    for (const event of result.securityEvents) {
      await logSecurityEvent(departmentId, userId, event.type, event.details, event.severity);
    }
  }

  return result;
}

export function sanitizeText(text: string): string {
  // 개인정보 패턴을 마스킹
  let sanitized = text;
  for (const pattern of PERSONAL_INFO_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[개인정보 마스킹]');
  }
  return sanitized;
}