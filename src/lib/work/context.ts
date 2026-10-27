// src/lib/work/context.ts
import type { WorkStore } from './store/types';
import type { WorkFiles } from './files';
import type { FieldGenerator } from './generation/compose';
import type { DocumentRenderer } from './documents/renderer';

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
  /** 기관 허용 모델로 확정(model-policy) */
  resolveModel(departmentId: string): Promise<string>;
  /** 기관 정지·한도(usage-limit) */
  checkLimit(departmentId: string, userId: string): Promise<{ allowed: boolean; message?: string }>;
  log(p: { level: 'info' | 'warning' | 'error' | 'critical'; category: string; message: string; details?: Record<string, unknown> }): Promise<void>;
  now(): Date;
}
