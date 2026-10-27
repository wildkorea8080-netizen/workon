import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { dateAppearsIn, redactSecrets, verifyItems, verifyMeta, type RawItem, type VerifySource } from '@/lib/work/workflows/items/verify';
import { departmentCandidates, flagReviewItems, handoverSpec, intakeSpec, meetingSpec } from '@/lib/work/workflows/items/specs';
import { parseExtract, mockItemsModel } from '@/lib/work/workflows/items/model';
import { buildItemsWorkbook } from '@/lib/work/workflows/items/workbook';
import { WorkError } from '@/lib/work/types';

/**
 * 항목 뽑기 공통 엔진(접수공문·회의·인수인계) — 순수 규칙.
 * 카탈로그 validationRules: 본문·붙임 기한 충돌 / 명시 없는 담당자·상대 기한은 확인 필요 / 제안·결정·미결 구분 /
 * 화자·담당·기한 추측 금지 / 담당·기한 최신성 / 비밀번호·계정 비밀 제외. 시나리오 A17.
 */
const body: VerifySource = {
  id: 's1',
  name: '공문.txt',
  text: '1. 2026년 3분기 사업 실적을 붙임 양식에 따라 2026. 10. 30.(금)까지 제출하여 주시기 바랍니다.\n2. 문의: 기획팀 주무관 김가나(02-123-4567)',
};
const attachment: VerifySource = { id: 's2', name: '붙임 작성 요령.txt', text: '제출 기한: 10월 31일\n대상 기간: 2026. 7. 1. ~ 9. 30.\n자료는 접수 후 7일 이내 보완 제출' };

const raw = (over: Partial<RawItem> & { values?: Record<string, string> }): RawItem => ({ type: '제출', sourceId: 's1', quote: '', values: {}, ...over });

