// src/lib/work/workflows/currentize/workbook.ts
import { safeText } from '@/lib/xlsx-export';
import { CHANGE_KIND_LABEL, CHANGE_STATUS_LABEL, type Change, type CurrentizeContent } from './plan';

/**
 * 현행화 변경 내역표(XLSX). 취합 엑셀(collection/workbook.ts)과 같은 원칙: **값만 쓴다(수식 없음)**,
 * 모든 글자는 safeText(수식 주입 방지 + 32,000자 자름)를 거친다.
 * 시트: 변경 내역 · 근거 대조 · 안내. 직원이 현행화된 HWPX 옆에서 '무엇이 어떻게 바뀌었나'를 확인하는 표다.
 */
const t = (s: string | null | undefined) => safeText(s ?? '');

const CITATION_STATUS_LABEL: Record<CurrentizeContent['citations'][number]['status'], string> = {
  same: '같음',
  changed: '바뀜',
  not_found: '찾지 못함',
};

export interface ChangeLogOptions {
  title: string;
  createdAt: Date;
  /** 조각 id → 사람이 읽는 위치(제목 사슬·표 좌표). 없으면 조각 id를 그대로 적는다 */
  segmentLabels?: Map<string, string>;
  /** 단위 경고 등 — '안내' 시트에 한 줄씩 */
  warnings?: string[];
}

export async function buildChangeLogWorkbook(content: CurrentizeContent, opts: ChangeLogOptions): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WORKON';
  wb.title = opts.title;
  const label = (segmentId: string) => opts.segmentLabels?.get(segmentId) ?? segmentId;

  // 변경 내역 — changes 순서 그대로
  const ws = wb.addWorksheet('변경 내역', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow(['번호', '위치', '종류', '작년 글', '올해 글', '상태', '근거', '비고']).font = { bold: true };
  for (const c of content.changes) {
    ws.addRow([t(c.id), t(label(c.segmentId)), t(CHANGE_KIND_LABEL[c.kind] ?? c.kind), t(c.before), t(c.after), t(CHANGE_STATUS_LABEL[c.status] ?? c.status), t(c.basis.join(', ')), t(c.note)]);
  }
  [8, 24, 12, 40, 40, 12, 24, 40].forEach((w, i) => (ws.getColumn(i + 1).width = w));

  // 근거 대조 — 인용마다 한 줄
  const cs = wb.addWorksheet('근거 대조', { views: [{ state: 'frozen', ySplit: 1 }] });
  cs.addRow(['조각', '인용 규정', '조문', '작년 글', '현재 조문 제목', '현재 조문 글', '시행일', '상태']).font = { bold: true };
  for (const p of content.citations) {
    cs.addRow([
      t(label(p.segmentId)),
      t(p.cited.name),
      t(p.cited.article),
      t(p.cited.text),
      t(p.current?.title),
      t(p.current?.text),
      t(p.current?.enforced),
      t(CITATION_STATUS_LABEL[p.status] ?? p.status),
    ]);
  }
  [24, 20, 12, 40, 24, 50, 14, 12].forEach((w, i) => (cs.getColumn(i + 1).width = w));

  // 안내
  const kst = new Date(opts.createdAt.getTime() + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
  const count = (s: Change['status']) => content.changes.filter((c) => c.status === s).length;
  const stops = [content.costStopped ? '원가 상한' : null, content.truncated ? '조각 상한' : null].filter((x): x is string => !!x);
  const lines: [string, string][] = [
    ['만든 때(KST)', kst],
    ['기준 연도', `${content.fromYear}년 → ${content.toYear}년`],
    ['작년 파일 해시', content.priorSha256.slice(0, 16)],
    ['변경 수', `바꿈 ${count('changed')} · 확인 필요 ${count('needs_check')} · 제안 ${count('proposed')}`],
    ['상한으로 멈춤', stops.length ? `예(${stops.join(', ')})` : '아니오'],
    ['시험 모드', content.mode === 'mock' ? '예 — 실제 기능이 아닙니다' : '아니오'],
    ...(opts.warnings ?? []).map((w): [string, string] => ['경고', w]),
    ['이 표의 값은 계산 결과이며 수식이 없습니다', ''],
  ];
  const ns = wb.addWorksheet('안내');
  for (const [k, v] of lines) ns.addRow([t(k), t(v)]);
  ns.getColumn(1).width = 26;
  ns.getColumn(2).width = 100;

  return Buffer.from(await wb.xlsx.writeBuffer());
}
