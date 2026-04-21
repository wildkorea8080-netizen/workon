import { useState, useEffect } from 'react';
import type { ReportTemplate } from '@/lib/db';

interface TemplateSelectorProps {
  onTemplateSelect: (template: ReportTemplate) => void;
}

export default function TemplateSelector({ onTemplateSelect }: TemplateSelectorProps) {
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    try {
      const response = await fetch('/api/templates');
      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.error?.message || '템플릿 목록을 불러올 수 없습니다.');
      }

      setTemplates(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="text-slate-600">템플릿을 불러오는 중...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <div className="text-red-600">{error}</div>
        <button
          onClick={loadTemplates}
          className="mt-4 px-4 py-2 bg-slate-900 text-white rounded-md hover:bg-slate-800"
        >
          다시 시도
        </button>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-xl font-semibold mb-4">보고서 템플릿 선택</h2>
      <p className="text-slate-600 mb-6">생성할 보고서 유형을 선택하세요.</p>

      {templates.length === 0 ? (
        <div className="text-center py-8 text-slate-500">
          사용 가능한 템플릿이 없습니다. 관리자에게 문의하세요.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {templates.map((template) => (
            <div
              key={template.id}
              className="p-4 border rounded-lg hover:border-slate-400 cursor-pointer transition-colors"
              onClick={() => onTemplateSelect(template)}
            >
              <h3 className="font-medium text-slate-900">{template.name}</h3>
              {template.description && (
                <p className="text-sm text-slate-600 mt-1">{template.description}</p>
              )}
              <div className="text-xs text-slate-500 mt-2">
                생성일: {new Date(template.created_at).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}