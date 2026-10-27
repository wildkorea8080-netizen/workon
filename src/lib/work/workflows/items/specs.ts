// src/lib/work/workflows/items/specs.ts
import type { NewReviewItem } from '../../store/types';
import { FLAG_LABEL, type ExtractedItem, type ItemFlag, type ItemsSpec } from './verify';

/**
 * 업무별 항목 규격 — 접수공문(요청사항)·회의(결정·미결·후속조치)·인수인계(진행·미결·반복 일정).
 * 칸 채우기(fieldValues)·업무별 확인 사항(checks)은 순수 함수다. 숫자·날짜·사람은 verify.ts가 이미 원문에 맞춰 거른 값만 쓴다.
 */
export interface ItemsContext {
  form: Record<string, unknown>;
  items: ExtractedItem[];
  meta: Record<string, string>;
  summary: string;
  /** 업무분장표에서 찾은 부서 후보(접수) */
  departmentCandidates?: Record<string, string[]>;
}

export interface ItemsWorkflowSpec {
  spec: ItemsSpec;
  /** 양식 칸 이름 → 글(HWPX 결과가 있을 때). 없으면 칸을 채우지 않는다 */
  fieldValues?(c: ItemsContext): Record<string, string>;
  /** 엑셀 처리표에 넣을 항목(전부 또는 일부) */
  sheetItems(c: ItemsContext): ExtractedItem[];
  checks(c: ItemsContext): NewReviewItem[];
}

const line = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();

/** 공통 확인 사항 — 깃발별로 묶어 하나씩(항목 번호 예시 4개) */
export function flagReviewItems(items: ExtractedItem[]): NewReviewItem[] {
  const by = new Map<ItemFlag, string[]>();
  for (const it of items) for (const f of it.flags) by.set(f, [...(by.get(f) ?? []), it.id]);
  const out: NewReviewItem[] = [];
  for (const [flag, ids] of by) {
    const severity = flag === 'secret_removed' ? 'info' : 'warning';
    const tail =
      flag === 'quote_not_found'
        ? ' — 원자료에서 그 문장을 찾지 못했습니다. 원문과 대조하세요.'
        : flag === 'secret_removed'
          ? ' — 비밀번호·계정 비밀로 보이는 값을 지웠습니다. 인수인계는 비밀값 없이 하고 전달은 별도 절차로 하세요.'
          : ' — 원자료에 적힌 값만 남기고 나머지는 비웠습니다. 담당자에게 확인하세요.';
    out.push({ severity, code: `ITEM_${flag.toUpperCase()}`, message: `${FLAG_LABEL[flag]} ${ids.length}건(${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ' …' : ''})${tail}`, field_ids: [] });
  }
  return out;
}

// ── 접수공문 처리 ─────────────────────────────────────────────

