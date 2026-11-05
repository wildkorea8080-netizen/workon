import { supabaseAdmin } from '@/lib/supabaseAdmin';

// 보안 이벤트 타입
export type SecurityEventType =
  | 'forbidden_word_detected'
  | 'personal_info_detected'
  | 'file_upload_blocked'
  | 'suspicious_content'
  | 'rate_limit_exceeded'
  /** 관리자가 감사 화면에서 직원 질문 원문을 열람함 (D1) */
  | 'query_revealed'
  /** 관리자가 직원의 앱 연동을 회수함 / 예약을 멈춤(잠금) / 잠금을 풂 (0050) */
  | 'app_webhook_revoked'
  | 'app_schedule_paused'
  | 'app_schedule_unlocked';

// 보안 감사 로그 기록 함수
export async function logSecurityEvent(
  departmentId: string,
  userId: string,
  eventType: SecurityEventType,
  details: Record<string, any>,
  severity: 'low' | 'medium' | 'high' | 'critical' = 'medium'
) {
  try {
    await supabaseAdmin.from('security_logs').insert({
      department_id: departmentId,
      user_id: userId,
      event_type: eventType,
      details,
      severity,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    // 보안 로그 기록 실패는 애플리케이션 실행을 중단하지 않음
    console.error('보안 로그 기록 실패:', error);
  }
}

/** 금액·수량 단위 — 이 단위가 바로 뒤에 붙은 긴 숫자는 개인정보(계좌번호)가 아니라 값으로 본다 */
const AMOUNT_UNITS = '(?:천원|만원|백만원|천만원|억원|조원|원|억|조|만|천|명|건|개|톤|㎡|평|%|퍼센트|회|대|가구|kg|km)';
const LONG_NUMBER = new RegExp(`(?<![\\w,.])\\d{9,15}(?![\\w,.])(?!\\s*${AMOUNT_UNITS})`, 'g');

/** 정규식에 넣을 글자 그대로 — 금지어에 `+`·`(` 같은 글자가 있어도 깨지지 않게 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 금지어가 글에 있는가(2026-11-06). 예전 `\b금지어\b`는 `\b`가 영문·숫자 경계만 알아 **한글 금지어를 한 번도 잡지 못했고**,
 * 금지어의 특수 글자(`c++`)가 정규식을 깨 대화가 멈췄다.
 * - 영문·숫자·공백만인 금지어: 영문·숫자에 붙지 않은 자리만(대소문자 무시) — 'ass'가 'class'에 걸리지 않게
 * - 그 밖(한글이 든 금지어): 들어 있으면 — 한국어는 조사가 붙어('비밀을') 낱말 경계로 가를 수 없다
 */
export function containsForbiddenWord(text: string, word: string): boolean {
  const w = word.normalize('NFC').trim();
  if (!w) return false;
  const t = text.normalize('NFC');
  if (/^[A-Za-z0-9_\s]+$/.test(w)) return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(w)}(?![A-Za-z0-9_])`, 'i').test(t);
  return t.toLocaleLowerCase('ko-KR').includes(w.toLocaleLowerCase('ko-KR'));
}

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
  /\b\d{6}-\d{7}\b/g, // 외국인등록번호 (주민등록번호와 동일 패턴)
  /\b[가-힣]{2,4}\s*\d{1,2}년\s*\d{1,2}월\s*\d{1,2}일\s*생\b/g, // 생년월일 (한글)
  /\b\d{4}년\s*\d{1,2}월\s*\d{1,2}일\b/g, // 생년월일 (숫자)
  /\b[가-힣]+시\s*[가-힣]+구\s*[가-힣]+동\s*\d+(-\d+)?\b/g, // 주소 패턴
  /\b\d{3}-\d{2}-\d{5}\b/g, // 미국 ITIN
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

export async function filterUserInput(departmentId: string, text: string, userId?: string): Promise<FilterResult> {
  const result: FilterResult = {
    isValid: true,
    blockedWords: [],
    blockedPatterns: [],
    filteredText: text,
    securityEvents: [],
  };

  // 금지어 확인
  const { data: forbiddenWords, error } = await supabaseAdmin
    .from('forbidden_words')
    .select('word')
    .eq('department_id', departmentId)
    .eq('is_active', true);

  if (error) {
    console.warn('[filter] 금지어 조회 실패, 필터링 스킵:', error.message);
    return result; // 필터 실패 시 차단하지 않고 통과
  }

  if (forbiddenWords) {
    for (const fw of forbiddenWords) {
      if (typeof fw.word === 'string' && containsForbiddenWord(text, fw.word)) {
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

  // 개인정보 패턴 확인
  for (const pattern of PERSONAL_INFO_PATTERNS) {
    const matches = text.match(pattern);
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