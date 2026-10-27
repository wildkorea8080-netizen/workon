// src/lib/work/files.ts
import { mkdir, readFile, rm, writeFile, stat } from 'fs/promises';
import path from 'path';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';

/**
 * 업무 파일 저장소 경계. 운영은 Supabase Storage(기존 비공개 documents 버킷), 시험은 로컬 폴더.
 *
 * 경로 규칙(이름·사용자 입력을 경로에 넣지 않는다):
 *   work/{기관}/{작업}/artifacts/{판 id}-{산출물 키}.{확장자}   — 같은 판·같은 키면 같은 경로(다시 시도해도 한 벌)
 *   work/{기관}/{작업}/sources/{원자료 id}.{확장자}  (+ .json 읽은 내용)
 * 대화 첨부(chat-uploads/…)·대화 생성 파일(generated/…)과 경로가 겹치지 않는다 — 그쪽 정리 작업이 이쪽을 지우지 않는다.
 * 서명 주소는 로그·이벤트에 남기지 않는다.
 */
export interface WorkFiles {
  put(storagePath: string, bytes: Buffer, contentType: string): Promise<void>;
  get(storagePath: string): Promise<Buffer | null>;
  remove(storagePaths: string[]): Promise<void>;
  /** 내려받기 서명 주소(짧은 수명). 이름은 직접 한 번만 인코딩해 붙인다(generated-files.ts와 같은 이유) */
  signedDownloadUrl(storagePath: string, fileName: string, ttlSeconds: number): Promise<string | null>;
  signedUploadToken(storagePath: string): Promise<{ token: string } | null>;
  size(storagePath: string): Promise<number | null>;
}

const SAFE_SEGMENT = /^[0-9a-f-]{36}$|^[A-Za-z0-9_.-]{1,80}$/;

function assertPath(parts: string[]): string {
  for (const p of parts) if (!SAFE_SEGMENT.test(p) || p === '.' || p === '..') throw new Error('잘못된 저장 경로');
  return parts.join('/');
}

export function artifactStoragePath(orgId: string, taskId: string, versionId: string, outputKey: string, ext: string): string {
  return assertPath(['work', orgId, taskId, 'artifacts', `${versionId}-${outputKey}.${ext}`]);
}

export function sourceStoragePath(orgId: string, taskId: string, sourceId: string, ext: string): string {
  return assertPath(['work', orgId, taskId, 'sources', `${sourceId}.${ext}`]);
}

export function sourceExtractPath(orgId: string, taskId: string, sourceId: string): string {
  return assertPath(['work', orgId, taskId, 'sources', `${sourceId}.extract.json`]);
}

export function createSupabaseWorkFiles(): WorkFiles {
  const bucket = () => supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET);
  return {
    async put(storagePath, bytes, contentType) {
      // 같은 판·같은 키의 경로는 같은 내용이다 — 다시 시도하며 덮어써도 된다(upsert)
      const { error } = await bucket().upload(storagePath, bytes, { contentType, upsert: true });
      if (error) throw new Error(`저장소에 올리지 못함: ${error.message}`);
    },
    async get(storagePath) {
      const { data, error } = await bucket().download(storagePath);
      if (error || !data) return null;
      return Buffer.from(await data.arrayBuffer());
    },
    async remove(paths) {
      if (!paths.length) return;
      const { error } = await bucket().remove(paths);
      if (error) throw new Error(`저장소에서 지우지 못함: ${error.message}`);
    },
    async signedDownloadUrl(storagePath, fileName, ttlSeconds) {
      const { data, error } = await bucket().createSignedUrl(storagePath, ttlSeconds);
      if (error || !data?.signedUrl) return null;
      const url = data.signedUrl;
      return `${url}${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(fileName)}`;
    },
    async signedUploadToken(storagePath) {
      const { data, error } = await bucket().createSignedUploadUrl(storagePath);
      if (error || !data?.token) return null;
      return { token: data.token };
    },
    async size(storagePath) {
      const dir = storagePath.split('/').slice(0, -1).join('/');
      const name = storagePath.split('/').pop()!;
      const { data, error } = await bucket().list(dir, { search: name, limit: 5 });
      if (error) return null;
      const hit = (data ?? []).find((f: { name: string }) => f.name === name) as { metadata?: { size?: number } } | undefined;
      return hit?.metadata?.size ?? null;
    },
  };
}

/** 시험·로컬 작업자용 — 폴더 아래에 같은 경로로 둔다 */
export function createLocalWorkFiles(root: string): WorkFiles {
  const full = (p: string) => {
    const f = path.resolve(root, p);
    if (!f.startsWith(path.resolve(root))) throw new Error('잘못된 저장 경로');
    return f;
  };
  return {
    async put(p, bytes) {
      await mkdir(path.dirname(full(p)), { recursive: true });
      await writeFile(full(p), bytes);
    },
    async get(p) {
      try {
        return await readFile(full(p));
      } catch {
        return null;
      }
    },
    async remove(paths) {
      for (const p of paths) await rm(full(p), { force: true });
    },
    async signedDownloadUrl(p, fileName) {
      return `local://${p}?download=${encodeURIComponent(fileName)}`;
    },
    async signedUploadToken(p) {
      return { token: `local:${p}` };
    },
    async size(p) {
      try {
        return (await stat(full(p))).size;
      } catch {
        return null;
      }
    },
  };
}
