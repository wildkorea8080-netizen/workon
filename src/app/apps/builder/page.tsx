'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import WorkShell, { Card, ErrorNote, PageTitle } from '@/components/work/WorkShell';
import AppFields from '@/components/apps/AppFields';
import AppStepEditor from '@/components/apps/AppStepEditor';
import { api } from '@/lib/work/client';
import { upgradeAppConditions, validateAppDefinition, type AppDefinition, type AppField } from '@/lib/apps/definition';
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
  useEffect(() => {
    let active = true;
    setAgent(null); setCopySource(null); setName(''); setDescription(''); setCategory('문서 작성·정리'); setInstructions('제공된 내용을 목적에 맞게 정리하고, 빠진 사실은 확인 필요로 표시하세요.'); setDefinition(initial); setTier('personal'); setPreview({}); setError(null); setNotice(null); setLoading(Boolean(id || copyId));
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
        const a = result.data; setAgent(a); setName(a.name); setDescription(a.description ?? ''); setCategory(a.category || '문서 작성·정리'); setInstructions(a.system_prompt ?? ''); setDefinition(a.app_definition ? upgradeAppConditions(a.app_definition) : initial);
      }
    })().catch(failure => { if (active) setError(failure instanceof Error ? failure.message : '앱을 불러오지 못했습니다.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, copyId]);
  function updateField(index: number, patch: Partial<AppField>) { setDefinition(d => ({ ...d, fields: d.fields.map((f, i) => i === index ? { ...f, ...patch } : f) })); setNotice(null); }
  async function save() {
    if (saving || loading || ((id || copyId) && !agent && !copySource)) return;
    const checked = validateAppDefinition(definition);
    if (!name.trim() || !instructions.trim() || instructions.length > 12000) { setError('앱 이름과 업무 지시문(12,000자 이내)을 입력해 주세요.'); return; }
    if (!checked.ok) { setError(checked.message); return; }
    setSaving(true); setError(null); setNotice(null);
    const capabilities = { ...(agent?.capabilities ?? {}) };
    if (definition.attachments) capabilities.file_read = {};
    else if (agent?.app_definition?.attachments) delete capabilities.file_read;
    const settings = { capabilities, name: name.trim(), description: description.trim(), category: category.trim() || '기타', system_prompt: instructions.trim(), app_definition: checked.value };
    const result = agent ? await api<Agent>(`/api/agents/${agent.id}`, { method: 'PATCH', json: { ...settings, base_version: agent.version } }) : await api<Agent>('/api/agents/personal', { method: 'POST', json: { ...settings, icon: '🧩', tier } });
    if (result.ok) { setAgent(result.data); setNotice('저장했습니다. 실행 화면에서 시험 입력으로 결과를 확인해 주세요.'); }
    else setError(result.status === 409 ? '다른 곳에서 설정을 바꿨거나 같은 이름의 앱이 있습니다. 새로 열어 확인해 주세요.' : result.error.message);
    setSaving(false);
  }
  return <div className="mx-auto max-w-6xl px-5 py-9 md:px-9"><PageTitle title={agent ? '앱 설정' : copyId ? '앱 복사해 만들기' : '입력형 앱 만들기'} subtitle="입력할 자료와 응답 형식을 정해 반복 업무를 나만의 앱으로 만드세요." action={<Link href="/apps" className="text-sm text-[#087581]">앱 목록으로</Link>} /><ErrorNote message={error} />{copySource && !agent && <p className="my-4 rounded-xl border border-teal-100 bg-teal-50 p-4 text-sm leading-6 text-teal-900">{copySource}의 입력 항목·처리 단계·업무 지시문을 가져왔습니다. 이름과 지시문을 확인하고 저장해 주세요. 문서함·외부 도구·모델 지정·실행 기록은 복사되지 않습니다. 필요한 자료는 실행할 때 첨부해 주세요.</p>}{notice && <p role="status" className="my-4 rounded-xl bg-teal-50 p-4 text-sm text-teal-800">{notice}</p>}
    {loading ? <p role="status">앱을 불러오는 중…</p> : <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1.2fr_1fr]"><Card><fieldset disabled={saving || Boolean((id || copyId) && !agent && !copySource)} className="space-y-5 disabled:opacity-60"><legend className="mb-4 font-semibold">1. 앱의 역할</legend><label className="block text-sm">앱 이름<input className={`${input} mt-2`} value={name} maxLength={80} onChange={e => setName(e.target.value)} /></label><label className="block text-sm">설명<input className={`${input} mt-2`} value={description} maxLength={500} onChange={e => setDescription(e.target.value)} /></label><label className="block text-sm">업무 분야<input className={`${input} mt-2`} value={category} maxLength={40} onChange={e => setCategory(e.target.value)} /></label>{!agent && <label className="block text-sm">제공 범위<select className={`${input} mt-2`} value={tier} onChange={e => setTier(e.target.value as typeof tier)}><option value="personal">나만 사용</option><option value="department">우리 부서에서 사용</option></select></label>}<label className="block text-sm">업무 지시문<textarea className={`${input} mt-2`} value={instructions} maxLength={12000} onChange={e => setInstructions(e.target.value)} rows={5} /></label>
    <h2 className="border-t pt-5 font-semibold">2. 입력 항목</h2>{definition.fields.map((field, index) => <div key={field.key} className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="flex items-center justify-between"><span className="text-xs text-slate-500">항목 {index + 1}</span><button type="button" disabled={definition.fields.length === 1} onClick={() => setDefinition(d => ({ ...d, fields: d.fields.filter((_, i) => i !== index) }))} className="text-xs text-red-600 disabled:opacity-40">항목 삭제</button></div><input aria-label={`항목 ${index + 1} 이름`} className={input} value={field.label} maxLength={60} onChange={e => updateField(index, { label: e.target.value })} /><select aria-label={`항목 ${index + 1} 종류`} className={input} value={field.type} onChange={e => updateField(index, { type: e.target.value as AppField['type'], ...(e.target.value === 'select' ? { options: ['선택 1', '선택 2'] } : { options: undefined }) })}><option value="text">짧은 글</option><option value="textarea">긴 글</option><option value="number">숫자</option><option value="date">날짜</option><option value="select">목록에서 선택</option></select>{field.type === 'select' && <label className="block text-xs text-slate-500">선택값 (한 줄에 하나)<textarea className={`${input} mt-2`} value={field.options?.join('\n') ?? ''} onChange={e => updateField(index, { options: e.target.value.split('\n') })} rows={3} /></label>}<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={field.required} onChange={e => updateField(index, { required: e.target.checked })} />필수 입력</label></div>)}<button type="button" disabled={definition.fields.length >= 8} onClick={() => setDefinition(d => ({ ...d, fields: [...d.fields, { key: `field_${Date.now().toString(36)}`, label: `입력 ${d.fields.length + 1}`, type: 'text', required: false }] }))} className="text-sm text-[#087581] disabled:opacity-40">+ 입력 항목 추가 (최대 8개)</button>
    <div className="space-y-3 border-t pt-5"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(definition.attachments)} onChange={e => setDefinition(d => ({ ...d, attachments: e.target.checked ? { required: false } : undefined }))} />파일 첨부 받기</label>{definition.attachments && <><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={definition.attachments.required} onChange={e => setDefinition(d => ({ ...d, attachments: { required: e.target.checked } }))} />파일 필수</label><p className="text-xs leading-5 text-slate-500">최대 3개, 파일당 10MB. 추출 자료 합계 20,000자 이내입니다. 일부만 읽힌 파일은 실행 전에 거절됩니다.</p></>}</div>
    <label className="block border-t pt-5 text-sm font-semibold">3. 응답 형식<select className={`${input} mt-2 font-normal`} value={definition.output} onChange={e => setDefinition(d => ({ ...d, output: e.target.value as AppDefinition['output'] }))}><option value="paragraphs">제목과 문단</option><option value="bullets">항목별 목록</option><option value="checklist">체크리스트</option></select></label><AppStepEditor definition={definition} onChange={setDefinition} /><button type="button" onClick={() => void save()} className="w-full rounded-xl bg-[#087f8c] py-3 text-sm font-semibold text-white">{saving ? '저장 중…' : '앱 저장'}</button>{agent && <Link href={`/apps/run?agent=${agent.id}`} className="block text-center text-sm text-[#087581] underline">저장된 앱 실행하기</Link>}</fieldset></Card><Card><h2 className="mb-2 font-semibold">입력 화면 미리보기</h2><p className="mb-6 text-xs leading-5 text-slate-500">입력 모양을 확인하는 공간입니다. AI 요청은 실행 화면에서 시작합니다. 이 앱은 텍스트 초안을 제공합니다.</p><AppFields definition={definition} values={preview} onChange={(key, value) => setPreview(p => ({ ...p, [key]: value }))} /></Card></div>}
  </div>;
}
export default function Page() { return <WorkShell><Suspense fallback={<p role="status">불러오는 중…</p>}><Builder /></Suspense></WorkShell>; }
