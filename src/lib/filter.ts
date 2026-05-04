import { supabaseAdmin } from '@/lib/supabaseAdmin';

// 보안 이벤트 타입
export type SecurityEventType =
  | 'forbidden_word_detected'
  | 'personal_info_detected'
  | 'file_upload_blocked'
  | 'suspicious_content'
  | 'rate_limit_exceeded';

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

// 개인정보 패턴 (한국어 포함)
const PERSONAL_INFO_PATTERNS = [
  /\b\d{6}-\d{7}\b/g, // 주민등록번호
  /\b\d{3}-\d{4}-\d{4}\b/g, // 전화번호
  /\b\d{2,3}-\d{3,4}-\d{4}\b/g, // 전화번호 (다른 형식)
  /\b\d{4}-\d{4}-\d{4}-\d{4}\b/g, // 신용카드 번호
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN (미국)
  /\b\d{10,15}\b/g, // 계좌번호 등 긴 숫자
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, // 이메일
  /\b\d{3}-\d{3}-\d{4}\b/g, // 미국 전화번호
  /\b\d{2}\.\d{2}\.\d{2}-\d{3}\.\d{3}\b/g, // 사업자등록번호
  /\b\d{6}-\d{7}\b/g, // 외국인등록번호 (주민등록번호와 동일 패턴)
  /\b[가-힣]{2,4}\s*\d{1,2}년\s*\d{1,2}월\s*\d{1,2}일\s*생\b/g, // 생년월일 (한글)
  /\b\d{4}년\s*\d{1,2}월\s*\d{1,2}일\b/g, // 생년월일 (숫자)
  /\b[가-힣]+시\s*[가-힣]+구\s*[가-힣]+동\s*\d+(-\d+)?\b/g, // 주소 패턴
  /\b\d{3}-\d{2}-\d{5}\b/g, // 미국 ITIN
  /\b\d{9}\b/g, // 미국 EIN
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
      const regex = new RegExp(`\\b${fw.word}\\b`, 'gi');
      if (regex.test(text)) {
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