// src/lib/work/catalog.ts
import raw from './workflow-catalog.json';
import { WORKFLOW_KEYS, type WorkflowKey } from './types';

/**
 * 10개 업무 비서 정의(docs/workon-rebuild/contracts/workflow-catalog.json의 사본 — 런타임 기준은 이 파일).
 * 이름은 바꿔도 key는 바꾸지 않는다. 기관에서 실제로 쓸 수 있는지는 여기가 아니라
 * 서버가 구현·양식·설치 상태로 판정한다(workflows/index.ts의 readiness).
 */
export type InputType = 'string' | 'long-text' | 'date' | 'enum' | 'file-set' | 'template' | 'string-list' | 'record-list';

export interface WorkflowInput {
  key: string;
  label: string;
  type: InputType;
  required: boolean;
  options?: string[];
}

export interface WorkflowOutput {
  key: string;
  label: string;
  format: 'hwpx' | 'xlsx';
  required: boolean;
}

export interface WorkflowDefinition {
  key: WorkflowKey;
  name: string;
  group: 'A' | 'B' | 'C';
  purpose: string;
  defaultTaskVisibility: 'private';
  inputs: WorkflowInput[];
  outputs: WorkflowOutput[];
  reuseCapabilities: string[];
  validationRules: string[];
  scopeNote: string;
}

const INPUT_TYPES: InputType[] = ['string', 'long-text', 'date', 'enum', 'file-set', 'template', 'string-list', 'record-list'];

function load(): WorkflowDefinition[] {
  const list = (raw as { workflows: WorkflowDefinition[] }).workflows;
  const keys = list.map((w) => w.key);
  if (new Set(keys).size !== keys.length) throw new Error('workflow-catalog: key 중복');
  for (const k of keys) if (!(WORKFLOW_KEYS as readonly string[]).includes(k)) throw new Error(`workflow-catalog: 모르는 key ${k}`);
  for (const w of list) {
    for (const i of w.inputs) {
      if (!INPUT_TYPES.includes(i.type)) throw new Error(`workflow-catalog: ${w.key}.${i.key} 입력 형식 ${i.type}`);
      if (i.type === 'enum' && !i.options?.length) throw new Error(`workflow-catalog: ${w.key}.${i.key} 선택지 없음`);
    }
    if (!w.outputs.some((o) => o.required)) throw new Error(`workflow-catalog: ${w.key} 필수 산출 파일 없음`);
  }
  return list;
}

export const WORKFLOWS: readonly WorkflowDefinition[] = load();

export function getWorkflow(key: string): WorkflowDefinition | null {
  return WORKFLOWS.find((w) => w.key === key) ?? null;
}

export function isWorkflowKey(key: unknown): key is WorkflowKey {
  return typeof key === 'string' && (WORKFLOW_KEYS as readonly string[]).includes(key);
}

/** 카탈로그 판 — 작업에 고정해 두고 나중에 정의가 바뀌어도 그때 무엇으로 만들었는지 안다 */
export const CATALOG_VERSION = (raw as { schemaVersion: string }).schemaVersion;
