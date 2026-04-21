import { useState, useEffect } from 'react';
import type { GeneratedReport } from './ReportWizard';

interface ReportGeneratorProps {
  templateId: string;
  formData: Record<string, string>;
  onGenerated: (report: GeneratedReport) => void;
  onError: (error: string) => void;
}

export default function ReportGenerator({
  templateId,
  formData,
  onGenerated,
  onError
}: ReportGeneratorProps) {
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('보고서를 생성하는 중...');

  useEffect(() => {
    generateReport();
  }, []);

  const generateReport = async () => {
    try {
      setProgress(10);
      setStatus('AI 모델을 준비하는 중...');

      setProgress(30);
      setStatus('보고서 템플릿을 처리하는 중...');

      const response = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: templateId,
          form_data: formData,
        }),
      });

      setProgress(70);
      setStatus('AI 응답을 생성하는 중...');

      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.error?.message || '보고서 생성 실패');
      }

      setProgress(100);
      setStatus('완료되었습니다.');

      // 약간의 지연 후 결과 전달
      setTimeout(() => {
        onGenerated(result.data);
      }, 500);

    } catch (error) {
      onError(error instanceof Error ? error.message : '보고서 생성 중 오류가 발생했습니다.');
    }
  };

  return (
    <div className="text-center py-12">
      <div className="mb-6">
        <div className="w-16 h-16 mx-auto mb-4">
          <svg className="animate-spin w-full h-full text-slate-600" fill="none" viewBox="0 0 24 24">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        </div>
        <h3 className="text-lg font-medium text-slate-900 mb-2">보고서 생성 중</h3>
        <p className="text-slate-600">{status}</p>
      </div>

      {/* Progress Bar */}
      <div className="w-full max-w-md mx-auto">
        <div className="bg-slate-200 rounded-full h-2 mb-2">
          <div
            className="bg-slate-900 h-2 rounded-full transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="text-sm text-slate-600">{progress}% 완료</div>
      </div>
    </div>
  );
}