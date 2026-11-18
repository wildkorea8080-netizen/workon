import { NextRequest, NextResponse } from 'next/server';
import { checkUserSeats, seatErrorBody } from '@/lib/user-seats';
import { authErrorMessage } from '@/lib/auth-error-text';

/** 줄 결과에 보일 안내(2026-11-17) — Auth·DB 원문(영문)은 결과 표·CSV에 싣지 않고 서버 기록에만 */
class RowError extends Error {}
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import crypto from 'crypto';
import { sendTempPasswordEmail, isMailConfigured } from '@/lib/mailer';
import { APP_URL } from '@/lib/config';
import { getManagedDepartmentIds } from '@/lib/department-scope';
import { logSecurityEvent } from '@/lib/security-log';

export const dynamic = 'force-dynamic';

/** 한 번에 등록할 수 있는 직원 수(2026-11-17) */
const MAX_BULK_ROWS = 500;

interface CsvRow {
  부서명: string;
  상위부서명?: string;
  직원이름: string;
  이메일: string;
  직책?: string;
  권한: string;
}

export interface RegisterResult {
  row: number;
  이메일: string;
  직원이름: string;
  부서명: string;
  success: boolean;
  error?: string;
  tempPassword?: string;
  /** 임시 비밀번호 안내 메일 발송 여부 (메일 미설정 시 false) */
  emailSent?: boolean;
}

function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

