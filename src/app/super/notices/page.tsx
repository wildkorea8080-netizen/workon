'use client';

import { useState, useEffect, useCallback } from 'react';

const IMPORTANCE_META: Record<string, { label: string; badge: string; icon: string }> = {
  normal:    { label: '일반', badge: 'bg-slate-700 text-slate-300', icon: '📌' },
  important: { label: '중요', badge: 'bg-blue-900/50 text-blue-300', icon: '📢' },
  urgent:    { label: '긴급', badge: 'bg-red-900/50 text-red-400', icon: '🚨' },
};

const fmtDate = (s?: string | null) => s ? new Date(s).toLocaleDateString('ko-KR') : '—';

// ═══════════════════════════════════════════════════════════
export default function NoticesPage() {
  const [notices, setNotices]   = useState<any[]>([]);
  const [orgs, setOrgs]         = useState<any[]>([]);
  const [loading, setLoading]   = useState(true);
  const [filterStatus, setFilterStatus]   = useState('all');
  const [filterImportance, setFilterImportance] = useState('all');
  const [panelNotice, setPanelNotice] = useState<any>(null); // null=closed, {}=new, obj=edit
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3000); };

  const load = useCallback(async () => {
    setLoading(true);
    const [nr, or] = await Promise.all([
      fetch(`/api/super/notices?status=${filterStatus}`).then(r => r.json()),
      fetch('/api/super/organizations?limit=100').then(r => r.json()),
    ]);
    if (nr.ok) setNotices(nr.data);
    if (or.ok) setOrgs(or.data);
    setLoading(false);
  }, [filterStatus]);

  useEffect(() => { load(); }, [load]);

  const filtered = filterImportance === 'all'
    ? notices
    : notices.filter(n => n.importance === filterImportance);

  const handleTogglePublish = async (n: any) => {
    const res = await fetch(`/api/super/notices/${n.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublished: !n.is_published }),
    });
    const d = await res.json();
    if (d.ok) { load(); showToast(n.is_published ? '발행이 취소됐습니다.' : '공지가 발행됐습니다.'); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('공지를 삭제하시겠습니까?')) return;
    const res = await fetch(`/api/super/notices/${id}`, { method: 'DELETE' });
    const d = await res.json();
    if (d.ok) { load(); showToast('삭제됐습니다.'); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">공지사항 관리</h1>
          <p className="text-slate-400 text-sm mt-1">기관 사용자에게 공지를 발행합니다.</p>
        </div>
        <button onClick={() => setPanelNotice({})}
          className="flex items-center gap-2 px-5 py-2.5 bg-[#7C3AED] hover:bg-[#6D28D9] text-white text-sm font-semibold rounded-xl transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4"/>
          </svg>
          새 공지 작성
        </button>
      </div>

      {/* 필터 */}
      <div className="flex gap-3">
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
          className="px-3 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]">
          <option value="all">상태 전체</option>
          <option value="published">발행됨</option>
          <option value="draft">임시저장</option>
        </select>
        <select value={filterImportance} onChange={e => setFilterImportance(e.target.value)}
          className="px-3 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]">
          <option value="all">중요도 전체</option>
          <option value="normal">일반</option>
          <option value="important">중요</option>
          <option value="urgent">긴급</option>
        </select>
      </div>

      {/* 테이블 */}
      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-700/50">
            <tr>
              {['제목','중요도','대상','발행일','만료일','읽음수','상태','관리'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {loading ? (
              Array.from({length:3}).map((_,i) => (
                <tr key={i}>{Array.from({length:8}).map((_,j) => (
                  <td key={j} className="px-4 py-4"><div className="h-3 bg-slate-700/50 rounded animate-pulse"/></td>
                ))}</tr>
              ))
            ) : filtered.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-500">공지사항이 없습니다.</td></tr>
            ) : (
              filtered.map(n => {
                const meta = IMPORTANCE_META[n.importance ?? 'normal'];
                return (
                  <tr key={n.id} className="hover:bg-slate-700/20 transition-colors">
                    <td className="px-4 py-3 font-medium text-white max-w-xs truncate">{n.title}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${meta.badge}`}>
                        {meta.icon} {meta.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-xs">
                      {n.target_type === 'all' ? '전체 기관' : `${n.target_org_ids?.length ?? 0}개 기관`}
                    </td>
                    <td className="px-4 py-3 text-slate-500 text-xs">{fmtDate(n.published_at)}</td>
                    <td className="px-4 py-3 text-slate-500 text-xs">{fmtDate(n.expires_at)}</td>
                    <td className="px-4 py-3 text-slate-400">{n.readCount ?? 0}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${n.is_published ? 'bg-emerald-900/40 text-emerald-400' : 'bg-slate-700 text-slate-400'}`}>
                        {n.is_published ? '발행됨' : '임시저장'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1.5">
                        <button onClick={() => setPanelNotice(n)}
                          className="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 text-white text-xs rounded-lg transition-colors">수정</button>
                        <button onClick={() => handleTogglePublish(n)}
                          className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${n.is_published ? 'bg-slate-700 hover:bg-amber-900/40 text-slate-300 hover:text-amber-400' : 'bg-[#7C3AED]/20 hover:bg-[#7C3AED]/40 text-violet-300'}`}>
                          {n.is_published ? '취소' : '발행'}
                        </button>
                        <button onClick={() => handleDelete(n.id)}
                          className="px-2.5 py-1 bg-red-900/20 hover:bg-red-900/40 text-red-400 text-xs rounded-lg transition-colors">삭제</button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {panelNotice !== null && (
        <NoticePanel
          notice={panelNotice.id ? panelNotice : null}
          orgs={orgs}
          onClose={() => setPanelNotice(null)}
          onSaved={() => { setPanelNotice(null); load(); showToast('저장됐습니다.'); }}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 px-5 py-3 bg-[#7C3AED] text-white text-sm font-semibold rounded-xl shadow-lg z-50">{toast}</div>
      )}
    </div>
  );
}

