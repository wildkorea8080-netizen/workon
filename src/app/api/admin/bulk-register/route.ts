import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import crypto from 'crypto';
import { sendTempPasswordEmail, isMailConfigured } from '@/lib/mailer';
import { APP_URL } from '@/lib/config';

export const dynamic = 'force-dynamic';

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

    const body = await request.json();
    const rows: CsvRow[] = body.rows ?? [];

    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json(
        { ok: false, error: { message: '등록할 직원 데이터가 없습니다.' } },
        { status: 400 }
      );
    }

    // 관리자가 속한 기관. 모든 부서 조회·생성을 이 기관으로 한정한다.
    const { data: adminDept } = await supabaseAdmin
      .from('departments')
      .select('name, organization_id')
      .eq('id', adminDeptId)
      .single();

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

    // 부서 캐시 (같은 이름 중복 조회 방지)
    const deptCache = new Map<string, string>();

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

      const { data: existing } = await supabaseAdmin
        .from('departments')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('name', name)
        .maybeSingle();

      if (existing) {
        deptCache.set(name, existing.id);
        return existing.id;
      }

      // 상위 부서가 지정돼 있으면 먼저 만들어 계층을 잇는다.
      // 자기 자신을 상위로 지정한 행은 무시한다.
      let parentId: string | null = null;
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

      if (error || !newDept) throw new Error(`부서 생성 실패: ${name}`);
      deptCache.set(name, newDept.id);
      return newDept.id;
    }

    const results: RegisterResult[] = [];

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

      try {
        const deptId = await findOrCreateDept(row.부서명, row.상위부서명);

        // 이미 존재하는 이메일 확인
        const { data: existingUser } = await supabaseAdmin
          .from('users')
          .select('id')
          .eq('email', email)
          .maybeSingle();

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
          throw new Error(authError?.message ?? 'Auth 사용자 생성 실패');
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
          });

        if (insertError) {
          // Auth 사용자 롤백
          await supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
          throw new Error(insertError.message);
        }

        // 임시 비밀번호 안내 메일 (미설정이면 조용히 건너뛴다 — 등록 자체는 성공)
        const mail = await sendTempPasswordEmail({
          to: email,
          fullName: row.직원이름.trim(),
          tempPassword,
          loginUrl: `${APP_URL}/login`,
        });

        results.push({
          row: i + 1, 이메일: email, 직원이름: row.직원이름.trim(),
          부서명: row.부서명.trim(), success: true, tempPassword,
          emailSent: mail.sent,
        });
      } catch (err) {
        results.push({
          row: i + 1, 이메일: email, 직원이름: row.직원이름.trim(),
          부서명: row.부서명.trim(), success: false,
          error: err instanceof Error ? err.message : '등록 실패',
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

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
