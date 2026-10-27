// src/lib/work/documents/renderer.ts
/**
 * 실제 파일 렌더러 경계 (개편 04 문서 7절, ADR 0002).
 *
 * '실제 파일 미리보기'는 저장한 바로 그 파일(같은 sha256)을 렌더러가 열어 그린 쪽 그림·PDF다.
 * 구조 미리보기(필드 목록을 화면에 그린 것)와 섞지 않는다.
 *
 * 지금 서버(Vercel)에서 쓸 수 있는 HWPX 렌더러는 없다 — 기본 구현은 `unavailableRenderer`이고 미리보기 상태는 'unsupported'다.
 * 로컬 Windows 작업자에서는 설치된 한글(COM)로 PDF를 만들 수 있지만(scripts/hancom-verify.ps1과 같은 방식),
 * 서버 배포용 사용권·환경은 확인되지 않았다 — 운영 렌더러로 쓰지 않는다.
 */
export interface RendererHealth {
  available: boolean;
  supportsHwpx: boolean;
  supportsPdf: boolean;
  reason?: string;
}

export interface RenderedPreview {
  inputSha256: string;
  renderer: { name: string; version: string };
  kind: 'actual_file_render';
  pageCount: number;
  pdf: Buffer | null;
  warnings: string[];
}

export interface DocumentRenderer {
  name: string;
  health(): Promise<RendererHealth>;
  render(input: { bytes: Buffer; sha256: string; format: 'hwpx' | 'docx' }): Promise<RenderedPreview>;
}

export const RENDERER_UNAVAILABLE_REASON = '이 서버에는 HWPX 실제 파일 렌더러가 없습니다. 파일을 내려받아 한글에서 확인해 주세요.';

export const unavailableRenderer: DocumentRenderer = {
  name: 'none',
  async health() {
    return { available: false, supportsHwpx: false, supportsPdf: false, reason: RENDERER_UNAVAILABLE_REASON };
  },
  async render() {
    throw new Error(RENDERER_UNAVAILABLE_REASON);
  },
};

let current: DocumentRenderer = unavailableRenderer;

export function getRenderer(): DocumentRenderer {
  return current;
}

/** 로컬 작업자(scripts/work-worker.mjs)가 한글 렌더러를 끼울 때, 시험이 가짜를 끼울 때 */
export function setRenderer(r: DocumentRenderer | null): void {
  current = r ?? unavailableRenderer;
}
