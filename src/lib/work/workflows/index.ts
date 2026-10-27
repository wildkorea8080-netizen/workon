// src/lib/work/workflows/index.ts
import { getWorkflow, WORKFLOWS, type WorkflowDefinition } from '../catalog';
import type { DocumentField, WorkflowKey } from '../types';
import type { FormValues } from './form';

/**
 * 업무별 구현 등록부. 카탈로그에 있어도 여기에 없으면 '준비 중'이다 — 프롬프트만 바꾼 껍데기를 '사용 가능'으로 꾸미지 않는다.
 *
 * 구현 하나가 갖추는 것: 기본 양식, 필수 칸, 폼 → 칸 미리 채우기, 결과 파일 키.
 * 공통 단계(실행·검수·파일·실패 복구)는 runs/executor.ts가 한다.
 */
export interface WorkflowImpl {
  key: WorkflowKey;
  /**
   * document = 양식 칸 채우기(HWPX), collection = 표 취합(XLSX, 숫자는 프로그램이 냄),
   * regulations = 근거를 찾아 검토 메모(HWPX — 양식 칸이지만 근거 모으기·유보 판정을 거친다),
   * items = 원자료에서 항목(요청사항·결정·미결 과제)을 원문 인용과 함께 뽑아 처리표(XLSX)·양식(HWPX)으로(workflows/items),
   * settlement = 예산·집행·증빙 대사(프로그램 계산, workflows/settlement), qa = 질문별 답변(회신·감사, workflows/qa)
   */
  kind: 'document' | 'collection' | 'regulations' | 'items' | 'settlement' | 'qa';
  /** 기관 양식이 없을 때 쓰는 WORKON 표준 양식(취합은 없음) */
  defaultTemplateRef: string | null;
  /** 비면 '검토 완료'를 막는 칸(양식 자리 이름) */
  requiredFieldLabels: readonly string[];
  /** 결과 파일 키(카탈로그 outputs의 key) — '검토 완료'가 요구하는 주 결과 */
  documentOutputKey: string;
  /** 함께 만드는 결과 파일(주 결과 포함, 순서대로). 없으면 주 결과 하나 */
  outputs?: readonly { key: string; format: 'hwpx' | 'xlsx' }[];
  /** 직원이 정하는 칸 — AI가 쓰지 않는다(공개구분·경유처럼 행정 판단이 필요한 값). 비면 확인 사항으로 알린다 */
  humanOnlyLabels: readonly string[];
  /** 폼 값으로 바로 채울 수 있는 칸 — 모델을 거치지 않는다(지어낼 여지를 줄인다) */
  prefill(values: FormValues, ctx: { organizationName: string | null; departmentName: string | null; today: string }): Record<string, string>;
}

const officialLetter: WorkflowImpl = {
  key: 'official-letter',
  kind: 'document',
  defaultTemplateRef: 'builtin:official_letter',
  requiredFieldLabels: ['수신', '제목', '본문', '발신명의'],
  documentOutputKey: 'letter',
  humanOnlyLabels: ['공개구분', '경유'],
  prefill(values, { organizationName }) {
    const out: Record<string, string> = {};
    if (typeof values.title === 'string') out['제목'] = values.title;
    const recipients = Array.isArray(values.recipients) ? (values.recipients as string[]) : [];
    // 수신처가 둘 이상이면 공문 관례대로 '수신자 참조'로 두고 본문 끝 수신자 목록은 모델이 쓰지 않는다(직원이 확인)
    if (recipients.length === 1) out['수신'] = recipients[0];
    else if (recipients.length > 1) out['수신'] = '수신자 참조';
    const attachments = Array.isArray(values.attachments) ? (values.attachments as { name: string; note?: string }[]) : [];
    if (attachments.length) out['붙임'] = attachments.map((a, i) => `${i + 1}. ${a.name}${a.note ? ` ${a.note}` : ''}`).join('\n') + '  끝.';
    if (organizationName) out['행정기관명'] = organizationName;
    return out;
  },
};

/** 자료 취합 — 부서별 제출 표를 항목별로 더해 통합 엑셀(workflows/collection). 모델을 부르지 않는다 */
const collection: WorkflowImpl = {
  key: 'collection',
  kind: 'collection',
  defaultTemplateRef: null,
  requiredFieldLabels: [],
  documentOutputKey: 'collection',
  humanOnlyLabels: [],
  prefill: () => ({}),
};

/**
 * 규정·지침 확인 — 기관 문서·공통 기준·법령·추가 자료에서 근거를 찾아 근거 검토 메모(workflows/regulations).
 * 칸은 프로그램이 찾은 근거로 쓰고 '검토 의견'만 모델 초안(근거 번호가 없는 문장은 유보로 옮긴다)
 */
const regulations: WorkflowImpl = {
  key: 'regulations',
  kind: 'regulations',
  defaultTemplateRef: 'builtin:regulation_memo',
  requiredFieldLabels: ['제목', '검토 질문', '적용 기준', '검토 의견'],
  documentOutputKey: 'regulationMemo',
  humanOnlyLabels: [],
  prefill: () => ({}),
};

/** 보고서·사업계획 — 근거 자료(다른 작업의 결과 파일도 가져와 쓴다)로 보고서 양식 칸을 채운다. 숫자는 원자료와 대조 */
const report: WorkflowImpl = {
  key: 'report',
  kind: 'document',
  defaultTemplateRef: 'builtin:report',
  requiredFieldLabels: ['제목', '개요', '주요 내용'],
  documentOutputKey: 'report',
  humanOnlyLabels: [],
  prefill(values, { departmentName, today }) {
    const out: Record<string, string> = {};
    if (typeof values.title === 'string') out['제목'] = values.title;
    if (departmentName) out['작성부서'] = departmentName;
    out['작성일'] = today;
    return out;
  },
};