describe('원문 대조', () => {
  it('날짜는 원문에 적힌 여러 꼴로 찾는다', () => {
    expect(dateAppearsIn('2026-10-30', body.text)).toBe(true);
    expect(dateAppearsIn('2026-10-31', attachment.text)).toBe(true);
    expect(dateAppearsIn('2026-11-30', body.text)).toBe(false);
    expect(dateAppearsIn('2026-07-01', attachment.text)).toBe(true);
    // 해를 줄인 '11. 10.'은 찾되, 다른 해 날짜의 꼬리(2025. 11. 10.)나 '111.10.'은 아니다
    expect(dateAppearsIn('2026-11-10', '기획팀이 11. 10.까지 제출')).toBe(true);
    expect(dateAppearsIn('2026-11-10', '지난해 2025. 11. 10. 보고')).toBe(false);
    expect(dateAppearsIn('2026-11-10', '예산 111.10.')).toBe(false);
    expect(dateAppearsIn('2026-11-10', '11a10b')).toBe(false);
  });

  it('인용이 원자료에 없으면 표시하고(버리지 않음), 원문 줄바꿈·공백 차이는 같은 글로 본다', () => {
    const items = verifyItems(
      [
        raw({ quote: '2026년 3분기 사업 실적을 붙임 양식에 따라  2026. 10. 30.(금)까지', values: { request: '3분기 실적 제출' } }),
        raw({ quote: '요약해서 지어낸 문장', values: { request: '없는 요청' } }),
        raw({ quote: '제출 기한', sourceId: 's9', values: { request: 'x' } }),
      ],
      [body, attachment],
      intakeSpec.spec
    );
    expect(items.map((i) => i.id)).toEqual(['I1', 'I2', 'I3']);
    expect(items[0].flags).toEqual([]);
    expect(items[1].flags).toEqual(['quote_not_found']);
    expect(items[2].flags).toEqual(expect.arrayContaining(['source_unknown', 'quote_not_found']));
  });

  it('기한 — 원문의 날짜만 남기고(YYYY-MM-DD), 없는 날짜는 비우고, 상대 기한은 원문 그대로 둔 채 확인 필요', () => {
    const [ok, missing, relative] = verifyItems(
      [
        raw({ quote: '2026. 10. 30.(금)까지 제출', values: { request: 'a', due: '2026. 10. 30.' } }),
        raw({ quote: '2026. 10. 30.(금)까지 제출', values: { request: 'b', due: '2026-11-15' } }),
        raw({ sourceId: 's2', quote: '자료는 접수 후 7일 이내 보완 제출', values: { request: 'c', due: '접수 후 7일 이내' } }),
      ],
      [body, attachment],
      intakeSpec.spec
    );
    expect(ok.values.due).toBe('2026-10-30');
    expect(missing.values.due).toBe('');
    expect(missing.flags).toContain('date_unverified');
    expect(relative.values.due).toBe('');
    expect(relative.values.dueText).toBe('접수 후 7일 이내');
    expect(relative.flags).toContain('relative_deadline');
  });

  it('담당·화자 — 원문에 없는 사람은 비우고 확인 필요(짐작 금지)', () => {
    const [a, b] = verifyItems(
      [raw({ values: { request: 'a', contact: '기획팀 주무관 김가나' } }), raw({ values: { request: 'b', contact: '총무과 박담당' } })],
      [body],
      intakeSpec.spec
    );
    expect(a.values.contact).toBe('기획팀 주무관 김가나');
    expect(b.values.contact).toBe('');
    expect(b.flags).toContain('person_unverified');
    expect(b.notes[0]).toContain('총무과 박담당');
  });

  it('모르는 구분은 마지막 선택지(기타)로, 메타도 원문에 있는 값만', () => {
    const [i] = verifyItems([raw({ type: '긴급' as string, values: { request: 'a' } })], [body], intakeSpec.spec);
    expect(i.type).toBe('기타');
    const m = verifyMeta({ place: '본관 2층 회의실', chair: '없는 부서' }, [{ id: 'm', name: 'm', text: '장소: 본관 2층 회의실' }], meetingSpec.spec);
    expect(m.values).toEqual({ place: '본관 2층 회의실', chair: '' });
    expect(m.notes[0]).toContain('없는 부서');
  });

  it('인수인계 — 비밀번호·계정 비밀은 값과 인용에서 지운다', () => {
    expect(redactSecrets('관리자 비밀번호: Abc!234 이고').text).toBe('관리자 비밀번호: [삭제됨] 이고');
    expect(redactSecrets('ID/PW : admin / qwer1234').text).toBe('ID/PW : [삭제됨]');
    expect(redactSecrets('PW=1234').removed).toBe(true);
    expect(redactSecrets('비밀번호 변경 주기 안내').removed).toBe(false);
    const src: VerifySource = { id: 'h', name: '인계 메모', text: '예산 시스템 접속 — 비밀번호: Abc!234 (매월 변경)' };
    const [it] = verifyItems([{ type: '반복 일정', sourceId: 'h', quote: '예산 시스템 접속 — 비밀번호: Abc!234', values: { task: '예산 시스템', reference: '비밀번호: Abc!234' } }], [src], handoverSpec.spec);
    expect(JSON.stringify(it)).not.toContain('Abc!234');
    expect(it.flags).toContain('secret_removed');
  });
});

