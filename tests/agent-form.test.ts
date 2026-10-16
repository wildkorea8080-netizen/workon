import { describe, it, expect } from 'vitest';
import {
  settingsFromAgent,
  settingsToBody,
  describeHistoryItem,
  canRevertTo,
  connectorChoices,
  connectorIdsOf,
  isConnectorOutOfScope,
  isSettingsDirty,
} from '@/lib/agent-form';

const agent = {
  name: '공문 비서', description: null, icon: '📨', category: '공공기관',
  usage_guide: null, starter_prompts: ['교육 안내', '자료 요청'], system_prompt: '공문을 씁니다',
  model_id: null, capabilities: { image: {}, public_data: { connectors: ['law'] } },
};

describe('설정 값', () => {
  it('비서에서 편집 값을 만든다', () => {
    expect(settingsFromAgent(agent as never)).toEqual({
      name: '공문 비서', description: '', icon: '📨', category: '공공기관', usage_guide: '',
      starter_prompts: '교육 안내\n자료 요청', system_prompt: '공문을 씁니다', model_id: '',
      doc_search: false, image: true, document: false, file_read: false, connectors: ['law'],
    });
  });

  it('대화형은 능력과 모델을 함께 보낸다', () => {
    const body = settingsToBody({ ...settingsFromAgent(agent as never), doc_search: true }, { isLink: false });
    expect(body.capabilities).toEqual({ doc_search: {}, image: {}, public_data: { connectors: ['law'] } });
    expect(body.model_id).toBeNull();
    expect(body.starter_prompts).toBe('교육 안내\n자료 요청');
  });

  it('문서 만들기를 능력으로 보낸다', () => {
    const body = settingsToBody({ ...settingsFromAgent(agent as never), document: true }, { isLink: false });
    expect(body.capabilities).toEqual({ image: {}, document: {}, public_data: { connectors: ['law'] } });
  });

  it('파일 받아 읽기를 저장 값에서 읽고 그대로 보낸다', () => {
    // 편집 창에 칸이 없어도 저장할 때 조용히 빠지면 안 된다
    const withFileRead = { ...agent, capabilities: { ...agent.capabilities, file_read: {} } };
    expect(settingsFromAgent(withFileRead as never).file_read).toBe(true);
    const body = settingsToBody(settingsFromAgent(withFileRead as never), { isLink: false });
    expect(body.capabilities).toEqual({ image: {}, file_read: {}, public_data: { connectors: ['law'] } });
  });

  it('연결을 다 끄면 공공데이터 능력을 뺀다', () => {
    const body = settingsToBody({ ...settingsFromAgent(agent as never), connectors: [] }, { isLink: false });
    expect(body.capabilities).toEqual({ image: {} });
  });

  it('링크형은 표시 정보만 보낸다', () => {
    // 링크형은 대화하지 않는다. 지시문·모델·능력을 보내면 의미 없는 판이 쌓인다.
    const body = settingsToBody(settingsFromAgent(agent as never), { isLink: true });
    expect(Object.keys(body).sort()).toEqual(['category', 'description', 'icon', 'name']);
  });

  it('깨진 능력 값에서도 연결 목록을 안전하게 읽는다', () => {
    expect(connectorIdsOf(null)).toEqual([]);
    expect(connectorIdsOf({ public_data: { connectors: 'law' } })).toEqual([]);
  });
});

describe('변경 기록 문장', () => {
  it('바뀐 칸을 사람 말로', () => {
    expect(describeHistoryItem({ kind: 'settings', version: 3, detail: { fields: ['model_id', 'system_prompt'] } }))
      .toBe('모델·지시문을 바꿈');
  });

  it('양식 추가·되돌리기·단계·문서', () => {
    expect(describeHistoryItem({ kind: 'settings', version: 4, detail: { template_added: '사업계획서', fields: ['template_ids'] } }))
      .toBe("양식 '사업계획서'을(를) 추가함");
    expect(describeHistoryItem({ kind: 'revert', version: 5, detail: { reverted_from: 2 } })).toBe('판 2로 되돌림');
    expect(describeHistoryItem({ kind: 'tier', version: null, detail: { from: 'personal', to: 'department' } }))
      .toBe('나만의 비서 → 부서 비서');
    expect(describeHistoryItem({ kind: 'document_added', version: null, detail: { file_name: '여비규정.hwp' } }))
      .toBe("문서 '여비규정.hwp'을(를) 올림");
    expect(describeHistoryItem({ kind: 'settings', version: 2, detail: { reason: 'auto_enable', fields: ['capabilities'] } }))
      .toBe('문서를 올려 참고 문서 찾기를 켬');
  });
});

describe('되돌리기 가능 여부', () => {
  it('판 번호가 있고 지금 판이 아닐 때만', () => {
    expect(canRevertTo({ kind: 'settings', version: 2, detail: {} }, 3)).toBe(true);
    expect(canRevertTo({ kind: 'settings', version: 3, detail: {} }, 3)).toBe(false);
    expect(canRevertTo({ kind: 'tier', version: null, detail: {} }, 3)).toBe(false);
    expect(canRevertTo({ kind: 'migrated', version: 1, detail: {} }, 3)).toBe(true);
  });
});

describe('연결 선택지', () => {
  const all = [
    { id: 'law', label: '법령', allowedForPersonal: true },
    { id: 'kosis', label: '통계', allowedForPersonal: false },
  ];

  it('공식 비서는 전부', () => {
    expect(connectorChoices(all, 'official', []).map((c) => c.id)).toEqual(['law', 'kosis']);
  });

  it('나만의·부서 비서는 기관이 쓰는 것만, 이미 켜 둔 것은 끌 수 있게 남긴다', () => {
    expect(connectorChoices(all, 'department', []).map((c) => c.id)).toEqual(['law']);
    expect(connectorChoices(all, 'personal', ['kosis']).map((c) => c.id)).toEqual(['law', 'kosis']);
  });
});

describe('기관이 안 쓰는 연결', () => {
  const law = { id: 'law', label: '법령', allowedForPersonal: true };
  const kosis = { id: 'kosis', label: '통계', allowedForPersonal: false };

  it('나만의·부서 비서에서 기관이 안 쓰는 연결은 범위 밖이다', () => {
    expect(isConnectorOutOfScope(kosis, 'personal')).toBe(true);
    expect(isConnectorOutOfScope(kosis, 'department')).toBe(true);
    expect(isConnectorOutOfScope(law, 'personal')).toBe(false);
  });

  it('공식 비서는 어느 연결도 범위 밖이 아니다', () => {
    expect(isConnectorOutOfScope(kosis, 'official')).toBe(false);
  });

  it('allowedForPersonal이 없으면(옛 응답) 범위 밖으로 본다', () => {
    expect(isConnectorOutOfScope({ id: 'x', label: 'x' }, 'personal')).toBe(true);
  });
});

describe('저장 안 한 수정', () => {
  const base = settingsFromAgent(agent as never);

  it('기준과 같으면 수정 없음', () => {
    expect(isSettingsDirty(base, JSON.stringify(base))).toBe(false);
  });

  it('값이 하나라도 다르면 수정 있음', () => {
    expect(isSettingsDirty({ ...base, name: '다른 이름' }, JSON.stringify(base))).toBe(true);
  });

  it('기준이 없으면(아직 못 읽음) 수정 없음', () => {
    expect(isSettingsDirty(base, null)).toBe(false);
  });
});
