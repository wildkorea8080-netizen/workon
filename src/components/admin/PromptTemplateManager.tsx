'use client';

import { useEffect, useState } from 'react';

type Template = { id: string; name: string; description: string | null; content: string; created_at: string };

/**
 * 옛 보고서 템플릿 — 읽기 전용(S1-c).
 *
 * 보고서 생성 화면은 S1-b에서 걷어냈다. 그 일은 비서의 지시문과 S2의
 * '양식 채우기'가 맡는다. 관리자가 써 둔 템플릿 내용을 잃지 않도록 보여 주고,
 * 비서 지시문으로 옮길 수 있게 복사 단추를 둔다.
 */
export default function PromptTemplateManager() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/templates')
      .then((r) => r.json())
      .then((r) => (r.ok ? setTemplates(r.data ?? []) : setError(r.error?.message ?? '불러오지 못했습니다.')))
      .catch(() => setError('불러오지 못했습니다.'));
  }, []);

  const copy = async (t: Template) => {
    // plain-http 사내망에서는 navigator.clipboard가 없거나 writeText가 거부된다.
    // 실패를 카드 안에 알리고, 직접 선택해 복사할 수 있도록 내용은 그대로 둔다.
    setFailedId(null);
    try {
      await navigator.clipboard.writeText(t.content);
      setCopiedId(t.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      setFailedId(t.id);
    }
  };

  return (
    <div className="space-y-4">
      <div className="p-4 rounded-xl bg-blue-50 border border-blue-100 text-sm text-slate-700">
        보고서 생성 기능은 비서로 옮겨졌습니다. 아래 내용을 복사해 비서 관리 → [설정] → 지시문에 붙여 넣으세요.
        기관 서식은 [설정] → 양식 탭에 올립니다.
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {templates.map((t) => (
        <div key={t.id} className="bg-white border border-slate-100 rounded-xl p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900">{t.name}</p>
              {t.description && <p className="text-xs text-slate-500 mt-0.5">{t.description}</p>}
            </div>
            <button
              onClick={() => copy(t)}
              className="px-3 py-1 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600 flex-shrink-0"
            >
              {copiedId === t.id ? '복사됨' : '내용 복사'}
            </button>
          </div>
          {failedId === t.id && (
            <p className="mt-2 text-xs text-red-500">복사하지 못했습니다. 아래 내용을 직접 선택해 복사하세요.</p>
          )}
          <pre className="mt-3 p-3 bg-slate-50 rounded-lg text-xs text-slate-600 whitespace-pre-wrap font-sans border border-slate-100 max-h-48 overflow-y-auto">
            {t.content}
          </pre>
        </div>
      ))}

      {templates.length === 0 && !error && (
        <p className="text-center py-10 text-sm text-slate-400">남아 있는 템플릿이 없습니다.</p>
      )}
    </div>
  );
}
