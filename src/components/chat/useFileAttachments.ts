'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { uploadAttachment, checkAttachmentFile } from '@/lib/attachments/upload-client';
import { MAX_ATTACHMENTS_PER_SEND } from '@/lib/attachments/limits';
import type { AttachmentRow } from '@/lib/attachments/types';

export type ChipStage = 'uploading' | 'reading' | 'ready' | 'failed';

export interface FileChip {
  key: string;
  name: string;
  size: number;
  stage: ChipStage;
  /** 준비된 첨부. 보낼 때 id를 쓴다 */
  attachment?: AttachmentRow;
  /** 실패 이유 */
  error?: string;
}

/** 한꺼번에 올리는 수. 파일 열 개를 동시에 읽히면 서버 함수가 겹쳐 느려진다 */
const UPLOAD_CONCURRENCY = 3;

let chipSeq = 0;

function deleteOnServer(chip: FileChip) {
  if (chip.stage === 'ready' && chip.attachment) {
    void fetch(`/api/attachments/${chip.attachment.id}`, { method: 'DELETE' }).catch(() => {});
  }
}

/**
 * 보내기 전에 붙여 둔 파일 칩. 올리기·읽기는 upload-client가 하고, 여기서는
 * 상태와 동시성만 다룬다. 화면 검사는 표시일 뿐 서버가 다시 본다.
 */
export function useFileAttachments(enabled: boolean) {
  const [chips, setChips] = useState<FileChip[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const chipsRef = useRef<FileChip[]>([]);
  chipsRef.current = chips;

  const queue = useRef<{ key: string; file: File }[]>([]);
  const running = useRef(0);

  const patchChip = useCallback((key: string, patch: Partial<FileChip>) => {
    setChips((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  }, []);

  const pump = useCallback(() => {
    while (running.current < UPLOAD_CONCURRENCY && queue.current.length > 0) {
      const next = queue.current.shift()!;
      running.current += 1;
      void uploadAttachment(next.file, (stage) => patchChip(next.key, { stage }))
        .then((result) => {
          if (!result.ok) {
            patchChip(next.key, { stage: 'failed', error: result.message });
          } else if (result.attachment.status === 'ready') {
            patchChip(next.key, { stage: 'ready', attachment: result.attachment });
          } else {
            patchChip(next.key, {
              stage: 'failed',
              error: result.attachment.error ?? '파일을 읽지 못했습니다.',
            });
          }
        })
        .catch(() => patchChip(next.key, { stage: 'failed', error: '파일을 올리지 못했습니다.' }))
        .finally(() => {
          running.current -= 1;
          pump();
        });
    }
  }, [patchChip]);

  const addFiles = useCallback(
    (files: File[]) => {
      setNotice(null);
      if (!enabled || files.length === 0) return;

      // 실패한 칩은 보내지 않으므로 상한에 세지 않는다
      const active = chipsRef.current.filter((c) => c.stage !== 'failed').length;
      let room = MAX_ATTACHMENTS_PER_SEND - active;
      const added: FileChip[] = [];
      let overflow = false;

      for (const file of files) {
        const refused = checkAttachmentFile(file);
        if (refused) {
          added.push({ key: `f${++chipSeq}`, name: file.name, size: file.size, stage: 'failed', error: refused });
          continue;
        }
        if (room <= 0) {
          overflow = true;
          continue;
        }
        room -= 1;
        const key = `f${++chipSeq}`;
        added.push({ key, name: file.name, size: file.size, stage: 'uploading' });
        queue.current.push({ key, file });
      }

      if (overflow) setNotice(`파일은 한 번에 ${MAX_ATTACHMENTS_PER_SEND}개까지 보낼 수 있습니다.`);
      if (added.length > 0) {
        chipsRef.current = [...chipsRef.current, ...added];
        setChips(chipsRef.current);
      }
      pump();
    },
    [enabled, pump]
  );

  const remove = useCallback((key: string) => {
    setNotice(null);
    const chip = chipsRef.current.find((c) => c.key === key);
    if (!chip || chip.stage === 'uploading' || chip.stage === 'reading') return;
    // 준비된 첨부는 서버에 기록이 있어 지운다. 실패한 것은 서버가 이미 정리했으니 화면에서만 지운다
    deleteOnServer(chip);
    setChips((prev) => prev.filter((c) => c.key !== key));
  }, []);

  /** 보낸 뒤 비운다. 서버 기록은 대화에 묶였으므로 지우지 않는다 */
  const clear = useCallback(() => {
    setNotice(null);
    setChips([]);
  }, []);

  // 파일을 받지 않는 비서로 바뀌면 붙여 둔 것을 놓는다(보내면 서버가 거절한다)
  useEffect(() => {
    if (enabled) return;
    chipsRef.current.forEach(deleteOnServer);
    queue.current = [];
    setChips((prev) => (prev.length > 0 ? [] : prev));
  }, [enabled]);

  const busy = chips.some((c) => c.stage === 'uploading' || c.stage === 'reading');
  const readyIds = chips
    .filter((c) => c.stage === 'ready' && c.attachment)
    .map((c) => c.attachment!.id);

  return { chips, notice, busy, readyIds, addFiles, remove, clear };
}
