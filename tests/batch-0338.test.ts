// tests/batch-0338.test.ts
// 사용자 관리 '직원 초대'의 세 가지(2026-11-27, 운영 화면에서 사용자가 겪음) — 복사가 안 되면 알리기·메일 실패 까닭을 사실대로·취소를 확인 창 없이.
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const ui = readFileSync('src/components/admin/UsersManager.tsx', 'utf8');

describe('직원 초대 화면', () => {
  it('복사 — 클립보드를 못 쓰면 조용히 넘기지 않고, 링크 전체를 골라 직접 복사하게', () => {
    expect(ui).toContain('setCopyFailed(true);');
    expect(ui).not.toContain('} catch { /* ignore */ }');
    expect(ui).toContain('select-all break-all');
    expect(ui).not.toMatch(/truncate font-mono">\{inviteResult\.url\}/);
  });
  it('메일 — 설정 안 됨과 보내기 실패를 가른다(실패를 \'설정되지 않음\'으로 보이지 않음)', () => {
    expect(ui).toContain("inviteResult.emailError === 'not_configured' ?");
    expect(ui).toContain('초대 메일을 보내지 못했습니다(메일 서비스가 받지 않음)');
    expect(ui).toContain("'메일로 보내지 못해 직접 전해 주세요. '");
  });
  it('초대 취소 — 확인 창(confirm) 대신 두 번 눌러 확인', () => {
    expect(ui).not.toContain("confirm('이 초대를 취소하시겠습니까?')");
    expect(ui).toContain('if (confirmCancelId !== id) { setConfirmCancelId(id); return; }');
    expect(ui).toContain("{confirmCancelId === inv.id ? '취소 확인' : '취소'}");
  });
});
