import { useState } from 'react';
import type { GeneratedReport } from './ReportWizard';

interface ReportViewerProps {
  report: GeneratedReport;
  onStartOver: () => void;
}

export default function ReportViewer({ report, onStartOver }: ReportViewerProps) {
  const [editedContent, setEditedContent] = useState(report.report);
  const [isEditing, setIsEditing] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const handleSave = async () => {
    if (!report.saved_id) {
      setIsEditing(false);
      return;
    }
    setSaveStatus('saving');
    try {
      const res = await fetch(`/api/reports/${report.saved_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report_content: editedContent }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error();
      setSaveStatus('saved');
      setIsEditing(false);
      setTimeout(() => setSaveStatus('idle'), 3000);
    } catch {
      setSaveStatus('error');
    }
  };

  const handleDownload = () => {
    const blob = new Blob([editedContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${report.template_name}_${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(editedContent);
      // Could show a toast notification here
    } catch (err) {
      console.error('클립보드 복사 실패:', err);
    }
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-xl font-semibold">보고서 결과</h2>
          <p className="text-slate-600 mt-1">{report.template_name}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setIsEditing(!isEditing)}
            className="px-4 py-2 border border-slate-300 rounded-md hover:bg-slate-50"
          >
            {isEditing ? '편집 취소' : '편집'}
          </button>
          <button
            onClick={handleCopy}
            className="px-4 py-2 border border-slate-300 rounded-md hover:bg-slate-50"
          >
            복사
          </button>
          <button
            onClick={handleDownload}
            className="px-4 py-2 bg-slate-900 text-white rounded-md hover:bg-slate-800"
          >
            다운로드
          </button>
        </div>
      </div>

      {/* Usage Info */}
      <div className="mb-6 p-4 bg-slate-50 rounded-lg">
        <div className="text-sm text-slate-600">
          <div>입력 토큰: {report.usage.input_tokens.toLocaleString()}</div>
          <div>출력 토큰: {report.usage.output_tokens.toLocaleString()}</div>
          <div>총 토큰: {(report.usage.input_tokens + report.usage.output_tokens).toLocaleString()}</div>
        </div>
      </div>

      {/* Report Content */}
      <div className="border rounded-lg">
        {isEditing ? (
          <textarea
            value={editedContent}
            onChange={(e) => setEditedContent(e.target.value)}
            className="w-full h-96 p-4 border-0 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-500 resize-none"
            placeholder="보고서 내용을 입력하세요..."
          />
        ) : (
          <div className="p-4 whitespace-pre-wrap text-sm leading-relaxed">
            {editedContent}
          </div>
        )}
      </div>

      {isEditing && (
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => setIsEditing(false)}
            className="px-4 py-2 border border-slate-300 rounded-md hover:bg-slate-50"
          >
            취소
          </button>
          <button
            onClick={handleSave}
            disabled={saveStatus === 'saving'}
            className="px-4 py-2 bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:bg-slate-400 disabled:cursor-not-allowed"
          >
            {saveStatus === 'saving' ? '저장 중...' : '저장'}
          </button>
        </div>
      )}

      {/* Actions */}
      <div className="mt-6 flex justify-between items-center">
        <button
          onClick={onStartOver}
          className="px-4 py-2 border border-slate-300 rounded-md hover:bg-slate-50"
        >
          처음부터 다시 시작
        </button>
        <div className="text-sm">
          {saveStatus === 'saved' && (
            <span className="text-green-600 font-medium">저장되었습니다.</span>
          )}
          {saveStatus === 'error' && (
            <span className="text-red-600">저장에 실패했습니다.</span>
          )}
          {saveStatus === 'idle' && (
            <span className="text-slate-500">보고서 생성이 완료되었습니다.</span>
          )}
        </div>
      </div>
    </div>
  );
}