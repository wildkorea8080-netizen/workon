'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  newIdempotencyKey,
  uploadSource,
  executeRun,
  formatBytes,
  formatDateTime,
  TASK_STATUS_LABEL,
  RUN_STATUS_LABEL,
  PREVIEW_STATUS_LABEL,
  SEVERITY_LABEL,
} from '@/lib/work/client';
import { Card, ErrorNote, StatusBadge, statusTone } from './WorkShell';
import FormFields, { cleanForm, type FormState } from './FormFields';
import CollectionView from './CollectionView';
import type { ArtifactDto, FieldDto, RunDto, TaskDetailDto } from './types';

/**
 * 업무 작업실 — 결과 파일·확인 사항·근거·수정이 한 화면에 있다(개편 03 문서 '업무 작업실').
 *
 *  - 'HWPX 만들기'는 초안 파일 생성 요청이다(제출·발송 아님). 같은 클릭이 여러 번 가도 같은 요청 번호로 한 번만 실행된다
 *  - 진행 표시는 서버의 실제 실행 상태다(가짜 진행률 없음). 화면을 닫아도 서버 작업자가 이어 처리한다
 *  - 실제 파일 미리보기와 문서 구조(편집용)는 구분해 보인다. 렌더러가 없으면 없다고 적는다
 *  - 직접 수정은 기준 판과 함께 보낸다 — 다른 화면이 먼저 고쳤으면 덮어쓰지 않고 알린다(409)
 */
type LeftTab = 'outline' | 'files' | 'sources';
type RightTab = 'review' | 'evidence' | 'revise';

const ORIGIN_LABEL: Record<FieldDto['origin'], string> = { empty: '빈 칸', form: '입력값', ai: 'AI 초안', user: '직접 수정', restore: '복구' };