export const intakeSpec: ItemsWorkflowSpec = {
  spec: {
    name: '요청사항·처리표',
    typeColumn: { key: 'type', label: '구분', type: 'enum', options: ['제출', '회신', '조치', '참석', '기타'], hint: '요청 종류' },
    columns: [
      { key: 'request', label: '요청 내용', type: 'text', hint: '무엇을 해 달라는지 한 줄로' },
      { key: 'deliverable', label: '제출물', type: 'text', hint: '내야 할 자료·양식 이름(원문 그대로). 없으면 빈 글' },
      { key: 'period', label: '대상 기간', type: 'text', hint: '자료의 대상 기간(원문 그대로). 없으면 빈 글' },
      { key: 'due', label: '기한', type: 'date', hint: "원문에 적힌 기한. 날짜면 YYYY-MM-DD, '접수 후 7일 이내'처럼 상대 기한이면 원문 그대로" },
      { key: 'method', label: '제출 방법', type: 'text', hint: '제출처·방법(원문 그대로). 없으면 빈 글' },
      { key: 'contact', label: '문의처', type: 'person', hint: '원문에 적힌 담당자·연락처만. 없으면 빈 글' },
    ],
    meta: [
      { key: 'sender', label: '발신 기관', type: 'text', hint: '공문을 보낸 기관(원문 그대로)' },
      { key: 'docNumber', label: '문서번호', type: 'text', hint: '원문에 적힌 문서번호' },
    ],
    wantsSummary: false,
    redactSecrets: false,
    rules: [
      '본문과 붙임에 같은 요청이 있으면 각각 따로 적습니다(기한이 서로 다른지 프로그램이 봅니다).',
      '담당 부서는 정하지 마세요 — 프로그램이 업무분장표로 후보만 냅니다.',
      '요청이 아닌 참고 문장(관련 근거·인사말)은 항목으로 넣지 않습니다.',
    ],
  },
  sheetItems: (c) => c.items,
  checks(c) {
    const out: NewReviewItem[] = [];
    // 본문·붙임 기한 충돌 — 서로 다른 날짜 기한이 있으면(같은 제출물끼리, 아니면 전체)
    const dated = c.items.filter((i) => i.values.due);
    const groups = new Map<string, Set<string>>();
    for (const i of dated) {
      const k = i.values.deliverable ? line(i.values.deliverable) : '(전체)';
      groups.set(k, new Set([...(groups.get(k) ?? []), i.values.due]));
    }
    const all = new Set(dated.map((i) => i.values.due));
    const conflicts = [...groups].filter(([, s]) => s.size > 1);
    if (conflicts.length || (groups.size > 1 && all.size > 1 && dated.some((i) => i.type === '제출'))) {
      const list = (conflicts.length ? conflicts : [['(전체)', all] as const]).map(([k, s]) => `${k}: ${[...s].sort().join(' / ')}`).join('; ');
      out.push({ severity: 'warning', code: 'DEADLINE_CONFLICT', message: `기한이 서로 다릅니다 — ${list}. 본문·붙임 중 어느 기한을 따를지 확인하세요.`, field_ids: [] });
    }
    const submissions = c.items.filter((i) => i.type === '제출');
    if (!submissions.length) out.push({ severity: 'info', code: 'NO_SUBMISSION', message: '제출을 요청하는 항목을 찾지 못했습니다. 공문에 제출 요청이 있는지 확인하세요.', field_ids: [] });
    const noPeriod = submissions.filter((i) => !i.values.period);
    if (noPeriod.length) out.push({ severity: 'warning', code: 'PERIOD_MISSING', message: `대상 기간이 적히지 않은 제출 항목 ${noPeriod.length}건(${noPeriod.slice(0, 4).map((i) => i.id).join(', ')}) — 대상 기간을 확인하세요.`, field_ids: [] });
    const noDeliverable = submissions.filter((i) => !i.values.deliverable);
    if (noDeliverable.length) out.push({ severity: 'warning', code: 'DELIVERABLE_MISSING', message: `제출물이 적히지 않은 제출 항목 ${noDeliverable.length}건 — 무엇을 내야 하는지 확인하세요.`, field_ids: [] });
    const noDue = submissions.filter((i) => !i.values.due && !i.values.dueText);
    if (noDue.length) out.push({ severity: 'warning', code: 'DUE_MISSING', message: `기한을 찾지 못한 제출 항목 ${noDue.length}건 — 기한을 확인하세요.`, field_ids: [] });
    if (!c.departmentCandidates) out.push({ severity: 'info', code: 'NO_DEPARTMENT_MAP', message: '업무분장표를 올리지 않아 담당 부서 후보를 내지 않았습니다. 배부는 직원이 정합니다.', field_ids: [] });
    return out;
  },
};

