import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { BATCH_LIST_UNREAD, batchCreatedNotice } from '@/components/apps/AppBatchPanel';

/**
 * 2026-11-20 — 일괄 실행을 만든 뒤 목록을 못 읽어도 만든 것을 알 수 있다.
 * 만들기가 성공하면 화면은 입력을 지우고 목록을 다시 읽는다. 예전엔 그 목록 읽기가 실패하면('목록은 표시일 뿐'이라 조용히 넘김)
 * 입력만 지워지고 목록에는 아무것도 보이지 않았다 — 실패한 줄 알고 같은 내용으로 다시 만들면 **같은 일괄 실행이 두 번 돈다**
 * (100줄이면 AI 호출도 두 배). 이제 만든 것은 목록과 따로 알리고, 목록을 못 읽은 것도 '다시 만들지 말라'와 함께 알린다.
 */

describe('알림 문구', () => {
  it('만든 직후 — 줄 수와 다시 만들지 말라는 안내', () => {
    const text = batchCreatedNotice(37);
    expect(text).toContain('일괄 실행을 만들었습니다(37줄)');
    expect(text).toContain('다시 만들지 마세요');
  });
  it('목록을 못 읽음 — 만든 것은 돌고 있다고 알린다', () => {
    expect(BATCH_LIST_UNREAD).toContain('목록을 지금 불러오지 못했습니다');
    expect(BATCH_LIST_UNREAD).toContain('만든 일괄 실행은 그대로 돌고 있습니다');
    expect(BATCH_LIST_UNREAD).toContain('다시 만들지 말고');
  });
});

describe('일괄 실행 칸 (원본)', () => {
  const src = readFileSync('src/components/apps/AppBatchPanel.tsx', 'utf8').replace(/\r\n/g, '\n');
  const submit = src.slice(src.indexOf('async function submit() {'), src.indexOf('async function addFiles('));
  const load = src.slice(src.indexOf('const load = useCallback(async () => {'), src.indexOf('useEffect(() => { if (open) void load(); }'));

  it('만들기가 성공하면 목록을 읽기 전에 알림을 세운다', () => {
    const ok = submit.slice(submit.indexOf('else {'));
    expect(ok.indexOf('setCreated(batchCreatedNotice(lines));')).toBeGreaterThan(-1);
    expect(ok.indexOf('setCreated(batchCreatedNotice(lines));')).toBeLessThan(ok.indexOf('await load();'));
    expect(submit).toContain("const lines = mode === 'files' ? readyIds.length : preview.rows.length;");
  });

  it('다시 만들기를 누르면 앞 알림을 지운다, 실패한 만들기는 알림을 세우지 않는다', () => {
    expect(submit).toContain('setBusy(true); setError(null); setErrors([]); setCreated(null);');
    const fail = submit.slice(submit.indexOf("if (!res.ok || !body?.ok) {"), submit.indexOf('else {'));
    expect(fail).not.toContain('setCreated(');
  });

  it('목록 읽기 실패를 조용히 넘기지 않고, 앞서 읽은 목록은 비우지 않는다', () => {
    expect(load).toContain('if (res.ok && body?.ok) { setBatches(body.data); setListUnread(false); }');
    expect(load).toContain('else setListUnread(true);');
    expect(load).toContain('} catch { setListUnread(true); }');
    expect(load).not.toContain('setBatches([])');
    expect(load).not.toContain('목록은 표시일 뿐');
  });

  it('두 알림이 화면에 그려진다', () => {
    expect(src).toContain('{created && <p role="status" className="text-xs text-emerald-700">{created}</p>}');
    expect(src).toContain('{listUnread && <p role="alert" className="text-xs text-amber-700">{BATCH_LIST_UNREAD}');
  });
});