// ─── 공지 작성/수정 슬라이드 패널 ─────────────────────────
function NoticePanel({ notice, orgs, onClose, onSaved }: {
  notice: any;
  orgs: any[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    title:      notice?.title        ?? '',
    content:    notice?.content      ?? '',
    importance: notice?.importance   ?? 'normal',
    targetType: notice?.target_type  ?? 'all',
    targetOrgIds: (notice?.target_org_ids ?? []) as string[],
    expiresAt:  notice?.expires_at   ? notice.expires_at.slice(0, 10) : '',
    isPublished: notice?.is_published ?? false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);

  const set = (k: string, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  const insertMarkdown = (md: string) => {
    set('content', form.content + md);
  };

  const toggleOrgId = (id: string) => {
    set('targetOrgIds', form.targetOrgIds.includes(id)
      ? form.targetOrgIds.filter((x: string) => x !== id)
      : [...form.targetOrgIds, id]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.content.trim()) { setError('제목, 내용 필수'); return; }
    setSaving(true); setError(null);
    const url  = notice?.id ? `/api/super/notices/${notice.id}` : '/api/super/notices';
    const method = notice?.id ? 'PATCH' : 'POST';
    const res  = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: form.title, content: form.content,
        importance: form.importance,
        targetType: form.targetType,
        targetOrgIds: form.targetType === 'specific' ? form.targetOrgIds : [],
        isPublished: form.isPublished,
        expiresAt: form.expiresAt || null,
      }),
    });
    const d = await res.json();
    if (d.ok) onSaved(); else setError(d.error);
    setSaving(false);
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-xl bg-[#1E293B] border-l border-slate-700 z-50 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-700 flex-shrink-0">
          <h2 className="text-lg font-bold text-white">{notice?.id ? '공지 수정' : '새 공지 작성'}</h2>
          <button onClick={onClose} className="p-2 hover:bg-slate-700 rounded-xl text-slate-400">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
            {error && <div className="px-4 py-3 bg-red-900/30 border border-red-700/50 rounded-xl text-sm text-red-400">{error}</div>}

            {/* 제목 */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">제목 <span className="text-red-400">*</span></label>
              <input value={form.title} onChange={e => set('title', e.target.value)} required
                placeholder="공지 제목"
                className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-[#7C3AED]"/>
            </div>

            {/* 중요도 */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-2">중요도</label>
              <div className="flex gap-3">
                {Object.entries(IMPORTANCE_META).map(([k, meta]) => (
                  <label key={k} className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="importance" value={k} checked={form.importance === k}
                      onChange={() => set('importance', k)} className="accent-[#7C3AED]"/>
                    <span className={`text-xs font-medium ${meta.badge.includes('red') ? 'text-red-400' : meta.badge.includes('blue') ? 'text-blue-400' : 'text-slate-400'}`}>
                      {meta.icon} {meta.label}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* 대상 */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-2">대상</label>
              <div className="flex gap-4">
                {[['all','전체 기관'],['specific','특정 기관']].map(([v,l]) => (
                  <label key={v} className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="targetType" value={v} checked={form.targetType === v}
                      onChange={() => set('targetType', v)} className="accent-[#7C3AED]"/>
                    <span className="text-sm text-slate-300">{l}</span>
                  </label>
                ))}
              </div>
              {form.targetType === 'specific' && (
                <div className="mt-3 max-h-32 overflow-y-auto space-y-1.5 p-3 bg-[#0F172A] rounded-xl border border-slate-700">
                  {orgs.map(o => (
                    <label key={o.id} className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={form.targetOrgIds.includes(o.id)}
                        onChange={() => toggleOrgId(o.id)} className="accent-[#7C3AED]"/>
                      <span className="text-sm text-slate-300">{o.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* 내용 */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-slate-400">내용 (마크다운) <span className="text-red-400">*</span></label>
                <div className="flex gap-1">
                  {[['**굵게**','B'],['*기울임*','I'],['---','─'],['- ','•'],['1. ','1.']].map(([md, label]) => (
                    <button key={label} type="button" onClick={() => insertMarkdown(md)}
                      className="w-7 h-7 bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold rounded transition-colors">
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <textarea value={form.content} onChange={e => set('content', e.target.value)} required rows={8}
                placeholder="공지 내용을 작성하세요. 마크다운을 지원합니다."
                className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-[#7C3AED] resize-none font-mono"/>
            </div>

            {/* 만료일 */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">만료일 (선택, 비우면 무기한)</label>
              <input type="date" value={form.expiresAt} onChange={e => set('expiresAt', e.target.value)}
                className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]"/>
            </div>

            {/* 발행 옵션 */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-2">발행 옵션</label>
              <div className="flex gap-4">
                {[[true,'즉시 발행'],[false,'임시 저장']].map(([v, l]) => (
                  <label key={String(v)} className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="publish" checked={form.isPublished === v}
                      onChange={() => set('isPublished', v)} className="accent-[#7C3AED]"/>
                    <span className="text-sm text-slate-300">{String(l)}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="px-6 py-5 border-t border-slate-700 flex gap-3 flex-shrink-0">
            <button type="button" onClick={onClose}
              className="flex-1 py-3 border border-slate-700 rounded-xl text-sm text-slate-400 hover:text-white">취소</button>
            <button type="submit" disabled={saving}
              className="flex-1 py-3 bg-[#7C3AED] hover:bg-[#6D28D9] disabled:bg-slate-700 text-white font-semibold rounded-xl text-sm">
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