describe('업무별 확인 사항', () => {
  it('접수 — 본문·붙임 기한이 다르면 충돌, 대상 기간·제출물·기한 빠짐을 알린다', () => {
    const items = verifyItems(
      [
        raw({ quote: '2026. 10. 30.(금)까지 제출하여', values: { request: '3분기 실적 제출', deliverable: '실적 양식', due: '2026-10-30' } }),
        raw({ sourceId: 's2', quote: '제출 기한: 10월 31일', values: { request: '3분기 실적 제출', deliverable: '실적 양식', due: '2026-10-31', period: '2026. 7. 1. ~ 9. 30.' } }),
        raw({ sourceId: 's2', quote: '자료는 접수 후 7일 이내 보완 제출', values: { request: '보완 제출' } }),
      ],
      [body, attachment],
      intakeSpec.spec
    );
    const codes = intakeSpec.checks({ form: {}, items, meta: {}, summary: '' }).map((c) => c.code);
    expect(codes).toEqual(expect.arrayContaining(['DEADLINE_CONFLICT', 'PERIOD_MISSING', 'DELIVERABLE_MISSING', 'DUE_MISSING', 'NO_DEPARTMENT_MAP']));
    const conflict = intakeSpec.checks({ form: {}, items, meta: {}, summary: '' }).find((c) => c.code === 'DEADLINE_CONFLICT')!;
    expect(conflict.message).toContain('2026-10-30 / 2026-10-31');
  });

  it('접수 — 업무분장표에서 요청 낱말이 나오는 부서를 후보로만 낸다', () => {
    const items = verifyItems([raw({ values: { request: '사업 실적 제출', deliverable: '실적 양식' } })], [body], intakeSpec.spec);
    const c = departmentCandidates(items, '기획팀: 사업 실적 취합, 중장기 계획\n총무과: 복무, 여비\n사업팀: 사업 운영');
    expect(c.I1).toEqual(['기획팀', '사업팀']);
  });

  it('A17 — 조건 표현이 있는 결정·조건 없는 조건부 합의·담당 없는 후속조치를 알리고, 회의록 칸은 결정과 조건부를 구분한다', () => {
    const src: VerifySource = { id: 'm', name: '회의 메모.txt', text: '안건: 4분기 사업 조정\n위원장: 예산 범위 안에서 추진하는 조건으로 승인\n김위원: 일정이 촉박하다는 반대 의견\n결론: 홍보비는 추후 결정\n사업팀은 계획서를 보완' };
    const items = verifyItems(
      [
        { type: '안건', sourceId: 'm', quote: '안건: 4분기 사업 조정', values: { content: '4분기 사업 조정' } },
        { type: '결정', sourceId: 'm', quote: '예산 범위 안에서 추진하는 조건으로 승인', values: { content: '사업 추진 승인', speaker: '위원장' } },
        { type: '조건부 합의', sourceId: 'm', quote: '예산 범위 안에서 추진하는 조건으로 승인', values: { content: '사업 추진', condition: '' } },
        { type: '반대 의견', sourceId: 'm', quote: '김위원: 일정이 촉박하다는 반대 의견', values: { content: '일정 촉박', speaker: '김위원' } },
        { type: '미결', sourceId: 'm', quote: '결론: 홍보비는 추후 결정', values: { content: '홍보비' } },
        { type: '후속조치', sourceId: 'm', quote: '사업팀은 계획서를 보완', values: { content: '계획서 보완', owner: '사업팀', due: '2026-11-15' } },
      ],
      [src],
      meetingSpec.spec
    );
    const ctx = { form: { meetingName: '4분기 조정 회의', participants: [] }, items, meta: { place: '', chair: '' }, summary: '' };
    const codes = meetingSpec.checks(ctx).map((c) => c.code);
    expect(codes).toEqual(expect.arrayContaining(['DECISION_CONDITIONAL', 'CONDITION_MISSING', 'FOLLOWUP_OWNER_DUE', 'PARTICIPANTS_UNCONFIRMED']));
    const f = meetingSpec.fieldValues!(ctx);
    expect(f['결정 사항']).toBe('○ 사업 추진 승인\n○ (조건부) 사업 추진 — 조건 확인 필요');
    expect(f['논의 내용']).toContain('○ (반대 의견) 일정 촉박 (김위원)');
    expect(f['논의 내용']).toContain('○ (미결) 홍보비');
    // 기한 2026-11-15는 원문에 없어 비웠다 → 향후 계획에 '기한 확인 필요'
    expect(f['향후 계획']).toBe('○ 계획서 보완 (사업팀 / 기한 확인 필요)');
    expect('참석자' in f).toBe(false);
    expect(meetingSpec.sheetItems(ctx).map((i) => i.type)).toEqual(['조건부 합의', '미결', '후속조치']);
  });

  it('인수인계 — 작성 기준일보다 기한이 지난 미결·진행 업무와 담당 없는 미결을 알린다', () => {
    const src: VerifySource = { id: 'confirmed', name: '확인 현황', text: '예산 재배정 미결 — 기한 2026. 9. 30.\n위원회 운영 진행 중 (총무과 협조)' };
    const items = verifyItems(
      [
        { type: '미결', sourceId: 'confirmed', quote: '예산 재배정 미결 — 기한 2026. 9. 30.', values: { task: '예산 재배정', due: '2026-09-30' } },
        { type: '진행 중', sourceId: 'confirmed', quote: '위원회 운영 진행 중 (총무과 협조)', values: { task: '위원회 운영', owner: '총무과' } },
      ],
      [src],
      handoverSpec.spec
    );
    const ctx = { form: { title: '사업 관리', basisDate: '2026-10-27' }, items, meta: {}, summary: '' };
    expect(handoverSpec.checks(ctx).map((c) => c.code)).toEqual(['DUE_PAST_BASIS', 'PENDING_OWNER_MISSING', 'SUMMARY_EMPTY']);
    const f = handoverSpec.fieldValues!(ctx);
    expect(f['미결 과제']).toBe('○ 예산 재배정 (2026-09-30)');
    expect(f['완료 업무']).toBe('없음');
    expect(f['유의 사항']).toContain('비밀번호');
  });

  it('깃발별 확인 사항은 묶어서 하나씩, 비밀값 지움은 참고', () => {
    const items = verifyItems([raw({ quote: 'x', values: { request: 'a' } }), raw({ quote: 'y', values: { request: 'b' } })], [body], intakeSpec.spec);
    const r = flagReviewItems(items);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ severity: 'warning', code: 'ITEM_QUOTE_NOT_FOUND' });
    expect(r[0].message).toContain('2건(I1, I2)');
  });
});

