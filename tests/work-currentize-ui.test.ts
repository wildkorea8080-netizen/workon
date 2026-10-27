import { describe, it, expect } from 'vitest';
import {
  filterChanges,
  countByStatus,
  kindLabel,
  statusLabel,
  citationFor,
  editableChange,
  draftFor,
  canSave,
  canAcknowledge,
} from '@/components/work/currentize-view-helpers';
import { inputsFor } from '@/components/work/file-set-helpers';
import type { CurrentizeChangeDto, CurrentizeDto } from '@/components/work/types';

/** 작업실 '대조' 보기(S6-1 Task 13) — 화면이 쓰는 순수 함수. DOM 시험 도구가 없어 그리는 규칙을 여기서 고정한다 */
const ch = (id: string, over: Partial<CurrentizeChangeDto> = {}): CurrentizeChangeDto => ({
  id,
  segmentId: '0:100',
  kind: 'year',
  before: '2025년 계획',
  after: '2026년 계획',
  status: 'changed',
  basis: [],
  note: null,
  location: '개요',
  ...over,
});

const content = (changes: CurrentizeChangeDto[], citations: CurrentizeDto['citations'] = []): CurrentizeDto => ({
  schema: 'currentize/1',
  priorSourceId: 'p',
  priorSha256: 'h',
  fromYear: 2025,
  toYear: 2026,
  changes,
  citations,
  truncated: false,
  costStopped: false,
  mode: 'llm',
  warnings: [],
});

const LIST = [
  ch('c1'),
  ch('c2', { kind: 'number', status: 'needs_check', after: null, note: '올해 자료에서 확인되지 않은 숫자가 있습니다 — 확인하세요' }),
  ch('c3', { kind: 'prose', status: 'proposed', segmentId: '0:300', before: '옛 문장', after: '새 문장' }),
  ch('c4', { kind: 'table', status: 'needs_check', segmentId: '0:400', before: '1,100', after: '1,200' }),
];

