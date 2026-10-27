'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import WorkShell, { Card, ErrorNote, PageTitle } from '@/components/work/WorkShell';
import FormFields, { cleanForm, type FormState } from '@/components/work/FormFields';
import { api } from '@/lib/work/client';
import type { TaskDetailDto, TemplatesDto, WorkflowSummaryDto } from '@/components/work/types';

/**
 * 작업 시작 — 양식 고르기 · 제목·필수 정보. 저장하면 서버에 작업이 생기고(새로고침·탭을 닫아도 이어감)
 * 업무 작업실에서 원자료를 올리고 'HWPX 만들기'를 누른다. 저장은 제출·발송이 아니다.
 */
function NewTask() {
  const params = useSearchParams();
  const router = useRouter();
  const key = params.get('workflow') ?? '';
  const [workflow, setWorkflow] = useState<WorkflowSummaryDto | null>(null);
  const [templates, setTemplates] = useState<TemplatesDto | null>(null);
  const [title, setTitle] = useState('');
  const [form, setForm] = useState<FormState>({});
  const [templateId, setTemplateId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);

  useEffect(() => {
    void (async () => {
      const [w, t] = await Promise.all([
        api<{ workflows: WorkflowSummaryDto[] }>('/api/workflows'),
        api<TemplatesDto>('/api/work/templates'),
      ]);
      if (w.ok) setWorkflow(w.data.workflows.find((x) => x.key === key) ?? null);
      else setError(w.error.message);
      if (t.ok) setTemplates(t.data);
    })();
  }, [key]);

  const templateOptions = useMemo(() => {
    if (!templates) return [];
    const builtin = templates.builtin.filter((b) => b.id && b.status !== 'draft').map((b) => ({ id: b.id!, label: `${b.name} — ${b.label}`, ref: b.ref }));
    const org = templates.organization.filter((o) => o.status !== 'draft').map((o) => ({ id: o.id, label: `${o.name} (기관 양식) — ${o.label}`, ref: '' }));
    return [...org, ...builtin];
  }, [templates]);

  useEffect(() => {
    if (!templateId && templateOptions.length && workflow) {
      const preferred = templateOptions.find((o) => o.ref === `builtin:${workflow.key === 'official-letter' ? 'official_letter' : workflow.key === 'meeting' ? 'minutes' : 'report'}`);
      setTemplateId((preferred ?? templateOptions[0]).id);
    }
  }, [templateOptions, templateId, workflow]);

  if (workflow && !workflow.available) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <PageTitle title={workflow.name} />
        <Card>
          <p className="text-[15px]">이 업무는 아직 준비 중입니다 — {workflow.reason}</p>
          <Link href="/assistants" className="mt-3 inline-block text-[#003087] underline">
            다른 업무 고르기
          </Link>
        </Card>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!workflow) return;
    setError(null);
    const req = workflow.inputs.filter((i) => i.required && !['file-set', 'template', 'title'].includes(i.type) && i.key !== 'title');
    const cleaned = cleanForm(workflow.inputs, form);
    const miss = req.filter((i) => cleaned[i.key] === undefined).map((i) => i.key);
    setMissing(miss);
    if (!title.trim()) return setError('작업 제목을 적어 주세요.');
    setSaving(true);
    const r = await api<TaskDetailDto>('/api/work/tasks', {
      method: 'POST',
      json: { workflowKey: workflow.key, title, form: cleaned, templateVersionId: templateId || undefined },
    });
    setSaving(false);
    if (!r.ok) return setError(r.error.message);
    router.push(`/tasks/${r.data.task.id}`);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-8">
      <PageTitle title={workflow ? `${workflow.name} 시작` : '작업 시작'} subtitle={workflow?.purpose} />
      <ErrorNote message={error} />
      {workflow && (
        <form onSubmit={submit} className="mt-4 space-y-6" noValidate>
          <Card>
            <h2 className="mb-4 text-[18px] font-semibold">1. 양식</h2>
            <label htmlFor="tpl" className="text-[15px] font-medium">
              결과 파일 양식 <span className="text-[13px] text-red-700">(필수)</span>
            </label>
            <select
              id="tpl"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="mt-1 w-full rounded-[10px] border border-[#DCE3EC] bg-white px-3 py-2.5 text-[15px]"
            >
              {templateOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            {templateOptions.length === 0 && templates && <p className="mt-2 text-[14px] text-red-700">쓸 수 있는 양식이 없습니다. 관리자에게 문의하세요.</p>}
            <p className="mt-2 text-[13px] text-slate-500">결과는 이 양식에 글을 채운 한글(HWPX) 파일입니다. 작업을 만든 뒤에는 양식이 바뀌지 않습니다.</p>
          </Card>
          <Card>
            <h2 className="mb-4 text-[18px] font-semibold">2. 필수 정보</h2>
            <div className="mb-5">
              <label htmlFor="title" className="text-[15px] font-medium">
                작업 제목 <span className="text-[13px] text-red-700">(필수)</span>
              </label>
              <input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                className="mt-1 w-full rounded-[10px] border border-[#DCE3EC] px-3 py-2.5 text-[15px] focus:border-[#003087] focus:outline-none focus:ring-2 focus:ring-[#003087]/20"
              />
              {workflow.inputs.some((i) => i.key === 'title') && <p className="mt-1 text-[13px] text-slate-500">문서 제목으로도 씁니다.</p>}
            </div>
            <FormFields inputs={workflow.inputs} value={form} onChange={setForm} missing={missing} />
            {workflow.inputs.some((i) => i.type === 'file-set') && (
              <p className="mt-5 rounded-lg bg-slate-50 px-3 py-2 text-[14px] text-slate-600">참고 자료 파일은 작업을 저장한 뒤 작업실에서 올립니다.</p>
            )}
          </Card>
          <div className="flex justify-end gap-3">
            <Link href="/assistants" className="rounded-[10px] border border-[#DCE3EC] bg-white px-5 py-3 text-[15px]">
              취소
            </Link>
            <button type="submit" disabled={saving || !templateId} className="rounded-[10px] bg-[#003087] px-5 py-3 text-[15px] font-semibold text-white disabled:bg-slate-300">
              {saving ? '저장 중…' : '작업 저장하고 작업실로'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export default function NewTaskPage() {
  return (
    <WorkShell>
      <Suspense fallback={null}>
        <NewTask />
      </Suspense>
    </WorkShell>
  );
}
