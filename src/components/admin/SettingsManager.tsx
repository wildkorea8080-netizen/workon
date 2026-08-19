'use client';

import { useState, useEffect } from 'react';
import { UPLOAD_FORMATS_LABEL } from '@/lib/file-types';
import type { ForbiddenWord } from '@/lib/db';

interface SecurityLog {
  id: string;
  event_type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  details: Record<string, any>;
  created_at: string;
  users: {
    name: string;
    email: string;
  };
}

export default function SettingsManager() {
  const [forbiddenWords, setForbiddenWords] = useState<ForbiddenWord[]>([]);
  const [securityLogs, setSecurityLogs] = useState<SecurityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(false);
  const [newWord, setNewWord] = useState('');
  const [newContext, setNewContext] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadForbiddenWords();
    loadSecurityLogs();
  }, []);

  const loadForbiddenWords = async () => {
    try {
      const response = await fetch('/api/forbidden-words');
      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.error?.message || '금지어 목록 로드 실패');
      }

      setForbiddenWords(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '금지어 목록 로드 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const loadSecurityLogs = async () => {
    setLogsLoading(true);
    try {
      const response = await fetch('/api/security-logs?limit=20');
      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.error?.message || '보안 로그 로드 실패');
      }

      setSecurityLogs(result.data.logs);
    } catch (err) {
      console.error('보안 로그 로드 오류:', err);
    } finally {
      setLogsLoading(false);
    }
  };

  const handleAddWord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWord.trim()) return;

    setAdding(true);
    setError(null);

    try {
      const response = await fetch('/api/forbidden-words', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          word: newWord.trim(),
          context: newContext.trim() || undefined,
        }),
      });

      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.error?.message || '금지어 추가 실패');
      }

      setForbiddenWords(prev => [result.data, ...prev]);
      setNewWord('');
      setNewContext('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '금지어 추가 중 오류가 발생했습니다.');
    } finally {
      setAdding(false);
    }
  };

  const toggleWordStatus = async (wordId: string, isActive: boolean) => {
    try {
      const response = await fetch(`/api/forbidden-words/${wordId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !isActive }),
      });

      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.error?.message || '금지어 상태 변경 실패');
      }

      setForbiddenWords(prev =>
        prev.map(word =>
          word.id === wordId ? result.data : word
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '금지어 상태 변경 중 오류가 발생했습니다.');
    }
  };

  const deleteWord = async (wordId: string) => {
    if (!confirm('정말로 이 금지어를 삭제하시겠습니까?')) return;

    try {
      const response = await fetch(`/api/forbidden-words/${wordId}`, {
        method: 'DELETE',
      });

      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.error?.message || '금지어 삭제 실패');
      }

      setForbiddenWords(prev => prev.filter(word => word.id !== wordId));
    } catch (err) {
      setError(err instanceof Error ? err.message : '금지어 삭제 중 오류가 발생했습니다.');
    }
  };

  if (loading) {
    return <div className="text-center py-8">로딩 중...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">금지어 관리</h2>
        <p className="text-slate-600 mt-1">부서별로 금지할 단어를 설정하여 AI 응답을 필터링합니다.</p>
      </div>

      {error && (
        <div className="p-4 text-red-700 bg-red-100 rounded-lg">{error}</div>
      )}

      {/* Add new forbidden word */}
      <div className="p-6 border rounded-lg bg-white">
        <h3 className="text-lg font-medium mb-4">새 금지어 추가</h3>
        <form onSubmit={handleAddWord} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700">금지어</label>
            <input
              type="text"
              value={newWord}
              onChange={(e) => setNewWord(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md mt-1"
              placeholder="금지할 단어를 입력하세요"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700">설명 (선택사항)</label>
            <input
              type="text"
              value={newContext}
              onChange={(e) => setNewContext(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md mt-1"
              placeholder="금지어에 대한 설명"
            />
          </div>

          <button
            type="submit"
            disabled={adding}
            className="px-4 py-2 bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-50"
          >
            {adding ? '추가 중...' : '금지어 추가'}
          </button>
        </form>
      </div>

      {/* Forbidden words list */}
      <div>
        <h3 className="text-lg font-medium mb-4">금지어 목록 ({forbiddenWords.length}개)</h3>
        <div className="space-y-4">
          {forbiddenWords.map((word) => (
            <div key={word.id} className="p-4 border rounded-lg bg-white">
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <h4 className="font-medium">{word.word}</h4>
                  {word.context && (
                    <p className="text-sm text-slate-600 mt-1">{word.context}</p>
                  )}
                  <p className="text-xs text-slate-500 mt-2">
                    등록일: {new Date(word.created_at).toLocaleDateString('ko-KR')}
                  </p>
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <span className={`text-sm px-2 py-1 rounded ${
                    word.is_active
                      ? 'text-green-700 bg-green-100'
                      : 'text-red-700 bg-red-100'
                  }`}>
                    {word.is_active ? '활성' : '비활성'}
                  </span>
                  <button
                    onClick={() => toggleWordStatus(word.id, word.is_active)}
                    className="px-3 py-1 text-sm border border-slate-300 rounded hover:bg-slate-50"
                  >
                    {word.is_active ? '비활성화' : '활성화'}
                  </button>
                  <button
                    onClick={() => deleteWord(word.id)}
                    className="px-3 py-1 text-sm border border-red-300 text-red-600 rounded hover:bg-red-50"
                  >
                    삭제
                  </button>
                </div>
              </div>
            </div>
          ))}

          {forbiddenWords.length === 0 && (
            <div className="text-center py-8 text-slate-500 border rounded-lg bg-white">
              등록된 금지어가 없습니다.
            </div>
          )}
        </div>
      </div>

      {/* Security Logs */}
      <div>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-medium">보안 이벤트 로그</h3>
          <button
            onClick={loadSecurityLogs}
            disabled={logsLoading}
            className="px-3 py-1 text-sm border border-slate-300 rounded hover:bg-slate-50 disabled:opacity-50"
          >
            {logsLoading ? '로딩 중...' : '새로고침'}
          </button>
        </div>
        <div className="space-y-4">
          {securityLogs.map((log) => (
            <div key={log.id} className="p-4 border rounded-lg bg-white">
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`text-xs px-2 py-1 rounded font-medium ${
                      log.severity === 'critical' ? 'text-red-700 bg-red-100' :
                      log.severity === 'high' ? 'text-orange-700 bg-orange-100' :
                      log.severity === 'medium' ? 'text-yellow-700 bg-yellow-100' :
                      'text-blue-700 bg-blue-100'
                    }`}>
                      {log.severity.toUpperCase()}
                    </span>
                    <span className="text-sm font-medium text-slate-900">
                      {log.event_type.replace(/_/g, ' ').toUpperCase()}
                    </span>
                  </div>
                  <p className="text-sm text-slate-600">
                    사용자: {log.users?.name || '알 수 없음'} ({log.users?.email || '알 수 없음'})
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    발생 시간: {new Date(log.created_at).toLocaleString('ko-KR')}
                  </p>
                  {log.details && Object.keys(log.details).length > 0 && (
                    <details className="mt-2">
                      <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-700">
                        상세 정보
                      </summary>
                      <pre className="text-xs text-slate-600 mt-1 bg-slate-50 p-2 rounded overflow-x-auto">
                        {JSON.stringify(log.details, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              </div>
            </div>
          ))}

          {securityLogs.length === 0 && !logsLoading && (
            <div className="text-center py-8 text-slate-500 border rounded-lg bg-white">
              보안 이벤트가 없습니다.
            </div>
          )}
        </div>
      </div>

      <div className="p-6 border rounded-lg bg-slate-50">
        <h3 className="text-lg font-medium mb-2">보안 설정</h3>
        <div className="space-y-4">
          <div>
            <h4 className="font-medium text-slate-900">개인정보 필터링</h4>
            <p className="text-slate-600 text-sm mt-1">
              자동으로 활성화되어 있습니다. 다음 패턴들을 차단합니다:
            </p>
            <ul className="text-xs text-slate-500 mt-2 space-y-1">
              <li>• 주민등록번호, 외국인등록번호</li>
              <li>• 전화번호 (국내/국제)</li>
              <li>• 이메일 주소</li>
              <li>• 신용카드 번호</li>
              <li>• 계좌번호</li>
              <li>• 사업자등록번호</li>
              <li>• 생년월일 정보</li>
              <li>• 주소 정보</li>
            </ul>
          </div>

          <div>
            <h4 className="font-medium text-slate-900">파일 업로드 보안</h4>
            <p className="text-slate-600 text-sm mt-1">
              다음 보안 조치들이 적용됩니다:
            </p>
            <ul className="text-xs text-slate-500 mt-2 space-y-1">
              <li>• 최대 파일 크기: 20MB</li>
              <li>• 허용 형식: {UPLOAD_FORMATS_LABEL}</li>
              <li>• 위험한 파일명 패턴 차단</li>
              <li>• 실행 파일 확장자 차단 (exe, bat, js 등)</li>
              <li>• 디렉토리 트래버설 공격 방지</li>
            </ul>
          </div>

          <div>
            <h4 className="font-medium text-slate-900">금지어 필터링</h4>
            <p className="text-slate-600 text-sm mt-1">
              AI 응답 생성 시 실시간으로 필터링되며, 부서별로 독립적으로 관리됩니다.
            </p>
          </div>

          <div>
            <h4 className="font-medium text-slate-900">보안 감사 로그</h4>
            <p className="text-slate-600 text-sm mt-1">
              모든 보안 이벤트가 자동으로 기록됩니다:
            </p>
            <ul className="text-xs text-slate-500 mt-2 space-y-1">
              <li>• 금지어 감지</li>
              <li>• 개인정보 유출 시도</li>
              <li>• 파일 업로드 차단</li>
              <li>• 의심스러운 콘텐츠</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}