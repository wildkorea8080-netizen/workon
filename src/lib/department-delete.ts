// src/lib/department-delete.ts
// 부서를 지워도 되는지 — 남은 것을 센다(2026-11-18).
//
// 부서 행을 지우면 DB가 조용히 따라 한다(외래 키):
// - **함께 지움(CASCADE)**: 그 부서의 대화(→ 메시지)·비서·문서·답변 평가·앱 예약/연동/일괄 실행·초대·금지어
// - **부서 칸을 비움(SET NULL)**: 직원(소속을 잃어 로그인이 막힘)·하위 부서(최상위로 올라감)·사용 기록·보안 로그·접속 기록
//   (관리 범위 부서로 거르는 감사 화면에서 그 기록이 사라진다 — 기록은 남아도 어느 부서 것인지를 잃는다)
// - **막음(NO ACTION)**: 채팅 첨부·만든 파일·업무 작업
//
// 예전 검사는 하위 부서·직원·비서 수만 봤고, **수를 못 읽으면(오류) '없음'으로 보고 지웠다.** 직원·비서를 옮긴 '빈' 부서를 지우면
// 그 부서에서 나눈 대화가 함께 지워지고 사용 기록의 부서가 비었다. 이제 못 읽으면 지우지 않고(닫힘), 기록이 남은 부서는 지우지 않는다.
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/** 기록 표 — 한 줄이라도 있으면 지우지 않는다. 이름은 안내에 쓴다 */
export const DEPARTMENT_RECORD_TABLES: ReadonlyArray<{ table: string; label: string }> = [
  { table: 'conversations', label: '대화' },
  { table: 'usage_logs', label: '사용 기록' },
  { table: 'security_logs', label: '보안 로그' },
  { table: 'access_logs', label: '접속 기록' },
  { table: 'documents', label: '문서' },
  { table: 'message_feedback', label: '답변 평가' },
  { table: 'app_schedules', label: '앱 예약' },
  { table: 'app_webhooks', label: '앱 연동' },
  { table: 'app_batches', label: '앱 일괄 실행' },
  { table: 'work_tasks', label: '업무 작업' },
  { table: 'generated_files', label: '만든 파일' },
  { table: 'chat_attachments', label: '대화 첨부' },
  // 부서 자료함(0106) — 부서 사람이 함께 쓰는 파일. 남아 있으면 부서를 지우지 않는다(옮기거나 지운 뒤)
  { table: 'my_library_files', label: '부서 자료함' },
];

export type DepartmentDeleteCheck =
  | { ok: false }
  | {
      ok: true;
      /** 옮기거나 정리하면 없어지는 것 — '하위 부서 2개' 같은 글 */
      blockers: string[];
      /** 남은 기록의 이름 — 지우지 않는 것이라 부서도 지우지 않는다 */
      records: string[];
    };

type CountResult = { count: number | null; error: unknown };
type RowsResult = { data: unknown[] | null; error: unknown };

const head = { count: 'exact', head: true } as const;

/**
 * 부서에 남은 것을 센다. 하나라도 못 읽으면 `{ ok: false }` — 부르는 쪽은 지우지 않는다.
 * 직원·비서는 보이는 것과 안 보이는 것(탈퇴 계정·지운 비서)을 갈라 알린다 — 화면에 안 보이는데 '직원 1명이 남아'라고 하면 무엇을 옮길지 알 수 없다.
 */
export async function checkDepartmentDelete(departmentId: string): Promise<DepartmentDeleteCheck> {
  const counts = (await Promise.all([
    supabaseAdmin.from('departments').select('id', head).eq('parent_id', departmentId),
    supabaseAdmin.from('users').select('id', head).eq('department_id', departmentId).is('deleted_at', null),
    supabaseAdmin.from('users').select('id', head).eq('department_id', departmentId).not('deleted_at', 'is', null),
    supabaseAdmin.from('agents').select('id', head).eq('department_id', departmentId).is('deleted_at', null),
    supabaseAdmin.from('agents').select('id', head).eq('department_id', departmentId).not('deleted_at', 'is', null),
    // 수락된 초대는 '누가 누구를 어떤 권한으로 초대했는지'의 흔적이다 — 기다리는 초대는 부서와 함께 지워도 된다
    supabaseAdmin.from('invitations').select('id', head).eq('department_id', departmentId).not('accepted_at', 'is', null),
  ])) as CountResult[];

  const records = (await Promise.all(
    DEPARTMENT_RECORD_TABLES.map(({ table }) =>
      supabaseAdmin.from(table).select('department_id').eq('department_id', departmentId).limit(1),
    ),
  )) as RowsResult[];

  // 못 읽은 것을 0으로 보지 않는다 — 수가 숫자로 오지 않은 것도 못 읽은 것이다
  if (counts.some((r) => r.error || typeof r.count !== 'number')) return { ok: false };
  if (records.some((r) => r.error || !Array.isArray(r.data))) return { ok: false };

  const [children, users, withdrawn, agents, removedAgents, acceptedInvites] = counts.map((r) => r.count as number);

  const blockers: string[] = [];
  if (children) blockers.push(`하위 부서 ${children}개`);
  if (users) blockers.push(`소속 직원 ${users}명`);
  if (agents) blockers.push(`비서 ${agents}개`);

  const kept: string[] = [];
  if (withdrawn) kept.push(`탈퇴 처리된 계정 ${withdrawn}개`);
  if (removedAgents) kept.push(`지운 비서 ${removedAgents}개`);
  if (acceptedInvites) kept.push(`수락된 초대 ${acceptedInvites}건`);
  DEPARTMENT_RECORD_TABLES.forEach(({ label }, i) => {
    if ((records[i].data as unknown[]).length > 0) kept.push(label);
  });

  return { ok: true, blockers, records: kept };
}

/** 지우지 못하는 까닭 — 없으면 null */
export function departmentDeleteMessage(check: { blockers: string[]; records: string[] }): string | null {
  if (check.blockers.length > 0) {
    return `${check.blockers.join(', ')}이(가) 남아 있어 삭제할 수 없습니다. 먼저 옮기거나 정리해주세요.`;
  }
  if (check.records.length > 0) {
    return `이 부서로 남은 기록(${check.records.join(', ')})이 있어 삭제할 수 없습니다. 기록은 지우지 않습니다 — 쓰지 않는 부서는 이름을 바꾸거나 다른 부서 아래로 옮겨 정리해 주세요.`;
  }
  return null;
}
