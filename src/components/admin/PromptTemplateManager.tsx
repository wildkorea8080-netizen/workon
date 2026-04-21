'use client';

import { useState, useEffect } from 'react';
import type { Agent, ReportTemplate } from '@/lib/db';

export default function PromptTemplateManager() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [activeTab, setActiveTab] = useState<'system' | 'template'>('system');

  // 템플릿 관련 상태
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<ReportTemplate | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');
  const [templateContent, setTemplateContent] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [loadingTemplates, setLoadingTemplates] = useState(false);

  useEffect(() => {
    loadAgents();
  }, []);

  useEffect(() => {
    if (selectedAgent) {
      setSystemPrompt(selectedAgent.system_prompt || '');
    }
  }, [selectedAgent]);

  useEffect(() => {
    if (activeTab === 'template') {
      loadTemplates();
    }
  }, [activeTab]);

  const loadAgents = async () => {
    try {
      const response = await fetch('/api/agents');
      const result = await response.json();
      if (result.ok) {
        setAgents(result.data);
        if (result.data.length > 0) {
          setSelectedAgent(result.data[0]);
        }
      }
    } catch (err) {
      setMessage('에이전트 로드 실패');
    } finally {
      setLoading(false);
    }
  };

  const loadTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const response = await fetch('/api/templates');
      const result = await response.json();
      if (result.ok) {
        setTemplates(result.data);
      }
    } catch (err) {
      console.error('템플릿 로드 실패:', err);
    } finally {
      setLoadingTemplates(false);
    }
  };

  const handleSavePrompt = async () => {
    if (!selectedAgent) return;

    setSaving(true);
    setMessage('');

    try {
      const response = await fetch(`/api/agents/${selectedAgent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_prompt: systemPrompt,
        }),
      });

      const result = await response.json();
      if (!result.ok) {
        throw new Error(result.error?.message || '저장 실패');
      }

      setSelectedAgent(result.data);

      setMessage('프롬프트가 저장되었습니다.');
      setTimeout(() => setMessage(''), 3000);
    } catch (err) {
      setMessage('오류: ' + (err instanceof Error ? err.message : '알 수 없는 오류'));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveTemplate = async () => {
    if (!templateName.trim() || !templateContent.trim()) {
      setMessage('템플릿 이름과 내용은 필수입니다.');
      return;
    }

    setSaving(true);
    setMessage('');

    try {
      const method = isEditing ? 'PATCH' : 'POST';
      const url = isEditing ? `/api/templates/${selectedTemplate?.id}` : '/api/templates';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: templateName.trim(),
          description: templateDescription.trim(),
          content: templateContent.trim(),
        }),
      });

      const result = await response.json();
      if (!result.ok) {
        throw new Error(result.error?.message || '저장 실패');
      }

      await loadTemplates();
      resetTemplateForm();
      setMessage(isEditing ? '템플릿이 수정되었습니다.' : '템플릿이 생성되었습니다.');
      setTimeout(() => setMessage(''), 3000);
    } catch (err) {
      setMessage('오류: ' + (err instanceof Error ? err.message : '알 수 없는 오류'));
    } finally {
      setSaving(false);
    }
  };

  const handleEditTemplate = (template: ReportTemplate) => {
    setSelectedTemplate(template);
    setTemplateName(template.name);
    setTemplateDescription(template.description || '');
    setTemplateContent(template.content);
    setIsEditing(true);
  };

  const handleDeleteTemplate = async (templateId: string) => {
    if (!confirm('정말로 이 템플릿을 삭제하시겠습니까?')) return;

    try {
      const response = await fetch(`/api/templates/${templateId}`, {
        method: 'DELETE',
      });

      const result = await response.json();
      if (!result.ok) {
        throw new Error(result.error?.message || '삭제 실패');
      }

      await loadTemplates();
      setMessage('템플릿이 삭제되었습니다.');
      setTimeout(() => setMessage(''), 3000);
    } catch (err) {
      setMessage('오류: ' + (err instanceof Error ? err.message : '알 수 없는 오류'));
    }
  };

  const resetTemplateForm = () => {
    setSelectedTemplate(null);
    setTemplateName('');
    setTemplateDescription('');
    setTemplateContent('');
    setIsEditing(false);
  };

  if (loading) {
    return <div className="text-center py-8">로딩 중...</div>;
  }

  return (
    <div className="space-y-6">
      {/* 탭 */}
      <div className="flex gap-2 border-b border-slate-200">
        <button
          onClick={() => setActiveTab('system')}
          className={`px-4 py-2 font-medium border-b-2 transition-colors ${
            activeTab === 'system'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          }`}
        >
          🤖 시스템 프롬프트
        </button>
        <button
          onClick={() => setActiveTab('template')}
          className={`px-4 py-2 font-medium border-b-2 transition-colors ${
            activeTab === 'template'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          }`}
        >
          📝 보고서 템플릿
        </button>
      </div>

      {/* 시스템 프롬프트 탭 */}
      {activeTab === 'system' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* 에이전트 목록 */}
            <div className="p-4 bg-white border rounded-lg shadow-sm">
              <h3 className="font-semibold text-slate-900 mb-3">에이전트</h3>
              <div className="space-y-2">
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    onClick={() => setSelectedAgent(agent)}
                    className={`w-full text-left px-3 py-2 rounded transition-colors ${
                      selectedAgent?.id === agent.id
                        ? 'bg-blue-100 text-blue-700 border border-blue-300'
                        : 'bg-slate-50 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <div className="font-medium">{agent.name}</div>
                    <div className="text-xs opacity-75">{agent.description || '설명 없음'}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* 프롬프트 에디터 */}
            <div className="md:col-span-2 p-4 bg-white border rounded-lg shadow-sm">
              <h3 className="font-semibold text-slate-900 mb-3">
                {selectedAgent?.name} 시스템 프롬프트
              </h3>

              {message && (
                <div
                  className={`mb-3 p-3 rounded text-sm ${
                    message.includes('오류')
                      ? 'bg-red-50 text-red-700 border border-red-200'
                      : 'bg-green-50 text-green-700 border border-green-200'
                  }`}
                >
                  {message}
                </div>
              )}

              <div className="space-y-3">
                <div className="relative">
                  <textarea
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    placeholder="이 에이전트의 시스템 프롬프트를 입력하세요.&#10;&#10;예시:&#10;당신은 우리 회사의 인사 규정 전문가입니다.&#10;직원의 질문에 정확하고 친절하게 답변해주세요.&#10;항상 회사 규정을 기반으로 답변하세요."
                    className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm resize-none h-64"
                  />
                  <div className="absolute bottom-2 right-2 text-xs text-slate-500">
                    {systemPrompt.length} 글자
                  </div>
                </div>

                {/* 프롬프트 템플릿 제안 */}
                <div className="bg-blue-50 border border-blue-200 rounded p-3">
                  <h4 className="font-medium text-blue-900 text-sm mb-2">💡 프롬프트 템플릿</h4>
                  <div className="space-y-2 text-sm text-blue-800">
                    <button
                      type="button"
                      onClick={() =>
                        setSystemPrompt(
                          '당신은 우리 회사의 인사 규정 전문가입니다.\n\n직원의 질문에 정확하고 친절하게 답변해주세요.\n항상 회사 규정을 기반으로 답변하고, 확실하지 않은 내용은 "확인이 필요합니다"라고 답변하세요.\n\n답변 형식:\n- 핵심 내용 요약\n- 관련 규정\n- 추가 정보 또는 조치 사항'
                        )
                      }
                      className="w-full text-left px-2 py-1.5 rounded hover:bg-blue-100 transition-colors"
                    >
                      📋 인사 규정 전문가
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setSystemPrompt(
                          '당신은 회사 보고서 작성 전문가입니다.\n\n제공된 정보를 바탕으로 전문적이고 명확한 보고서를 작성해주세요.\n\n작성 원칙:\n- 객관적이고 중립적인 톤\n- 명확한 제목과 목차\n- 데이터 기반의 결론\n- 실행 가능한 제안\n\n보고서 구조:\n1. 개요\n2. 주요 내용\n3. 분석 결과\n4. 결론 및 제안'
                        )
                      }
                      className="w-full text-left px-2 py-1.5 rounded hover:bg-blue-100 transition-colors"
                    >
                      📊 보고서 작성 전문가
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setSystemPrompt(
                          '당신은 회사의 비서 겸 업무 조정자입니다.\n\n직원의 질문과 요청에 빠르고 효율적으로 대응해주세요.\n\n주요 역할:\n- 일정 및 회의 조율\n- 문서 작성 및 정리\n- 정보 검색 및 제공\n- 업무 프로세스 안내\n\n응답 원칙:\n- 친근하고 도움이 되는 톤\n- 빠른 응답\n- 실용적인 조언 제공'
                        )
                      }
                      className="w-full text-left px-2 py-1.5 rounded hover:bg-blue-100 transition-colors"
                    >
                      👔 비서 겸 업무 조정자
                    </button>
                  </div>
                </div>

                <button
                  onClick={handleSavePrompt}
                  disabled={saving}
                  className="w-full px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 transition-colors font-medium"
                >
                  {saving ? '저장 중...' : '✓ 프롬프트 저장'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 보고서 템플릿 탭 */}
      {activeTab === 'template' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* 템플릿 목록 */}
            <div className="space-y-4">
              <h3 className="text-lg font-semibold text-slate-900">📝 보고서 템플릿</h3>

              {loadingTemplates ? (
                <div className="text-center py-4">로딩 중...</div>
              ) : templates.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  아직 템플릿이 없습니다.
                </div>
              ) : (
                <div className="space-y-3">
                  {templates.map((template) => (
                    <div
                      key={template.id}
                      className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                        selectedTemplate?.id === template.id
                          ? 'border-blue-300 bg-blue-50'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                      onClick={() => handleEditTemplate(template)}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <h4 className="font-medium text-slate-900">{template.name}</h4>
                          {template.description && (
                            <p className="text-sm text-slate-600 mt-1">{template.description}</p>
                          )}
                          <p className="text-xs text-slate-500 mt-2">
                            버전 {template.version} • {new Date(template.created_at).toLocaleDateString()}
                          </p>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteTemplate(template.id);
                          }}
                          className="text-red-500 hover:text-red-700 p-1"
                          title="삭제"
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <button
                onClick={() => {
                  resetTemplateForm();
                  setIsEditing(false);
                }}
                className="w-full px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors font-medium"
              >
                ➕ 새 템플릿 만들기
              </button>
            </div>

            {/* 템플릿 에디터 */}
            <div className="space-y-4">
              <h3 className="text-lg font-semibold text-slate-900">
                {isEditing ? '템플릿 수정' : '새 템플릿 만들기'}
              </h3>

              {message && (
                <div
                  className={`p-3 rounded text-sm ${
                    message.includes('오류')
                      ? 'bg-red-50 text-red-700 border border-red-200'
                      : 'bg-green-50 text-green-700 border border-green-200'
                  }`}
                >
                  {message}
                </div>
              )}

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    템플릿 이름 *
                  </label>
                  <input
                    type="text"
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder="예: 월간 업무 보고서"
                    className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    설명
                  </label>
                  <input
                    type="text"
                    value={templateDescription}
                    onChange={(e) => setTemplateDescription(e.target.value)}
                    placeholder="템플릿에 대한 간단한 설명"
                    className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    템플릿 내용 *
                  </label>
                  <textarea
                    value={templateContent}
                    onChange={(e) => setTemplateContent(e.target.value)}
                    placeholder={`# {{title}}

## 개요
{{summary}}

## 주요 내용
{{content}}

## 결론
{{conclusion}}

---
작성일: {{date}}
작성자: {{author}}`}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm resize-none h-80"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    {templateContent.length} 글자 • 변수: {'{{title}}'}, {'{{date}}'}, {'{{author}}'} 등 사용 가능
                  </p>
                </div>

                {/* 변수 설명 */}
                <div className="bg-blue-50 border border-blue-200 rounded p-3">
                  <h4 className="font-medium text-blue-900 text-sm mb-2">💡 사용 가능한 변수</h4>
                  <div className="text-sm text-blue-800 space-y-1">
                    <div><code className="bg-blue-100 px-1 rounded">{'{{title}}'}</code> - 보고서 제목</div>
                    <div><code className="bg-blue-100 px-1 rounded">{'{{date}}'}</code> - 작성 날짜</div>
                    <div><code className="bg-blue-100 px-1 rounded">{'{{author}}'}</code> - 작성자 이름</div>
                    <div><code className="bg-blue-100 px-1 rounded">{'{{summary}}'}</code> - 요약 내용</div>
                    <div><code className="bg-blue-100 px-1 rounded">{'{{content}}'}</code> - 본문 내용</div>
                    <div><code className="bg-blue-100 px-1 rounded">{'{{conclusion}}'}</code> - 결론</div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={handleSaveTemplate}
                    disabled={saving}
                    className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 transition-colors font-medium"
                  >
                    {saving ? '저장 중...' : (isEditing ? '✓ 수정하기' : '✓ 만들기')}
                  </button>
                  {isEditing && (
                    <button
                      onClick={resetTemplateForm}
                      className="px-4 py-2 bg-slate-500 text-white rounded-md hover:bg-slate-600 transition-colors"
                    >
                      취소
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
