import { describe, it, expect } from 'vitest';
import { parseCatalogFields } from '@/lib/agent-catalog';

/**
 * 비서 카탈로그 필드 검증.
 *
 * 링크형 비서의 주소 검증이 특히 중요하다. javascript: 는 클릭 시 스크립트가
 * 실행되고 data: 는 임의 문서를 띄울 수 있어, 관리자 계정 하나가 뚫리면
 * 전 직원 화면에 그대로 노출된다.
 */

describe('링크형 비서 주소', () => {
  it('http/https는 통과한다', () => {
    for (const url of ['https://gw.example.go.kr', 'http://intra.example.go.kr/portal']) {
      const { payload, error } = parseCatalogFields({ agent_type: 'link', link_url: url });
      expect(error, url).toBeUndefined();
      expect(payload.link_url).toContain('example.go.kr');
    }
  });

  it('javascript: 는 막는다', () => {
    const { error } = parseCatalogFields({
      agent_type: 'link',
      link_url: 'javascript:alert(document.cookie)',
    });
    expect(error).toBeTruthy();
  });

  it('data: 는 막는다', () => {
    const { error } = parseCatalogFields({
      agent_type: 'link',
      link_url: 'data:text/html,<script>alert(1)</script>',
    });
    expect(error).toBeTruthy();
  });

  it('주소 형식이 아니면 막는다', () => {
    expect(parseCatalogFields({ agent_type: 'link', link_url: '그냥 텍스트' }).error).toBeTruthy();
  });

  it('링크형으로 바꾸면서 주소를 안 주면 막는다', () => {
    expect(parseCatalogFields({ agent_type: 'link' }).error).toBeTruthy();
  });

  it('링크형 비서의 다른 필드만 고칠 때는 주소를 건드리지 않는다', () => {
    // 이름만 바꾸는 요청에는 agent_type도 link_url도 실려 오지 않는다.
    // 여기서 주소를 지우면 기존 링크형 비서가 클릭해도 아무 일 없는 상태가 된다.
    const { payload, error } = parseCatalogFields({ icon: '🔗' }, 'link');
    expect(error).toBeUndefined();
    expect(payload.link_url).toBeUndefined();
  });

  it('대화형으로 되돌리면 주소를 반드시 비운다', () => {
    // 남겨두면 유형만 다시 바꿨을 때 예전 주소가 되살아난다
    const { payload } = parseCatalogFields({ agent_type: 'chat' }, 'link');
    expect(payload.agent_type).toBe('chat');
    expect(payload.link_url).toBeNull();
  });
});

describe('표시 필드', () => {
  it('빈 문자열은 null로 정리한다', () => {
    const { payload } = parseCatalogFields({ icon: '   ', category: '' });
    expect(payload.icon).toBeNull();
    expect(payload.category).toBeNull();
  });

  it('아이콘이 지나치게 길면 막는다', () => {
    expect(parseCatalogFields({ icon: '아주긴아이콘이름입니다' }).error).toBeTruthy();
  });

  it('정렬 순서는 정수로 만든다', () => {
    expect(parseCatalogFields({ display_order: '3.7' }).payload.display_order).toBe(3);
  });

  it('정렬 순서가 숫자가 아니면 막는다', () => {
    expect(parseCatalogFields({ display_order: '앞으로' }).error).toBeTruthy();
  });

  it('알 수 없는 유형은 막는다', () => {
    expect(parseCatalogFields({ agent_type: 'video' }).error).toBeTruthy();
  });

  it('손대지 않은 필드는 payload에 넣지 않는다', () => {
    // undefined와 null을 구분하지 않으면 이름만 바꾸는 요청이
    // 아이콘·카테고리를 함께 지운다
    const { payload } = parseCatalogFields({ icon: '📄' });
    expect(payload.icon).toBe('📄');
    expect('category' in payload).toBe(false);
    expect('is_published' in payload).toBe(false);
  });
});
