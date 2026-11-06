'use client';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import WorkShell, { Card, ErrorNote, PageTitle } from '@/components/work/WorkShell';
import { useFileAttachments } from '@/components/chat/useFileAttachments';
import { PendingFileChips } from '@/components/chat/AttachmentChips';
import { ATTACHMENT_ACCEPT } from '@/lib/attachments/limits';
import { APP_MAX_FILES } from '@/lib/apps/definition';
import AppFields from '@/components/apps/AppFields';
import AppStepResults from '@/components/apps/AppStepResults';
import AppResultExport from '@/components/apps/AppResultExport';
import AppScheduleForm from '@/components/apps/AppScheduleForm';
import AppWebhookForm from '@/components/apps/AppWebhookForm';
import AppLibraryPicker from '@/components/apps/AppLibraryPicker';
import type { AppStepRecord } from '@/lib/apps/pipeline';
import { loadChatLaunchAgent } from '@/lib/apps/chat-launch';
import { renderAppInput, validateAppDefinition } from '@/lib/apps/definition';
import { readAppStream } from '@/lib/apps/stream';
import type { Agent } from '@/lib/db';
import { loadAppResumeSource, type AppResumeSource } from '@/lib/apps/resume-client';
import { api } from '@/lib/work/client';
import { readAppDraft, withDraftSettings } from '@/lib/apps/draft';
import { kstTime } from '@/components/apps/AppDraftPanel';

