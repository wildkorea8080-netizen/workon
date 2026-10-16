'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent } from '@/lib/db';
import {
  settingsFromAgent,
  settingsToBody,
  connectorChoices,
  isConnectorOutOfScope,
  isSettingsDirty,
  TIER_LABELS,
  type AgentSettingsValue,
  type ConnectorChoice,
} from '@/lib/agent-form';
import { requestJson } from '@/lib/request-json';
import TemplatesPanel from './TemplatesPanel';
import HistoryPanel from './HistoryPanel';

type ModelOption = { id: string; label: string; note: string };
type Tab = 'settings' | 'templates' | 'history';

const input =
  'w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#003087]/20';
const label = 'block text-xs font-medium text-slate-500 mb-1';

/**
 * 비서 편집 창 — 관리자·직원 공통(설계 6.4).
 *
 * 판 설정만 다룬다. 노출·공개 범위·유형 같은 운영 값은 관리 화면에 있다.
 * 저장할 때 보고 있던 판 번호를 보낸다. 그 사이 다른 사람이 저장했으면
 * 서버가 거절하고, 여기서 충돌 안내를 띄운다.
 */
export default function AgentEditorModal({
  agentId,
  categories = [],
  onClose,
  onSaved,
}: {
  agentId: string;
  categories?: string[];
  onClose: () => void;
  onSaved?: (agent: Agent) => void;
}) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [value, setValue] = useState<AgentSettingsValue | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [connectors, setConnectors] = useState<ConnectorChoice[]>([]);
  const [tab, setTab] = useState<Tab>('settings');
  const [saving, setSaving] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 서버에서 마지막으로 읽은 설정의 모습. 판만 오르고 설정이 그대로인지 가릴 때 쓴다 */
  const baselineRef = useRef<string | null>(null);
  /** 마우스를 배경에서 눌렀는가. 끌어서 창 밖에서 놓은 것을 배경 클릭으로 세지 않는다 */
  const pressedOnBackdrop = useRef(false);

  /** 최신 판을 불러와 화면을 덮는다. 읽은 행을 돌려준다(되돌리기 뒤 목록 갱신에 쓴다) */
  const load = useCallback(async (): Promise<Agent | null> => {
    const { r } = await requestJson(`/api/agents/${agentId}`);
    if (!r.ok || !r.data) {
      setError(r.error?.message ?? '비서를 불러오지 못했습니다.');
      return null;
    }
    const next = settingsFromAgent(r.data);
    baselineRef.current = JSON.stringify(next);
    setAgent(r.data);
    setValue(next);
    setConflict(false);
    setError(null);
    return r.data as Agent;
  }, [agentId]);

  /**
   * 양식·변경 기록처럼 판만 올리는 일 뒤에 쓴다. 고친 내용(value)은 건드리지 않는다.
   * 그 사이 설정을 다른 사람이 바꿨다면 최신 판으로 덮지 않고 충돌로 안내한다 —
   * 판 번호만 올리면 그 사람의 변경을 모른 채 다음 저장이 덮어쓴다.
   */
  const refreshAgent = useCallback(async () => {
    const { r } = await requestJson(`/api/agents/${agentId}`);
    if (!r.ok || !r.data) {
      setError(r.error?.message ?? '비서를 불러오지 못했습니다.');
      return;
    }
    if (JSON.stringify(settingsFromAgent(r.data)) !== baselineRef.current) {
      setConflict(true);
      return;
    }
    setAgent(r.data);
  }, [agentId]);

  useEffect(() => {
    load();
    fetch('/api/models')
      .then((r) => r.json())
      .then((r) => r.ok && setModels(r.data ?? []))
      .catch(() => {});
    fetch('/api/connectors')
      .then((r) => r.json())
      .then((r) => r.ok && setConnectors(r.data ?? []))
      .catch(() => {});
  }, [load]);

  /** 되돌린 뒤 다시 읽고, 관리 목록·직원 카드도 새 행으로 갱신한다 */
  const reloadAfterRevert = async () => {
    const row = await load();
    if (row) onSaved?.(row);
  };

  const patch = (p: Partial<AgentSettingsValue>) => setValue((v) => (v ? { ...v, ...p } : v));

  const save = async () => {
    if (!agent || !value) return;
    if (!value.name.trim()) {
      setError('비서 이름을 입력해 주세요.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { status, r } = await requestJson(`/api/agents/${agent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...settingsToBody(value, { isLink: agent.agent_type === 'link' }),
          base_version: agent.version,
        }),
      });
      if (status === 409 && r.error?.details?.reason === 'conflict') {
        setConflict(true);
        return;
      }
      if (!r.ok) {
        setError(r.error?.message ?? '저장하지 못했습니다.');
        return;
      }
      const saved = settingsFromAgent(r.data);
      baselineRef.current = JSON.stringify(saved);
      setAgent(r.data);
      setValue(saved);
      setNotice(`판 ${r.data.version}로 저장했습니다.`);
      onSaved?.(r.data);
    } finally {
      setSaving(false);
    }
  };

  const enhance = async () => {
    if (!value?.system_prompt.trim()) return;
    setEnhancing(true);
    setError(null);
    try {
      const { r } = await requestJson('/api/enhance-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: value.system_prompt, type: 'agent' }),
      });
      if (r.ok) patch({ system_prompt: r.data.enhancedPrompt });
      else setError(r.error?.message ?? '지시문을 다듬지 못했습니다.');
    } finally {
      setEnhancing(false);
    }
  };

  const isLink = agent?.agent_type === 'link';
  const choices = agent && value ? connectorChoices(connectors, agent.tier, value.connectors) : [];
  /**
   * 카탈로그에 없는데 아직 켜져 있는 연결. 목록에서 빠지면 체크를 끌 방법이 없어
   * 저장이 계속 거절된다. 카탈로그를 못 읽었을 때(빈 목록)는 지우지 않는다 —
   * 실패가 기능을 떼어 내면 안 된다.
   */
  const catalogIds = new Set(connectors.map((c) => c.id));
  const staleIds = value && connectors.length > 0 ? value.connectors.filter((id) => !catalogIds.has(id)) : [];
  /** 허용 목록을 읽었는데 비서의 모델이 거기 없다 — 서버가 저장을 400으로 거절한다 */
  const modelNotAllowed = !!value && !!value.model_id && models.length > 0 && !models.some((m) => m.id === value.model_id);
  const toggleConnector = (id: string, on: boolean) =>
    setValue((v) =>
      v ? { ...v, connectors: on ? [...v.connectors, id] : v.connectors.filter((x) => x !== id) } : v
    );

  /**
   * 저장 안 한 설정 수정이 있으면 묻고 닫는다. 배경·× ·닫기 단추가 모두 이 길을 거친다.
   * 마지막으로 읽은/저장한 설정과 지금 값을 비교한다(baselineRef).
   */
  const requestClose = () => {
    if (value && isSettingsDirty(value, baselineRef.current) && !confirm('저장하지 않은 수정이 있습니다. 닫을까요?')) return;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4"
      onMouseDown={(e) => {
        pressedOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // 창 안에서 글자를 끌어 선택하다 밖에서 놓으면 click이 배경에서 일어난다.
        // 누른 곳도 배경이었을 때만 닫는다.
        const closes = pressedOnBackdrop.current && e.target === e.currentTarget;
        pressedOnBackdrop.current = false;
        if (closes) requestClose();
      }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-slate-100 px-5 pt-4 z-10">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-base font-bold text-slate-900 truncate">
                {agent?.icon} {agent?.name ?? '비서'}
              </p>
              {agent && (
                <p className="text-[11px] text-slate-400">
                  {TIER_LABELS[agent.tier]} · 판 {agent.version}
                </p>
              )}
            </div>
            <button onClick={requestClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none" aria-label="닫기">
              ×
            </button>
          </div>
          <div className="flex gap-4 mt-3 text-sm">
            {(
              [
                ['settings', '설정'],
                ...(isLink ? [] : [['templates', '양식']]),
                ['history', '변경 기록'],
              ] as [Tab, string][]
            ).map(([key, text]) => (
              <button
                key={key}
                onClick={() => {
                  setTab(key);
                  setNotice(null);
                }}
                className={`pb-2 border-b-2 ${tab === key ? 'border-[#003087] text-[#003087] font-semibold' : 'border-transparent text-slate-500'}`}
              >
                {text}
              </button>
            ))}
          </div>
        </div>

        <div className="p-5 space-y-4">
          {conflict && (
            <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800 space-y-2">
              <p>다른 분이 먼저 고쳤습니다. 최신 내용을 불러오면 지금 고친 내용은 사라집니다. 필요하면 복사해 두세요.</p>
              <button onClick={() => void load()} className="px-3 py-1 bg-amber-600 text-white rounded-lg font-semibold">
                최신 내용 불러오기
              </button>
            </div>
          )}

          {/* 탭과 무관하게 보이는 자리 — 양식·기록 탭에서 난 오류도 여기서 읽는다 */}
          {error && <p className="text-xs text-red-500">{error}</p>}
          {notice && <p className="text-xs text-green-600">{notice}</p>}

          {!agent || !value ? (
            error ? null : <p className="text-sm text-slate-400">불러오는 중...</p>
          ) : tab === 'templates' ? (
            <TemplatesPanel agentId={agent.id} version={agent.version} onChanged={refreshAgent} />
          ) : tab === 'history' ? (
            <HistoryPanel agentId={agent.id} version={agent.version} onReverted={reloadAfterRevert} onStale={refreshAgent} />
          ) : (
            <>
              <div className="grid grid-cols-[84px_1fr] gap-3">
                <div>
                  <label className={label}>아이콘</label>
                  <input
                    value={value.icon}
                    maxLength={8}
                    onChange={(e) => patch({ icon: e.target.value })}
                    className={`${input} text-center text-lg`}
                  />
                </div>
                <div>
                  <label className={label}>이름</label>
                  <input value={value.name} onChange={(e) => patch({ name: e.target.value })} className={input} />
                </div>
              </div>

              <div>
                <label className={label}>설명</label>
                <input value={value.description} onChange={(e) => patch({ description: e.target.value })} className={input} />
              </div>

              <div>
                <label className={label}>카테고리</label>
                {categories.length > 0 ? (
                  <select value={value.category} onChange={(e) => patch({ category: e.target.value })} className={`${input} bg-white`}>
                    <option value="">(미분류)</option>
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={value.category} onChange={(e) => patch({ category: e.target.value })} className={input} />
                )}
              </div>

              {!isLink && (
                <>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-slate-500">지시문</label>
                      <button
                        onClick={enhance}
                        disabled={enhancing || !value.system_prompt.trim()}
                        className="text-xs text-[#003087] disabled:text-slate-300"
                      >
                        {enhancing ? '다듬는 중...' : '✨ 요술봉'}
                      </button>
                    </div>
                    <textarea
                      rows={6}
                      value={value.system_prompt}
                      onChange={(e) => patch({ system_prompt: e.target.value })}
                      className={`${input} resize-y`}
                    />
                  </div>

                  <div>
                    <label className={label}>모델</label>
                    <select value={value.model_id} onChange={(e) => patch({ model_id: e.target.value })} className={`${input} bg-white`}>
                      <option value="">기관 기본 모델</option>
                      {modelNotAllowed && (
                        <option value={value.model_id}>{`${value.model_id} (허용되지 않음 — 바꿔 주세요)`}</option>
                      )}
                      {models.map((m) => (
                        <option key={m.id} value={m.id} title={m.note}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    {modelNotAllowed && (
                      <p className="mt-1 text-[11px] text-amber-600">
                        기관 허용 목록에 없는 모델입니다. 다른 모델을 고르거나 &lsquo;기관 기본 모델&rsquo;로 바꿔야 저장됩니다.
                      </p>
                    )}
                  </div>

                  <div className="border border-slate-200 rounded-xl p-3 space-y-2">
                    <p className="text-xs font-semibold text-slate-700">능력</p>
                    {(
                      [
                        ['doc_search', '참고 문서 찾기', '연결한 문서에서 근거를 찾아 출처와 함께 답합니다'],
                        ['image', '사진 읽기', '캡처·사진·도표를 첨부받아 읽습니다'],
                        ['file_read', '파일 받아 읽기', '대화 중에 엑셀·한글·PDF 등 파일을 여러 개 받아 읽습니다'],
                        ['document', '문서 만들기', '한글·Word 양식을 채우거나 표준 서식으로 문서 파일을 만듭니다'],
                      ] as const
                    ).map(([key, text, hint]) => (
                      <label key={key} className="flex items-start gap-2.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={value[key]}
                          onChange={(e) => patch({ [key]: e.target.checked } as Partial<AgentSettingsValue>)}
                          className="mt-0.5 w-4 h-4 rounded border-slate-300 text-[#003087]"
                        />
                        <span>
                          <span className="block text-xs font-medium text-slate-800">{text}</span>
                          <span className="block text-[11px] text-slate-400">{hint}</span>
                        </span>
                      </label>
                    ))}
                    {(choices.length > 0 || staleIds.length > 0) && (
                      <div className="pt-2 border-t border-slate-100">
                        <p className="text-xs font-medium text-slate-800 mb-1">공공데이터 조회</p>
                        {choices.map((c) => (
                          <label key={c.id} className="flex items-center gap-2.5 cursor-pointer py-0.5">
                            <input
                              type="checkbox"
                              checked={value.connectors.includes(c.id)}
                              onChange={(e) => toggleConnector(c.id, e.target.checked)}
                              className="w-4 h-4 rounded border-slate-300 text-[#003087]"
                            />
                            {agent && value.connectors.includes(c.id) && isConnectorOutOfScope(c, agent.tier) ? (
                              <span className="text-xs text-amber-700">{`${c.label} (기관에서 쓰지 않음 — 꺼 주세요)`}</span>
                            ) : (
                              <span className="text-xs text-slate-700">{c.label}</span>
                            )}
                          </label>
                        ))}
                        {staleIds.map((id) => (
                          <label key={id} className="flex items-center gap-2.5 cursor-pointer py-0.5">
                            <input
                              type="checkbox"
                              checked
                              onChange={(e) => toggleConnector(id, e.target.checked)}
                              className="w-4 h-4 rounded border-slate-300 text-[#003087]"
                            />
                            <span className="text-xs text-amber-700">{`${id} (사용할 수 없음 — 꺼 주세요)`}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className={label}>사용 방법 (선택)</label>
                    <textarea
                      rows={2}
                      maxLength={500}
                      value={value.usage_guide}
                      onChange={(e) => patch({ usage_guide: e.target.value })}
                      className={`${input} resize-none`}
                    />
                  </div>

                  <div>
                    <label className={label}>대화 시작 예시 (한 줄에 하나, 최대 6개)</label>
                    <textarea
                      rows={3}
                      value={value.starter_prompts}
                      onChange={(e) => patch({ starter_prompts: e.target.value })}
                      className={`${input} resize-none`}
                    />
                  </div>
                </>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={save}
                  disabled={saving || conflict}
                  className="px-4 py-2 bg-[#003087] hover:bg-[#002070] disabled:bg-slate-300 text-white text-sm font-semibold rounded-xl"
                >
                  {saving ? '저장 중...' : '저장'}
                </button>
                <button onClick={requestClose} className="px-4 py-2 border border-slate-200 rounded-xl text-sm text-slate-600">
                  닫기
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