/** 업무분장표 글에서 요청 낱말이 나오는 줄의 부서 이름 — 후보일 뿐 배부가 아니다 */
export function departmentCandidates(items: ExtractedItem[], mapText: string): Record<string, string[]> {
  const lines = mapText.split('\n').map((l) => l.trim()).filter(Boolean);
  const deptOf = (l: string) => /([가-힣A-Za-z0-9]{1,12}(?:과|팀|실|국|부|센터|단|본부))/.exec(l)?.[1] ?? null;
  const out: Record<string, string[]> = {};
  for (const it of items) {
    const words = `${it.values.request ?? ''} ${it.values.deliverable ?? ''}`.split(/[\s,·()]+/).filter((w) => w.length >= 2 && !/^(제출|요청|자료|관련|및|등|대한|위한)$/.test(w));
    const scored = new Map<string, number>();
    for (const l of lines) {
      const d = deptOf(l);
      if (!d) continue;
      const n = words.filter((w) => l.includes(w)).length;
      if (n > 0) scored.set(d, Math.max(scored.get(d) ?? 0, n));
    }
    out[it.id] = [...scored].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([d]) => d);
  }
  return out;
}

// ── 회의·위원회 정리 ──────────────────────────────────────────

const CONDITIONAL = /(조건으로|전제로|경우에\s*한해|하는\s*조건|검토\s*후\s*결정|추후\s*결정|보완\s*후|단서)/;

