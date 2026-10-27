import { readFileSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';

/**
 * 가상 분기 실적 과제(docs/workon-rebuild/fixtures/quarterly-report.json)를 실제 XLSX 원자료로 만든다.
 * JSON만 읽고 통과했다고 하지 않으려고, 시험은 이 파일을 실제 첨부 읽기(readAttachment)로 읽는다.
 * 시트: 1행 '(단위: 천원)' 같은 단위 줄, 2행 머리글, 3행부터 자료(fixture의 sourceRow와 같은 시트 행).
 */
interface FixtureRow {
  sourceRow: number;
  project: string;
  budget: number;
  spent: number;
  participants: number;
  isSummary?: boolean;
}
interface FixtureFile {
  id: string;
  department: string;
  unit?: string;
  sheet?: string;
  rows?: FixtureRow[];
  sameContentAs?: string;
}

export const fixture = JSON.parse(readFileSync(path.join(process.cwd(), 'docs', 'workon-rebuild', 'fixtures', 'quarterly-report.json'), 'utf8')) as {
  expectedDepartments: string[];
  sourceFiles: FixtureFile[];
  expectedAfterReview: { budgetKrw: number; spentKrw: number; participants: number; executionRatePercentDisplay: string; missingDepartments: string[] };
};

export async function fixtureWorkbooks(): Promise<{ id: string; fileName: string; bytes: Buffer; sha256: string }[]> {
  const ExcelJS = (await import('exceljs')).default;
  const out: { id: string; fileName: string; bytes: Buffer; sha256: string }[] = [];
  const byId = new Map(fixture.sourceFiles.map((f) => [f.id, f]));
  for (const f of fixture.sourceFiles) {
    let bytes: Buffer;
    if (f.sameContentAs) {
      // 같은 제출의 사본 — 바이트까지 같은 파일(다른 이름)
      bytes = out.find((o) => o.id === f.sameContentAs)!.bytes;
    } else {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(f.sheet ?? '실적');
      ws.getCell('A1').value = `(단위: ${f.unit})`;
      ws.getRow(2).values = ['사업명', '예산', '집행', '참여자'];
      for (const r of f.rows ?? []) ws.getRow(r.sourceRow).values = [r.project, r.budget, r.spent, r.participants];
      bytes = Buffer.from(await wb.xlsx.writeBuffer());
    }
    const dept = byId.get(f.sameContentAs ?? f.id)!.department;
    out.push({ id: f.id, fileName: `${dept}_3분기실적${f.sameContentAs ? '(사본)' : ''}.xlsx`, bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return out;
}
