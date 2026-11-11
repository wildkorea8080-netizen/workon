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

/**
 * 개인 월 한도 알림(0052) — 직원 본인에게. 기관·부서 알림과 달리 받는 사람이 한도를 바꿀 수 없으니 할 일은 '관리자에게 요청'이다.
 * 금액·기준·시각만 싣는다(무엇을 물었는지 같은 사용 내용은 싣지 않는다)
 */
export function personalBudgetAlertMail(params: {
  organizationName: string;
  userName: string | null;
  threshold: number;
  used: number;
  limit: number;
  percent: number;
  statsUrl: string;
  checkedAt: Date;
}): { subject: string; html: string } {
  const { organizationName, userName, threshold, used, limit, percent, statsUrl, checkedAt } = params;
  const exhausted = threshold >= 100;
  const who = userName?.trim() ? `${userName.trim()}님` : '회원님';
  const heading = exhausted
    ? `${who}의 이번 달 개인 AI 사용 한도를 모두 사용했습니다`
    : `${who}의 이번 달 개인 AI 사용이 한도의 ${threshold}%에 이르렀습니다`;
  const subject = exhausted
    ? `[${APP_NAME}] 이번 달 개인 AI 사용 한도 모두 사용 — 다음 달 1일까지 이용이 멈췄습니다`
    : `[${APP_NAME}] 이번 달 개인 AI 사용 한도 ${threshold}% 도달`;
  const kst = (d: Date) => new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const won = (n: number) => `${Math.round(n).toLocaleString('ko-KR')}원`;
  const rows: Array<[string, string]> = [
    ['기관', organizationName],
    ['사용', `${won(used)} / ${won(limit)} (${percent}%)`],
    ['확인 시각', `${kst(checkedAt)} (한국 시간)`],
  ];
  const next = exhausted
    ? '다음 달 1일(한국 시간)까지 AI 대화와 업무 문서 만들기를 쓸 수 없습니다. 이번 달에 더 써야 하면 기관 관리자에게 개인 한도 조정을 요청해 주세요.'
    : '100%가 되면 다음 달 1일(한국 시간)까지 AI 대화와 업무 문서 만들기가 멈춥니다. 남은 업무를 확인해 주세요.';
  const table = rows
    .map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#64748b">${escapeHtml(k)}</td><td style="font-weight:600">${escapeHtml(v)}</td></tr>`)
    .join('');
  return {
    subject,
    html: layout(
      heading,
      `<table style="margin:8px 0 20px;font-size:15px">${table}</table>
       <p style="font-size:15px;line-height:1.7">${escapeHtml(next)}</p>
       ${button(statsUrl, '내 사용현황 보기')}
       <p style="font-size:13px;color:#64748b">같은 달에는 기준마다 한 번만 보냅니다.</p>`
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

/**
 * 앱 예약 실행을 마쳤다는 알림(직원이 '완료 메일'을 고른 예약만, 0069) — 앱·예약·시각·다음 실행·결과 보기 링크만.
 * **결과 글·입력값은 싣지 않는다** — 메일은 기관 밖 메일함으로 갈 수 있고, 결과는 로그인해 본다
 */
export function scheduleSuccessMail(params: {
  appName: string;
  description: string;
  nextRunAt: string | null;
  finishedAt: Date;
  resultUrl: string;
  schedulesUrl: string;
  /** 결과 한글 파일(0071) — 있으면 '한글 파일 받기' 단추(로그인한 주인만 받는다) */
  fileUrl?: string;
}): { subject: string; html: string } {
  const { appName, description, nextRunAt, finishedAt, resultUrl, schedulesUrl, fileUrl } = params;
  const kst = (d: Date) => new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const rows: Array<[string, string]> = [
    ['앱', appName],
    ['예약', description],
    ['마친 시각', `${kst(finishedAt)} (한국 시간)`],
  ];
  if (nextRunAt) rows.push(['다음 실행', `${kst(new Date(nextRunAt))} (한국 시간)`]);
  const table = rows
    .map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#64748b;vertical-align:top">${escapeHtml(k)}</td><td style="font-weight:600">${escapeHtml(v)}</td></tr>`)
    .join('');
  return {
    subject: `[${APP_NAME}] 앱 예약 실행을 마쳤습니다 — ${appName}`,
    html: layout(
      `${appName} 예약 실행을 마쳤습니다`,
      `<table style="margin:8px 0 20px;font-size:15px">${table}</table>
       <p style="font-size:15px;line-height:1.7">AI가 작성한 결과입니다. 로그인해 내용을 검토한 뒤 사용해 주세요. 결과 글은 메일에 싣지 않습니다.</p>
       ${button(resultUrl, '결과 보기')}
       ${fileUrl ? button(fileUrl, '한글 파일 받기') : ''}
       <p style="font-size:13px;line-height:1.7;color:#64748b">이 메일을 그만 받으려면 <a href="${escapeHtml(schedulesUrl)}">앱 예약</a>에서 예약을 고쳐 '완료 메일 받기'를 끄세요.</p>`
    ),
  };
}

export function sendScheduleSuccessEmail(to: string, mail: { subject: string; html: string }): Promise<MailResult> {
  return sendMail(to, mail.subject, mail.html);
}

export type AutomationNoticeKind = 'webhook_revoked' | 'schedule_paused' | 'schedule_unlocked' | 'batch_stopped';

/**
 * 관리자 조치 알림(2026-11-08) — 기관 관리자가 직원의 앱 연동을 회수하거나 예약을 멈추·잠금을 풀었을 때 그 직원에게.
 * 무엇이·어떻게·언제·관리자가 적은 사유·할 일만. 관리자 이름·입력값·결과·토큰은 싣지 않는다
 */
export function automationAdminNoticeMail(params: {
  kind: AutomationNoticeKind;
  appName: string;
  target: string;
  reason: string;
  at: Date;
  url: string;
}): { subject: string; html: string } {
  const { kind, appName, target, reason, at, url } = params;
  const kst = (d: Date) => new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const what = kind === 'webhook_revoked' ? '앱 연동을 회수했습니다' : kind === 'schedule_paused' ? '앱 예약을 멈췄습니다' : kind === 'batch_stopped' ? '앱 일괄 실행을 멈췄습니다' : '앱 예약의 잠금을 풀었습니다';
  const next = kind === 'batch_stopped'
    ? '기다리던 줄은 실행하지 않습니다(이미 실행 중이던 줄은 끝까지 갑니다). 마친 줄의 결과는 실행 화면의 결과 엑셀로 받을 수 있습니다. 다시 하려면 사유를 확인한 뒤 새로 만들거나 기관 관리자에게 문의하세요.'
    : kind === 'webhook_revoked'
    ? '이 연동 토큰으로는 더 이상 앱을 실행할 수 없습니다(되돌릴 수 없음). 계속 연동해야 하면 사유를 확인한 뒤 새 연동을 만들거나 기관 관리자에게 문의하세요.'
    : kind === 'schedule_paused'
      ? '이 예약은 관리자가 잠가 직원이 다시 켤 수 없습니다. 다시 써야 하면 기관 관리자에게 문의하세요. 예약을 지우는 것은 할 수 있습니다.'
      : '예약은 멈춘 채로 있습니다. 앱 예약 화면에서 다시 켜거나 고칠 수 있습니다.';
  const rows: Array<[string, string]> = [['앱', appName], ['대상', target], ['시각', `${kst(at)} (한국 시간)`], ['관리자가 적은 사유', reason]];
  const table = rows
    .map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#64748b;vertical-align:top">${escapeHtml(k)}</td><td style="font-weight:600">${escapeHtml(v)}</td></tr>`)
    .join('');
  return {
    subject: `[${APP_NAME}] 기관 관리자가 ${what} — ${appName}`,
    html: layout(
      `기관 관리자가 ${what}`,
      `<table style="margin:8px 0 20px;font-size:15px">${table}</table>
       <p style="font-size:15px;line-height:1.7">${escapeHtml(next)}</p>
       ${button(url, kind === 'webhook_revoked' ? '앱 연동 보기' : kind === 'batch_stopped' ? '실행 화면 열기' : '앱 예약 보기')}`
    ),
  };
}

export function sendAutomationAdminNoticeEmail(to: string, mail: { subject: string; html: string }): Promise<MailResult> {
  return sendMail(to, mail.subject, mail.html);
}

/** 앱 예약 실행기 점검 안내의 글(슈퍼관리자에게) — 숫자·시각·조치만, 직원·입력값은 싣지 않는다 */
export function scheduleRunnerAlertMail(params: {
  problems: string[];
  runnerLastRunAt: string | null;
  activeCount: number;
  checkedAt: Date;
  superUrl: string;
}): { subject: string; html: string } {
  const { problems, runnerLastRunAt, activeCount, checkedAt, superUrl } = params;
  const kst = (d: Date) => new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const rows: Array<[string, string]> = [
    ['점검 시각', `${kst(checkedAt)} (한국 시간)`],
    ['실행기 마지막 호출', runnerLastRunAt ? `${kst(new Date(runnerLastRunAt))} (한국 시간)` : '기록 없음'],
    ['켜진 예약', `${activeCount}개`],
  ];
  const table = rows
    .map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#64748b;vertical-align:top">${escapeHtml(k)}</td><td style="font-weight:600">${escapeHtml(v)}</td></tr>`)
    .join('');
  const list = problems.map((p) => `<li style="margin:4px 0">${escapeHtml(p)}</li>`).join('');
  return {
    subject: `[${APP_NAME}] 앱 예약 실행기 확인 필요`,
    html: layout(
      '앱 예약 실행기를 확인해 주세요',
      `<ul style="font-size:15px;line-height:1.7;padding-left:20px">${list}</ul>
       <table style="margin:8px 0 20px;font-size:15px">${table}</table>
       <p style="font-size:14px;line-height:1.7;color:#475569">Supabase pg_cron 작업 <b>workon-app-schedules</b>(5분마다)가 돌고 있는지, cron.job_run_details·net._http_response의 최근 결과가 200인지 확인해 주세요. 응답이 401이면 Vault <b>work_worker_secret</b>과 Vercel <b>WORK_WORKER_SECRET</b>이 같은지 봅니다.</p>
       ${button(superUrl, '운영 기록 보기')}`
    ),
  };
}

/** 앱 예약 실행기 점검 안내 한 통 — 슈퍼관리자마다 따로 */
export function sendScheduleRunnerAlertEmail(to: string, mail: { subject: string; html: string }): Promise<MailResult> {
  return sendMail(to, mail.subject, mail.html);
}

/**
 * 입력형 앱 일괄 실행(0077)을 마쳤다는 안내의 글(보내지 않음 — 시험이 글을 본다). 만든 직원에게 한 번.
 * 줄 수·멈춘 이유·보내기 전 확인을 기다리는 결과 수만 싣고, 입력값·결과 글은 싣지 않는다
 */
export function batchFinishedMail(params: {
  appName: string;
  batchName: string;
  stopped: boolean;
  stopReason: string | null;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  /** 보내기 전 확인(0078)을 기다리는 이 묶음의 결과 수 */
  awaitingApproval: number;
  finishedAt: Date;
  runUrl: string;
  /** 마친 줄이 있을 때만 — 결과 엑셀(로그인한 주인만 받는다) */
  exportUrl?: string;
}): { subject: string; html: string } {
  const { appName, batchName, stopped, stopReason, total, done, failed, skipped, awaitingApproval, finishedAt, runUrl, exportUrl } = params;
  const kst = (d: Date) => new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const rows: Array<[string, string]> = [
    ['앱', appName],
    ['일괄 실행', batchName],
    ['마친 시각', `${kst(finishedAt)} (한국 시간)`],
    ['줄', `전체 ${total}줄 · 마침 ${done} · 실패 ${failed}${skipped ? ` · 건너뜀 ${skipped}` : ''}`],
  ];
  if (stopped && stopReason) rows.push(['멈춘 이유', stopReason]);
  if (awaitingApproval > 0) rows.push(['보내기 전 확인', `${awaitingApproval}건이 확인을 기다립니다`]);
  const table = rows
    .map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#64748b;vertical-align:top">${escapeHtml(k)}</td><td style="font-weight:600">${escapeHtml(v)}</td></tr>`)
    .join('');
  const notes = [
    'AI가 작성한 결과입니다. 로그인해 내용을 검토한 뒤 사용해 주세요. 입력값과 결과 글은 메일에 싣지 않습니다.',
    ...(awaitingApproval > 0 ? ['결과를 외부 시스템으로 보내기 전에 실행 화면의 \'보내기 전 확인할 결과\'에서 보낼지 정해 주세요 — 7일 안에 정하지 않으면 보내지 않습니다.'] : []),
  ];
  return {
    subject: stopped ? `[${APP_NAME}] 앱 일괄 실행이 멈췄습니다 — ${appName}` : `[${APP_NAME}] 앱 일괄 실행을 마쳤습니다 — ${appName}`,
    html: layout(
      stopped ? `${appName} 일괄 실행을 멈췄습니다` : `${appName} 일괄 실행을 마쳤습니다`,
      `<table style="margin:8px 0 20px;font-size:15px">${table}</table>
       ${notes.map((n) => `<p style="font-size:15px;line-height:1.7">${escapeHtml(n)}</p>`).join('')}
       ${button(runUrl, '실행 화면 열기')}
       ${exportUrl ? button(exportUrl, '결과 엑셀 받기') : ''}`
    ),
  };
}

/** 일괄 실행 마침 안내 한 통 — 만든 직원에게만 */
export function sendBatchFinishedEmail(to: string, mail: { subject: string; html: string }): Promise<MailResult> {
  return sendMail(to, mail.subject, mail.html);
}