describe('모델 출력·시험 모드·엑셀', () => {
  it('모르는 칸·글이 아닌 값은 버리고, 형식이 틀리면 다시 시도할 오류', () => {
    const o = parseExtract('앞말 {"items":[{"type":"제출","values":{"request":"a","evil":"x","due":3},"sourceId":"s1","quote":"q"}],"meta":{"sender":"가","nope":"b"}}', intakeSpec.spec);
    expect(o.items[0].values).toEqual({ request: 'a' });
    expect(o.meta).toEqual({ sender: '가' });
    expect(() => parseExtract('글만', intakeSpec.spec)).toThrow(WorkError);
  });

  it('시험 모드는 원자료 줄을 그대로 인용한다(원문 대조를 통과)', async () => {
    const r = await mockItemsModel.extract({ workflowName: '접수', title: 't', facts: [], sources: [body], spec: intakeSpec.spec }, { model: 'm' });
    const items = verifyItems(r.items, [body], intakeSpec.spec);
    expect(items.length).toBe(2);
    expect(items.every((i) => !i.flags.includes('quote_not_found'))).toBe(true);
    expect(items[0].values.request).toContain('[시험 모드]');
  });

  it('처리표 엑셀 — 값만, 수식 주입 방지, 상대 기한은 원문 표시, 원문 근거·확인 사항 시트', async () => {
    const items = verifyItems(
      [
        raw({ sourceId: 's2', quote: '자료는 접수 후 7일 이내 보완 제출', values: { request: '=HYPERLINK("x")', due: '접수 후 7일 이내' } }),
      ],
      [body, attachment],
      intakeSpec.spec
    );
    const buf = await buildItemsWorkbook({ title: '접수 처리표', spec: intakeSpec.spec, items, extraColumns: [{ label: '담당 부서 후보', values: { I1: '기획팀' } }], review: [{ severity: 'warning', message: '확인' }], createdAt: new Date('2026-10-27T00:00:00Z'), testMode: false });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['요청사항·처리표', '원문 근거', '확인 사항']);
    const ws = wb.worksheets[0];
    const header = (ws.getRow(3).values as string[]).slice(1);
    expect(header).toEqual(['번호', '구분', '요청 내용', '제출물', '대상 기간', '기한', '제출 방법', '문의처', '담당 부서 후보', '확인 필요', '출처']);
    const row = (ws.getRow(4).values as string[]).slice(1);
    expect(row[2]).toBe("'=HYPERLINK(\"x\")");
    expect(row[5]).toBe('접수 후 7일 이내 (원문)');
    expect(row[8]).toBe('기획팀');
    expect(row[9]).toContain('상대 기한');
    let formulas = 0;
    wb.eachSheet((s) => s.eachRow((r) => r.eachCell((c) => { if (c.formula) formulas++; })));
    expect(formulas).toBe(0);
  });
});

