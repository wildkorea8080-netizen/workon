import { APP_NAME, MAIL_FROM, RESEND_API_KEY } from '@/lib/config';

const RESEND_API_URL = 'https://api.resend.com/emails';

export interface MailResult {
  sent: boolean;
  /** sent=false인 이유. 미설정이면 'not_configured' */
  reason?: 'not_configured' | 'send_failed';
  error?: string;
}

/** 메일 발송이 설정되어 있는지 — 미설정이면 호출부가 링크 수동 전달로 폴백한다 */
export function isMailConfigured(): boolean {
  return Boolean(RESEND_API_KEY && MAIL_FROM);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendMail(to: string, subject: string, html: string): Promise<MailResult> {
  if (!isMailConfigured()) {
    return { sent: false, reason: 'not_configured' };
  }

  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = body?.message ?? `HTTP ${response.status}`;
      console.error('[mailer] 발송 실패:', to, error);
      return { sent: false, reason: 'send_failed', error };
    }

    return { sent: true };
  } catch (err: any) {
    console.error('[mailer] 발송 예외:', to, err?.message);
    return { sent: false, reason: 'send_failed', error: err?.message ?? '알 수 없는 오류' };
  }
}

function layout(heading: string, bodyHtml: string) {
  return `
<div style="font-family:'Malgun Gothic',-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1e293b">
  <div style="border-bottom:3px solid #003087;padding-bottom:12px;margin-bottom:24px">
    <span style="font-size:18px;font-weight:700;color:#003087">${escapeHtml(APP_NAME)}</span>
  </div>
  <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h1>
  ${bodyHtml}
  <p style="margin-top:32px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8">
    본 메일은 발신 전용입니다. 문의는 기관 관리자에게 연락해주세요.
  </p>
</div>`.trim();
}

function button(url: string, label: string) {
  return `<p style="margin:24px 0">
    <a href="${escapeHtml(url)}" style="display:inline-block;background:#003087;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">${escapeHtml(label)}</a>
  </p>
  <p style="font-size:13px;color:#64748b">버튼이 열리지 않으면 아래 주소를 브라우저에 붙여넣으세요.<br>
    <span style="word-break:break-all;color:#003087">${escapeHtml(url)}</span>
  </p>`;
}

/** 초대 링크 안내 메일 */
export function sendInvitationEmail(params: {
  to: string;
  inviteUrl: string;
  organizationName?: string;
  expiresAt?: string;
}): Promise<MailResult> {
  const { to, inviteUrl, organizationName, expiresAt } = params;
  const where = organizationName ? `${organizationName}의 ` : '';

  const expiryLine = expiresAt
    ? `<p style="font-size:13px;color:#64748b">이 링크는 ${escapeHtml(
        new Date(expiresAt).toLocaleString('ko-KR')
      )}까지 유효합니다.</p>`
    : '';

  return sendMail(
    to,
    `[${APP_NAME}] 가입 초대`,
    layout(
      `${where}${APP_NAME} 사용자로 초대되었습니다`,
      `<p style="font-size:15px;line-height:1.7">아래 버튼을 눌러 비밀번호를 설정하면 바로 이용할 수 있습니다.</p>
       ${button(inviteUrl, '가입 완료하기')}
       ${expiryLine}`
    )
  );
}

/** 일괄 등록 시 임시 비밀번호 안내 메일 */
export function sendTempPasswordEmail(params: {
  to: string;
  fullName: string;
  tempPassword: string;
  loginUrl: string;
}): Promise<MailResult> {
  const { to, fullName, tempPassword, loginUrl } = params;

  return sendMail(
    to,
    `[${APP_NAME}] 계정이 생성되었습니다`,
    layout(
      `${fullName}님, 계정이 생성되었습니다`,
      `<p style="font-size:15px;line-height:1.7">아래 임시 비밀번호로 로그인한 뒤 비밀번호를 변경해주세요.</p>
       <table style="margin:20px 0;font-size:15px">
         <tr><td style="padding:6px 16px 6px 0;color:#64748b">아이디</td><td style="font-weight:600">${escapeHtml(to)}</td></tr>
         <tr><td style="padding:6px 16px 6px 0;color:#64748b">임시 비밀번호</td><td style="font-family:monospace;font-weight:700;color:#003087">${escapeHtml(tempPassword)}</td></tr>
       </table>
       ${button(loginUrl, '로그인하기')}`
    )
  );
}
