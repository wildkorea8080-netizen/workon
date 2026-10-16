'use client';

import { useEffect, useState } from 'react';
import { formatFileSize } from '@/lib/file-size';
import type { AttachmentRow } from '@/lib/attachments/types';
import type { FileChip } from './useFileAttachments';

function stageText(chip: FileChip): string {
  switch (chip.stage) {
    case 'uploading':
      return '올리는 중';
    case 'reading':
      return '읽는 중';
    case 'ready': {
      const tables = chip.attachment?.summary?.tables.length ?? 0;
      return tables > 0 ? `준비됨 · 표 ${tables}개` : '준비됨';
    }
    case 'failed':
      return `실패: ${chip.error ?? '파일을 읽지 못했습니다.'}`;
  }
}

/** 보내기 전에 붙여 둔 파일 칩. 올리는·읽는 중에는 지울 수 없다 */
export function PendingFileChips({
  chips,
  onRemove,
}: {
  chips: FileChip[];
  onRemove: (key: string) => void;
}) {
  // 읽는 장치가 바뀐 내용을 알리려면 영역이 먼저 있어야 해서 비어 있어도 그린다
  return (
    <div aria-live="polite" className={chips.length > 0 ? 'mb-2 flex flex-col gap-1.5' : undefined}>
      {chips.map((chip) => {
        const inProgress = chip.stage === 'uploading' || chip.stage === 'reading';
        const tone =
          chip.stage === 'failed'
            ? 'border-red-200 bg-red-50 text-red-700'
            : chip.stage === 'ready'
            ? 'border-[#003087]/20 bg-[#003087]/5 text-slate-700'
            : 'border-slate-200 bg-white text-slate-500';
        return (
          <div key={chip.key} className={`flex items-center gap-2 border rounded-lg px-3 py-1.5 text-xs ${tone}`}>
            {inProgress && (
              <svg className="w-3.5 h-3.5 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            )}
            <span className="font-medium truncate max-w-[40%]" title={chip.name}>{chip.name}</span>
            <span className="text-slate-400 flex-shrink-0">{formatFileSize(chip.size)}</span>
            <span className="flex-1 min-w-0 truncate" title={stageText(chip)}>{stageText(chip)}</span>
            {!inProgress && (
              <button
                type="button"
                onClick={() => onRemove(chip.key)}
                aria-label={`${chip.name} 지우기`}
                className="flex-shrink-0 w-5 h-5 rounded-full text-slate-500 hover:bg-slate-200 hover:text-slate-900 flex items-center justify-center"
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 이 대화에 묶인 첨부 목록. 접어 두고, 열면 안내와 파일 목록이 나온다 */
export function ConversationAttachments({
  conversationId,
  refreshKey,
}: {
  conversationId: string;
  /** 바뀌면 다시 불러온다 — 보낸 직후 */
  refreshKey: number;
}) {
  const [items, setItems] = useState<AttachmentRow[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/attachments?conversation_id=${encodeURIComponent(conversationId)}`)
      .then((r) => r.json())
      .then((r) => {
        if (!cancelled) setItems(r.ok && Array.isArray(r.data) ? r.data : []);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, refreshKey]);

  if (items.length === 0) return null;

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-xs font-semibold text-[#003087] hover:underline"
      >
        이 대화의 첨부 {items.length}개 {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="mt-1.5 border border-slate-200 rounded-lg bg-white px-3 py-2">
          <ul className="space-y-1">
            {items.map((item) => {
              const tables = item.summary?.tables.length ?? 0;
              return (
                <li key={item.id} className="flex items-center gap-2 text-xs text-slate-700">
                  <span className="truncate font-medium" title={item.file_name}>{item.file_name}</span>
                  <span className="text-slate-400 flex-shrink-0">
                    {formatFileSize(item.size_bytes)}{tables > 0 ? ` · 표 ${tables}개` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-[11px] text-slate-400">
            첨부한 파일은 이 대화에서 계속 쓸 수 있습니다. 대화를 지우면 함께 지워집니다.
          </p>
        </div>
      )}
    </div>
  );
}