/** 접수공문 처리 — 본문·붙임에서 요청사항·제출물·기한을 원문 인용과 함께(처리표 XLSX). 담당 부서는 후보만 */
const intake: WorkflowImpl = {
  key: 'intake',
  kind: 'items',
  defaultTemplateRef: null,
  requiredFieldLabels: [],
  documentOutputKey: 'actionSheet',
  outputs: [{ key: 'actionSheet', format: 'xlsx' }],
  humanOnlyLabels: [],
  prefill: () => ({}),
};

/** 회의·위원회 정리 — 메모·전사문에서 결정·조건부 합의·제안·미결·후속조치(회의록 HWPX + 후속조치표 XLSX) */
const meeting: WorkflowImpl = {
  key: 'meeting',
  kind: 'items',
  defaultTemplateRef: 'builtin:minutes',
  requiredFieldLabels: ['회의명', '결정 사항'],
  documentOutputKey: 'minutes',
  outputs: [{ key: 'minutes', format: 'hwpx' }, { key: 'followups', format: 'xlsx' }],
  humanOnlyLabels: ['작성자'],
  prefill: () => ({}),
};

/** 인수인계 — 확인된 자료로 진행·미결·완료·반복 일정(인수인계서 HWPX + 반복 일정·미결 과제 XLSX). 비밀값은 지운다 */
const handover: WorkflowImpl = {
  key: 'handover',
  kind: 'items',
  defaultTemplateRef: 'builtin:handover',
  requiredFieldLabels: ['제목', '작성 기준일', '미결 과제'],
  documentOutputKey: 'handover',
  outputs: [{ key: 'handover', format: 'hwpx' }, { key: 'calendar', format: 'xlsx' }],
  humanOnlyLabels: ['인계자', '인수자', '확인자'],
  prefill: () => ({}),
};

/** 예산·정산 대사 — 승인 예산·집행 내역·증빙을 프로그램이 맞춰 대사표 XLSX. 비용 인정·지급은 하지 않는다 */
const settlement: WorkflowImpl = {
  key: 'settlement',
  kind: 'settlement',
  defaultTemplateRef: null,
  requiredFieldLabels: [],
  documentOutputKey: 'reconciliation',
  outputs: [{ key: 'reconciliation', format: 'xlsx' }],
  humanOnlyLabels: [],
  prefill: () => ({}),
};

/** 민원·문의 회신 — 담당자가 확인한 사실·근거로 질문별 회신 초안(HWPX). 처분·자격·발송은 하지 않는다 */
const reply: WorkflowImpl = {
  key: 'reply',
  kind: 'qa',
  defaultTemplateRef: 'builtin:reply',
  requiredFieldLabels: ['제목', '답변'],
  documentOutputKey: 'reply',
  outputs: [{ key: 'reply', format: 'hwpx' }],
  humanOnlyLabels: ['연락처'],
  prefill: () => ({}),
};

/** 감사·평가 요구자료 — 요구 항목별 답변(HWPX) + 증빙목록·수치 대조(XLSX) */
const auditResponse: WorkflowImpl = {
  key: 'audit-response',
  kind: 'qa',
  defaultTemplateRef: 'builtin:audit_response',
  requiredFieldLabels: ['제목', '요구 항목별 답변'],
  documentOutputKey: 'response',
  outputs: [{ key: 'response', format: 'hwpx' }, { key: 'evidenceIndex', format: 'xlsx' }],
  humanOnlyLabels: [],
  prefill: () => ({}),
};

const IMPLEMENTATIONS: Partial<Record<WorkflowKey, WorkflowImpl>> = {
  'official-letter': officialLetter,
  collection,
  regulations,
  report,
  intake,
  meeting,
  handover,
  settlement,
  reply,
  'audit-response': auditResponse,
};

/** 만들 결과 파일 키 — 주 결과가 먼저 */
export function outputKeysOf(impl: WorkflowImpl): string[] {
  return impl.outputs?.map((o) => o.key) ?? [impl.documentOutputKey];
}

export function getWorkflowImpl(key: string): WorkflowImpl | null {
  return (IMPLEMENTATIONS as Record<string, WorkflowImpl | undefined>)[key] ?? null;
}

export interface WorkflowSummary {
  key: WorkflowKey;
  name: string;
  group: 'A' | 'B' | 'C';
  purpose: string;
  outputs: WorkflowDefinition['outputs'];
  inputs: WorkflowDefinition['inputs'];
  scopeNote: string;
  available: boolean;
  /** 준비 중이면 그 이유 */
  reason: string | null;
  /** 새 작업 화면이 먼저 고를 표준 양식 */
  defaultTemplateRef: string | null;
}

export function summarizeWorkflows(): WorkflowSummary[] {
  return WORKFLOWS.map((w) => {
    const impl = getWorkflowImpl(w.key);
    return {
      key: w.key,
      name: w.name,
      group: w.group,
      purpose: w.purpose,
      outputs: w.outputs,
      inputs: w.inputs,
      scopeNote: w.scopeNote,
      available: Boolean(impl),
      reason: impl ? null : '업무 처리·검수·결과 파일 구현이 아직 끝나지 않았습니다.',
      defaultTemplateRef: impl?.defaultTemplateRef ?? null,
    };
  });
}

export function definitionFor(key: WorkflowKey): WorkflowDefinition {
  return getWorkflow(key)!;
}

/** 폼 값으로 미리 채운 칸(origin 'form') */
export function applyPrefill(fields: DocumentField[], prefill: Record<string, string>): DocumentField[] {
  return fields.map((f) => (prefill[f.label] !== undefined && !f.locked && f.origin !== 'user' ? { ...f, value: prefill[f.label], origin: 'form' } : f));
}
