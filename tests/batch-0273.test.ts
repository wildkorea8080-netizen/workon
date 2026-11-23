import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 0273(큰 묶음) — 처리 중에 같은 조작을 다시 보내지 않기.
// 업무 작업실 '검토 완료'·확인 사항 '고쳤음/확인함'·'AI 수정 적용', 변경 기록 '이 판 내용으로 복구', 관리자 비서 카테고리 '추가'가
// 처리 중에도 단추가 열려 있었다. 두 번 누르면 첫 요청은 성공하고 둘째가 판이 바뀜(409)·이미 완료·같은 이름으로 거절돼
// 성공 바로 뒤에 실패 글이 떴다. 카테고리 추가는 Enter와 단추가 같은 조작을 불러 화면 상태만으로는 못 막는다 — useInFlight(ref).

const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

describe('useInFlight', () => {
  it('ref로 막고 단추를 막을 상태를 준다', () => {
    const s = norm('src/lib/use-in-flight.ts');
    expect(s).toContain('if (ref.current !== null) return;');
    expect(s).toContain('} finally {\n      ref.current = null;\n      setRunning(null);');
  });
});

describe('업무 작업실', () => {
  const s = norm('src/components/work/TaskWorkbench.tsx');
  it("'검토 완료'는 처리 중 막힌다 — 갈고리는 이른 return보다 앞에", () => {
    const top = s.indexOf('export default function TaskWorkbench(');
    const hook = s.indexOf('const approveFlight = useInFlight();');
    const firstReturn = s.indexOf('\n  if (!detail) {', top);
    expect(hook).toBeGreaterThan(top);
    expect(firstReturn === -1 || hook < firstReturn).toBe(true);
    expect(s).toContain("const approve = () => void approveFlight.run('approve', approveNow);");
    expect(s).toContain('disabled={!canApprove || approveFlight.running !== null}');
  });
  it("확인 사항 '고쳤음·확인함'", () => {
    expect(s).toContain("onClick={() => void flight.run(i.id, () => act(i.id, 'resolve'))} disabled={flight.running !== null}");
    expect(s).toContain("onClick={() => void flight.run(i.id, () => act(i.id, 'acknowledge'))} disabled={flight.running !== null}");
  });
  it("'AI 수정 적용'", () => {
    expect(s).toContain("onClick={() => void applyFlight.run('apply', apply)} disabled={applyFlight.running !== null}");
  });
});

describe('변경 기록 복구·카테고리 추가', () => {
  it('복구', () => {
    expect(norm('src/app/tasks/[id]/history/page.tsx')).toContain('onClick={() => void flight.run(r.id, () => restore(r))} disabled={flight.running !== null}');
  });
  it('카테고리 추가 — Enter와 단추 모두 같은 막이로', () => {
    const s = norm('src/components/admin/AgentsManager.tsx');
    expect(s).toContain("const addCategory = () => void categoryFlight.run('add', handleAddCategory);");
    expect(s).toContain('e.preventDefault(); addCategory(); } }}');
    expect(s).toContain('<button onClick={addCategory} disabled={!newCategoryName.trim() || categoryFlight.running !== null}');
  });
});