function validateRow(row: CsvRow, index: number): string | null {
  if (!row.부서명?.trim()) return `${index + 1}행: 부서명 필수`;
  if (!row.직원이름?.trim()) return `${index + 1}행: 직원이름 필수`;
  if (!row.이메일?.trim()) return `${index + 1}행: 이메일 필수`;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.이메일.trim())) return `${index + 1}행: 이메일 형식 오류`;
  const role = row.권한?.trim().toUpperCase();
  if (!['ADMIN', 'USER'].includes(role)) return `${index + 1}행: 권한은 ADMIN 또는 USER`;
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json(
        { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      );
    }

    const adminDeptId = session.user.departmentId;
    if (!adminDeptId) {
      return NextResponse.json(
        { ok: false, error: { message: '관리자 부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }

    let body: { rows?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ ok: false, error: { message: '요청 형식이 올바르지 않습니다.' } }, { status: 400 });
    }
    const rows = ((body?.rows ?? []) as CsvRow[]);

    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json(
        { ok: false, error: { message: '등록할 직원 데이터가 없습니다.' } },
        { status: 400 }
      );
    }
    // 한 번에 500명까지(2026-11-17) — 줄마다 계정·메일을 만들어 함수 시간 안에 끝나야 한다
    if (rows.length > MAX_BULK_ROWS) {
      return NextResponse.json(
        { ok: false, error: { message: `한 번에 ${MAX_BULK_ROWS}명까지 등록할 수 있습니다. 파일을 나눠 올려 주세요.` } },
        { status: 400 }
      );
    }

    // 기관의 사용자 수 상한(2026-11-17) — 남은 자리만큼만 만들고, 나머지 줄은 '상한'으로 알린다. 못 세면 아무것도 만들지 않는다
    const seats = await checkUserSeats(adminDeptId, 0);
    if (!seats.ok) return NextResponse.json(seatErrorBody(seats), { status: seats.status });
    let seatsLeft = seats.remaining; // null = 무제한

    // 관리자가 속한 기관. 모든 부서 조회·생성을 이 기관으로 한정한다.
    const { data: adminDept, error: adminDeptError } = await supabaseAdmin
      .from('departments')
      .select('name, organization_id, parent_id')
      .eq('id', adminDeptId)
      .maybeSingle();

    // 못 읽은 것을 '기관에 연결 안 됨'으로 보지 않는다(2026-11-18)
    if (adminDeptError) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } },
        { status: 503 }
      );
    }

    const organizationId = adminDept?.organization_id;
    if (!organizationId) {
      return NextResponse.json(
        {
          ok: false,
          error: { message: '관리자 부서가 기관에 연결되어 있지 않습니다. 슈퍼관리자에게 문의하세요.' },
        },
        { status: 409 }
      );
    }

    // **관리 범위**(2026-11-18) — 예전에는 기관 안의 아무 부서나 이름으로 찾아 넣었다. 하위 부서 관리자가 CSV에 기관 직속 부서 이름과
    // 권한 ADMIN을 적으면 기관 전체 관리자 계정이 만들어졌고(임시 비밀번호는 응답으로 받는다), 상위 없는 새 부서도 만들 수 있었다
    // (부서 화면은 기관 직속 관리자만 최상위 부서를 만든다). 이제 있는 부서는 관리 범위 안일 때만, 새 부서는 관리 범위 안의 부서 아래에만 만든다.
    const managedIds = new Set(await getManagedDepartmentIds(adminDeptId));
    const isRootAdmin = adminDept?.parent_id == null;

    // 부서 캐시 (같은 이름 중복 조회 방지)
    const deptCache = new Map<string, string>();
    // 이번에 만든 부서 — 보안 로그에 남긴다
    const createdDepartments: Array<{ id: string; name: string; parentId: string | null; parentName: string | null }> = [];

    function makeSlug(name: string) {
      return (
        name
          .toLowerCase()
          .replace(/\s+/g, '-')
          .replace(/[^a-z0-9가-힣-]/g, '') +
        '-' +
        Date.now().toString(36) +
        Math.random().toString(36).slice(2, 6)
      );
    }

    /**
     * 부서를 찾거나 만든다.
     *
     * 조회를 반드시 organization_id로 한정한다. 예전에는 이름만으로 조회해
     * 다른 기관의 동명 부서('총무과')가 잡혔고, 그 결과 이 기관 직원이 타 기관
     * 부서에 배정돼 타 기관 자료에 접근할 수 있었다.
     */
    async function findOrCreateDept(deptName: string, parentName?: string): Promise<string> {
      const name = deptName.trim();
      if (deptCache.has(name)) return deptCache.get(name)!;

      const { data: existing, error: existingError } = await supabaseAdmin
        .from('departments')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('name', name)
        .maybeSingle();

      // 못 읽은 것을 '없는 부서'로 보고 새로 만들지 않는다
      if (existingError) throw new RowError(`부서를 확인하지 못했습니다: ${name}`);

      if (existing) {
        if (!managedIds.has(existing.id)) throw new RowError(`관리 범위 밖의 부서에는 등록할 수 없습니다: ${name}`);
        deptCache.set(name, existing.id);
        return existing.id;
      }

      // 상위 부서가 지정돼 있으면 먼저 만들어 계층을 잇는다(그 상위도 관리 범위 안이어야 한다).
      // 자기 자신을 상위로 지정한 행은 무시한다.
      // 상위가 없으면: 기관 직속 관리자는 최상위 부서로(예전과 같음), 그 밖의 관리자는 **자기 부서 아래**로 —
      // 최상위로 만들면 그 부서가 상위 부서 관리자의 관리 범위에서 빠진다.
      let parentId: string | null = isRootAdmin ? null : (adminDeptId ?? null);
      const parent = parentName?.trim();
      if (parent && parent !== name) {
        parentId = await findOrCreateDept(parent);
      }

      const { data: newDept, error } = await supabaseAdmin
        .from('departments')
        .insert({
          name,
          slug: makeSlug(name),
          organization_id: organizationId,
          parent_id: parentId,
          description: parent ? `${parent} 산하 부서` : `${adminDept?.name ?? ''} 산하 부서`,
        })
        .select('id')
        .single();

      if (error || !newDept) throw new RowError(`부서를 만들지 못했습니다: ${name}`);
      deptCache.set(name, newDept.id);
      managedIds.add(newDept.id);
      createdDepartments.push({ id: newDept.id, name, parentId, parentName: parent && parent !== name ? parent : parentId ? adminDept?.name ?? null : null });
      return newDept.id;
    }

    const results: RegisterResult[] = [];
    // 이번에 만든 관리자 계정 — 하나씩 보안 로그에 남긴다
    const createdAdminIds: string[] = [];
    const impersonating = session.user.isImpersonating === true;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const validErr = validateRow(row, i);

      if (validErr) {
        results.push({
          row: i + 1, 이메일: row.이메일 ?? '', 직원이름: row.직원이름 ?? '',
          부서명: row.부서명 ?? '', success: false, error: validErr,
        });
        continue;
      }

      const email = row.이메일.trim();
      const role = row.권한.trim().toUpperCase() as 'ADMIN' | 'USER';
      const tempPassword = generateTempPassword();

      if (seatsLeft !== null && seatsLeft <= 0) {
        results.push({
          row: i + 1, 이메일: email, 직원이름: row.직원이름.trim(),
          부서명: row.부서명.trim(), success: false, error: `기관 사용자 수 상한(${seats.limit}명)에 닿아 등록하지 않음`,
        });
        continue;
      }

      // 대리 접근 중의 조작은 그 기관 관리자 이름으로 기록된다 — 관리자 계정은 만들지 않는다(직원 권한 바꾸기·관리자 초대와 같은 규칙)
      if (role === 'ADMIN' && impersonating) {
        results.push({
          row: i + 1, 이메일: email, 직원이름: row.직원이름.trim(),
          부서명: row.부서명.trim(), success: false, error: '대리 접근 중에는 관리자 계정을 만들 수 없습니다',
        });
        continue;
      }

      try {
        const deptId = await findOrCreateDept(row.부서명, row.상위부서명);

        // 이미 존재하는 이메일 확인 — 못 읽으면 '없음'으로 보고 계정을 만들지 않는다
        const { data: existingUsers, error: existingUserError } = await supabaseAdmin
          .from('users')
          .select('id')
          .eq('email', email)
          .limit(1);
        if (existingUserError) throw new RowError('등록 여부를 확인하지 못했습니다. 잠시 뒤 다시 올려 주세요.');
        const existingUser = (existingUsers ?? [])[0];

        if (existingUser) {
          results.push({
            row: i + 1, 이메일: email, 직원이름: row.직원이름.trim(),
            부서명: row.부서명.trim(), success: false, error: '이미 등록된 이메일',
          });
          continue;
        }

        // Supabase Auth 사용자 생성
        const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
          email,
          password: tempPassword,
          email_confirm: true,
        });

        if (authError || !authUser.user) {
          console.warn('[bulk-register] createUser failed', authError?.status ?? '', authError?.code ?? '');
          throw new RowError(authError ? authErrorMessage(authError).replace('회원가입', '계정 만들기') : '계정을 만들지 못했습니다.');
        }

        // users 테이블 삽입 (비밀번호는 Supabase Auth가 관리)
        const { error: insertError } = await supabaseAdmin
          .from('users')
          .insert({
            id: authUser.user.id,
            email,
            full_name: row.직원이름.trim(),
            role,
            department_id: deptId,
            position: row.직책?.trim() || null,
            password_must_change: true, // 임시 비밀번호 — 첫 로그인 때 바꾸게 한다(0093)
          });

        if (insertError) {
          // Auth 사용자 롤백
          await supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
          console.warn('[bulk-register] users insert failed', insertError.code);
          throw new RowError('직원 정보를 저장하지 못했습니다.');
        }

        // 임시 비밀번호 안내 메일 (미설정이면 조용히 건너뛴다 — 등록 자체는 성공)
        const mail = await sendTempPasswordEmail({
          to: email,
          fullName: row.직원이름.trim(),
          tempPassword,
          loginUrl: `${APP_URL}/login`,
        });

        if (seatsLeft !== null) seatsLeft -= 1;
        if (role === 'ADMIN') createdAdminIds.push(authUser.user.id);
        results.push({
          row: i + 1, 이메일: email, 직원이름: row.직원이름.trim(),
          부서명: row.부서명.trim(), success: true, tempPassword,
          emailSent: mail.sent,
        });
      } catch (err) {
        results.push({
          row: i + 1, 이메일: email, 직원이름: row.직원이름.trim(),
          부서명: row.부서명.trim(), success: false,
          error: err instanceof RowError ? err.message : '등록하지 못했습니다.',
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    // ── 보안 로그(2026-11-18 — 그 전에는 일괄 등록으로 관리자 계정을 만들어도 어디에도 남지 않았다) ──
    // 관리자 계정은 하나씩(high), 전체는 수만 한 줄로, 새로 만든 부서는 부서 화면에서 만든 것과 같은 사건으로. 이메일·임시 비밀번호는 싣지 않는다.
    const mark = impersonating ? { impersonating: true } : {};
    for (const dept of createdDepartments) {
      await logSecurityEvent(adminDeptId, session.user.id, 'department_created',
        { department_id: dept.id, dept_name: dept.name, parent_id: dept.parentId, parent_name: dept.parentName, via: 'bulk_register', ...mark }, 'low');
    }
    for (const id of createdAdminIds) {
      await logSecurityEvent(adminDeptId, session.user.id, 'user_created',
        { target_user_id: id, created_role: 'ADMIN', via: 'bulk_register', ...mark }, 'high');
    }
    if (successCount > 0) {
      await logSecurityEvent(adminDeptId, session.user.id, 'users_bulk_created',
        { created_count: successCount, created_admins: createdAdminIds.length, created_departments: createdDepartments.length, failed_count: failCount, ...mark },
        createdAdminIds.length > 0 ? 'high' : 'low');
    }

    return NextResponse.json({
      ok: true,
      data: {
        results,
        summary: {
          total: rows.length,
          success: successCount,
          fail: failCount,
          // 메일 미설정이면 관리자가 임시 비밀번호를 직접 전달해야 한다
          mailConfigured: isMailConfigured(),
        },
      },
    });
  } catch (error) {
    console.error('[bulk-register POST]', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
