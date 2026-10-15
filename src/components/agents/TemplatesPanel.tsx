'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { TEMPLATE_EXTENSIONS, MAX_TEMPLATES } from '@/lib/template-files';

type TemplateItem = { id: string; name: string; file_name: string; size_bytes: number; created_at: string };

/**
 * 양식 파일 — 결과를 채울 기관 서식(HWP·HWPX·DOCX). 채우는 일은 S2가 한다.
 * 바꿀 때마다 판이 오르므로 저장 뒤에는 부모가 비서를 다시 읽는다(onChanged).
 */
export default function TemplatesPanel({
  agentId,
  version,
  onChanged,
}: {
  agentId: string;
  version: number;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<TemplateItem[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/agents/${agentId}/templates`);
    const r = await res.json();
    if (r.ok) setItems(r.data.items);
    else setError(r.error?.message ?? '양식을 불러오지 못했습니다.');
  }, [agentId]);

  useEffect(() => {
    load();
  }, [load, version]);

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file || !name.trim()) {
      setError('양식 이름과 파일을 모두 넣어 주세요.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', name.trim());
      fd.append('base_version', String(version));
      const res = await fetch(`/api/agents/${agentId}/templates`, { method: 'POST', body: fd });
      const r = await res.json();
      if (!r.ok) {
        setError(r.error?.message ?? '양식을 올리지 못했습니다.');
        // 판이 어긋났으면 부모가 판을 새로 읽어야 다음 시도가 통한다
        if (res.status === 409 && r.error?.details?.reason === 'conflict') onChanged();
        return;
      }
      setName('');
      if (fileRef.current) fileRef.current.value = '';
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: TemplateItem) => {
    if (!confirm(`'${item.name}' 양식을 뺄까요? 변경 기록에서 이전 판으로 되돌리면 다시 살아납니다.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/templates/${item.id}?base_version=${version}`, { method: 'DELETE' });
      const r = await res.json();
      if (!r.ok) {
        setError(r.error?.message ?? '양식을 빼지 못했습니다.');
        if (res.status === 409 && r.error?.details?.reason === 'conflict') onChanged();
      } else {
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">
        결과를 채울 기관 서식을 올려 둡니다. 비서 하나에 {MAX_TEMPLATES}개까지, 양식마다 이름을 붙입니다.
        대화에서 &ldquo;사업계획서 양식으로 써 줘&rdquo;처럼 이름으로 고릅니다.
      </p>

      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 p-3 border border-slate-100 rounded-xl">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-800 truncate">{item.name}</p>
              <p className="text-[11px] text-slate-400 truncate">
                {item.file_name} · {Math.max(1, Math.round(item.size_bytes / 1024))}KB
              </p>
            </div>
            <button
              onClick={() => remove(item)}
              disabled={busy}
              className="px-3 py-1 text-xs border border-red-200 text-red-500 rounded-lg hover:bg-red-50 disabled:opacity-50"
            >
              빼기
            </button>
          </li>
        ))}
        {items.length === 0 && <li className="text-xs text-slate-400 py-4 text-center">올린 양식이 없습니다.</li>}
      </ul>

      {items.length < MAX_TEMPLATES && (
        <div className="border border-slate-200 rounded-xl p-3 space-y-2">
          <input
            type="text"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            placeholder="양식 이름 (예: 사업계획서)"
            className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#003087]/20"
          />
          <input
            ref={fileRef}
            type="file"
            accept={TEMPLATE_EXTENSIONS.map((e) => `.${e}`).join(',')}
            className="block w-full text-xs text-slate-500"
          />
          <button
            onClick={upload}
            disabled={busy}
            className="px-4 py-2 bg-[#003087] hover:bg-[#002070] disabled:bg-slate-300 text-white text-sm font-semibold rounded-xl"
          >
            {busy ? '올리는 중...' : '양식 올리기'}
          </button>
        </div>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