function Runner() {
  const params = useSearchParams();
  const id = params.get('agent'); const resumeId = params.get('resume'); const from = params.get('from');
  const draftMode = params.get('draft') === '1';
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null); const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<Record<string, string>>({}); const [running, setRunning] = useState(false);
  const [result, setResult] = useState(''); const [conversation, setConversation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null); const [status, setStatus] = useState('');
  const [steps, setSteps] = useState<AppStepRecord[]>([]);
  const [numberWarning, setNumberWarning] = useState<string[]>([]);
  const [finished, setFinished] = useState(false);
  const [resumeSource, setResumeSource] = useState<AppResumeSource | null>(null);
  // 문서함에서 고른 문서(2026-11-05) — 앱이 허용할 때만, 올린 파일과 합쳐 앱 상한까지
  const [pickedDocs, setPickedDocs] = useState<string[]>([]);
  const controller = useRef<AbortController | null>(null); const pending = useRef(false);
  useEffect(() => {
    let active = true; setAgent(null); setDraftSavedAt(null); setResult(''); setConversation(null); setValues({}); setLoading(true); setError(null); setResumeSource(null); setSteps([]); setFinished(false); setPickedDocs([]);
    void (async () => {
      if (draftMode && id) {
        // 시험 판(0053) — 편집 창과 같은 길로 읽는다(고칠 수 있는 사람만). 이어 실행·예약·연동은 지금 판에만 있다
        const loaded = await api<Agent>(`/api/agents/${encodeURIComponent(id)}`);
        if (!active) return;
        const draft = loaded.ok ? readAppDraft(loaded.data.app_draft) : null;
        if (!loaded.ok || !draft) { setError(loaded.ok ? '배포하지 않은 시험 판이 없습니다. 앱 설정에서 시험 판을 저장해 주세요.' : loaded.error.message); return; }
        setAgent({ ...withDraftSettings(loaded.data, draft), description: draft.settings.description ?? loaded.data.description });
        setDraftSavedAt(draft.saved_at);
        return;
      }
      const a = id ? await loadChatLaunchAgent(id) : null;
      if (!active) return;
      if (!a?.app_definition) { setError('이 입력형 앱을 사용할 수 없습니다. 앱 목록에서 다시 선택해 주세요.'); return; }
      setAgent(a);
      if (resumeId && from) {
        const source = await loadAppResumeSource(a, from, resumeId);
        if (!active) return;
        if (source) { setResumeSource(source); setValues(source.inputs); setSteps(source.records); setConversation(source.conversationId); setStatus('이전 실행 기록입니다. 입력을 확인한 뒤 이어서 실행해 주세요.'); }
        else setError('이 기록은 이어서 실행할 수 없습니다. 앱 설정과 원래 입력을 확인하거나 새로 실행해 주세요.');
      }
    })().catch(() => { if (active) setError('앱을 불러오지 못했습니다.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.current?.abort(); };
  }, [id, resumeId, from, draftMode]);
  const checked = validateAppDefinition(agent?.app_definition ?? null);
  const definition = checked.ok ? checked.value : null;
  const files = useFileAttachments(Boolean(definition?.attachments), APP_MAX_FILES);
  const currentInput = definition ? renderAppInput(definition, values) : null;
  const previousInput = definition && resumeSource ? renderAppInput(definition, resumeSource.inputs) : null;
  const sameInput = Boolean(currentInput?.ok && previousInput?.ok && currentInput.message === previousInput.message);
  // 파일을 붙이면 근거가 바뀐다 — 서버(prepare.ts isInputOnlyRun)도 거절한다
  const filesAdded = files.chips.some(chip => chip.stage !== 'failed') || pickedDocs.length > 0;
  const canResume = sameInput && !filesAdded;
  async function run(event?: React.FormEvent, resumeMessageId?: string) {
    event?.preventDefault(); if (!agent || !definition || pending.current) return;
    const input = renderAppInput(definition, values);
    if (!input.ok) { setError(input.message); return; }
    if (files.busy || (definition.attachments?.required && !files.readyIds.length && !pickedDocs.length)) { setError(definition.attachments?.library ? '파일을 첨부하거나 문서함에서 문서를 골라 주세요.' : '파일 읽기를 마친 뒤 필요한 파일을 첨부해 주세요.'); return; }
    pending.current = true; setRunning(true); setError(null); setResult(''); setConversation(null); setStatus('입력 내용을 확인하고 있습니다…');
    setFinished(false);
    setSteps((definition.steps ?? []).map(step => ({ name: step.name, status: 'pending' }))); setNumberWarning([]);
    const previousResume = resumeSource; setResumeSource(null);
    let runConversation: string | null = null;
    const requestController = new AbortController(); controller.current = requestController;
    try {
      const response = await fetch('/api/chat', { method: 'POST', signal: requestController.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_id: agent.id, message: '앱 실행', app_inputs: values, app_version: agent.version, attachment_ids: files.readyIds, ...(pickedDocs.length ? { app_document_ids: pickedDocs } : {}), ...(resumeMessageId ? { resume_message_id: resumeMessageId } : {}), ...(draftSavedAt ? { app_draft: draftSavedAt } : {}) }) });
      if (!response.ok || !response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) { const data = await response.json().catch(() => null); if (data?.error?.details?.attachments_consumed || data?.details?.attachments_consumed) files.clear(); throw new Error(data?.error?.message || '앱을 실행하지 못했습니다.'); }
      await readAppStream(response.body, (name, data) => {
        if (requestController.signal.aborted) return;
        if (name === 'app_step' && typeof data.index === 'number' && data.step) {
          const step = data.step as AppStepRecord;
          setSteps(previous => previous.map((old, index) => index === data.index ? step : old));
          setStatus(`${step.name}: ${step.status === 'running' ? '처리 중…' : step.status === 'completed' ? '완료' : step.status === 'skipped' ? '조건에 따라 건너뜀' : '중단'}`);
        }
        if (name === 'app_material' && typeof data.index === 'number' && typeof data.total === 'number') setStatus(data.phase === 'reduce' ? `추린 자료를 합치는 중… (${data.index + 1}/${data.total})` : `긴 첨부를 나눠 추리는 중… (${data.index + 1}/${data.total})`);
        if (name === 'done' && data.number_check) setNumberWarning((data.number_check as { unverified?: string[] }).unverified ?? []);
        if (name === 'meta' && typeof data.conversation_id === 'string') { files.clear(); runConversation = data.conversation_id; setConversation(data.conversation_id); }
        if (name === 'delta' && typeof data.text === 'string') { setResult(text => text + data.text); setStatus('초안을 작성하고 있습니다…'); }
        if (name === 'tool_start') setStatus('연결된 자료를 확인하고 있습니다…');
      });
      setStatus('작성을 마쳤습니다. 내용을 검토한 뒤 사용해 주세요.');
      setFinished(true);
    } catch (failure) {
      if (requestController.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : '응답을 받지 못했습니다.'); setStatus('');
      if (runConversation) { try { setResumeSource(await loadAppResumeSource(agent, runConversation)); } catch { /* History can be opened later. */ } }
      else if (resumeMessageId) setResumeSource(previousResume);
    }
    finally { pending.current = false; setRunning(false); }
  }
  return <div className="mx-auto max-w-6xl px-5 py-9 md:px-9"><PageTitle title={agent?.name || '입력형 앱'} subtitle={agent?.description || '자료를 입력하면 설정한 업무에 맞는 텍스트 초안을 만듭니다.'} action={<Link href="/apps" className="text-sm text-ws-accent-text">앱 목록으로</Link>} /><ErrorNote message={error} />{draftSavedAt && <p role="status" className="my-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">시험 판 실행 — {kstTime(draftSavedAt)}에 저장한 배포 전 설정입니다. 부서 사람들에게는 아직 반영되지 않았고, 예약·외부 연동은 지금 판으로만 돕니다. 사용량은 평소처럼 기록됩니다. <Link href={`/apps/builder?agent=${encodeURIComponent(agent?.id ?? id ?? '')}`} className="font-semibold underline">앱 설정으로 돌아가기</Link></p>}{loading ? <p role="status">앱을 불러오는 중…</p> : agent && definition && <div className="mt-6 grid items-start gap-6 lg:grid-cols-2"><Card><form onSubmit={run}><AppFields definition={definition} values={values} disabled={running} onChange={(key, value) => setValues(p => ({ ...p, [key]: value }))} />{definition.attachments && <fieldset disabled={running} className="mt-5 space-y-3"><legend className="text-sm font-semibold">참고 파일{definition.attachments.required ? ' (필수)' : ' (선택)'}</legend><input aria-label="참고 파일 첨부" type="file" multiple accept={ATTACHMENT_ACCEPT} onChange={e => { files.addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} className="max-w-full text-sm" /><p className="text-xs leading-5 text-slate-500">최대 3개 · 파일당 10MB · 추출 자료 합계 20,000자까지는 그대로, 120,000자까지는 조각(최대 6개)으로 나눠 추려 읽습니다(조각마다 AI 사용량이 더 듭니다). 스캔·일부 추출 등 읽기 경고가 있는 파일은 정리 후 첨부해 주세요. 실행 후 다시 실행하려면 파일을 새로 첨부해 주세요.</p><PendingFileChips chips={files.chips} onRemove={files.remove} />{definition.attachments.library && <AppLibraryPicker agentId={agent.id} selected={pickedDocs} onChange={setPickedDocs} limit={APP_MAX_FILES - files.chips.filter(chip => chip.stage !== 'failed').length} disabled={running} />}{files.notice && <p role="status" className="text-xs text-amber-800">{files.notice}</p>}</fieldset>}<button disabled={running || files.busy} className="mt-6 w-full rounded-xl bg-ws-accent py-3 text-sm font-semibold text-white disabled:opacity-50">{running ? '작성 중…' : '초안 만들기'}</button>{resumeSource && <div className="mt-4 rounded-xl border border-teal-100 bg-teal-50 p-3"><button type="button" disabled={running || !canResume} onClick={() => void run(undefined, resumeSource.id)} className="text-sm font-semibold text-ws-accent-text disabled:opacity-40">완료된 단계부터 이어서 실행</button><p className="mt-2 text-xs leading-5 text-slate-600">{canResume ? '원래 입력과 앱 설정이 같으면 완료된 단계 결과를 재사용합니다. 새로 실행은 모든 단계를 다시 처리합니다.' : filesAdded ? '파일을 붙이면 근거가 바뀌어 이어서 실행할 수 없습니다. 파일을 빼거나 새로 실행해 주세요.' : '입력이 바뀌었습니다. 원래 입력으로 돌리거나 새로 실행해 주세요.'}</p></div>}<p className="mt-3 text-xs leading-5 text-slate-500">실행하면 기관에 설정된 AI 모델을 사용하며 사용량이 기록됩니다. 다시 실행하면 새 대화로 저장합니다.</p></form>{!draftSavedAt && <AppScheduleForm agentId={agent.id} appVersion={agent.version} definition={definition} values={values} documentIds={pickedDocs} hasUploads={files.chips.some(chip => chip.stage !== 'failed')} disabled={running} />}{!draftSavedAt && <AppWebhookForm agentId={agent.id} appVersion={agent.version} definition={definition} documentIds={pickedDocs} disabled={running} />}</Card><Card><h2 className="mb-4 font-semibold">작성 결과</h2><p role="status" className="mb-4 text-xs text-ws-accent-text">{status}</p><AppStepResults steps={steps} />{numberWarning.length > 0 && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">원자료에서 확인되지 않은 숫자입니다. 사용 전에 확인해 주세요: {numberWarning.join(", ")}</p>}<div className="whitespace-pre-wrap break-words text-sm leading-7">{result || '입력을 마치고 초안 만들기를 누르면 결과가 여기에 표시됩니다.'}</div>{finished && conversation && <AppResultExport conversationId={conversation} content={result} />}{conversation && <Link href={`/chat?conv=${encodeURIComponent(conversation)}`} className="mt-6 inline-block text-sm font-semibold text-ws-accent-text underline">대화에서 근거 확인·추가 요청하기</Link>}</Card></div>}</div>;
}
export default function Page() { return <WorkShell><Suspense fallback={<p role="status">불러오는 중…</p>}><Runner /></Suspense></WorkShell>; }