export default function TaskWorkbench({ taskId }: { taskId: string }) {
  const [detail, setDetail] = useState<TaskDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [left, setLeft] = useState<LeftTab>('outline');
  const [right, setRight] = useState<RightTab>('review');
  const [selected, setSelected] = useState<string[]>([]);
  const [run, setRun] = useState<RunDto | null>(null);
  const genKey = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await api<TaskDetailDto>(`/api/work/tasks/${taskId}`);
    if (!r.ok) return setError(r.error.message);
    setDetail(r.data);
    setRun(r.data.run);
  }, [taskId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 실행 중이면 서버 상태를 본다(화면이 꾸민 진행률이 아님)
  useEffect(() => {
    if (!run || !['queued', 'running'].includes(run.status)) return;
    let kicking = false;
    const t = setInterval(async () => {
      const r = await api<RunDto>(`/api/work/tasks/${taskId}/runs/${run.id}`);
      if (!r.ok) return;
      setRun(r.data);
      if (!['queued', 'running'].includes(r.data.status)) void refresh();
      // 아직 아무도 안 잡은 실행(새로고침·끊긴 요청)이면 이 화면이 처리를 건다 — 잡기는 원자적이라 겹쳐도 한 번만 돈다
      if (r.data.status === 'queued' && !kicking) {
        kicking = true;
        void executeRun<RunDto>(taskId, r.data).finally(() => {
          kicking = false;
        });
      }
    }, 2500);
    return () => clearInterval(t);
  }, [run, taskId, refresh]);

  // 저장·적용이 만든 '이 판의 파일 만들기' 실행 — 바로 처리를 건다(끊겨도 작업자가 이어 받음)
  async function startRun(r: RunDto | null) {
    if (!r) return;
    setRun(r);
    const done = await executeRun<RunDto>(taskId, r);
    if (done?.ok) setRun(done.data);
    await refresh();
  }

  async function generate(decisions?: unknown) {
    if (!detail) return;
    setError(null);
    if (!genKey.current) genKey.current = newIdempotencyKey();
    const r = await api<{ run: RunDto; executeUrl: string }>(`/api/work/tasks/${taskId}/runs`, {
      method: 'POST',
      json: { operation: 'generate', baseVersion: detail.version?.version ?? 0, ...(decisions ? { decisions } : {}) },
      idempotencyKey: genKey.current,
    });
    if (!r.ok) {
      genKey.current = null;
      return setError(r.error.message);
    }
    setRun(r.data.run);
    // 바로 처리를 건다 — 이 요청이 끊겨도 실행은 서버에 남아 작업자가 이어 받는다
    const done = await api<RunDto>(r.data.executeUrl, { method: 'POST' });
    genKey.current = null;
    if (done.ok) setRun(done.data);
    await refresh();
  }

  if (!detail) {
    return (
      <div className="p-8">
        <ErrorNote message={error} />
        {!error && <p role="status" className="text-[15px] text-slate-500">작업을 불러오는 중…</p>}
      </div>
    );
  }

  const { task, version } = detail;
  const current = detail.currentArtifacts.find((a) => a.validation_status === 'valid') ?? null;
  const busy = Boolean(run && ['queued', 'running'].includes(run.status));
  const openBlocking = detail.review.filter((i) => i.severity === 'blocking' && i.state === 'open').length;
  const canApprove = task.access.review && version && current && openBlocking === 0 && task.status !== 'completed';

  async function approve() {
    if (!version) return;
    const r = await api(`/api/work/tasks/${taskId}/review`, { method: 'POST', json: { action: 'approve', versionId: version.id } });
    if (!r.ok) return setError(r.error.message);
    setNotice('검토를 마쳤습니다. 이 판의 파일이 최종본입니다(제출·발송은 별도 절차).');
    await refresh();
  }

  return (
    <div className="flex h-full flex-col">
      {/* 위쪽 — 제목·상태·판·내려받기·검토 완료 */}
      <div className="flex flex-wrap items-center gap-3 border-b border-[#DCE3EC] bg-white px-4 py-3 md:px-6">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-slate-500">
            <Link href="/tasks" className="hover:underline">내 작업함</Link> · {task.workflowName}
          </div>
          <h1 className="truncate text-[22px] font-bold">{task.title}</h1>
        </div>
        <StatusBadge label={TASK_STATUS_LABEL[task.status] ?? task.status} tone={statusTone(task.status)} />
        {version && <span className="text-[14px] text-slate-600">{version.version}판</span>}
        {detail.generatorMode === 'mock' && <StatusBadge label="시험 모드(AI 미사용)" tone="bad" />}
        {current && task.access.download && (
          <a href={`/api/work/artifacts/${current.id}/download`} className="rounded-[10px] border border-[#003087] px-4 py-2 text-[14px] font-semibold text-[#003087] hover:bg-blue-50">
            {current.format.toUpperCase()} 내려받기
          </a>
        )}
        {task.access.review && version && (
          <button
            onClick={approve}
            disabled={!canApprove}
            title={!canApprove ? (openBlocking ? `반드시 고칠 사항 ${openBlocking}건` : !current ? '이 판의 파일이 아직 없음' : '') : undefined}
            className="rounded-[10px] bg-[#003087] px-4 py-2 text-[14px] font-semibold text-white disabled:bg-slate-300"
          >
            검토 완료
          </button>
        )}
        <Link href={`/tasks/${taskId}/history`} className="text-[14px] text-[#003087] hover:underline">
          변경 기록
        </Link>
      </div>

      <div className="px-4 pt-3 md:px-6 space-y-2">
        <ErrorNote message={error} />
        {notice && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-[14px] text-emerald-900">{notice}</p>}
        {run && (
          <RunBanner run={run} onCancel={async () => {
            const r = await api(`/api/work/tasks/${taskId}/runs/${run.id}/cancel`, { method: 'POST' });
            if (!r.ok) setError(r.error.message);
            await refresh();
          }} canCancel={task.access.edit} />
        )}
      </div>

      <div className="grid flex-1 gap-4 overflow-y-auto p-4 md:p-6 lg:grid-cols-[220px_1fr_360px]">
        {/* 왼쪽 — 목차·파일·원자료 */}
        <aside className="order-2 lg:order-1">
          <Tabs<LeftTab> value={left} onChange={setLeft} items={[['outline', '목차'], ['files', '파일'], ['sources', '원자료']]} label="작업 항목" />
          <Card className="mt-2 p-3">
            {left === 'outline' && (version ? (
              <ol className="space-y-1 text-[14px]">
                {version.fields.map((f) => (
                  <li key={f.id}>
                    <a href={`#field-${f.id}`} className="block rounded px-2 py-1 hover:bg-slate-100">
                      {f.label}
                      {f.required && !f.value.trim() && <span className="ml-1 text-[12px] text-red-700">(비어 있음)</span>}
                    </a>
                  </li>
                ))}
              </ol>
            ) : <p className="text-[14px] text-slate-500">파일을 만들면 문서 목차가 보입니다.</p>)}
            {left === 'files' && <ArtifactList artifacts={detail.artifacts} canDownload={task.access.download} />}
            {left === 'sources' && <SourceList detail={detail} taskId={taskId} onChanged={refresh} />}
          </Card>
        </aside>

        {/* 가운데 — 입력(만들기 전) 또는 결과 파일·문서 구조 */}
        <section className="order-1 lg:order-2 space-y-4 min-w-0">
          {!version ? (
            <BeforeGenerate detail={detail} taskId={taskId} busy={busy} onGenerate={() => generate()} onSaved={refresh} setError={setError} />
          ) : detail.kind === 'collection' && version.collection ? (
            <>
              <PreviewCard artifact={current} canDownload={task.access.download} />
              <CollectionView key={version.id} result={version.collection} canEdit={task.access.edit} busy={busy} onRecompute={(d) => generate(d)} />
            </>
          ) : (
            <>
              <PreviewCard artifact={current} canDownload={task.access.download} />
              <FieldEditor
                key={version.id}
                detail={detail}
                taskId={taskId}
                selected={selected}
                onSelect={setSelected}
                onSaved={async (msg) => {
                  setNotice(msg);
                  await refresh();
                }}
                setError={setError}
                onRun={(r) => void startRun(r)}
              />
              {task.access.edit && (
                <Card>
                  <h2 className="text-[16px] font-semibold">다시 만들기</h2>
                  <p className="mt-1 text-[14px] text-slate-600">입력·원자료로 초안을 다시 만듭니다. 직접 고친 칸과 잠근 칸은 그대로 둡니다.</p>
                  <button onClick={() => generate()} disabled={busy} className="mt-3 rounded-[10px] border border-[#003087] px-4 py-2 text-[14px] font-semibold text-[#003087] disabled:opacity-50">
                    초안 다시 만들기
                  </button>
                </Card>
              )}
            </>
          )}
        </section>

        {/* 오른쪽 — 확인할 사항·근거·수정 */}
        <aside className="order-3">
          <Tabs<RightTab> value={right} onChange={setRight} items={[['review', `확인할 사항${detail.review.filter((i) => i.state === 'open').length ? ` ${detail.review.filter((i) => i.state === 'open').length}` : ''}`], ['evidence', '근거'], ['revise', '수정']]} label="검토 도구" />
          <Card className="mt-2">
            {right === 'review' && <ReviewPanel detail={detail} taskId={taskId} onChanged={refresh} setError={setError} />}
            {right === 'evidence' && <EvidencePanel detail={detail} selected={selected} />}
            {right === 'revise' && (
              <RevisePanel detail={detail} taskId={taskId} selected={selected} onApplied={async (msg) => { setNotice(msg); await refresh(); }} onRun={(r) => void startRun(r)} setError={setError} />
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}

function Tabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: [T, string][]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 rounded-[10px] bg-slate-100 p-1">
      {items.map(([k, l]) => (
        <button key={k} role="tab" aria-selected={value === k} onClick={() => onChange(k)} className={`flex-1 rounded-lg px-2 py-1.5 text-[14px] ${value === k ? 'bg-white font-semibold shadow-sm' : 'text-slate-600'}`}>
          {l}
        </button>
      ))}
    </div>
  );
}

function RunBanner({ run, onCancel, canCancel }: { run: RunDto; onCancel: () => void; canCancel: boolean }) {
  const active = ['queued', 'running'].includes(run.status);
  if (!active && run.status !== 'failed') return null;
  const opLabel = run.operation === 'generate' ? '초안 파일 만들기' : run.operation === 'package' ? '수정한 판의 파일 만들기' : run.operation === 'revise' ? 'AI 수정 후보 만들기' : run.operation;
  return (
    <div role="status" aria-live="polite" className={`flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-[14px] ${active ? 'border-blue-200 bg-blue-50 text-blue-900' : 'border-red-200 bg-red-50 text-red-900'}`}>
      <span className="font-semibold">{opLabel}: {RUN_STATUS_LABEL[run.status]}</span>
      {run.attempt > 1 && <span>(시도 {run.attempt}/{run.maxAttempts})</span>}
      {run.error && <span>— {run.error.message}{run.error.retryable && run.status === 'failed' ? ' 다시 시도할 수 있습니다.' : ''}</span>}
      {active && <span className="text-blue-800">화면을 닫아도 서버에서 이어 처리합니다.</span>}
      {active && canCancel && !run.cancelRequested && (
        <button onClick={onCancel} className="ml-auto rounded border border-blue-300 bg-white px-2 py-1 text-[13px]">취소</button>
      )}
      {run.cancelRequested && active && <span>취소 요청 접수됨 — 지금 단계가 끝나면 멈춥니다.</span>}
    </div>
  );
}

function BeforeGenerate({ detail, taskId, busy, onGenerate, onSaved, setError }: { detail: TaskDetailDto; taskId: string; busy: boolean; onGenerate: () => void; onSaved: () => Promise<void>; setError: (m: string | null) => void }) {
  const { task, workflow } = detail;
  const [form, setForm] = useState<FormState>(task.form);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(cleanForm(workflow.inputs, form)) !== JSON.stringify(cleanForm(workflow.inputs, task.form));
  const missing = workflow.inputs.filter((i) => i.required && !['file-set', 'template'].includes(i.type) && cleanForm(workflow.inputs, task.form)[i.key] === undefined).map((i) => i.key);

  async function save() {
    setSaving(true);
    const r = await api(`/api/work/tasks/${taskId}`, { method: 'PATCH', json: { revision: task.revision, form: { ...cleanForm(workflow.inputs, form), title: task.form.title } } });
    setSaving(false);
    if (!r.ok) return setError(r.error.message);
    setError(null);
    await onSaved();
  }

  return (
    <>
      <Card>
        <h2 className="mb-1 text-[18px] font-semibold">입력 정보</h2>
        {detail.template && <p className="mb-4 text-[14px] text-slate-500">양식: {detail.template.name} — {detail.template.label}</p>}
        <FormFields inputs={workflow.inputs} value={form} onChange={setForm} disabled={!task.access.edit || busy} missing={missing} />
        {task.access.edit && (
          <button onClick={save} disabled={!dirty || saving} className="mt-4 rounded-[10px] border border-[#DCE3EC] px-4 py-2 text-[14px] disabled:opacity-50">
            {saving ? '저장 중…' : dirty ? '입력 저장' : '저장됨'}
          </button>
        )}
      </Card>
      <Card>
        <h2 className="text-[18px] font-semibold">파일 만들기</h2>
        <p className="mt-1 text-[14px] text-slate-600">
          {detail.kind === 'collection'
            ? '올린 원자료의 표를 부서·항목별로 더해 통합 엑셀(XLSX)을 만듭니다. 숫자는 프로그램이 계산하고, 중복·미제출·단위 차이는 확인할 사항으로 알립니다.'
            : '입력과 원자료로 양식의 칸을 채운 한글(HWPX) 초안을 만듭니다. 모르는 사실(발신 명의·기한·금액 등)은 지어내지 않고 비워 둔 뒤 확인할 사항으로 알립니다.'}
        </p>
        {detail.kind === 'collection' && <p className="mt-1 text-[13px] text-slate-500">원자료는 왼쪽 &lsquo;원자료&rsquo; 탭에서 올립니다(부서별 파일 — 파일 이름에 부서명이 있으면 부서를 알아봅니다).</p>}
        <button
          onClick={onGenerate}
          disabled={!task.access.edit || busy || dirty || task.status === 'draft'}
          className="mt-4 rounded-[10px] bg-[#003087] px-5 py-3 text-[15px] font-semibold text-white disabled:bg-slate-300"
        >
          {busy ? '만드는 중…' : detail.kind === 'collection' ? '취합 엑셀 만들기' : 'HWPX 만들기'}
        </button>
        {task.status === 'draft' && <p className="mt-2 text-[13px] text-red-700">필수 입력을 먼저 채워 저장해 주세요.</p>}
        {dirty && <p className="mt-2 text-[13px] text-amber-800">바꾼 입력을 먼저 저장해 주세요.</p>}
      </Card>
    </>
  );
}

function PreviewCard({ artifact, canDownload }: { artifact: ArtifactDto | null; canDownload: boolean }) {
  return (
    <Card>
      <h2 className="text-[16px] font-semibold">실제 파일 미리보기</h2>
      {!artifact ? (
        <p className="mt-2 text-[14px] text-slate-600" role="status">이 판의 파일을 만드는 중입니다.</p>
      ) : (
        <div className="mt-2 text-[14px] text-slate-700">
          <p>
            {PREVIEW_STATUS_LABEL[artifact.preview_status]}
            {artifact.preview.pageCount ? ` · ${artifact.preview.pageCount}쪽` : ''}
            {artifact.preview.renderer ? ` · ${artifact.preview.renderer.name}` : ''}
          </p>
          {artifact.preview_status === 'unsupported' && (
            <p className="mt-1 text-slate-600">아래 &lsquo;문서 구조&rsquo;는 편집용 보기이며 실제 쪽 배치와 다를 수 있습니다. 쪽 배치는 파일을 내려받아 한글에서 확인하세요.</p>
          )}
          <p className="mt-1 text-[13px] text-slate-500">
            {artifact.file_name} · {formatBytes(artifact.size_bytes)} · 구조 검사 {artifact.validation_status === 'valid' ? '통과' : '실패'} · 해시 {artifact.sha256.slice(0, 12)}
          </p>
          {canDownload && artifact.validation_status === 'valid' && (
            <a href={`/api/work/artifacts/${artifact.id}/download`} className="mt-2 inline-block text-[#003087] underline">
              이 판의 HWPX 내려받기
            </a>
          )}
        </div>
      )}
    </Card>
  );
}

function FieldEditor({ detail, taskId, selected, onSelect, onSaved, setError, onRun }: {
  detail: TaskDetailDto;
  taskId: string;
  selected: string[];
  onSelect: (ids: string[]) => void;
  onSaved: (msg: string) => Promise<void>;
  setError: (m: string | null) => void;
  onRun: (r: RunDto) => void;
}) {
  const version = detail.version!;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const canEdit = detail.task.access.edit;
  const dirtyIds = Object.keys(drafts).filter((id) => drafts[id] !== version.fields.find((f) => f.id === id)?.value);
  const reviewByField = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of detail.review.filter((x) => x.state === 'open')) for (const id of r.fieldIds) m.set(id, [...(m.get(id) ?? []), r.message]);
    return m;
  }, [detail.review]);

  async function send(patches: unknown[]) {
    setSaving(true);
    const r = await api<{ version: { version: number } | null; run: RunDto | null; unchanged: boolean }>(`/api/work/tasks/${taskId}/document`, {
      method: 'PATCH',
      json: { baseVersion: version.version, patches },
    });
    setSaving(false);
    if (!r.ok) {
      if (r.error.code === 'VERSION_CONFLICT') setConflict(true);
      return setError(r.error.message);
    }
    setError(null);
    setDrafts({});
    if (r.data.run) onRun(r.data.run);
    await onSaved(r.data.version ? `${r.data.version.version}판으로 저장했습니다. 이 판의 파일을 만들고 있습니다.` : '바뀐 내용이 없습니다.');
  }

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-[16px] font-semibold">문서 구조(편집용)</h2>
          <p className="text-[13px] text-slate-500">칸을 고쳐 저장하면 새 판과 새 파일이 생깁니다. 잠근 칸은 AI가 바꾸지 않습니다.</p>
        </div>
        {canEdit && (
          <button onClick={() => send(dirtyIds.map((id) => ({ fieldId: id, operation: 'set_value', value: drafts[id] })))} disabled={!dirtyIds.length || saving} className="rounded-[10px] bg-[#003087] px-4 py-2 text-[14px] font-semibold text-white disabled:bg-slate-300">
            {saving ? '저장 중…' : dirtyIds.length ? `변경 저장(${dirtyIds.length})` : '저장됨'}
          </button>
        )}
      </div>
      {conflict && (
        <p role="alert" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[14px] text-amber-900">
          다른 화면에서 문서가 먼저 바뀌었습니다. 고친 내용을 따로 적어 둔 뒤 <button className="underline" onClick={() => window.location.reload()}>최신 판 불러오기</button>.
        </p>
      )}
      <div className="space-y-4">
        {version.fields.map((f) => {
          const value = drafts[f.id] ?? f.value;
          const issues = reviewByField.get(f.id);
          return (
            <div key={f.id} id={`field-${f.id}`} className={`rounded-[10px] border p-3 ${issues ? 'border-amber-300 bg-amber-50/40' : 'border-[#DCE3EC]'}`}>
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <label htmlFor={`f-${f.id}`} className="text-[15px] font-medium">{f.label}</label>
                {f.required && <span className="text-[12px] text-red-700">필수</span>}
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[12px] text-slate-600">{ORIGIN_LABEL[f.origin]}</span>
                {f.locked && <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[12px] text-white">잠김</span>}
                <span className="ml-auto flex items-center gap-3 text-[13px]">
                  <label className="flex items-center gap-1">
                    <input type="checkbox" checked={selected.includes(f.id)} onChange={(e) => onSelect(e.target.checked ? [...selected, f.id] : selected.filter((x) => x !== f.id))} />
                    AI 수정 대상
                  </label>
                  {canEdit && (
                    <button onClick={() => send([{ fieldId: f.id, operation: 'set_lock', value: !f.locked }])} disabled={saving || dirtyIds.length > 0} className="underline disabled:opacity-50">
                      {f.locked ? '잠금 풀기' : '잠그기'}
                    </button>
                  )}
                </span>
              </div>
              {f.type === 'paragraph' ? (
                <textarea id={`f-${f.id}`} value={value} disabled={!canEdit} rows={Math.min(14, Math.max(3, value.split('\n').length + 1))} onChange={(e) => setDrafts({ ...drafts, [f.id]: e.target.value })} className="w-full rounded-lg border border-[#DCE3EC] px-3 py-2 text-[15px] leading-relaxed focus:border-[#003087] focus:outline-none disabled:bg-slate-50" />
              ) : (
                <input id={`f-${f.id}`} value={value} disabled={!canEdit} onChange={(e) => setDrafts({ ...drafts, [f.id]: e.target.value })} className="w-full rounded-lg border border-[#DCE3EC] px-3 py-2 text-[15px] focus:border-[#003087] focus:outline-none disabled:bg-slate-50" />
              )}
              {issues && <ul className="mt-1 list-disc pl-5 text-[13px] text-amber-900">{issues.map((m, i) => <li key={i}>{m}</li>)}</ul>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ReviewPanel({ detail, taskId, onChanged, setError }: { detail: TaskDetailDto; taskId: string; onChanged: () => Promise<void>; setError: (m: string | null) => void }) {
  const items = [...detail.review].sort((a, b) => Number(a.state !== 'open') - Number(b.state !== 'open'));
  const canAct = detail.task.access.edit || detail.task.access.review;
  async function act(itemId: string, action: 'resolve' | 'acknowledge') {
    const r = await api(`/api/work/tasks/${taskId}/review`, { method: 'POST', json: { action, itemId } });
    if (!r.ok) return setError(r.error.message);
    setError(null);
    await onChanged();
  }
  if (!detail.version) return <p className="text-[14px] text-slate-500">파일을 만들면 확인할 사항이 여기 보입니다.</p>;
  if (!items.length)
    return (
      <p className="text-[14px] text-slate-600">
        확인할 사항이 없습니다. 검사 범위: 필수 칸 · AI가 비워 둔 정보 · 입력·원자료에 없는 숫자 · 남은 자리 표시. 사실이 모두 맞다는 확인은 아닙니다.
      </p>
    );
  return (
    <ul className="space-y-3">
      {items.map((i) => (
        <li key={i.id} className={`rounded-lg border p-3 text-[14px] ${i.state === 'open' ? (i.severity === 'blocking' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50') : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
          <div className="mb-1 text-[12px] font-semibold">
            {SEVERITY_LABEL[i.severity]} {i.state !== 'open' && `· ${i.state === 'resolved' ? '고침' : '확인함'}`}
          </div>
          <p>{i.message}</p>
          {i.fieldIds[0] && <a href={`#field-${i.fieldIds[0]}`} className="text-[13px] text-[#003087] underline">해당 칸으로</a>}
          {i.state === 'open' && canAct && (
            <div className="mt-2 flex gap-2">
              <button onClick={() => act(i.id, 'resolve')} className="rounded border border-slate-300 bg-white px-2 py-1 text-[13px]">고쳤음</button>
              {i.severity !== 'blocking' && <button onClick={() => act(i.id, 'acknowledge')} className="rounded border border-slate-300 bg-white px-2 py-1 text-[13px]">확인함(그대로 둠)</button>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function EvidencePanel({ detail, selected }: { detail: TaskDetailDto; selected: string[] }) {
  const fields = detail.version?.fields.filter((f) => selected.includes(f.id)) ?? [];
  const sourceName = (id: string) => detail.sources.find((s) => s.id === id)?.file_name ?? '(지운 원자료)';
  return (
    <div className="space-y-3 text-[14px]">
      <p className="text-slate-600">AI가 근거로 적은 원자료입니다. 실제로 쓴 것만 남기며 쪽·칸 위치는 아는 경우에만 보입니다.</p>
      {fields.length === 0 && <p className="text-slate-500">가운데에서 &lsquo;AI 수정 대상&rsquo;으로 칸을 고르면 그 칸의 근거가 보입니다.</p>}
      {fields.map((f) => (
        <div key={f.id}>
          <div className="font-medium">{f.label}</div>
          {f.evidenceIds.length ? <ul className="list-disc pl-5">{f.evidenceIds.map((e) => <li key={e}>{sourceName(e)}</li>)}</ul> : <p className="text-slate-500">근거로 적힌 원자료 없음({f.origin === 'form' ? '직원 입력값' : f.origin === 'user' ? '직접 수정' : '입력에서 작성'})</p>}
        </div>
      ))}
    </div>
  );
}

const QUICK = ['핵심만 3줄로', '공문체로 다듬기', '더 간결하게', '항목을 개조식으로'];

function RevisePanel({ detail, taskId, selected, onApplied, onRun, setError }: { detail: TaskDetailDto; taskId: string; selected: string[]; onApplied: (m: string) => Promise<void>; onRun: (r: RunDto) => void; setError: (m: string | null) => void }) {
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<{ id: string; status: string; changes: { fieldId: string; before: string; after: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);
  const version = detail.version;
  if (detail.kind === 'collection') return <p className="text-[14px] text-slate-600">취합 숫자는 원자료에서 프로그램이 계산합니다. 고치려면 가운데에서 결정(중복·단위·잠정)을 바꿔 다시 취합하거나 원자료를 고쳐 다시 올리세요.</p>;
  if (!version) return <p className="text-[14px] text-slate-500">파일을 만든 뒤 고칠 수 있습니다.</p>;
  if (!detail.task.access.edit) return <p className="text-[14px] text-slate-500">이 작업을 고칠 권한이 없습니다.</p>;
  const label = (id: string) => version.fields.find((f) => f.id === id)?.label ?? id;

  async function request() {
    setBusy(true);
    setProposal(null);
    if (!keyRef.current) keyRef.current = newIdempotencyKey();
    const r = await api<{ proposalId: string; executeUrl: string }>(`/api/work/tasks/${taskId}/revision-proposals`, {
      method: 'POST',
      json: { baseVersion: version!.version, fieldIds: selected, instruction },
      idempotencyKey: keyRef.current,
    });
    keyRef.current = null;
    if (!r.ok) {
      setBusy(false);
      return setError(r.error.message);
    }
    await api(r.data.executeUrl, { method: 'POST' });
    // 작업자가 처리한 결과를 본다(화면을 닫아도 후보는 서버에 남는다)
    for (let i = 0; i < 60; i++) {
      const p = await api<{ id: string; status: string; changes: { fieldId: string; before: string; after: string }[] }>(`/api/work/tasks/${taskId}/revision-proposals/${r.data.proposalId}`);
      if (p.ok && p.data.status !== 'pending') {
        setProposal(p.data);
        break;
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
    setBusy(false);
  }

  async function apply() {
    if (!proposal) return;
    const r = await api<{ version: { version: number }; run: RunDto | null }>(`/api/work/tasks/${taskId}/revision-proposals/${proposal.id}/apply`, { method: 'POST', json: { baseVersion: version!.version } });
    if (!r.ok) return setError(r.error.message);
    setProposal(null);
    setInstruction('');
    if (r.data.run) onRun(r.data.run);
    await onApplied(`AI 수정을 적용해 ${r.data.version.version}판을 만들었습니다.`);
  }

  return (
    <div className="space-y-3 text-[14px]">
      <p className="text-slate-600">고를 칸: {selected.length ? selected.map(label).join(', ') : '가운데에서 ‘AI 수정 대상’을 고르세요(문서 전체를 바꾸려면 모든 칸을 고릅니다)'}</p>
      <label htmlFor="rev-inst" className="font-medium">어떻게 고칠까요?</label>
      <textarea id="rev-inst" rows={3} value={instruction} onChange={(e) => setInstruction(e.target.value)} className="w-full rounded-lg border border-[#DCE3EC] px-3 py-2" />
      <div className="flex flex-wrap gap-1">
        {QUICK.map((q) => (
          <button key={q} onClick={() => setInstruction(q)} className="rounded-full border border-[#DCE3EC] px-2 py-0.5 text-[13px] hover:border-[#003087]">{q}</button>
        ))}
      </div>
      <button onClick={request} disabled={busy || !selected.length || !instruction.trim()} className="w-full rounded-[10px] bg-[#003087] px-4 py-2 font-semibold text-white disabled:bg-slate-300">
        {busy ? '후보 만드는 중…' : '수정 후보 보기'}
      </button>
      {proposal && proposal.status !== 'ready' && <p role="alert" className="text-red-700">후보를 만들지 못했습니다({proposal.status === 'stale' ? '그 사이 문서가 바뀜' : '실패'}). 다시 요청해 주세요.</p>}
      {proposal?.status === 'ready' && (
        <div className="space-y-3">
          {proposal.changes.length === 0 && <p>바뀔 내용이 없습니다.</p>}
          {proposal.changes.map((c) => (
            <div key={c.fieldId} className="rounded-lg border border-[#DCE3EC] p-2">
              <div className="font-medium">{label(c.fieldId)}</div>
              <div className="mt-1 whitespace-pre-wrap rounded bg-red-50 p-2 text-[13px] text-red-900 line-through decoration-red-300">{c.before || '(빈 칸)'}</div>
              <div className="mt-1 whitespace-pre-wrap rounded bg-emerald-50 p-2 text-[13px] text-emerald-900">{c.after}</div>
            </div>
          ))}
          {proposal.changes.length > 0 && (
            <div className="flex gap-2">
              <button onClick={apply} className="flex-1 rounded-[10px] bg-[#003087] px-3 py-2 font-semibold text-white">적용(새 판·새 파일)</button>
              <button onClick={() => setProposal(null)} className="rounded-[10px] border border-[#DCE3EC] px-3 py-2">버리기</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ArtifactList({ artifacts, canDownload }: { artifacts: ArtifactDto[]; canDownload: boolean }) {
  if (!artifacts.length) return <p className="text-[14px] text-slate-500">아직 만든 파일이 없습니다.</p>;
  return (
    <ul className="space-y-2 text-[14px]">
      {artifacts.map((a) => (
        <li key={a.id} className="rounded border border-[#DCE3EC] p-2">
          <div className="font-medium break-all">{a.file_name}</div>
          <div className="text-[12px] text-slate-500">
            {a.current ? '최신 판' : '지난 판'} · {formatDateTime(a.created_at)}
          </div>
          {canDownload && a.validation_status === 'valid' && <a href={`/api/work/artifacts/${a.id}/download`} className="text-[13px] text-[#003087] underline">내려받기</a>}
        </li>
      ))}
    </ul>
  );
}

function SourceList({ detail, taskId, onChanged }: { detail: TaskDetailDto; taskId: string; onChanged: () => Promise<void> }) {
  const [stage, setStage] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  async function onFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      setErr(null);
      const r = await uploadSource(taskId, file, 'reference', (s) => setStage(`${file.name}: ${s === 'uploading' ? '올리는 중' : '읽는 중'}`));
      if (!r.ok) setErr(`${file.name}: ${r.message}`);
    }
    setStage(null);
    if (inputRef.current) inputRef.current.value = '';
    await onChanged();
  }
  return (
    <div className="space-y-2 text-[14px]">
      {detail.sources.length === 0 && <p className="text-slate-500">올린 원자료가 없습니다.</p>}
      <ul className="space-y-2">
        {detail.sources.map((s) => (
          <li key={s.id} className="rounded border border-[#DCE3EC] p-2">
            <div className="break-all font-medium">{s.file_name}</div>
            <div className="text-[12px] text-slate-500">
              {s.status === 'ready' ? '읽음' : s.status === 'pending' ? '확인 전' : `읽지 못함 — ${s.failure_reason ?? ''}`} · {formatBytes(s.size_bytes)}
              {(s.summary as { truncated?: boolean } | null)?.truncated ? ' · 길어서 앞부분만 읽음' : ''}
            </div>
          </li>
        ))}
      </ul>
      {detail.task.access.edit && (
        <>
          <input ref={inputRef} id="src-file" type="file" multiple className="sr-only" accept=".xlsx,.xlsm,.csv,.hwpx,.hwp,.docx,.pdf,.pptx,.txt" onChange={(e) => onFiles(e.target.files)} />
          <label htmlFor="src-file" className="inline-block cursor-pointer rounded-[10px] border border-[#DCE3EC] px-3 py-1.5 hover:border-[#003087]">파일 선택</label>
          <p className="text-[12px] text-slate-500">엑셀·CSV·한글·워드·PDF·파워포인트·TXT, 10MB까지. 자료는 그대로 읽어 근거로만 씁니다.</p>
        </>
      )}
      {stage && <p role="status">{stage}</p>}
      {err && <p role="alert" className="text-red-700">{err}</p>}
    </div>
  );
}
