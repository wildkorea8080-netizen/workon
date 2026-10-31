'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { taskAgentChoices } from '@/lib/apps/work-launch';
import type { Agent } from '@/lib/db';
import WorkShell, { Card, ErrorNote, PageTitle } from '@/components/work/WorkShell';
import FormFields, { cleanForm, type FormState } from '@/components/work/FormFields';
import { inputsFor } from '@/components/work/file-set-helpers';
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
  const requestedAgentId = params.get('agent');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [launchWarning, setLaunchWarning] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowSummaryDto | null>(null);
  const [templates, setTemplates] = useState<TemplatesDto | null>(null);
  const [title, setTitle] = useState('');
  const [form, setForm] = useState<FormState>({});
  const [templateId, setTemplateId] = useState('');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState('');
  const [useAgentDocuments, setUseAgentDocuments] = useState(false);
  const [agentError, setAgentError] = useState(false);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    setLoading(true); setWorkflow(null); setTemplates(null); setError(null);
    setTemplateId(''); setForm({}); setTitle(''); setMissing([]); setUseAgentDocuments(false);
    void (async () => {
      const [w, t] = await Promise.all([
        api<{ workflows: WorkflowSummaryDto[] }>('/api/workflows'),
        api<TemplatesDto>('/api/work/templates'),
      ]);
      if (!active) return;
      if (w.ok) {
        const found = w.data.workflows.find((x) => x.key === key) ?? null;
        setWorkflow(found);
        if (!found) setError('업무를 찾을 수 없습니다. 앱 목록에서 다시 선택해 주세요.');
        else if (!t.ok && found.inputs.some((i) => i.type === 'template')) setError('양식을 불러오지 못했습니다. 다시 불러오기를 눌러 주세요.');
      } else setError(w.error.message);
      if (t.ok) setTemplates(t.data);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [key, reload]);

  useEffect(() => {
    let active = true;
    setAgentId(''); setUseAgentDocuments(false); setLaunchWarning(null); setAgentsLoading(true);
    void Promise.all([api<Agent[]>('/api/agents'), api<Agent[]>('/api/agents?personal=true')]).then(([shared, personal]) => {
      if (!active) return;
      setAgentError(!shared.ok || !personal.ok);
      const rows = [...(shared.ok ? shared.data : []), ...(personal.ok ? personal.data : [])];
      const choices = taskAgentChoices(rows);
      setAgents(choices); setAgentsLoading(false);
      if (requestedAgentId) {
        const selected = choices.find((a) => a.id === requestedAgentId);
        if (selected) setAgentId(selected.id);
        else setLaunchWarning('선택한 비서를 불러오지 못했습니다. 아래에서 다른 비서를 선택하거나 기본 업무 지침으로 시작해 주세요.');
      }
    });
    return () => { active = false; };
  }, [requestedAgentId, reload]);

  const templateOptions = useMemo(() => {
    if (!templates) return [];
    const builtin = templates.builtin.filter((b) => b.id && b.status !== 'draft').map((b) => ({ id: b.id!, label: `${b.name} — ${b.label}`, ref: b.ref }));
    const org = templates.organization.filter((o) => o.status !== 'draft').map((o) => ({ id: o.id, label: `${o.name} (기관 양식) — ${o.label}`, ref: '' }));
    return [...org, ...builtin];
  }, [templates]);

  useEffect(() => {
    if (!templateId && templateOptions.length && workflow) {
      const preferred = templateOptions.find((o) => o.ref === (workflow.defaultTemplateRef ?? 'builtin:report'));
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
      json: { workflowKey: workflow.key, title, documentScope: ['regulations', 'report', 'reply'].includes(workflow.key) && agentId && useAgentDocuments ? 'selected-agent' : 'default', agentId: !['collection', 'settlement'].includes(workflow.key) ? agentId || undefined : undefined, form: cleaned, templateVersionId: workflow.inputs.some((i) => i.type === 'template') ? templateId || undefined : undefined },
    });
    setSaving(false);
    if (!r.ok) return setError(r.error.message);
    router.push(`/tasks/${r.data.task.id}`);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-8">
      <PageTitle title={workflow ? `${workflow.name} 시작` : '작업 시작'} subtitle={workflow?.purpose} />
      <ErrorNote message={error} />
      {loading && <p role="status" className="py-6 text-slate-500">업무 설정을 불러오는 중…</p>}
      {!loading && error && <div className="mt-3 flex gap-4"><button type="button" onClick={() => setReload((v) => v + 1)} className="text-sm text-[#003087] underline">다시 불러오기</button><Link href="/apps" className="text-sm text-[#003087] underline">앱 목록으로</Link></div>}
      {launchWarning && <p role="status" className="mt-3 text-sm text-amber-800">{launchWarning}</p>}
      {workflow && (
        <form onSubmit={submit} className="mt-4 space-y-6" noValidate>
          {!['collection', 'settlement'].includes(workflow.key) && <Card>
            <label htmlFor="task-agent" className="text-[15px] font-medium">작성에 사용할 비서 (선택)</label>
            <select id="task-agent" disabled={agentsLoading} value={agentId} onChange={(e) => { setAgentId(e.target.value); setUseAgentDocuments(false); setLaunchWarning(null); }} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2.5">
              <option value="">기본 업무 지침</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <p className="mt-2 text-sm text-slate-500">선택한 비서의 현재 지침·모델·버전을 이 작업에 보존합니다. 연결 도구는 가져오지 않습니다. 규정 확인·보고서·회신에서는 아래 옵션으로 비서 문서함을 연결할 수 있습니다.</p>
            {['regulations', 'report', 'reply'].includes(workflow.key) && agentId && (() => {
              const a = agents.find((item) => item.id === agentId);
              const eligible = a?.tier === 'official' && a.is_published && !!a.capabilities && Object.prototype.hasOwnProperty.call(a.capabilities, 'doc_search');
              return eligible ? <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={useAgentDocuments} onChange={(e) => setUseAgentDocuments(e.target.checked)} />선택한 비서의 문서함을 근거로 검색합니다. 규정 확인은 공통 기준·법령도 함께 조회하며, 보고서·회신은 첨부 자료와 함께 사용합니다. 보고서는 새 문서 작성에서 지원하며 작년 파일 현행화에는 사용할 수 없습니다.</label> : <p className="mt-2 text-sm text-slate-500">문서함 연결은 문서 검색을 사용하는 공개 공식 비서에서 지원합니다.</p>;
            })()}
            {agentError && <p className="mt-2 text-sm text-amber-800">일부 비서를 불러오지 못했습니다. 새로고침하면 다시 불러옵니다.</p>}
          </Card>}
          {workflow.inputs.some((i) => i.type === 'template') && (
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
          )}
          <Card>
            <h2 className="mb-4 text-[18px] font-semibold">{workflow.inputs.some((i) => i.type === 'template') ? '2. 필수 정보' : '필수 정보'}</h2>
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
              {workflow.inputs.some((i) => i.key === 'title') && (
                <p className="mt-1 text-[13px] text-slate-500">{workflow.outputs.some((o) => o.format === 'hwpx') ? '문서 제목으로도 씁니다.' : '결과 파일 이름으로도 씁니다.'}</p>
              )}
            </div>
            <FormFields inputs={workflow.inputs} value={form} onChange={setForm} missing={missing} />
            {inputsFor(workflow.inputs, workflow.currentizes).some((i) => i.type === 'file-set') && (
              <p className="mt-5 rounded-lg bg-slate-50 px-3 py-2 text-[14px] text-slate-600">
                {inputsFor(workflow.inputs, workflow.currentizes).filter((i) => i.type === 'file-set').map((i) => i.label).join('·')} 파일은 작업을 저장한 뒤 작업실에서 올립니다.
              </p>
            )}
          </Card>
          <div className="flex justify-end gap-3">
            <Link href="/assistants" className="rounded-[10px] border border-[#DCE3EC] bg-white px-5 py-3 text-[15px]">
              취소
            </Link>
            <button type="submit" disabled={saving || loading || agentsLoading || (workflow.inputs.some((i) => i.type === 'template') && !templateId)} className="rounded-[10px] bg-[#003087] px-5 py-3 text-[15px] font-semibold text-white disabled:bg-slate-300">
              {saving ? '저장 중…' : agentsLoading ? '비서 목록 확인 중…' : '작업 저장하고 작업실로'}
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
