'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import WorkShell, { Card, ErrorNote, PageTitle } from '@/components/work/WorkShell';
import AppFields from '@/components/apps/AppFields';
import AppStepEditor from '@/components/apps/AppStepEditor';
import { api } from '@/lib/work/client';
import { APP_LOOKUP_TOOLS, appLookupConnectors, upgradeAppConditions, validateAppDefinition, type AppDefinition, type AppField, type AppLookupTool } from '@/lib/apps/definition';
import { lookupCapability } from '@/lib/apps/lookup-capability';
import { readAppDraft, savesAsDraft, type AppDraft } from '@/lib/apps/draft';
import AppDraftPanel, { kstTime } from '@/components/apps/AppDraftPanel';
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
  const [draft, setDraft] = useState<AppDraft | null>(null);
  useEffect(() => {
    // 직원이 자기 앱에 켤 수 있는 공공 데이터(기관이 공식 비서에서 쓰는 것) — 못 불러오면 조회를 고를 수 없을 뿐이다
    let active = true;
    void api<Array<{ id: string; allowedForPersonal: boolean }>>('/api/connectors').then(result => {
      if (!active || !result.ok) return;
      const allowed = new Set(result.data.filter(c => c.allowedForPersonal).map(c => c.id));
      setLookupTools((Object.keys(APP_LOOKUP_TOOLS) as AppLookupTool[]).filter(tool => allowed.has(APP_LOOKUP_TOOLS[tool].connector)));
    }).catch(() => {});
    return () => { active = false; };
  }, []);
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
  return <div className="mx-auto max-w-6xl px-5 py-9 md:px-9"><PageTitle title={agent ? '앱 설정' : copyId ? '앱 복사해 만들기' : '입력형 앱 만들기'} subtitle="입력할 자료와 응답 형식을 정해 반복 업무를 나만의 앱으로 만드세요." action={<Link href="/apps" className="text-sm text-[#087581]">앱 목록으로</Link>} /><ErrorNote message={error} />{copySource && !agent && <p className="my-4 rounded-xl border border-teal-100 bg-teal-50 p-4 text-sm leading-6 text-teal-900">{copySource}의 입력 항목·처리 단계·업무 지시문을 가져왔습니다. 이름과 지시문을 확인하고 저장해 주세요. 문서함·외부 도구·모델 지정·실행 기록은 복사되지 않습니다(공공 데이터 조회 단계는 단계째 가져오며, 저장할 때 내가 쓸 수 있는 조회인지 다시 확인합니다). 필요한 자료는 실행할 때 첨부해 주세요.</p>}{notice && <p role="status" className="my-4 rounded-xl bg-teal-50 p-4 text-sm text-teal-800">{notice}</p>}
    {loading ? <p role="status">앱을 불러오는 중…</p> : <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1.2fr_1fr]"><Card><fieldset disabled={saving || Boolean((id || copyId) && !agent && !copySource)} className="space-y-5 disabled:opacity-60"><legend className="mb-4 font-semibold">1. 앱의 역할</legend><label className="block text-sm">앱 이름<input className={`${input} mt-2`} value={name} maxLength={80} onChange={e => setName(e.target.value)} /></label><label className="block text-sm">설명<input className={`${input} mt-2`} value={description} maxLength={500} onChange={e => setDescription(e.target.value)} /></label><label className="block text-sm">업무 분야<input className={`${input} mt-2`} value={category} maxLength={40} onChange={e => setCategory(e.target.value)} /></label>{!agent && <label className="block text-sm">제공 범위<select className={`${input} mt-2`} value={tier} onChange={e => setTier(e.target.value as typeof tier)}><option value="personal">나만 사용</option><option value="department">우리 부서에서 사용</option></select></label>}<label className="block text-sm">업무 지시문<textarea className={`${input} mt-2`} value={instructions} maxLength={12000} onChange={e => setInstructions(e.target.value)} rows={5} /></label>
    <h2 className="border-t pt-5 font-semibold">2. 입력 항목</h2>{definition.fields.map((field, index) => <div key={field.key} className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="flex items-center justify-between"><span className="text-xs text-slate-500">항목 {index + 1}</span><button type="button" disabled={definition.fields.length === 1} onClick={() => setDefinition(d => ({ ...d, fields: d.fields.filter((_, i) => i !== index) }))} className="text-xs text-red-600 disabled:opacity-40">항목 삭제</button></div><input aria-label={`항목 ${index + 1} 이름`} className={input} value={field.label} maxLength={60} onChange={e => updateField(index, { label: e.target.value })} /><select aria-label={`항목 ${index + 1} 종류`} className={input} value={field.type} onChange={e => updateField(index, { type: e.target.value as AppField['type'], ...(e.target.value === 'select' ? { options: ['선택 1', '선택 2'] } : { options: undefined }) })}><option value="text">짧은 글</option><option value="textarea">긴 글</option><option value="number">숫자</option><option value="date">날짜</option><option value="select">목록에서 선택</option></select>{field.type === 'select' && <label className="block text-xs text-slate-500">선택값 (한 줄에 하나)<textarea className={`${input} mt-2`} value={field.options?.join('\n') ?? ''} onChange={e => updateField(index, { options: e.target.value.split('\n') })} rows={3} /></label>}<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={field.required} onChange={e => updateField(index, { required: e.target.checked })} />필수 입력</label></div>)}<button type="button" disabled={definition.fields.length >= 8} onClick={() => setDefinition(d => ({ ...d, fields: [...d.fields, { key: `field_${Date.now().toString(36)}`, label: `입력 ${d.fields.length + 1}`, type: 'text', required: false }] }))} className="text-sm text-[#087581] disabled:opacity-40">+ 입력 항목 추가 (최대 8개)</button>
    <div className="space-y-3 border-t pt-5"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(definition.attachments)} onChange={e => setDefinition(d => ({ ...d, attachments: e.target.checked ? { required: false } : undefined }))} />파일 첨부 받기</label>{definition.attachments && <><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={definition.attachments.required} onChange={e => setDefinition(d => ({ ...d, attachments: { required: e.target.checked } }))} />파일 필수</label><p className="text-xs leading-5 text-slate-500">최대 3개, 파일당 10MB. 추출 자료 합계 20,000자까지는 그대로 넣고, 120,000자까지는 조각으로 나눠 추려 읽습니다(조각마다 AI 사용량이 더 듭니다). 일부만 읽힌 파일은 실행 전에 거절됩니다.</p></>}</div>
    <label className="block border-t pt-5 text-sm font-semibold">3. 응답 형식<select className={`${input} mt-2 font-normal`} value={definition.output} onChange={e => setDefinition(d => ({ ...d, output: e.target.value as AppDefinition['output'] }))}><option value="paragraphs">제목과 문단</option><option value="bullets">항목별 목록</option><option value="checklist">체크리스트</option></select></label><AppStepEditor definition={definition} onChange={setDefinition} lookupTools={lookupTools} /><button type="button" onClick={() => void save()} className="w-full rounded-xl bg-[#087f8c] py-3 text-sm font-semibold text-white">{saving ? '저장 중…' : agent && savesAsDraft(agent.tier) ? '시험 판 저장' : '앱 저장'}</button>{agent && <AppDraftPanel tier={agent.tier} version={agent.version} draft={draft} agentId={agent.id} busy={saving} onPublish={() => void publish()} onDiscard={() => void discard()} />}{agent && <Link href={`/apps/run?agent=${agent.id}`} className="block text-center text-sm text-[#087581] underline">{savesAsDraft(agent.tier) ? `지금 판(판 ${agent.version}) 실행하기` : '저장된 앱 실행하기'}</Link>}</fieldset></Card><Card><h2 className="mb-2 font-semibold">입력 화면 미리보기</h2><p className="mb-6 text-xs leading-5 text-slate-500">입력 모양을 확인하는 공간입니다. AI 요청은 실행 화면에서 시작합니다. 이 앱은 텍스트 초안을 제공합니다.</p><AppFields definition={definition} values={preview} onChange={(key, value) => setPreview(p => ({ ...p, [key]: value }))} /></Card></div>}
  </div>;
}
export default function Page() { return <WorkShell><Suspense fallback={<p role="status">불러오는 중…</p>}><Builder /></Suspense></WorkShell>; }
