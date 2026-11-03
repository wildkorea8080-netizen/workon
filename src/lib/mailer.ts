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

/** 기관·부서 예산 알림 메일의 글(보내지 않음 — 시험이 글을 본다). 개인별 사용 내역은 싣지 않는다 */
export function budgetAlertMail(params: {
  organizationName: string;
  /** 부서 월 한도 알림일 때만 */
  departmentName?: string | null;
  kind: 'annual_budget' | 'monthly_tokens' | 'department_monthly';
  threshold: number;
  used: number;
  limit: number;
  percent: number;
  periodEndsAt: string | null;
  adminUrl: string;
  checkedAt: Date;
}): { subject: string; html: string } {
  const { organizationName, departmentName, kind, threshold, used, limit, percent, periodEndsAt, adminUrl, checkedAt } = params;
  const department = kind === 'department_monthly';
  const label = kind === 'annual_budget' ? '연간 계약 예산' : kind === 'monthly_tokens' ? '이번 달 토큰 한도' : '이번 달 부서 예산';
  const scope = department && departmentName ? `${organizationName} ${departmentName}` : organizationName;
  const amount = (n: number) => `${Math.round(n).toLocaleString('ko-KR')}${kind === 'monthly_tokens' ? ' 토큰' : '원'}`;
  const exhausted = threshold >= 100;
  const heading = exhausted
    ? `${scope}의 AI ${label}을 모두 사용했습니다`
    : `${scope}의 AI ${label} 사용이 ${threshold}%에 이르렀습니다`;
  const subjectScope = department && departmentName ? ` ${departmentName}` : '';
  const subject = exhausted
    ? `[${APP_NAME}]${subjectScope} AI ${label} 모두 사용 — 이용이 멈췄습니다`
    : `[${APP_NAME}]${subjectScope} AI ${label} ${threshold}% 도달`;
  const kst = (d: Date) => new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const rows: Array<[string, string]> = [
    ['사용', `${amount(used)} / ${amount(limit)} (${percent}%)`],
    ['확인 시각', `${kst(checkedAt)} (한국 시간)`],
  ];
  if (periodEndsAt) rows.push(['계약 종료', kst(new Date(periodEndsAt)).slice(0, 10)]);
  const who = department ? '이 부서 직원' : '직원';
  const next = exhausted
    ? `지금은 ${who}이 AI 대화와 업무 문서 만들기를 쓸 수 없습니다. ${department ? '부서 한도는 부서 관리 화면에서 조정할 수 있고, 다음 달 1일(한국 시간)에 새로 시작합니다.' : '계약 담당자와 증액·조정을 협의해 주세요.'}`
    : `100%가 되면 ${who}의 AI 대화와 업무 문서 만들기가 멈춥니다. 남은 기간과 사용 추세를 확인해 주세요.`;
  const table = rows
    .map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#64748b">${escapeHtml(k)}</td><td style="font-weight:600">${escapeHtml(v)}</td></tr>`)
    .join('');
  return {
    subject,
    html: layout(
      heading,
      `<table style="margin:8px 0 20px;font-size:15px">${table}</table>
       <p style="font-size:15px;line-height:1.7">${escapeHtml(next)}</p>
       ${button(adminUrl, department ? '부서 한도 보기' : '예산 현황 보기')}
       <p style="font-size:13px;color:#64748b">같은 기간에는 기준마다 한 번만 보냅니다.</p>`
    ),
  };
}

/** 예산 알림 한 통 — 받는 사람마다 따로 보낸다(서로의 주소가 보이지 않게) */
export function sendBudgetAlertEmail(to: string, mail: { subject: string; html: string }): Promise<MailResult> {
  return sendMail(to, mail.subject, mail.html);
}

/** 입력형 앱 예약 실행 실패 안내의 글(보내지 않음 — 시험이 글을 본다). 입력값·결과 글은 싣지 않는다 */
export function scheduleFailureMail(params: {
  appName: string;
  description: string;
  error: string;
  paused: boolean;
  nextRunAt: string | null;
  schedulesUrl: string;
  failedAt: Date;
}): { subject: string; html: string } {
  const { appName, description, error, paused, nextRunAt, schedulesUrl, failedAt } = params;
  const kst = (d: Date) => new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const rows: Array<[string, string]> = [
    ['앱', appName],
    ['예약', description],
    ['실패 시각', `${kst(failedAt)} (한국 시간)`],
    ['이유', error],
  ];
  if (!paused && nextRunAt) rows.push(['다음 실행', `${kst(new Date(nextRunAt))} (한국 시간)`]);
  const table = rows
    .map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#64748b;vertical-align:top">${escapeHtml(k)}</td><td style="font-weight:600">${escapeHtml(v)}</td></tr>`)
    .join('');
  const next = paused
    ? '이 예약은 멈췄습니다. 입력과 앱 설정을 확인한 뒤 예약 화면에서 다시 켜 주세요.'
    : '다음 차례에 다시 실행합니다. 연속 3회 실패하면 예약을 멈추고 알립니다.';
  return {
    subject: paused ? `[${APP_NAME}] 앱 예약이 멈췄습니다 — ${appName}` : `[${APP_NAME}] 앱 예약 실행 실패 — ${appName}`,
    html: layout(
      paused ? `${appName} 예약 실행을 멈췄습니다` : `${appName} 예약 실행이 실패했습니다`,
      `<table style="margin:8px 0 20px;font-size:15px">${table}</table>
       <p style="font-size:15px;line-height:1.7">${escapeHtml(next)}</p>
       ${button(schedulesUrl, '앱 예약 보기')}`
    ),
  };
}

/** 예약 실패 안내 한 통 — 예약한 직원에게만 */
export function sendScheduleFailureEmail(to: string, mail: { subject: string; html: string }): Promise<MailResult> {
  return sendMail(to, mail.subject, mail.html);
}
