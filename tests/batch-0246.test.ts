import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { connectorListUnread, MODEL_LIST_UNREAD, CREATE_MODEL_LIST_UNREAD, CREATE_CONNECTOR_LIST_UNREAD } from '@/lib/agent-form';

/**
 * 2026-11-21 — 비서 편집·만들기 창이 모델·공공데이터 조회 목록을 못 읽은 것을 빈 목록으로 보지 않는다.
 * 서버(`/api/models`·`/api/connectors`)는 정책을 못 읽으면 503으로 답하는데(0216), 화면은 `r.ok && set…`·`.catch(() => {})`로 그 답을 버렸다:
 *  - 편집 창: 비서에 정해 둔 모델(예: Opus)이 선택지에 없어 모델 칸이 **'기관 기본 모델'로 보였고**, 켜 둔 공공데이터 조회 칸이 **통째로 사라졌다**
 *    (저장 값은 그대로라 화면이 거짓말을 했다 — 직원은 연결이 꺼진 줄 알고, 모델이 기본으로 바뀐 줄 안다)
 *  - 만들기 창: 모델 고르기·실시간 조회 칸이 까닭 없이 사라졌다
 * 이제 못 읽은 것을 따로 기억해 지금 모델을 그대로 보이고, 칸을 숨기지 않고 그렇다고 알린다.
 */

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

describe('편집 창', () => {
  const src = read('src/components/agents/AgentEditorModal.tsx');
  it('목록 응답을 버리지 않고 못 읽음을 기억한다', () => {
    expect(src).not.toContain(".then((r) => r.ok && setModels(r.data ?? []))");
    expect(src).not.toContain(".then((r) => r.ok && setConnectors(r.data ?? []))");
    expect(src).toContain("fetchOkJson<{ data: ModelOption[] }>('/api/models')");
    expect(src).toContain('setOptionsUnread((u) => ({ ...u, models: !b }));');
    expect(src).toContain('setOptionsUnread((u) => ({ ...u, connectors: !b }));');
  });
  it('모델 목록을 못 읽으면 지금 모델을 그대로 보인다', () => {
    expect(src).toContain('const modelUnlisted = optionsUnread.models && !!value && !!value.model_id && !models.some((m) => m.id === value.model_id);');
    expect(src).toContain('{modelUnlisted && <option value={value.model_id}>');
    expect(src).toContain('{optionsUnread.models && <p role="status"');
  });
  it('연결 목록을 못 읽어도 공공데이터 조회 칸을 숨기지 않는다', () => {
    expect(src).toContain('(choices.length > 0 || staleIds.length > 0 || optionsUnread.connectors) && (');
    expect(src).toContain('{connectorListUnread(value.connectors.length)}');
  });
});

describe('만들기 창', () => {
  const src = read('src/components/chat/CreateAgentModal.tsx');
  it('목록 응답을 버리지 않는다', () => {
    expect(src).not.toContain(".catch(() => {});\n    fetch('/api/models')");
    expect(src).toContain('setConnectorsUnread(!b);');
    expect(src).toContain('setModelsUnread(!b);');
  });
  it('못 읽으면 그렇다고', () => {
    expect(src).toContain('{modelsUnread && <p role="status"');
    expect(src).toContain('{connectorsUnread && <p role="status"');
  });
});

describe('문구', () => {
  it('켜 둔 연결 수를 밝힌다', () => {
    expect(connectorListUnread(2)).toBe('공공데이터 조회 목록을 지금 불러오지 못했습니다 — 켜 둔 연결 2개는 그대로 둡니다. 켜거나 끄려면 창을 다시 열어 주세요.');
    expect(connectorListUnread(0)).toBe('공공데이터 조회 목록을 지금 불러오지 못했습니다 — 켜거나 끄려면 창을 다시 열어 주세요.');
  });
  it('모델·만들기 문구', () => {
    expect(MODEL_LIST_UNREAD).toContain('고른 모델은 그대로 둡니다');
    expect(CREATE_MODEL_LIST_UNREAD).toContain('기관 기본 모델로 만들고');
    expect(CREATE_CONNECTOR_LIST_UNREAD).toContain('만든 뒤 편집 창에서 켤 수 있습니다');
  });
});
