// src/lib/work/context.ts
import type { WorkStore } from './store/types';
import type { WorkFiles } from './files';
import type { FieldGenerator } from './generation/compose';
import type { DocumentRenderer } from './documents/renderer';
import type { RegulationProviders } from './workflows/regulations/gather';
import type { RegulationModel } from './workflows/regulations/model';
import type { ItemsModel } from './workflows/items/model';
import type { QaModel } from './workflows/qa/model';

/**
 * 업무 서비스·실행기가 쓰는 의존성 묶음. 운영 기본값은 defaultWorkContext(server-context.ts),
 * 통합 시험은 pg 저장소·로컬 파일·가짜 생성기를 끼운다.
 */
export interface WorkContext {
  store: WorkStore;
  files: WorkFiles;
  generator: FieldGenerator;
  /** 시험 모드 생성기를 쓰는 중인지(결과에 표시) */
  generatorMode: 'llm' | 'mock';
  renderer: DocumentRenderer;
  /** 규정·지침 확인의 근거 제공자·모델 — 없으면 그 업무는 준비 중으로 실패한다 */
  regulations?: { providers: RegulationProviders; model: RegulationModel };
  /** 항목 뽑기(접수·회의·인수인계) 모델 — 없으면 그 업무들은 준비 중으로 실패한다 */
  items?: { model: ItemsModel };
  /** 질문별 답변(회신·감사) 모델 */
  qa?: { model: QaModel };
  /** 기관 허용 모델로 확정(model-policy) */
  resolveModel(departmentId: string): Promise<string>;
  /** 기관 정지·한도(usage-limit) */
  checkLimit(departmentId: string, userId: string): Promise<{ allowed: boolean; message?: string }>;
  log(p: { level: 'info' | 'warning' | 'error' | 'critical'; category: string; message: string; details?: Record<string, unknown> }): Promise<void>;
  now(): Date;
}
