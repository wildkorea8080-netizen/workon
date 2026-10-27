// src/lib/work/workflows/qa/output.ts
import { safeText } from '@/lib/xlsx-export';
import { ANSWER_FLAG_LABEL, type QaResult } from './verify';

/**
 * 질문별 답변 → 양식 칸(회신·답변서)과 감사 증빙목록·수치 대조 엑셀. 칸 글은 검사한 답변 그대로 — 근거 표시는 프로그램이 붙인다.
 */
const line = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();

function flagsNote(r: QaResult): string {
  const lines = r.pairs.filter((p) => p.flags.length).map((p) => `○ ${p.id} ${line(p.question).slice(0, 60)} — ${p.flags.map((f) => ANSWER_FLAG_LABEL[f]).join(', ')}`);
  return lines.length ? lines.join('\n') : '없음';
}

export function replyFieldValues(r: QaResult, ctx: { title: string; recipient: string; today: string; departmentName: string | null }): Record<string, string> {
  const evidence = new Map<string, string>();
  for (const p of r.pairs) for (const e of p.evidence) evidence.set(e.id, e.id.startsWith('F') ? `[${e.id}] 담당자 확인 사실: ${r.facts.find((f) => f.id === e.id)?.text ?? ''}` : `[자료] ${e.label}`);
  return {
    제목: ctx.title,
    ...(ctx.recipient ? { 수신: ctx.recipient } : {}),
    회신일: ctx.today,
    '문의 요지': r.pairs.map((p, i) => `${i + 1}. ${line(p.question)}`).join('\n'),
    답변: r.pairs.map((p, i) => `${i + 1}. ${line(p.question)}\n→ ${p.answer ? line(p.answer) : '(답변 없음 — 확인 필요)'}`).join('\n'),
    '관련 근거': evidence.size ? [...evidence.values()].join('\n') : '없음',
    '추가 확인 필요': flagsNote(r),
    ...(ctx.departmentName ? { '담당 부서': ctx.departmentName } : {}),
  };
}

export function auditFieldValues(r: QaResult, ctx: { title: string; organizationName: string | null; definitions: string[] }): Record<string, string> {
  const files = [...new Set(r.pairs.flatMap((p) => p.evidence.filter((e) => !e.id.startsWith('F')).map((e) => e.label)))];
  return {
    제목: ctx.title,
    ...(ctx.organizationName ? { '제출 기관': ctx.organizationName } : {}),
    '기준 기간': ctx.definitions.join(' / '),
    '요구 항목별 답변': r.pairs
      .map((p, i) => {
        const ev = p.evidence.filter((e) => !e.id.startsWith('F')).map((e) => e.label);
        return `${i + 1}. ${line(p.question)}\n→ ${p.answer ? line(p.answer) : '(답변 없음 — 확인 필요)'}${ev.length ? ` [증빙: ${ev.join(', ')}]` : ' [증빙 없음]'}`;
      })
      .join('\n'),
    '증빙 목록': files.length ? files.map((f) => `○ ${f}`).join('\n') : '없음',
    '확인 필요 사항': [
      ...r.pairs.flatMap((p) => p.priorDiffs.map((d) => `○ ${p.id} ${d.label}: 과거 ${d.prior} → 지금 ${d.current}${d.reason ? ` (${d.reason})` : ' — 차이 근거 필요'}`)),
      flagsNote(r) === '없음' ? '' : flagsNote(r),
    ]
      .filter(Boolean)
      .join('\n') || '없음',
  };
}

const MAX_CELL = 32000;
const t = (s: string) => safeText(s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s);

/** 감사 — 증빙목록·수치 대조(요구 항목 × 답변 × 증빙 × 과거 수치 × 확인). 값만, 수식 주입 방지 */
export async function buildAuditIndexWorkbook(input: { title: string; result: QaResult; review: { severity: string; message: string }[]; createdAt: Date; testMode: boolean }): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WORKON';
  wb.title = input.title;
  const kst = new Date(input.createdAt.getTime() + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
  const ws = wb.addWorksheet('증빙목록·수치 대조', { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.getCell('A1').value = t(input.title);
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = t(`만든 때 ${kst} · 증빙을 대지 못한 답변은 '증빙 없음'으로 표시${input.testMode ? ' · 시험 모드 결과 — 실제 제출에 쓰지 마세요' : ''}`);
  ws.getRow(3).values = ['번호', '요구 항목', '답변', '증빙', '과거 수치 차이', '확인', '요구서 원문'].map(t);
  ws.getRow(3).font = { bold: true };
  input.result.pairs.forEach((p, i) => {
    ws.getRow(4 + i).values = [
      p.id,
      line(p.question),
      p.answer ? line(p.answer) : '(답변 없음)',
      p.evidence.length ? p.evidence.map((e) => (e.id.startsWith('F') ? `담당자 확인 ${e.id}` : e.label)).join(', ') : '증빙 없음',
      p.priorDiffs.map((d) => `${d.label}: ${d.prior} → ${d.current}${d.reason ? ` (${d.reason})` : ' (근거 없음)'}`).join(' / '),
      p.flags.map((f) => ANSWER_FLAG_LABEL[f]).join(', '),
      `${p.quote}${p.sourceName ? ` — ${p.sourceName}` : ''}`,
    ].map((v) => t(String(v)));
  });
  ws.columns.forEach((c, i) => (c.width = [6, 30, 50, 30, 30, 24, 50][i] ?? 20));
  const rs = wb.addWorksheet('확인 사항');
  rs.getRow(1).values = ['구분', '내용'].map(t);
  rs.getRow(1).font = { bold: true };
  input.review.forEach((r, i) => (rs.getRow(2 + i).values = [r.severity === 'blocking' ? '반드시 고칠 것' : r.severity === 'warning' ? '확인 필요' : '참고', r.message].map(t)));
  rs.getColumn(2).width = 110;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
