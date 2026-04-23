import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import crypto from 'crypto';

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

    // 관리자 부서 정보 조회 (신규 부서 생성 시 상위 부서명 참조용)
    const { data: adminDept } = await supabaseAdmin
      .from('departments')
      .select('name')
      .eq('id', adminDeptId)
      .single();

    // 부서 캐시 (같은 이름 중복 조회 방지)
    const deptCache = new Map<string, string>();

    async function findOrCreateDept(deptName: string): Promise<string> {
      if (deptCache.has(deptName)) return deptCache.get(deptName)!;

      const { data: existing } = await supabaseAdmin
        .from('departments')
        .select('id')
        .eq('name', deptName.trim())
        .maybeSingle();

      if (existing) {
        deptCache.set(deptName, existing.id);
        return existing.id;
      }

      // 없으면 새 부서 생성
      const slug = deptName.trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9가-힣-]/g, '')
        + '-' + Date.now();

      const { data: newDept, error } = await supabaseAdmin
        .from('departments')
        .insert({ name: deptName.trim(), slug, description: `${adminDept?.name ?? ''} 산하 부서` })
        .select('id')
        .single();

      if (error || !newDept) throw new Error(`부서 생성 실패: ${deptName}`);
      deptCache.set(deptName, newDept.id);
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
        const deptId = await findOrCreateDept(row.부서명.trim());

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

        results.push({
          row: i + 1, 이메일: email, 직원이름: row.직원이름.trim(),
          부서명: row.부서명.trim(), success: true, tempPassword,
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
        summary: { total: rows.length, success: successCount, fail: failCount },
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