export const meetingSpec: ItemsWorkflowSpec = {
  spec: {
    name: '회의 내용·후속조치',
    typeColumn: { key: 'type', label: '구분', type: 'enum', options: ['안건', '결정', '조건부 합의', '제안', '반대 의견', '미결', '후속조치', '기타'], hint: '발언·내용의 성격' },
    columns: [
      { key: 'content', label: '내용', type: 'text', hint: '한 줄 요약(원문 뜻 그대로)' },
      { key: 'condition', label: '조건', type: 'text', hint: '조건부 합의의 조건(원문 그대로). 없으면 빈 글' },
      { key: 'speaker', label: '발언자', type: 'person', hint: '원문에 적힌 발언자만. 없으면 빈 글' },
      { key: 'owner', label: '담당', type: 'person', hint: '원문에 적힌 담당자·부서만. 없으면 빈 글' },
      { key: 'due', label: '기한', type: 'date', hint: '원문에 적힌 기한만(YYYY-MM-DD 또는 원문 그대로). 없으면 빈 글' },
    ],
    meta: [
      { key: 'place', label: '장소', type: 'text', hint: '원문에 적힌 회의 장소' },
      { key: 'chair', label: '주관', type: 'text', hint: '원문에 적힌 주관(주재) 부서·사람' },
    ],
    wantsSummary: false,
    redactSecrets: false,
    rules: [
      "확정된 결정만 '결정'입니다. 조건이 붙은 합의는 '조건부 합의'(조건 칸에 조건), 제안·검토 의견은 '제안', 결론이 나지 않은 것은 '미결'입니다.",
      "반대·유보 의견을 빠뜨리지 마세요('반대 의견').",
      '발언자·담당·기한은 원문에 적혀 있을 때만 씁니다. 짐작하지 마세요.',
    ],
  },
  fieldValues(c) {
    const by = (t: string) => c.items.filter((i) => i.type === t);
    const who = (i: ExtractedItem) => (i.values.speaker ? ` (${i.values.speaker})` : '');
    const discussion = [
      ...by('제안').map((i) => `○ (제안) ${line(i.values.content)}${who(i)}`),
      ...by('반대 의견').map((i) => `○ (반대 의견) ${line(i.values.content)}${who(i)}`),
      ...by('미결').map((i) => `○ (미결) ${line(i.values.content)}`),
      ...by('기타').map((i) => `○ ${line(i.values.content)}${who(i)}`),
    ];
    const decisions = [
      ...by('결정').map((i) => `○ ${line(i.values.content)}`),
      ...by('조건부 합의').map((i) => `○ (조건부) ${line(i.values.content)}${i.values.condition ? ` — 조건: ${line(i.values.condition)}` : ' — 조건 확인 필요'}`),
    ];
    const follow = by('후속조치').map((i) => {
      const owner = i.values.owner || '담당 확인 필요';
      const due = i.values.due || i.values.dueText || '기한 확인 필요';
      return `○ ${line(i.values.content)} (${owner} / ${due})`;
    });
    const participants = Array.isArray(c.form.participants) ? (c.form.participants as string[]).filter(Boolean) : [];
    return {
      회의명: String(c.form.meetingName ?? ''),
      ...(typeof c.form.meetingOn === 'string' && c.form.meetingOn ? { 일시: c.form.meetingOn } : {}),
      ...(c.meta.place ? { 장소: c.meta.place } : {}),
      ...(c.meta.chair ? { 주관: c.meta.chair } : {}),
      ...(participants.length ? { 참석자: participants.join(', ') } : {}),
      안건: by('안건').map((i, n) => `${n + 1}. ${line(i.values.content)}`).join('\n') || '',
      '논의 내용': discussion.join('\n'),
      '결정 사항': decisions.length ? decisions.join('\n') : '○ 확정된 결정 없음',
      '향후 계획': follow.length ? follow.join('\n') : '',
    };
  },
  sheetItems: (c) => c.items.filter((i) => i.type === '후속조치' || i.type === '미결' || i.type === '조건부 합의'),
  checks(c) {
    const out: NewReviewItem[] = [];
    const looksConditional = c.items.filter((i) => i.type === '결정' && CONDITIONAL.test(`${i.quote} ${i.values.content}`));
    if (looksConditional.length) {
      out.push({ severity: 'warning', code: 'DECISION_CONDITIONAL', message: `'결정'으로 분류했지만 원문에 조건·추후 결정 표현이 있는 항목 ${looksConditional.length}건(${looksConditional.map((i) => i.id).slice(0, 4).join(', ')}) — 확정 결정인지 확인하세요.`, field_ids: [] });
    }
    const condNoCond = c.items.filter((i) => i.type === '조건부 합의' && !i.values.condition);
    if (condNoCond.length) out.push({ severity: 'warning', code: 'CONDITION_MISSING', message: `조건이 적히지 않은 조건부 합의 ${condNoCond.length}건 — 조건을 확인하세요.`, field_ids: [] });
    const followNoOwner = c.items.filter((i) => i.type === '후속조치' && (!i.values.owner || (!i.values.due && !i.values.dueText)));
    if (followNoOwner.length) out.push({ severity: 'warning', code: 'FOLLOWUP_OWNER_DUE', message: `담당·기한이 원문에 없는 후속조치 ${followNoOwner.length}건 — 짐작하지 않고 비웠습니다. 회의 주관 부서가 정하세요.`, field_ids: [] });
    const participants = Array.isArray(c.form.participants) ? (c.form.participants as string[]).filter(Boolean) : [];
    if (!participants.length) out.push({ severity: 'info', code: 'PARTICIPANTS_UNCONFIRMED', message: '확인된 참석자를 적지 않아 참석자 칸을 비웠습니다(원자료에서 짐작하지 않음).', field_ids: [] });
    if (!c.items.some((i) => i.type === '결정' || i.type === '조건부 합의')) out.push({ severity: 'info', code: 'NO_DECISION', message: '확정·조건부 결정을 찾지 못했습니다. 결정이 없었던 회의인지 확인하세요.', field_ids: [] });
    return out;
  },
};

// ── 인수인계 ─────────────────────────────────────────────────

