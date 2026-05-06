'use client';

import { useState, useEffect } from 'react';
import type { Document, Agent } from '@/lib/db';

export default function DocumentsManager() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadForm, setUploadForm] = useState({
    file: null as File | null,
    agentId: '',
    title: '',
  });
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [agentsResponse, docsResponse] = await Promise.all([
        fetch('/api/agents'),
        fetch('/api/documents'),
      ]);
      const [agentsResult, docsResult] = await Promise.all([
        agentsResponse.json(),
        docsResponse.json(),
      ]);
      if (agentsResult.ok) setAgents(agentsResult.data);
      if (docsResult.ok) setDocuments(docsResult.data);
    } catch (err) {
      setErrorMessage('데이터 로드 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (documentId: string) => {
    if (!confirm('문서를 삭제하시겠습니까? 이 작업은 취소할 수 없습니다.')) return;
    try {
      const response = await fetch('/api/documents', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId }),
      });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error?.message || '삭제 실패');
      setDocuments((prev) => prev.filter((d) => d.id !== documentId));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '삭제 중 오류가 발생했습니다.');
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMessage('');
    setErrorMessage('');

    if (!uploadForm.file) {
      setErrorMessage('파일을 선택해주세요.');
      return;
    }

    if (!uploadForm.agentId) {
      setErrorMessage('에이전트를 선택해주세요.');
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    const formData = new FormData();
    formData.append('file', uploadForm.file);
    formData.append('agentId', uploadForm.agentId);
    if (uploadForm.title) {
      formData.append('title', uploadForm.title);
    }

    try {
      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.error?.message || '업로드 실패');
      }

      setStatusMessage('문서 업로드 및 처리가 완료되었습니다.');
      setUploadForm({ file: null, agentId: '', title: '' });
      setUploadProgress(0);
      loadData();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '업로드 중 오류가 발생했습니다.');
    } finally {
      setUploading(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-slate-600"></div>
        <span className="ml-3 text-slate-600">로딩 중...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Upload Form */}
      <div className="p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-xl font-semibold mb-4">문서 업로드</h2>

        {statusMessage && (
          <div className="p-4 text-green-700 bg-green-100 rounded-lg mb-4 flex items-center space-x-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span>{statusMessage}</span>
          </div>
        )}
        {errorMessage && (
          <div className="p-4 text-red-700 bg-red-100 rounded-lg mb-4 flex items-center space-x-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{errorMessage}</span>
          </div>
        )}

        <form onSubmit={handleUpload} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">에이전트 선택 *</label>
            <select
              value={uploadForm.agentId}
              onChange={(e) => setUploadForm(prev => ({ ...prev, agentId: e.target.value }))}
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-slate-500"
              required
            >
              <option value="">에이전트를 선택하세요</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                  {agent.description && ` - ${agent.description}`}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">문서 제목 (선택사항)</label>
            <input
              type="text"
              value={uploadForm.title}
              onChange={(e) => setUploadForm(prev => ({ ...prev, title: e.target.value }))}
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-slate-500"
              placeholder="문서 제목을 입력하세요"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">파일 선택 *</label>
            {uploadForm.file ? (
              <div className="p-4 border-2 border-dashed border-blue-300 bg-blue-50 rounded-md">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <div>
                      <p className="font-medium text-blue-900">{uploadForm.file.name}</p>
                      <p className="text-sm text-blue-700">{formatFileSize(uploadForm.file.size)}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setUploadForm(prev => ({ ...prev, file: null }))}
                    className="text-blue-600 hover:text-blue-800"
                  >
                    변경
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <label
                  className={`w-full p-8 border-2 border-dashed rounded-md cursor-pointer transition-colors flex items-center justify-center ${
                    dragging ? 'border-blue-400 bg-blue-50' : 'border-slate-300 hover:border-slate-400'
                  }`}
                  onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    const dropped = e.dataTransfer.files[0];
                    if (dropped) setUploadForm(prev => ({ ...prev, file: dropped }));
                  }}
                >
                  <div className="text-center pointer-events-none">
                    <svg className="w-10 h-10 mx-auto mb-2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3v-6" />
                    </svg>
                    <p className="font-medium text-slate-700">
                      {dragging ? '파일을 놓으세요' : '클릭 또는 드래그앤드롭'}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">PDF, DOCX, TXT (최대 20MB)</p>
                  </div>
                  <input
                    type="file"
                    accept=".pdf,.docx,.txt"
                    onChange={(e) => setUploadForm(prev => ({ ...prev, file: e.target.files?.[0] || null }))}
                    className="hidden"
                  />
                </label>
              </div>
            )}
          </div>

          {uploading && (
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-600">업로드 중...</span>
                <span className="text-sm font-medium text-slate-900">{uploadProgress}%</span>
              </div>
              <div className="w-full bg-slate-200 rounded-full h-2">
                <div
                  className="bg-slate-900 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                ></div>
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={uploading}
            className="w-full px-4 py-2 bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:bg-slate-400 disabled:cursor-not-allowed flex items-center justify-center space-x-2 transition-colors"
          >
            {uploading ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                <span>업로드 중...</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3v-6" />
                </svg>
                <span>문서 업로드</span>
              </>
            )}
          </button>
        </form>
      </div>

      {/* Documents List */}
      <div>
        <h2 className="text-xl font-semibold mb-4">업로드된 문서</h2>
        <div className="space-y-3">
          {documents.map((doc) => (
            <div key={doc.id} className="p-4 border rounded-lg bg-white hover:shadow-sm transition-shadow">
              <div className="flex justify-between items-start">
                <div className="flex items-start space-x-4 flex-1">
                  <div className="w-10 h-10 bg-slate-100 rounded-lg flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium text-slate-900 truncate">{doc.title || doc.file_name}</h3>
                    <div className="flex flex-wrap items-center gap-3 mt-1">
                      <span className="text-xs text-slate-500">{doc.file_type}</span>
                      <span className="text-xs text-slate-500">•</span>
                      <span className="text-xs text-slate-500">{new Date(doc.created_at).toLocaleDateString('ko-KR')}</span>
                      <span className="text-xs text-slate-500">•</span>
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        doc.agent_id
                          ? 'bg-green-100 text-green-800'
                          : 'bg-amber-100 text-amber-800'
                      }`}>
                        {doc.agent_id ? '에이전트 연결' : '미연결'}
                      </span>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(doc.id)}
                  className="ml-4 p-2 text-slate-400 hover:text-red-600 transition-colors"
                  title="문서 삭제"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
          ))}

          {documents.length === 0 && (
            <div className="text-center py-12 text-slate-500 border rounded-lg bg-slate-50">
              <svg className="w-12 h-12 mx-auto mb-4 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <div className="text-sm">아직 업로드된 문서가 없습니다.</div>
              <div className="text-xs mt-1">위에서 문서를 업로드하면 여기에 표시됩니다.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}