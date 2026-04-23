'use client';

import { useState, useRef, useCallback } from 'react';
import Papa from 'papaparse';
import type { RegisterResult } from '@/app/api/admin/bulk-register/route';

interface CsvRow {
  row: number;
  부서명: string;
  상위부서명: string;
  직원이름: string;
  이메일: string;
  직책: string;
  권한: string;
  _error?: string;
}

function validateRow(row: Omit<CsvRow, 'row' | '_error'>): string | null {
  if (!row.부서명?.trim()) return '부서명 필수';
  if (!row.직원이름?.trim()) return '직원이름 필수';
  if (!row.이메일?.trim()) return '이메일 필수';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.이메일.trim())) return '이메일 형식 오류';
  const role = row.권한?.trim().toUpperCase();
  if (!['ADMIN', 'USER'].includes(role)) return '권한은 ADMIN 또는 USER';
  return null;
}

export default function CsvRegisterTab() {
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<RegisterResult[] | null>(null);
  const [summary, setSummary] = useState<{ total: number; success: number; fail: number } | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const parseFile = useCallback((file: File) => {
    if (!file.name.endsWith('.csv')) {
      alert('CSV 파일만 업로드 가능합니다.');
      return;
    }
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const parsed: CsvRow[] = res.data.map((r, i) => {
          const rowData = {
            부서명: r['부서명'] ?? '',
            상위부서명: r['상위부서명'] ?? '',
            직원이름: r['직원이름'] ?? '',
            이메일: r['이메일'] ?? '',
            직책: r['직책'] ?? '',
            권한: r['권한'] ?? '',
          };
          return { row: i + 1, ...rowData, _error: validateRow(rowData) ?? undefined };
        });
        setRows(parsed);
        setSelected(new Set(
          parsed.filter(r => !r._error).map(r => r.row)
        ));
        setResults(null);
        setSummary(null);
        setApiError(null);
      },
    });
  }, []);

  const handleFile = (file: File) => parseFile(file);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const toggleSelect = (row: number) => {
    setSelected(prev => {
      const s = new Set(prev);
      s.has(row) ? s.delete(row) : s.add(row);
      return s;
    });
  };
  const toggleAll = () => {
    const validRows = rows.filter(r => !r._error).map(r => r.row);
    setSelected(prev => prev.size === validRows.length ? new Set() : new Set(validRows));
  };

  const handleSubmit = async () => {
    const toRegister = rows.filter(r => selected.has(r.row) && !r._error);
    if (toRegister.length === 0) return;
    setSubmitting(true);
    setApiError(null);
    try {
      const res = await fetch('/api/admin/bulk-register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: toRegister }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setResults(result.data.results);
      setSummary(result.data.summary);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : '처리 중 오류가 발생했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  const downloadResult = () => {
    if (!results) return;
    const csv = [
      '이름,이메일,부서명,결과,임시비밀번호,오류사유',
      ...results.map(r =>
        `${r.직원이름},${r.이메일},${r.부서명},${r.success ? '성공' : '실패'},${r.tempPassword ?? ''},${r.error ?? ''}`
      ),
    ].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = '등록결과.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const validCount = rows.filter(r => !r._error).length;

  return (
    <div className="space-y-6">
      {/* 양식 다운로드 */}
      <div className="flex items-center justify-between p-4 bg-blue-50 border border-blue-200 rounded-xl">
        <div>
          <p className="text-sm font-semibold text-[#003087]">CSV 양식 다운로드</p>
          <p className="text-xs text-slate-500 mt-0.5">헤더: 부서명, 상위부서명, 직원이름, 이메일, 직책, 권한(ADMIN/USER)</p>
        </div>
        <a
          href="/templates/직원등록양식.csv"
          download
          className="flex items-center gap-2 px-4 py-2 bg-[#003087] hover:bg-[#002070] text-white text-xs font-semibold rounded-xl transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          양식 다운로드
        </a>
      </div>

      {/* 업로드 영역 */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-all ${
          dragging ? 'border-[#003087] bg-blue-50' : 'border-slate-200 hover:border-[#003087] hover:bg-slate-50'
        }`}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
        />
        <svg className="w-8 h-8 text-slate-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
        </svg>
        <p className="text-sm font-medium text-slate-600">CSV 파일을 드래그하거나 클릭해서 업로드</p>
        <p className="text-xs text-slate-400 mt-1">.csv 파일만 지원</p>
      </div>

      {/* 미리보기 테이블 */}
      {rows.length > 0 && !results && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-700">
              미리보기 — 총 {rows.length}행
              {rows.some(r => r._error) && (
                <span className="ml-2 text-red-500">오류 {rows.filter(r => r._error).length}행 (선택 불가)</span>
              )}
            </p>
            <p className="text-xs text-slate-400">선택된 {selected.size}명 등록 예정</p>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-3 py-2.5 text-left">
                    <input
                      type="checkbox"
                      checked={selected.size === validCount && validCount > 0}
                      onChange={toggleAll}
                      className="rounded accent-[#003087]"
                    />
                  </th>
                  {['부서명', '이름', '이메일', '직책', '권한', '상태'].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(row => (
                  <tr key={row.row} className={row._error ? 'bg-red-50' : 'bg-white hover:bg-slate-50'}>
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        disabled={!!row._error}
                        checked={selected.has(row.row)}
                        onChange={() => toggleSelect(row.row)}
                        className="rounded accent-[#003087] disabled:opacity-30"
                      />
                    </td>
                    <td className="px-3 py-2.5 text-slate-700">{row.부서명}</td>
                    <td className="px-3 py-2.5 font-medium text-slate-900">{row.직원이름}</td>
                    <td className="px-3 py-2.5 text-slate-600">{row.이메일}</td>
                    <td className="px-3 py-2.5 text-slate-500">{row.직책}</td>
                    <td className="px-3 py-2.5">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        row.권한?.toUpperCase() === 'ADMIN'
                          ? 'bg-purple-100 text-purple-700'
                          : 'bg-slate-100 text-slate-600'
                      }`}>
                        {row.권한?.toUpperCase() === 'ADMIN' ? '관리자' : '일반 직원'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {row._error ? (
                        <span className="flex items-center gap-1 text-xs text-red-600 font-medium">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          {row._error}
                        </span>
                      ) : (
                        <span className="text-xs text-emerald-600 font-medium">✓ 유효</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {apiError && (
            <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">{apiError}</div>
          )}

          <div className="flex items-center justify-between pt-1">
            <button
              onClick={() => { setRows([]); setSelected(new Set()); }}
              className="text-sm text-slate-500 hover:text-slate-700"
            >
              초기화
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting || selected.size === 0}
              className="flex items-center gap-2 px-6 py-2.5 bg-[#003087] hover:bg-[#002070] disabled:bg-slate-300 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-colors"
            >
              {submitting ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  처리 중...
                </>
              ) : `등록 확인 (${selected.size}명)`}
            </button>
          </div>
        </div>
      )}

      {/* 처리 결과 */}
      {results && summary && (
        <div className="space-y-4">
          {/* 요약 */}
          <div className="grid grid-cols-3 gap-3">
            <div className="p-4 bg-slate-50 rounded-xl text-center">
              <p className="text-2xl font-bold text-slate-900">{summary.total}</p>
              <p className="text-xs text-slate-500 mt-0.5">전체</p>
            </div>
            <div className="p-4 bg-green-50 rounded-xl text-center">
              <p className="text-2xl font-bold text-green-600">{summary.success}</p>
              <p className="text-xs text-green-600 mt-0.5">✅ 성공</p>
            </div>
            <div className="p-4 bg-red-50 rounded-xl text-center">
              <p className="text-2xl font-bold text-red-500">{summary.fail}</p>
              <p className="text-xs text-red-500 mt-0.5">❌ 실패</p>
            </div>
          </div>

          {/* 임시 비밀번호 테이블 */}
          {results.some(r => r.success) && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-700">임시 비밀번호 목록</p>
                <button
                  onClick={downloadResult}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#003087] border border-[#003087]/30 rounded-lg hover:bg-blue-50 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  CSV 다운로드
                </button>
              </div>
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      {['이름', '이메일', '부서', '임시 비밀번호', '상태'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {results.map((r, i) => (
                      <tr key={i} className={r.success ? 'bg-white' : 'bg-red-50'}>
                        <td className="px-4 py-2.5 font-medium text-slate-900">{r.직원이름}</td>
                        <td className="px-4 py-2.5 text-slate-600">{r.이메일}</td>
                        <td className="px-4 py-2.5 text-slate-600">{r.부서명}</td>
                        <td className="px-4 py-2.5">
                          {r.tempPassword ? (
                            <CopyCell value={r.tempPassword} />
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {r.success ? (
                            <span className="text-xs font-medium text-green-600">✅ 성공</span>
                          ) : (
                            <span className="text-xs text-red-500">❌ {r.error}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-amber-600 font-medium">
                ⚠️ 임시 비밀번호는 이 화면에서만 확인 가능합니다. 반드시 저장해두세요.
              </p>
            </div>
          )}

          <button
            onClick={() => { setRows([]); setResults(null); setSummary(null); setSelected(new Set()); }}
            className="w-full py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50 transition-colors"
          >
            새 파일 등록
          </button>
        </div>
      )}
    </div>
  );
}

function CopyCell({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={copy}
      className="flex items-center gap-1.5 font-mono text-xs text-slate-800 hover:text-[#003087] transition-colors"
    >
      <span>{value}</span>
      {copied ? (
        <svg className="w-3.5 h-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  );
}