export const handoverSpec: ItemsWorkflowSpec = {
  spec: {
    name: '인수인계 업무 목록',
    typeColumn: { key: 'type', label: '구분', type: 'enum', options: ['진행 중', '미결', '완료', '반복 일정', '기타'], hint: '업무 상태' },
    columns: [
      { key: 'task', label: '업무', type: 'text', hint: '업무 이름' },
      { key: 'status', label: '현황', type: 'text', hint: '지금 상태·다음 할 일(원문 뜻 그대로)' },
      { key: 'owner', label: '관련 담당', type: 'person', hint: '원문에 적힌 담당자·부서·기관만' },
      { key: 'due', label: '기한·주기', type: 'date', hint: "원문에 적힌 기한(YYYY-MM-DD) 또는 주기('매월 5일')를 원문 그대로" },
      { key: 'reference', label: '참고 자료', type: 'text', hint: '관련 문서·시스템 이름(원문 그대로). 비밀번호·계정 정보는 쓰지 마세요' },
    ],
    meta: [],
    wantsSummary: true,
    redactSecrets: true,
    rules: [
      "'담당자 확인 현황'(직원이 직접 적은 글)이 다른 자료와 다르면 확인 현황을 따르고, 다른 자료의 내용은 현황 칸에 '(자료와 다름)'으로 적습니다.",
      "끝난 일은 '완료', 진행 중인 일은 '진행 중', 결정·조치가 남은 일은 '미결', 정기적으로 돌아오는 일은 '반복 일정'입니다.",
      '비밀번호·계정·인증 정보는 절대 옮기지 마세요.',
    ],
  },
  fieldValues(c) {
    const by = (t: string) => c.items.filter((i) => i.type === t);
    const row = (i: ExtractedItem) => {
      const tail = [i.values.owner, i.values.due || i.values.dueText].filter(Boolean).join(' / ');
      return `○ ${line(i.values.task)}${i.values.status ? ` — ${line(i.values.status)}` : ''}${tail ? ` (${tail})` : ''}`;
    };
    const refs = [...new Set(c.items.map((i) => i.values.reference).filter(Boolean).map(line))];
    return {
      제목: `${String(c.form.title ?? '')} 인수인계서`.trim(),
      '작성 기준일': String(c.form.basisDate ?? ''),
      '업무 개요': c.summary,
      '진행 중 업무': by('진행 중').map(row).join('\n') || '없음',
      '미결 과제': by('미결').map(row).join('\n') || '없음',
      '완료 업무': by('완료').map(row).join('\n') || '없음',
      '반복 일정': by('반복 일정').map(row).join('\n') || '없음',
      '참고 자료': refs.map((r) => `○ ${r}`).join('\n') || '없음',
      '유의 사항': '○ 비밀번호·계정 정보는 이 문서에 적지 않았습니다. 시스템 권한은 별도 절차로 신청·이관하세요.\n○ 담당·기한은 원자료에 적힌 것만 옮겼습니다. 비어 있는 곳은 인계자에게 확인하세요.',
    };
  },
  sheetItems: (c) => c.items.filter((i) => i.type === '반복 일정' || i.type === '미결' || i.type === '진행 중'),
  checks(c) {
    const out: NewReviewItem[] = [];
    const basis = typeof c.form.basisDate === 'string' ? c.form.basisDate : '';
    const overdue = c.items.filter((i) => (i.type === '미결' || i.type === '진행 중') && i.values.due && basis && i.values.due < basis);
    if (overdue.length) out.push({ severity: 'warning', code: 'DUE_PAST_BASIS', message: `기한이 작성 기준일(${basis})보다 지난 미결·진행 업무 ${overdue.length}건(${overdue.slice(0, 4).map((i) => i.id).join(', ')}) — 지금도 남은 일인지, 기한이 바뀌었는지 확인하세요.`, field_ids: [] });
    const pendingNoOwner = c.items.filter((i) => i.type === '미결' && !i.values.owner);
    if (pendingNoOwner.length) out.push({ severity: 'warning', code: 'PENDING_OWNER_MISSING', message: `관련 담당이 적히지 않은 미결 과제 ${pendingNoOwner.length}건 — 인계자에게 확인하세요.`, field_ids: [] });
    if (!c.summary.trim()) out.push({ severity: 'info', code: 'SUMMARY_EMPTY', message: '업무 개요를 원자료로 쓰지 못했습니다. 직접 적어 주세요.', field_ids: [] });
    return out;
  },
};

export const ITEMS_WORKFLOWS = { intake: intakeSpec, meeting: meetingSpec, handover: handoverSpec } as const;
export type ItemsWorkflowKey = keyof typeof ITEMS_WORKFLOWS;