describe('대조 보기 — 거르기·세기', () => {
  it('전체·확인 필요·제안·바꿈으로 거른다(순서 그대로)', () => {
    expect(filterChanges(LIST, 'all').map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(filterChanges(LIST, 'needs_check').map((c) => c.id)).toEqual(['c2', 'c4']);
    expect(filterChanges(LIST, 'proposed').map((c) => c.id)).toEqual(['c3']);
    expect(filterChanges(LIST, 'changed').map((c) => c.id)).toEqual(['c1']);
  });
  it('상태별 개수', () => {
    expect(countByStatus(LIST)).toEqual({ all: 4, needs_check: 2, proposed: 1, changed: 1 });
    expect(countByStatus([])).toEqual({ all: 0, needs_check: 0, proposed: 0, changed: 0 });
  });
});

describe('대조 보기 — 칩 이름(변경 내역표와 같다)', () => {
  it('종류', () => {
    expect(['year', 'period', 'number', 'citation', 'person', 'date', 'prose', 'table', 'structure'].map(kindLabel)).toEqual([
      '연도',
      '기간',
      '수치',
      '근거 인용',
      '담당자',
      '날짜',
      '문장',
      '표 칸',
      '구조',
    ]);
    expect(kindLabel('unknown')).toBe('unknown');
  });
  it('상태', () => {
    expect(['changed', 'needs_check', 'proposed'].map(statusLabel)).toEqual(['바꿈', '확인 필요', '제안']);
  });
});

describe('대조 보기 — 인용 근거 찾기', () => {
  const pair = (segmentId: string, status: 'same' | 'changed' | 'not_found') => ({
    segmentId,
    cited: { name: '지방공기업법', article: '제64조', text: '에 따라 편성한다' },
    current: status === 'not_found' ? null : { kind: 'law', title: '지방공기업법', article: '제64조', text: '제64조(예산) …', enforced: '2020-01-01' },
    status,
  });
  it('같은 조각의 인용만, 순서 그대로', () => {
    const c = content(LIST, [pair('0:100', 'changed'), pair('0:300', 'same'), pair('0:100', 'not_found')]);
    expect(citationFor(c, '0:100').map((p) => p.status)).toEqual(['changed', 'not_found']);
    expect(citationFor(c, '0:999')).toEqual([]);
  });
});

describe('대조 보기 — 고칠 수 있는가', () => {
  it('빈 칸(구조)은 한글에서 직접', () => {
    expect(editableChange(ch('c5', { kind: 'structure', before: '', after: '500', status: 'needs_check' }))).toEqual({ ok: false, reason: '빈 칸은 한글에서 직접 채워 주세요' });
  });
  it('여러 줄 칸(표)은 한글에서 직접', () => {
    expect(editableChange(ch('c6', { kind: 'table', before: '가\n나', status: 'needs_check' }))).toEqual({ ok: false, reason: '여러 줄 칸은 한글에서 직접 고쳐 주세요' });
  });
  it('그 밖은 고칠 수 있다', () => {
    for (const c of LIST) expect(editableChange(c)).toEqual({ ok: true });
  });
});

describe('대조 보기 — 올해 글 입력칸의 처음 글', () => {
  it('올해 글이 있으면 그 글', () => {
    expect(draftFor(LIST[2], LIST)).toBe('새 문장');
  });
  it('없으면 같은 문단의 바꿈 글(연도를 민 글), 그것도 없으면 작년 글 — 빈칸에서 문단 전체를 다시 치지 않게', () => {
    expect(draftFor(LIST[1], LIST)).toBe('2026년 계획');
    const lone = ch('c9', { segmentId: '0:900', kind: 'citation', status: 'needs_check', after: null, before: '「법」 제3조에 따라 한다' });
    expect(draftFor(lone, [lone])).toBe('「법」 제3조에 따라 한다');
  });
  it('저장 단추 — 빈 글은 안 되고, 이미 바꾼 글과 같으면 바뀐 것이 없다', () => {
    expect(canSave(LIST[0], '2026년 계획')).toBe(false);
    expect(canSave(LIST[0], '2026년 수정 계획')).toBe(true);
    expect(canSave(LIST[1], '  ')).toBe(false);
    // 확인 필요·제안은 같은 글이어도 '이대로 받아들임'이라 저장할 수 있다
    expect(canSave(LIST[2], '새 문장')).toBe(true);
    expect(canSave(LIST[1], '2026년 계획')).toBe(true);
  });
});

describe('대조 보기 — 확인함(I6)', () => {
  it('확인 필요만 확인함으로 닫는다 — 글을 넣을 수 없는 빈 칸·여러 줄 칸·표 구조도', () => {
    expect(canAcknowledge(LIST[1])).toBe(true);
    expect(canAcknowledge(LIST[3])).toBe(true);
    expect(canAcknowledge(ch('c5', { kind: 'structure', before: '', after: null, status: 'needs_check' }))).toBe(true);
    expect(canAcknowledge(LIST[0])).toBe(false);
    expect(canAcknowledge(LIST[2])).toBe(false);
  });
  it('넣을 값이 없는 구조 확인(열을 못 가린 표)은 표를 한글에서 고치라고 한다', () => {
    expect(editableChange(ch('c5', { kind: 'structure', before: '', after: null, status: 'needs_check' }))).toEqual({ ok: false, reason: '표는 한글에서 직접 고쳐 주세요' });
  });
  it('확인함으로 닫은 행(올해 글 = 작년 글)은 입력칸의 처음 글이 되지 않는다', () => {
    const acked = ch('c7', { kind: 'number', before: '2025년 계획', after: '2025년 계획', status: 'changed', basis: ['user'], note: '확인함' });
    const year = ch('c8', { kind: 'year' });
    const open = ch('c9', { kind: 'citation', status: 'needs_check', after: null });
    expect(draftFor(open, [acked, year, open])).toBe('2026년 계획');
  });
});

describe('업무 입력 보이기 — 작년 파일은 현행화 업무에만(I1)', () => {
  const inputs = [
    { key: 'title', type: 'string' },
    { key: 'prior', type: 'file-set' },
    { key: 'meetingSource', type: 'file-set' },
  ];
  it('현행화하지 않는 업무는 작년 파일 입력을 숨긴다', () => {
    expect(inputsFor(inputs, false).map((i) => i.key)).toEqual(['title', 'meetingSource']);
    expect(inputsFor(inputs, true).map((i) => i.key)).toEqual(['title', 'prior', 'meetingSource']);
  });
});
