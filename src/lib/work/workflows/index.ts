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
  /** 기관 양식이 없을 때 쓰는 WORKON 표준 양식 */
  defaultTemplateRef: string;
  /** 비면 '검토 완료'를 막는 칸(양식 자리 이름) */
  requiredFieldLabels: readonly string[];
  /** 결과 파일 키(카탈로그 outputs의 key) */
  documentOutputKey: string;
  /** 폼 값으로 바로 채울 수 있는 칸 — 모델을 거치지 않는다(지어낼 여지를 줄인다) */
  prefill(values: FormValues, ctx: { organizationName: string | null }): Record<string, string>;
}

const joinList = (v: FormValues[string] | undefined): string =>
  Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x.name)).join(', ') : typeof v === 'string' ? v : '';

const officialLetter: WorkflowImpl = {
  key: 'official-letter',
  defaultTemplateRef: 'builtin:official_letter',
  requiredFieldLabels: ['수신', '제목', '본문', '발신명의'],
  documentOutputKey: 'letter',
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

const IMPLEMENTATIONS: Partial<Record<WorkflowKey, WorkflowImpl>> = {
  'official-letter': officialLetter,
};

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
