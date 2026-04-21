'use client';

import { useState, useEffect } from 'react';
import TemplateSelector from './TemplateSelector';
import ReportForm from './ReportForm';
import ReportGenerator from './ReportGenerator';
import ReportViewer from './ReportViewer';
import type { ReportTemplate } from '@/lib/db';

export interface GeneratedReport {
  report: string;
  template_name: string;
  saved_id: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

type Step = 'select' | 'form' | 'generate' | 'view';

export default function ReportWizard() {
  const [currentStep, setCurrentStep] = useState<Step>('select');
  const [selectedTemplate, setSelectedTemplate] = useState<ReportTemplate | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [generatedReport, setGeneratedReport] = useState<GeneratedReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleTemplateSelect = (template: ReportTemplate) => {
    setSelectedTemplate(template);
    setFormData({});
    setCurrentStep('form');
  };

  const handleFormSubmit = (data: Record<string, string>) => {
    setFormData(data);
    setCurrentStep('generate');
  };

  const handleReportGenerated = (report: GeneratedReport) => {
    setGeneratedReport(report);
    setCurrentStep('view');
  };

  const handleBack = () => {
    if (currentStep === 'form') {
      setCurrentStep('select');
      setSelectedTemplate(null);
    } else if (currentStep === 'generate') {
      setCurrentStep('form');
    } else if (currentStep === 'view') {
      setCurrentStep('form');
      setGeneratedReport(null);
    }
  };

  const handleStartOver = () => {
    setCurrentStep('select');
    setSelectedTemplate(null);
    setFormData({});
    setGeneratedReport(null);
    setError(null);
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border">
      {/* Progress Indicator */}
      <div className="px-6 py-4 border-b border-slate-200">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <StepIndicator step="select" currentStep={currentStep} label="템플릿 선택" />
            <StepIndicator step="form" currentStep={currentStep} label="정보 입력" />
            <StepIndicator step="generate" currentStep={currentStep} label="보고서 생성" />
            <StepIndicator step="view" currentStep={currentStep} label="결과 확인" />
          </div>
          {currentStep !== 'select' && (
            <button
              onClick={handleBack}
              className="text-sm text-slate-600 hover:text-slate-900"
            >
              ← 뒤로
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="p-6">
        {error && (
          <div className="mb-6 p-4 text-red-700 bg-red-100 rounded-lg">
            {error}
          </div>
        )}

        {currentStep === 'select' && (
          <TemplateSelector onTemplateSelect={handleTemplateSelect} />
        )}

        {currentStep === 'form' && selectedTemplate && (
          <ReportForm
            template={selectedTemplate}
            onSubmit={handleFormSubmit}
            initialData={formData}
          />
        )}

        {currentStep === 'generate' && selectedTemplate && (
          <ReportGenerator
            templateId={selectedTemplate.id}
            formData={formData}
            onGenerated={handleReportGenerated}
            onError={setError}
          />
        )}

        {currentStep === 'view' && generatedReport && (
          <ReportViewer
            report={generatedReport}
            onStartOver={handleStartOver}
          />
        )}
      </div>
    </div>
  );
}

function StepIndicator({ step, currentStep, label }: {
  step: Step;
  currentStep: Step;
  label: string;
}) {
  const isActive = currentStep === step;
  const isCompleted = getStepOrder(currentStep) > getStepOrder(step);

  return (
    <div className="flex items-center">
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
          isCompleted
            ? 'bg-green-600 text-white'
            : isActive
            ? 'bg-slate-900 text-white'
            : 'bg-slate-200 text-slate-600'
        }`}
      >
        {isCompleted ? '✓' : getStepOrder(step)}
      </div>
      <span className={`ml-2 text-sm ${isActive ? 'text-slate-900 font-medium' : 'text-slate-600'}`}>
        {label}
      </span>
    </div>
  );
}

function getStepOrder(step: Step): number {
  const orders = { select: 1, form: 2, generate: 3, view: 4 };
  return orders[step];
}