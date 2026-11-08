'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/work/client';
type FileRef = { id: string; file_name: string; size_bytes: number; emptied?: string[] };
type TemplateOption = { id: string; name: string };

// 같은 대화의 답마다 버튼이 붙으므로 양식 목록은 대화마다 한 번만 읽는다(실패는 기억하지 않는다)
const templateLists = new Map<string, Promise<TemplateOption[]>>();
function loadTemplates(conversationId: string): Promise<TemplateOption[]> {
  let pending = templateLists.get(conversationId);
  if (!pending) {
    pending = api<{ templates: TemplateOption[] }>(`/api/apps/export?conversationId=${encodeURIComponent(conversationId)}`)
      .then(r => (r.ok ? r.data.templates : []))
      .catch(() => [] as TemplateOption[])
      .then(list => { if (!list.length) templateLists.delete(conversationId); return list; });
    templateLists.set(conversationId, pending);
  }
  return pending;
}

const STANDARD = '';

export default function AppResultExport({ conversationId, messageId, content, defaultTemplateId }: { conversationId: string; messageId?: string; content: string; /** 앱 설정의 결과 한글 파일 양식 — 목록에 있으면 먼저 골라 둔다 */ defaultTemplateId?: string }) {
  const [files, setFiles] = useState<Record<string, FileRef>>({}); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TemplateOption[]>([]); const [choice, setChoice] = useState(STANDARD);
  const pending = useRef(false);
  useEffect(() => { setFiles({}); setError(null); }, [conversationId, messageId, content]);
  useEffect(() => {
    let live = true;
    setTemplates([]); setChoice(STANDARD);
    void loadTemplates(conversationId).then(list => { if (!live) return; setTemplates(list); if (defaultTemplateId && list.some(t => t.id === defaultTemplateId)) setChoice(defaultTemplateId); });
    return () => { live = false; };
  }, [conversationId, defaultTemplateId]);
  const file = files[choice];
  async function create() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    const target = choice;
    try {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
      const expectedHash = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
      const response = await api<FileRef>('/api/apps/export', { method: 'POST', json: { conversationId, ...(messageId ? { messageId } : {}), expectedHash, ...(target ? { templateId: target } : {}) } });
      if (response.ok) setFiles(prev => ({ ...prev, [target]: response.data })); else setError(response.error.message);
    } catch { setError('파일을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return (
    <div className="my-5 rounded-xl border border-teal-100 bg-teal-50/50 p-4">
      <p className="mb-3 text-xs text-slate-600">내용을 검토한 뒤 한글 파일로 받을 수 있습니다. 저장된 결과를 그대로 담으며 AI를 다시 호출하지 않습니다.</p>
      {templates.length > 0 && (
        <label className="mb-3 block text-xs text-slate-600">
          담을 양식
          <select aria-label="담을 양식" value={choice} disabled={busy} onChange={e => { setChoice(e.target.value); setError(null); }} className="ml-2 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs">
            <option value={STANDARD}>표준 보고서</option>
            {templates.map(t => <option key={t.id} value={t.id}>기관 양식 · {t.name}</option>)}
          </select>
        </label>
      )}
      {file
        ? <a href={`/api/files/${file.id}`} className="inline-flex rounded-xl bg-ws-accent px-4 py-2.5 text-sm font-semibold text-white">{file.file_name} 내려받기</a>
        : <button type="button" disabled={busy} onClick={() => void create()} className="rounded-xl bg-ws-accent px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? '파일 준비 중…' : '한글(HWPX) 파일 만들기'}</button>}
      {file?.emptied?.length ? <p role="status" className="mt-3 text-xs leading-5 text-amber-800">양식의 빈 칸으로 둔 항목: {file.emptied.join(', ')} — 한글에서 채워 주세요.</p> : null}
      {error && <p role="alert" className="mt-3 text-xs text-red-700">{error}</p>}
    </div>
  );
}
