'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import WorkShell, { Card, ErrorNote, PageTitle } from '@/components/work/WorkShell';
import AppFields from '@/components/apps/AppFields';
import AppStepEditor, { RequiredWhenEditor, lookupAgentChoices, type LookupAgentChoice } from '@/components/apps/AppStepEditor';
import { api } from '@/lib/work/client';
import { APP_LOOKUP_TOOLS, appLookupConnectors, appUsesDocSearchLookup, upgradeAppConditions, validateAppDefinition, type AppDefinition, type AppField, type AppLookupTool } from '@/lib/apps/definition';
import { lookupCapability } from '@/lib/apps/lookup-capability';
import { readAppDraft, savesAsDraft, type AppDraft } from '@/lib/apps/draft';
import AppDraftPanel, { kstTime } from '@/components/apps/AppDraftPanel';
import AppApprovalPanel from '@/components/apps/AppApprovalPanel';
import type { Agent } from '@/lib/db';
import { loadChatLaunchAgent } from '@/lib/apps/chat-launch';
import { appCopyDraft } from '@/lib/apps/copy';

const input = 'w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm';
const initial: AppDefinition = { schemaVersion: 1, fields: [{ key: 'source', label: '정리할 내용', type: 'textarea', required: true }], output: 'bullets' };
function Builder() {
  const params = useSearchParams();
  const id = params.get('agent');
  const copyId = params.get('copy');
  const [copySource, setCopySource] = useState<string | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [name, setName] = useState(''); const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('제공된 내용을 목적에 맞게 정리하고, 빠진 사실은 확인 필요로 표시하세요.');
  const [definition, setDefinition] = useState<AppDefinition>(initial);
  const [tier, setTier] = useState<'personal' | 'department'>('personal');
  const [category, setCategory] = useState('문서 작성·정리');
  const [preview, setPreview] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(Boolean(id || copyId)); const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [lookupTools, setLookupTools] = useState<AppLookupTool[]>([]);
  // 문서 찾기 단계가 찾을 수 있는 다른 비서(2026-11-09) — 못 불러오면 이 앱 비서의 문서함만 고를 수 있다
  const [lookupAgentRows, setLookupAgentRows] = useState<Agent[]>([]);
  const [draft, setDraft] = useState<AppDraft | null>(null);
  useEffect(() => {
    // 직원이 자기 앱에 켤 수 있는 공공 데이터(기관이 공식 비서에서 쓰는 것) — 못 불러오면 조회를 고를 수 없을 뿐이다
    let active = true;
    void api<Array<{ id: string; allowedForPersonal: boolean }>>('/api/connectors').then(result => {
      if (!active || !result.ok) return;
      const allowed = new Set(result.data.filter(c => c.allowedForPersonal).map(c => c.id));
      // 문서 찾기(커넥터 없음)는 언제나 고를 수 있다 — 이 앱 비서의 문서함을 찾는다
      setLookupTools((Object.keys(APP_LOOKUP_TOOLS) as AppLookupTool[]).filter(tool => { const connector = APP_LOOKUP_TOOLS[tool].connector; return connector === null || allowed.has(connector); }));
    }).catch(() => {});
    void Promise.all([api<Agent[]>('/api/agents'), api<Agent[]>('/api/agents?personal=true')]).then(([shared, personal]) => {
      if (!active) return;
      setLookupAgentRows([...(shared.ok ? shared.data : []), ...(personal.ok ? personal.data : [])]);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  const lookupAgents: LookupAgentChoice[] = lookupAgentChoices(lookupAgentRows as Parameters<typeof lookupAgentChoices>[0], agent?.id ?? null);
  useEffect(() => {
    let active = true;
    setAgent(null); setDraft(null); setCopySource(null); setName(''); setDescription(''); setCategory('문서 작성·정리'); setInstructions('제공된 내용을 목적에 맞게 정리하고, 빠진 사실은 확인 필요로 표시하세요.'); setDefinition(initial); setTier('personal'); setPreview({}); setError(null); setNotice(null); setLoading(Boolean(id || copyId));
    void (async () => {
      if (id && copyId) throw new Error('수정할 앱 또는 복사할 앱 하나만 선택해 주세요.');
      if (copyId) {
        const source = await loadChatLaunchAgent(copyId);
        if (!source) throw new Error('복사할 앱을 사용할 수 없습니다. 앱 목록에서 다시 선택해 주세요.');
        const draft = appCopyDraft(source);
        if (!active) return;
        setName(draft.name); setDescription(draft.description); setCategory(draft.category); setInstructions(draft.instructions); setDefinition(draft.definition); setCopySource(source.name);
      } else if (id) {
        const result = await api<Agent>(`/api/agents/${encodeURIComponent(id)}`);
        if (!active) return;
        if (!result.ok) throw new Error(result.error.message);
        const a = result.data; setAgent(a);
        // 시험 판(0053)이 있으면 그것을 이어 고친다 — 지금 판은 배포 전까지 그대로
        const d = readAppDraft(a.app_draft); setDraft(d);
        fillForm(d ? d.settings : a);
        if (d) setNotice(`배포하지 않은 시험 판(${kstTime(d.saved_at)} 저장)을 불러왔습니다. 부서 사람들은 지금 판(판 ${a.version})을 씁니다.`);
      }
    })().catch(failure => { if (active) setError(failure instanceof Error ? failure.message : '앱을 불러오지 못했습니다.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, copyId]);
  function fillForm(s: { name: string; description?: string | null; category?: string | null; system_prompt?: string | null; app_definition?: AppDefinition | null }) {
    setName(s.name); setDescription(s.description ?? ''); setCategory(s.category || '문서 작성·정리'); setInstructions(s.system_prompt ?? ''); setDefinition(s.app_definition ? upgradeAppConditions(s.app_definition) : initial);
  }
  /** 시험 판 배포 — save_agent로 판을 올린다. 그 사이 누가 배포했거나 시험 판이 바뀌었으면 409 */
  async function publish() {
    if (!agent || !draft || saving) return;
    setSaving(true); setError(null); setNotice(null);
    const result = await api<Agent>(`/api/agents/${agent.id}/app-draft`, { method: 'POST', json: { draft_saved_at: draft.saved_at } });
    if (result.ok) { setAgent(result.data); setDraft(null); fillForm(result.data); setNotice(`배포했습니다. 이제 부서 사람들이 판 ${result.data.version}을 씁니다. 판이 바뀌면 이 앱의 예약 실행이 멈추니, 예약해 둔 사람에게 다시 켜 달라고 알려 주세요.`); }
    else setError(result.error.message);
    setSaving(false);
  }
  /** 시험 판 버리기 — 지금 판으로 되돌려 보인다 */
  async function discard() {
    if (!agent || !draft || saving) return;
    setSaving(true); setError(null); setNotice(null);
    const result = await api<{ app_draft: null }>(`/api/agents/${agent.id}/app-draft?saved_at=${encodeURIComponent(draft.saved_at)}`, { method: 'DELETE' });
    if (result.ok) { setDraft(null); fillForm(agent); setNotice('시험 판을 버렸습니다. 지금 판의 설정을 보여 드립니다.'); }
    else setError(result.error.message);
    setSaving(false);
  }
  function updateField(index: number, patch: Partial<AppField>) { setDefinition(d => ({ ...d, fields: d.fields.map((f, i) => i === index ? { ...f, ...patch } : f) })); setNotice(null); }
  async function save() {
    if (saving || loading || ((id || copyId) && !agent && !copySource)) return;
    const checked = validateAppDefinition(definition);
    if (!name.trim() || !instructions.trim() || instructions.length > 12000) { setError('앱 이름과 업무 지시문(12,000자 이내)을 입력해 주세요.'); return; }
    if (!checked.ok) { setError(checked.message); return; }
    setSaving(true); setError(null); setNotice(null);
    // 시험 판을 고치는 중이면 그 시험 판이 '이전 설정'이다
    const before = draft ? draft.settings : agent;
    const capabilities = { ...(before?.capabilities ?? {}) };
    if (definition.attachments) capabilities.file_read = {};
    else if (before?.app_definition?.attachments) delete capabilities.file_read;
    // 공공 데이터 조회 단계 — 쓰는 커넥터를 앱 능력에 켜고, 조회 단계를 지워 더 안 쓰게 된 것은 끈다(서버가 직원 범위를 다시 본다)
    const enabled = (capabilities.public_data as { connectors?: unknown } | undefined)?.connectors;
    const connectors = lookupCapability(Array.isArray(enabled) ? enabled.filter((id): id is string => typeof id === 'string') : [],appLookupConnectors(before?.app_definition ?? null), appLookupConnectors(checked.value));
    if (connectors.length) capabilities.public_data = { connectors }; else delete capabilities.public_data;
    // 문서 찾기 조회 단계(2026-11-09) — 쓰면 문서 찾기 능력을 켠다(단계를 지워도 끄지 않는다 — 올린 문서로 답하는 데도 쓰는 능력이다)
    if (appUsesDocSearchLookup(checked.value)) capabilities.doc_search = {};
    const settings = { capabilities, name: name.trim(), description: description.trim(), category: category.trim() || '기타', system_prompt: instructions.trim(), app_definition: checked.value };
    if (agent && savesAsDraft(agent.tier)) {
      // 부서·공식 앱은 시험 판으로 — 지금 판(부서 사람들의 실행·예약·연동)은 배포 전까지 그대로
      const saved = await api<{ app_draft: unknown }>(`/api/agents/${agent.id}/app-draft`, { method: 'PUT', json: { ...settings, base_version: agent.version, draft_saved_at: draft?.saved_at ?? null } });
      if (saved.ok) { setDraft(readAppDraft(saved.data.app_draft)); setNotice('시험 판을 저장했습니다. 부서 사람들은 아직 지금 판을 씁니다. 시험 판으로 실행해 본 뒤 배포해 주세요.'); }
      else setError(saved.error.message);
      setSaving(false);
      return;
    }
    const result = agent ? await api<Agent>(`/api/agents/${agent.id}`, { method: 'PATCH', json: { ...settings, base_version: agent.version } }) : await api<Agent>('/api/agents/personal', { method: 'POST', json: { ...settings, icon: '🧩', tier } });
    if (result.ok) { setAgent(result.data); setNotice('저장했습니다. 실행 화면에서 시험 입력으로 결과를 확인해 주세요.'); }
    else setError(result.status === 409 ? '다른 곳에서 설정을 바꿨거나 같은 이름의 앱이 있습니다. 새로 열어 확인해 주세요.' : result.error.message);
    setSaving(false);
  }
  return <div className="mx-auto max-w-6xl px-5 py-9 md:px-9"><PageTitle title={agent ? '앱 설정' : copyId ? '앱 복사해 만들기' : '입력형 앱 만들기'} subtitle="입력할 자료와 응답 형식을 정해 반복 업무를 나만의 앱으로 만드세요." action={<Link href="/apps" className="text-sm text-ws-accent-text">앱 목록으로</Link>} /><ErrorNote message={error} />{copySource && !agent && <p className="my-4 rounded-xl border border-teal-100 bg-teal-50 p-4 text-sm leading-6 text-teal-900">{copySource}의 입력 항목·처리 단계·업무 지시문을 가져왔습니다. 이름과 지시문을 확인하고 저장해 주세요. 문서함·외부 도구·모델 지정·실행 기록은 복사되지 않습니다(공공 데이터 조회 단계는 단계째 가져오며, 저장할 때 내가 쓸 수 있는 조회인지 다시 확인합니다). 필요한 자료는 실행할 때 첨부해 주세요.</p>}{notice && <p role="status" className="my-4 rounded-xl bg-teal-50 p-4 text-sm text-teal-800">{notice}</p>}
    {loading ? <p role="status">앱을 불러오는 중…</p> : <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1.2fr_1fr]"><Card><fieldset disabled={saving || Boolean((id || copyId) && !agent && !copySource)} className="space-y-5 disabled:opacity-60"><legend className="mb-4 font-semibold">1. 앱의 역할</legend><label className="block text-sm">앱 이름<input className={`${input} mt-2`} value={name} maxLength={80} onChange={e => setName(e.target.value)} /></label><label className="block text-sm">설명<input className={`${input} mt-2`} value={description} maxLength={500} onChange={e => setDescription(e.target.value)} /></label><label className="block text-sm">업무 분야<input className={`${input} mt-2`} value={category} maxLength={40} onChange={e => setCategory(e.target.value)} /></label>{!agent && <label className="block text-sm">제공 범위<select className={`${input} mt-2`} value={tier} onChange={e => setTier(e.target.value as typeof tier)}><option value="personal">나만 사용</option><option value="department">우리 부서에서 사용</option></select></label>}<label className="block text-sm">업무 지시문<textarea className={`${input} mt-2`} value={instructions} maxLength={12000} onChange={e => setInstructions(e.target.value)} rows={5} /></label>
    <h2 className="border-t pt-5 font-semibold">2. 입력 항목</h2>{definition.fields.map((field, index) => <div key={field.key} className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="flex items-center justify-between"><span className="text-xs text-slate-500">항목 {index + 1}</span><button type="button" disabled={definition.fields.length === 1} onClick={() => setDefinition(d => ({ ...d, fields: d.fields.filter((_, i) => i !== index) }))} className="text-xs text-red-600 disabled:opacity-40">항목 삭제</button></div><input aria-label={`항목 ${index + 1} 이름`} className={input} value={field.label} maxLength={60} onChange={e => updateField(index, { label: e.target.value })} /><select aria-label={`항목 ${index + 1} 종류`} className={input} value={field.type} onChange={e => updateField(index, { type: e.target.value as AppField['type'], ...(e.target.value === 'select' ? { options: ['선택 1', '선택 2'] } : { options: undefined }) })}><option value="text">짧은 글</option><option value="textarea">긴 글</option><option value="number">숫자</option><option value="date">날짜</option><option value="select">목록에서 선택</option></select>{field.type === 'select' && <label className="block text-xs text-slate-500">선택값 (한 줄에 하나)<textarea className={`${input} mt-2`} value={field.options?.join('\n') ?? ''} onChange={e => updateField(index, { options: e.target.value.split('\n') })} rows={3} /></label>}<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={field.required} onChange={e => updateField(index, { required: e.target.checked, ...(e.target.checked ? { requiredWhen: undefined } : {}) })} />필수 입력</label><RequiredWhenEditor field={field} fields={definition.fields} onChange={when => updateField(index, { requiredWhen: when })} /></div>)}<button type="button" disabled={definition.fields.length >= 8} onClick={() => setDefinition(d => ({ ...d, fields: [...d.fields, { key: `field_${Date.now().toString(36)}`, label: `입력 ${d.fields.length + 1}`, type: 'text', required: false }] }))} className="text-sm text-ws-accent-text disabled:opacity-40">+ 입력 항목 추가 (최대 8개)</button>
    <div className="space-y-3 border-t pt-5"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(definition.attachments)} onChange={e => setDefinition(d => ({ ...d, attachments: e.target.checked ? { required: false } : undefined }))} />파일 첨부 받기</label>{definition.attachments && <><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={definition.attachments.required} onChange={e => setDefinition(d => ({ ...d, attachments: { ...d.attachments, required: e.target.checked } }))} />파일 필수</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(definition.attachments.library)} onChange={e => setDefinition(d => ({ ...d, attachments: { required: d.attachments?.required ?? false, ...(e.target.checked ? { library: true } : {}) } }))} />이 앱에 올린 참고 문서에서 고르기 허용</label><p className="text-xs leading-5 text-slate-500">최대 3개, 파일당 10MB. 추출 자료 합계 20,000자까지는 그대로 넣고, 120,000자까지는 조각으로 나눠 추려 읽습니다(조각마다 AI 사용량이 더 듭니다). 일부만 읽힌 파일은 실행 전에 거절됩니다. 참고 문서 고르기를 허용하면 직원이 이 앱 비서의 읽힌 현재 판 문서를 골라 같은 자리에 넣습니다(파일 필수면 둘 중 하나 이상).</p></>}</div><ExportTemplatePicker agentId={agent?.id ?? null} value={definition.exportTemplateId} onChange={templateId => setDefinition(d => { const { exportTemplateId: _drop, ...rest } = d; void _drop; return templateId ? { ...rest, exportTemplateId: templateId } : rest; })} /><DeliverEndpointPicker value={definition.deliverEndpointId} onChange={endpointId => setDefinition(d => { const { deliverEndpointId: _drop, ...rest } = d; void _drop; return endpointId ? { ...rest, deliverEndpointId: endpointId } : rest; })} />
    <label className="block border-t pt-5 text-sm font-semibold">3. 응답 형식<select className={`${input} mt-2 font-normal`} value={definition.output} onChange={e => setDefinition(d => ({ ...d, output: e.target.value as AppDefinition['output'] }))}><option value="paragraphs">제목과 문단</option><option value="bullets">항목별 목록</option><option value="checklist">체크리스트</option></select></label><AppStepEditor definition={definition} onChange={setDefinition} lookupTools={lookupTools} lookupAgents={lookupAgents} /><button type="button" onClick={() => void save()} className="w-full rounded-xl bg-ws-accent py-3 text-sm font-semibold text-white">{saving ? '저장 중…' : agent && savesAsDraft(agent.tier) ? '시험 판 저장' : '앱 저장'}</button>{agent && <AppDraftPanel tier={agent.tier} version={agent.version} draft={draft} agentId={agent.id} busy={saving} onPublish={() => void publish()} onDiscard={() => void discard()} />}{agent && <AppApprovalPanel agent={agent} hasDraft={Boolean(draft)} onRequested={version => setAgent(a => a ? { ...a, approval_status: 'pending', approval_version: version } : a)} />}{agent && <Link href={`/apps/run?agent=${agent.id}`} className="block text-center text-sm text-ws-accent-text underline">{savesAsDraft(agent.tier) ? `지금 판(판 ${agent.version}) 실행하기` : '저장된 앱 실행하기'}</Link>}</fieldset></Card><Card><h2 className="mb-2 font-semibold">입력 화면 미리보기</h2><p className="mb-6 text-xs leading-5 text-slate-500">입력 모양을 확인하는 공간입니다. AI 요청은 실행 화면에서 시작합니다. 이 앱은 텍스트 초안을 제공합니다.</p><AppFields definition={definition} values={preview} onChange={(key, value) => setPreview(p => ({ ...p, [key]: value }))} /></Card></div>}
  </div>;
}
export default function Page() { return <WorkShell><Suspense fallback={<p role="status">불러오는 중…</p>}><Builder /></Suspense></WorkShell>; }

/**
 * 결과 한글 파일의 기본 양식(2026-11-08) — 이 앱 비서에 올린 한글(HWPX) 양식 가운데 하나. 손으로 내보낼 때 먼저 골라 두고, 예약의 '한글 파일로도 만들기'가 쓴다.
 * 양식은 비서 편집 창의 '양식' 탭에서 올린다(여기서는 고르기만). 쓸 때 서버가 그 앱의 지금 양식인지 다시 보고, 아니면 표준 보고서로 만든다
 */
/** 결과를 보낼 곳(0076) — 기관 전체 관리자가 승인한 곳만(이름만 보임). 고르면 끝까지 마친 실행의 결과 글이 그곳으로 서명돼 간다 */
function DeliverEndpointPicker({ value, onChange }: { value: string | undefined; onChange: (endpointId: string | undefined) => void }) {
  const [endpoints, setEndpoints] = useState<Array<{ id: string; name: string }> | null>(null);
  useEffect(() => {
    let active = true;
    void api<Array<{ id: string; name: string }>>('/api/apps/outbound-endpoints').then(r => { if (active) setEndpoints(r.ok ? r.data : []); }).catch(() => { if (active) setEndpoints([]); });
    return () => { active = false; };
  }, []);
  if (!endpoints?.length && !value) return null;
  const missing = Boolean(value && endpoints && !endpoints.some(e => e.id === value));
  return <div className="space-y-2 border-t pt-5"><label className="block text-sm font-semibold">결과를 보낼 곳<select aria-label="결과를 보낼 곳" value={value ?? ''} onChange={e => onChange(e.target.value || undefined)} className="mt-1 block w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal"><option value="">보내지 않음</option>{(endpoints ?? []).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}{missing && <option value={value}>(회수된 보낼 곳)</option>}</select></label><p className="text-xs leading-5 text-slate-500">기관 관리자가 승인한 외부 시스템으로 이 앱의 <strong>결과 글</strong>을 보냅니다 — 끝까지 마친 실행(예약·연동 실행 포함)만, 시험 판 실행은 빼고, 약 5분 안에. 입력값·중간 단계는 보내지 않습니다.{missing ? ' 고른 곳이 회수돼 보내지 않습니다 — 다른 곳을 고르거나 보내지 않음으로 바꾸세요.' : ''}</p></div>;
}

function ExportTemplatePicker({ agentId, value, onChange }: { agentId: string | null; value: string | undefined; onChange: (templateId: string | undefined) => void }) {
  const [templates, setTemplates] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => {
    if (!agentId) { setTemplates([]); return; }
    let live = true;
    void api<{ items: { id: string; name: string; file_name: string }[] }>(`/api/agents/${encodeURIComponent(agentId)}/templates`).then(r => {
      if (live) setTemplates(r.ok ? r.data.items.filter(t => /\.hwpx$/i.test(t.file_name)).map(t => ({ id: t.id, name: t.name })) : []);
    });
    return () => { live = false; };
  }, [agentId]);
  const missing = Boolean(value && templates && !templates.some(t => t.id === value));
  return <div className="space-y-2 border-t pt-5"><label className="block text-sm font-semibold">결과 한글 파일 양식<select aria-label="결과 한글 파일 양식" value={value ?? ''} onChange={e => onChange(e.target.value || undefined)} className="mt-1 block w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal"><option value="">표준 보고서</option>{(templates ?? []).map(t => <option key={t.id} value={t.id}>기관 양식 · {t.name}</option>)}{missing && <option value={value}>(지금 없는 양식)</option>}</select></label><p className="text-xs leading-5 text-slate-500">결과를 한글 파일로 만들 때 먼저 쓸 양식입니다(직원은 내보낼 때 바꿀 수 있고, 예약의 '한글 파일로도 만들기'는 이 양식을 씁니다). 양식에 {'{{주요 내용}}'}(또는 {'{{본문}}'}) 표시가 있어야 결과가 들어갑니다. {agentId ? '양식은 비서 편집 창의 \'양식\' 탭에서 올립니다.' : '앱을 먼저 저장한 뒤 비서 편집 창의 \'양식\' 탭에서 양식을 올리면 여기서 고를 수 있습니다.'}{missing ? ' 고른 양식이 지금 앱에 없어 표준 보고서로 만듭니다.' : ''}</p></div>;
}
