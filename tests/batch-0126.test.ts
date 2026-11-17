import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { findDiscardedWrites } from './helpers/discarded-writes';
import { SYNC_WARNINGS } from '@/lib/contract-sync';

/**
 * 2026-11-17 — 결과를 받되 오류는 받지 않는 쓰기(`const { data } = await supabaseAdmin.from(…).insert(…)`)도 막는다.
 * - 대리 접근: 기록(`impersonation_logs`)을 못 남기면 들어가지 않는다(예전엔 기록 없는 대리 접근이 생겼다)
 * - 기관 만들기: 기본 부서를 못 만들면 소속 없는 초대(가입에서 거절됨)를 만들지 않고 경고
 * - 앱 일괄 실행: 묶음 멈춤·마침 쓰기의 오류를 던진다
 */

describe('찾개가 오류를 받지 않는 꼴도 잡는다', () => {
  it('src에 `const { data } = await …쓰기`(error 없음)가 남지 않았다', () => {
    const destructuredOnly = findDiscardedWrites().filter((w) => {
      const line = readFileSync(w.file, 'utf8').split(/\r?\n/)[w.line - 1];
      return /^\s*(?:const|let)\s+\{/.test(line);
    });
    expect(destructuredOnly).toEqual([]);
  });
  it('찾개 원본에 그 꼴이 있다', () => {
    expect(readFileSync('tests/helpers/discarded-writes.ts', 'utf8')).toContain('(?:const|let)\\s+\\{([^}]*)\\}\\s*=\\s*await supabaseAdmin');
  });
});

describe('대리 접근 — 기록 없이는 들어가지 않는다', () => {
  const src = readFileSync('src/app/api/super/organizations/[id]/impersonate/route.ts', 'utf8');
  it('기록 오류·행 없음이면 503, 쿠키보다 앞에서 끝낸다', () => {
    expect(src).toContain('const { data: logRow, error: logError } = await supabaseAdmin');
    const guard = src.indexOf('if (logError || !logRow?.id)');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(src.indexOf('await encode('));
    expect(guard).toBeLessThan(src.indexOf('response.cookies.set('));
    expect(src.slice(guard, guard + 600)).toContain('status: 503');
    expect(src).toContain('impersonateLogId: logRow.id,');
  });
});

describe('기관 만들기 — 기본 부서를 못 만들면', () => {
  const src = readFileSync('src/app/api/super/organizations/route.ts', 'utf8');
  it('초대를 만들지 않고 경고(소속 없는 초대는 가입에서 거절되므로)', () => {
    expect(src).toContain('const { data: dept, error: deptError } = await supabaseAdmin');
    expect(src).toContain("inviteWarning = await reportContractSync('org_default_department', org.id, deptError?.code ?? 'no_row')");
    expect(src).not.toContain('department_id: dept?.id ?? null');
    expect(SYNC_WARNINGS.org_default_department).toContain('기본 부서');
  });
});

describe('앱 일괄 실행 — 멈춤·마침 쓰기', () => {
  const src = readFileSync('src/lib/apps/batches.ts', 'utf8');
  it('오류를 던지고, 멈춤을 못 쓰면 줄을 건너뛰지 않는다(다음 차례에 다시 멈추기)', () => {
    expect(src).toContain("if (error) throw new Error(`app_batches stop: ${error.message}`);\n      await skipPendingItems(batchId, nowIso, reason);".replace(/\n/g, src.includes('\r\n') ? '\r\n' : '\n'));
    expect(src).toContain('if (doneError) throw new Error(`app_batches settle: ${doneError.message}`);');
  });
});
