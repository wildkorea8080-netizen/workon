import { useState } from 'react';
import type { ReportTemplate } from '@/lib/db';

interface ReportFormProps {
  template: ReportTemplate;
  onSubmit: (data: Record<string, string>) => void;
  initialData: Record<string, string>;
}

// 템플릿 content에서 변수 추출
function extractVariables(content: string): Array<{ name: string; label: string; type: 'text' | 'textarea' | 'date'; required?: boolean }> {
  const variableRegex = /\{\{(\w+)\}\}/g;
  const variables = new Set<string>();
  let match;

  while ((match = variableRegex.exec(content)) !== null) {
    variables.add(match[1]);
  }

  return Array.from(variables).map(varName => {
    let type: 'text' | 'textarea' | 'date' = 'text';
    let label = varName;
    let required = false;

    // 변수명에 따른 타입과 라벨 설정
    switch (varName.toLowerCase()) {
      case 'title':
        label = '제목';
        required = true;
        break;
      case 'summary':
      case 'content':
      case 'conclusion':
        label = varName === 'summary' ? '요약' : varName === 'content' ? '내용' : '결론';
        type = 'textarea';
        break;
      case 'date':
        label = '작성일';
        type = 'date';
        break;
      case 'author':
        label = '작성자';
        required = true;
        break;
      case 'project_name':
        label = '프로젝트명';
        required = true;
        break;
      default:
        label = varName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    }

    return { name: varName, label, type, required };
  });
}

export default function ReportForm({ template, onSubmit, initialData }: ReportFormProps) {
  const [formData, setFormData] = useState<Record<string, string>>(initialData);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const fields = extractVariables(template.content);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // 유효성 검사
    const newErrors: Record<string, string> = {};
    fields.forEach(field => {
      if (field.required && !formData[field.name]?.trim()) {
        newErrors[field.name] = '필수 입력 항목입니다.';
      }
    });

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setErrors({});
    onSubmit(formData);
  };

  const handleChange = (name: string, value: string) => {
    setFormData(prev => ({ ...prev, [name]: value }));
    if (errors[name]) {
      setErrors(prev => ({ ...prev, [name]: '' }));
    }
  };

  return (
    <div>
      <h2 className="text-xl font-semibold mb-2">{template.name}</h2>
      {template.description && (
        <p className="text-slate-600 mb-6">{template.description}</p>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {fields.map(field => (
          <div key={field.name}>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              {field.label}
              {field.required && <span className="text-red-600 ml-1">*</span>}
            </label>

            {field.type === 'textarea' ? (
              <textarea
                value={formData[field.name] || ''}
                onChange={(e) => handleChange(field.name, e.target.value)}
                placeholder={`${field.label}을(를) 입력하세요`}
                className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-slate-500 ${
                  errors[field.name] ? 'border-red-300' : 'border-slate-300'
                }`}
                rows={field.name === 'content' ? 6 : 3}
              />
            ) : field.type === 'date' ? (
              <input
                type="date"
                value={formData[field.name] || ''}
                onChange={(e) => handleChange(field.name, e.target.value)}
                className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-slate-500 ${
                  errors[field.name] ? 'border-red-300' : 'border-slate-300'
                }`}
              />
            ) : (
              <input
                type="text"
                value={formData[field.name] || ''}
                onChange={(e) => handleChange(field.name, e.target.value)}
                placeholder={`${field.label}을(를) 입력하세요`}
                className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-slate-500 ${
                  errors[field.name] ? 'border-red-300' : 'border-slate-300'
                }`}
              />
            )}

            {errors[field.name] && (
              <p className="text-red-600 text-sm mt-1">{errors[field.name]}</p>
            )}
          </div>
        ))}

        <div className="flex justify-end">
          <button
            type="submit"
            className="px-6 py-2 bg-slate-900 text-white rounded-md hover:bg-slate-800"
          >
            보고서 생성
          </button>
        </div>
      </form>
    </div>
  );
}