describe('실제 모델 점검에서 찾은 것(2026-10-27)', () => {
  it('원문에 그대로 적힌 주기·해 없는 날짜는 원문 글로 두고 확인 필요로 표시하지 않는다 — 원문에 없는 글·사건 기준 기한만 표시', () => {
    const src: VerifySource = { id: 'm', name: '메모', text: '기획예산과가 11. 10.까지 재배정안 작성\n위원회는 매 분기 마지막 달 둘째 주' };
    const items = verifyItems(
      [
        { type: '후속조치', sourceId: 'm', quote: '기획예산과가 11. 10.까지 재배정안 작성', values: { content: '재배정안', owner: '기획예산과', due: '11. 10.' } },
        { type: '후속조치', sourceId: 'm', quote: '위원회는 매 분기 마지막 달 둘째 주', values: { content: '위원회', due: '매 분기 마지막 달 둘째 주' } },
        { type: '후속조치', sourceId: 'm', quote: '기획예산과가 11. 10.까지 재배정안 작성', values: { content: 'x', due: '다음 주 중' } },
        { type: '후속조치', sourceId: 'm', quote: '기획예산과가 11. 10.까지 재배정안 작성', values: { content: 'y', due: '통보 후 7일 이내' } },
      ],
      [src],
      meetingSpec.spec
    );
    expect(items.map((i) => [i.values.due, i.values.dueText, i.flags])).toEqual([
      ['', '11. 10.', []],
      ['', '매 분기 마지막 달 둘째 주', []],
      ['', '다음 주 중', ['date_unverified']],
      ['', '통보 후 7일 이내', ['relative_deadline']],
    ]);
    expect(meetingSpec.fieldValues!({ form: { meetingName: 'm' }, items, meta: {}, summary: '' })['향후 계획']).toContain('○ 재배정안 (기획예산과 / 11. 10.)');
  });

  it('인수인계 현황이 업무 이름으로 시작하면 되풀이를 뗀다', () => {
    const src: VerifySource = { id: 'confirmed', name: '확인', text: '3분기 실적 취합 진행 중 — 운영팀 자료 대기' };
    const items = verifyItems([{ type: '진행 중', sourceId: 'confirmed', quote: '3분기 실적 취합 진행 중 — 운영팀 자료 대기', values: { task: '3분기 실적 취합', status: '3분기 실적 취합 진행 중 — 운영팀 자료 대기' } }], [src], handoverSpec.spec);
    expect(handoverSpec.fieldValues!({ form: { title: 't', basisDate: '2026-10-27' }, items, meta: {}, summary: '' })['진행 중 업무']).toBe('○ 3분기 실적 취합 — 진행 중 — 운영팀 자료 대기');
  });
});
