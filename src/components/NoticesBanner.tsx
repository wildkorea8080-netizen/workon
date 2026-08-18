'use client';

import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Notice {
  id: string;
  title: string;
  content: string;
  importance: 'normal' | 'important' | 'urgent';
  published_at: string;
  isRead: boolean;
}

const BG: Record<string, string> = {
  urgent:    'bg-red-600 text-white',
  important: 'bg-blue-600 text-white',
  normal:    'bg-slate-700 text-slate-200',
};
const ICON: Record<string, string> = {
  urgent: '🚨', important: '📢', normal: '📌',
};

export default function NoticesBanner() {
  const [notice, setNotice]     = useState<Notice | null>(null);
  const [modal, setModal]       = useState<Notice | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    fetch('/api/notices')
      .then(r => r.json())
      .then(d => {
        if (!d.ok || !d.data?.length) return;
        // 읽지 않은 것 중 가장 중요한 것 1개
        const unread = (d.data as Notice[]).filter(n => !n.isRead);
        const priority = ['urgent', 'important', 'normal'];
        const top = priority.reduce((found: Notice | null, imp) =>
          found ?? unread.find(n => n.importance === imp) ?? null, null
        );
        if (top) setNotice(top);
      })
      .catch(() => {});
  }, []);

  const handleRead = async (n: Notice) => {
    setModal(n);
    if (!n.isRead) {
      await fetch(`/api/notices/${n.id}/read`, { method: 'POST' }).catch(() => {});
      setNotice(prev => prev ? { ...prev, isRead: true } : null);
    }
  };

  if (!notice || dismissed) return null;

  return (
    <>
      <div className={`${BG[notice.importance]} px-4 py-2.5 flex items-center gap-3`}>
        <span className="text-base flex-shrink-0">{ICON[notice.importance]}</span>
        <span className="text-sm font-semibold flex-1 truncate">
          {notice.importance === 'urgent' ? '[긴급] ' : notice.importance === 'important' ? '[중요] ' : ''}
          {notice.title}
          <span className="ml-2 font-normal opacity-70 text-xs">
            {new Date(notice.published_at).toLocaleDateString('ko-KR')}
          </span>
        </span>
        <button onClick={() => handleRead(notice)}
          className="text-xs underline opacity-80 hover:opacity-100 flex-shrink-0">자세히 보기 →</button>
        <button onClick={() => setDismissed(true)}
          className="ml-1 p-1 rounded hover:bg-white/20 transition-colors flex-shrink-0 text-xs">✕ 닫기</button>
      </div>

      {modal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4"
          onClick={() => setModal(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className="text-xl">{ICON[modal.importance]}</span>
                <h2 className="text-base font-bold text-slate-900">{modal.title}</h2>
              </div>
              <button onClick={() => setModal(null)} className="text-slate-400 hover:text-slate-600 p-1">✕</button>
            </div>
            <div className="prose prose-sm max-w-none text-slate-700 max-h-80 overflow-y-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{modal.content}</ReactMarkdown>
            </div>
            <p className="text-xs text-slate-400 mt-4">{new Date(modal.published_at).toLocaleString('ko-KR')}</p>
            <button onClick={() => setModal(null)}
              className="mt-4 w-full py-2.5 bg-slate-900 hover:bg-slate-700 text-white text-sm font-semibold rounded-xl transition-colors">
              확인
            </button>
          </div>
        </div>
      )}
    </>
  );
}
