'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/work/client';
type FileRef = { id: string; file_name: string; size_bytes: number };

export default function AppResultExport({ conversationId, messageId, content }: { conversationId: string; messageId?: string; content: string }) {
  const [file, setFile] = useState<FileRef | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  useEffect(() => { setFile(null); setError(null); }, [conversationId, messageId, content]);
  async function create() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
      const expectedHash = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
      const response = await api<FileRef>('/api/apps/export', { method: 'POST', json: { conversationId, ...(messageId ? { messageId } : {}), expectedHash } });
      if (response.ok) setFile(response.data); else setError(response.error.message);
    } catch { setError('파일을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="my-5 rounded-xl border border-teal-100 bg-teal-50/50 p-4"><p className="mb-3 text-xs text-slate-600">내용을 검토한 뒤 한글 파일로 받을 수 있습니다. 저장된 결과를 그대로 담으며 AI를 다시 호출하지 않습니다.</p>{file ? <a href={`/api/files/${file.id}`} className="inline-flex rounded-xl bg-[#087f8c] px-4 py-2.5 text-sm font-semibold text-white">{file.file_name} 내려받기</a> : <button type="button" disabled={busy} onClick={() => void create()} className="rounded-xl bg-[#087f8c] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? '파일 준비 중…' : '한글(HWPX) 파일 만들기'}</button>}{error && <p role="alert" className="mt-3 text-xs text-red-700">{error}</p>}</div>;
}
