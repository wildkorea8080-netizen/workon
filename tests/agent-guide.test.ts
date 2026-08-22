import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { parseCatalogFields } from '../src/lib/agent-catalog';
import {
  MAX_AGENT_DOCUMENTS,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_SIZE_LABEL,
} from '../src/lib/file-types';

/**
 * 사용 방법·대화 시작 예시(0025)와 업로드 상한.
 *
 * 둘 다 "화면에는 있는데 실제로는 다르게 도는" 종류의 실패가 나기 쉬운
 * 자리다. 상한은 화면에만 있었고, 폼 필드는 생성과 수정이 갈라지기 쉽다.
 */

describe('사용 방법·시작 예시 파싱', () => {
  it('생성과 수정이 같은 파서를 쓴다', () => {
    // 라우트마다 따로 파싱하면 "만들 때는 들어갔는데 고치면 사라진다"가 된다
    const post = readFileSync('src/app/api/agents/route.ts', 'utf8');
    const patch = readFileSync('src/app/api/agents/[id]/route.ts', 'utf8');
    expect(post).toContain('parseCatalogFields');
    expect(patch).toContain('parseCatalogFields');
    // PATCH가 자기만의 파싱을 다시 두지 않았는지
    expect(patch).not.toContain('MAX_STARTERS');
  });

  it('줄바꿈으로 적은 예시를 배열로 받는다', () => {
    const { payload, error } = parseCatalogFields({
      starter_prompts: '교육 참가 안내 공문\n자료 제출 요청 공문',
    });
    expect(error).toBeUndefined();
    expect(payload.starter_prompts).toEqual(['교육 참가 안내 공문', '자료 제출 요청 공문']);
  });

  it('배열로 직접 보내도 받는다', () => {
    // 화면은 줄바꿈으로 보내지만 API를 직접 부르면 배열로 온다
    const { payload } = parseCatalogFields({ starter_prompts: ['가', '나'] });
    expect(payload.starter_prompts).toEqual(['가', '나']);
  });

  it('빈 값은 NULL로 되돌린다', () => {
    // 빈 배열을 저장하면 "안 정함"과 구분되지 않는다 (allowed_models와 같은 규칙)
    expect(parseCatalogFields({ starter_prompts: '   \n  ' }).payload.starter_prompts).toBeNull();
    expect(parseCatalogFields({ usage_guide: '  ' }).payload.usage_guide).toBeNull();
  });

  it('개수와 길이 상한을 넘으면 이유를 말한다', () => {
    const many = parseCatalogFields({ starter_prompts: Array(7).fill('가') });
    expect(many.error).toMatch(/최대/);

    const long = parseCatalogFields({ starter_prompts: ['가'.repeat(121)] });
    expect(long.error).toMatch(/이내/);

    const guide = parseCatalogFields({ usage_guide: '가'.repeat(501) });
    expect(guide.error).toMatch(/이내/);
  });

  it('건드리지 않은 필드는 payload에 넣지 않는다', () => {
    // undefined와 null은 뜻이 다르다. 안 보낸 값을 NULL로 저장하면
    // 다른 화면에서 저장할 때마다 안내가 지워진다.
    const { payload } = parseCatalogFields({ icon: '📄' });
    expect('usage_guide' in payload).toBe(false);
    expect('starter_prompts' in payload).toBe(false);
  });
});

describe('업로드 상한은 한 곳에만', () => {
  it('서버가 개수를 판정한다', () => {
    // 상한이 화면에만 있었다. /api/upload에 개수 검사가 아예 없어
    // 화면을 거치지 않으면 얼마든지 붙일 수 있었다.
    const upload = readFileSync('src/app/api/upload/route.ts', 'utf8');
    expect(upload).toContain('MAX_AGENT_DOCUMENTS');
    expect(upload).toContain("from('documents')");
  });

  it('선택한 비서 전부를 본다', () => {
    // 문서는 비서마다 한 행씩 들어간다. 첫 번째만 검사하면 나머지는
    // 상한을 넘겨 쌓인다.
    const upload = readFileSync('src/app/api/upload/route.ts', 'utf8');
    // import 줄이 아니라 실제 검사 지점을 본다
    const at = upload.indexOf('const full = agentIds.filter');
    expect(at, '문서 수 검사를 찾지 못했다').toBeGreaterThan(-1);
    const block = upload.slice(Math.max(0, at - 900), at + 400);
    expect(block).toContain(".in('agent_id', agentIds)");
    expect(block).toContain('MAX_AGENT_DOCUMENTS');
  });

  it('화면과 서버가 같은 숫자를 쓴다', () => {
    // 화면은 10MB, 서버는 20MB로 갈라져 안내와 실제가 어긋났었다
    for (const file of [
      'src/components/chat/CreateAgentModal.tsx',
      'src/app/api/upload/route.ts',
    ]) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toMatch(/const MAX_FILE_SIZE\s*=/);
    }
    expect(MAX_UPLOAD_SIZE_LABEL).toBe('20MB');
    expect(MAX_UPLOAD_BYTES).toBe(20 * 1024 * 1024);
  });

  it('비서당 문서 수가 실무에 쓸 만하다', () => {
    // 10개는 복무·여비·문서관리 규정을 한 질만 올려도 넘는다
    expect(MAX_AGENT_DOCUMENTS).toBeGreaterThanOrEqual(50);
  });
});

describe('업로드 화면 안내', () => {
  it('질문/답변 형식을 권한다', () => {
    // 검색은 문서 전체가 아니라 청크 단위로 걸린다. 질문에 쓰일 표현이
    // 문서 안에 있어야 찾아온다.
    for (const file of [
      'src/components/admin/DocumentsManager.tsx',
      'src/components/chat/CreateAgentModal.tsx',
    ]) {
      expect(readFileSync(file, 'utf8'), file).toContain('질문/답변');
    }
  });
});

describe('직원 화면', () => {
  const ui = readFileSync('src/components/chat/ChatInterface.tsx', 'utf8');

  it('사용 방법과 시작 예시를 보여준다', () => {
    expect(ui).toContain('selectedAgent.usage_guide');
    expect(ui).toContain('starter_prompts');
  });

  it('예시를 누르면 채우기만 하고 보내지 않는다', () => {
    // 담당자가 자기 상황에 맞게 고쳐 써야 한다
    const at = ui.indexOf('starter_prompts ?? []).map');
    const block = ui.slice(at, at + 600);
    expect(block).toContain('setInputMessage(prompt)');
    expect(block).not.toContain('handleSendMessage');
  });
});
