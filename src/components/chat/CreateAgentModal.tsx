'use client';

import { useState, useRef } from 'react';

const EMOJI_ICONS = [
  '🤖', '📝', '📊', '📋', '📨', '💬', '📢', '🎤',
  '⚖️', '🔍', '📚', '💡', '🗒️', '📁', '🖊️', '🏛️',
];

const CATEGORIES = ['전체', '공공기관', '업무', '문서', '번역', '기타'];

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['pdf', 'docx', 'txt'];

interface CreateAgentModalProps {
  onClose: () => void;
  onCreated: () => void;
}

export default function CreateAgentModal({ onClose, onCreated }: CreateAgentModalProps) {
  const [icon, setIcon] = useState('🤖');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('전체');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [enhancing, setEnhancing] = useState(false);
  const [fileCapability, setFileCapability] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleEnhance = async () => {
    if (!systemPrompt.trim() || enhancing) return;
    setEnhancing(true);
    try {
      const res = await fetch('/api/enhance-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: systemPrompt, type: 'agent' }),
      });
      const result = await res.json();
      if (result.ok) setSystemPrompt(result.data.enhancedPrompt);
    } catch {
      // silent
    } finally {
      setEnhancing(false);
    }
  };

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const valid = Array.from(incoming).filter(f => {
      const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
      return ALLOWED_EXTENSIONS.includes(ext) && f.size <= MAX_FILE_SIZE;
    });
    setFiles(prev => [...prev, ...valid].slice(0, 10));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(e.dataTransfer.files);
  };

  const handleSubmit = async () => {
    if (!name.trim()) { setError('비서 이름을 입력해주세요.'); return; }
    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch('/api/agents/personal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          icon,
          category,
          systemPrompt: systemPrompt.trim() || undefined,
        }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);

      const agentId: string = result.data.id;

      if (fileCapability && files.length > 0) {
        for (const file of files) {
          const fd = new FormData();
          fd.append('file', file);
          fd.append('agentId', agentId);
          await fetch('/api/upload', { method: 'POST', body: fd });
        }
      }

      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '비서 생성에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-[560px] max-h-[90vh] flex flex-col">

        {/* 헤더 */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100 flex-shrink-0">
          <h2 className="text-lg font-bold text-slate-900">나만의 비서 만들기</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-400 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 스크롤 본문 */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-7">

          {/* 섹션 1: 기본 정보 */}
          <section>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4">기본 정보</p>

            {/* 아이콘 그리드 */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-slate-700 mb-2">아이콘</label>
              <div className="grid grid-cols-8 gap-1.5">
                {EMOJI_ICONS.map(e => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => setIcon(e)}
                    className={`w-9 h-9 flex items-center justify-center rounded-lg text-lg transition-all ${
                      icon === e
                        ? 'bg-brand-100 ring-2 ring-brand-400 scale-110'
                        : 'hover:bg-slate-100'
                    }`}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>

            {/* 이름 */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-slate-700 mb-1">
                비서 이름 <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="예) 인사규정 전문 비서"
                className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
            </div>

            {/* 카테고리 */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">카테고리</label>
              <select
                value={category}
                onChange={e => setCategory(e.target.value)}
                className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 bg-white"
              >
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </section>

          {/* 섹션 2: 역할 설정 */}
          <section>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4">역할 설정</p>
            <textarea
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              placeholder="예) 나는 우리 기관의 인사규정 전문가야. 복무규정, 출장규정 관련 질문에 답해줘."
              rows={4}
              className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 resize-none"
            />
            <button
              type="button"
              onClick={handleEnhance}
              disabled={!systemPrompt.trim() || enhancing}
              className="mt-2 flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 hover:bg-amber-100 disabled:bg-slate-50 disabled:text-slate-300 text-amber-700 text-xs font-semibold rounded-lg border border-amber-200 disabled:border-slate-200 transition-colors"
            >
              {enhancing ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  ✨ 다듬는 중...
                </>
              ) : (
                '✨ 프롬프트 다듬기'
              )}
            </button>
          </section>

          {/* 섹션 3: 능력 설정 */}
          <section>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4">능력 설정</p>
            <div className="space-y-3">

              {/* 파일 분석 */}
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <span className="text-xl">📎</span>
                    <div>
                      <p className="text-sm font-semibold text-slate-800">파일 분석 능력</p>
                      <p className="text-xs text-slate-500">첨부한 문서를 읽고 질문에 답합니다</p>
                    </div>
                  </div>
                  <Toggle checked={fileCapability} onChange={setFileCapability} />
                </div>

                {fileCapability && (
                  <div className="px-4 pb-4 border-t border-slate-100 pt-4">
                    {/* 드래그앤드롭 업로드 */}
                    <div
                      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={handleDrop}
                      onClick={() => fileInputRef.current?.click()}
                      className={`border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition-colors ${
                        dragOver
                          ? 'border-brand-400 bg-brand-50'
                          : 'border-slate-200 hover:border-brand-300 hover:bg-slate-50'
                      }`}
                    >
                      <svg className="w-7 h-7 text-slate-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                      </svg>
                      <p className="text-xs text-slate-500">PDF, DOCX, TXT · 최대 10MB · 최대 10개</p>
                      <p className="text-xs text-brand-600 font-medium mt-1">클릭하거나 드래그하여 업로드</p>
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept=".pdf,.docx,.txt"
                        className="hidden"
                        onChange={e => addFiles(e.target.files)}
                      />
                    </div>

                    {files.length > 0 && (
                      <ul className="mt-2 space-y-1.5">
                        {files.map((f, i) => (
                          <li key={i} className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-lg">
                            <span className="text-sm flex-1 truncate text-slate-700">{f.name}</span>
                            <span className="text-xs text-slate-400 flex-shrink-0">
                              {(f.size / 1024).toFixed(0)}KB
                            </span>
                            <button
                              type="button"
                              onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))}
                              className="w-5 h-5 flex items-center justify-center rounded-full hover:bg-slate-200 text-slate-400 hover:text-slate-600 flex-shrink-0 text-base leading-none"
                            >
                              ×
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              {/* 실시간 검색 (준비 중) */}
              <div className="border border-slate-200 rounded-xl p-4 opacity-60">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-xl">🔍</span>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-slate-800">실시간 검색 능력</p>
                        <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 text-[10px] font-bold rounded-full">준비 중</span>
                      </div>
                      <p className="text-xs text-slate-500">최신 정보를 검색해서 답합니다</p>
                    </div>
                  </div>
                  <Toggle checked={false} onChange={() => {}} disabled />
                </div>
              </div>
            </div>
          </section>

          {error && (
            <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
              {error}
            </div>
          )}
        </div>

        {/* 하단 버튼 */}
        <div className="flex gap-3 px-6 py-4 border-t border-slate-100 flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50 transition-colors"
          >
            취소
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || !name.trim()}
            className="flex-1 py-2.5 bg-[#003087] hover:bg-[#002070] disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-semibold rounded-xl text-sm transition-colors"
          >
            {submitting ? '생성 중...' : '비서 만들기'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
        checked ? 'bg-brand-600' : 'bg-slate-200'
      } ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}
