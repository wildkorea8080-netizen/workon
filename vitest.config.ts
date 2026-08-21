import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * 회귀 테스트 설정.
 *
 * 이 프로젝트에서 실제로 난 버그들은 전부 **조용한 종류**였다 — 오류가 나지
 * 않고 결과만 틀렸다. RAG 임계값이 높아 아무 문서도 검색되지 않던 것, 트리거가
 * 빠져 사용량이 기관에 귀속되지 않던 것, 최상위 부서 관리자가 기관 전체를
 * 못 보던 것 모두 수동으로 찔러봐야 나왔다.
 *
 * 그래서 테스트 대상은 "동작하는가"가 아니라 **"조용히 틀리지 않는가"**다.
 * 순수 함수 위주로 두고 DB·외부 API는 건드리지 않는다 — 그쪽은
 * `npm run db:check`와 `npm run connector:probe`가 실측으로 본다.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // exceljs로 실제 통합문서를 만들어 넣는 표 테스트가 여러 파일을 동시에
    // 돌릴 때 기본 5초를 넘긴다. 실측 13초. 목을 세우면 빨라지지만 그러면
    // "우리가 상상한 엑셀"만 검증하게 되므로 시간을 늘리는 쪽을 택한다.
    // 간헐적으로 실패하는 테스트는 통과해도 믿지 않게 되어 더 나쁘다.
    testTimeout: 30_000,
    // 워커를 CPU 수만큼 띄우면 개발 기기에서 메모리가 마른다. 표·이미지
    // 테스트가 수 MB짜리 버퍼를 만들어 워커마다 사본을 갖기 때문이다.
    // 실제로 "JavaScript heap out of memory"로 스위트 전체가 죽었다.
    // 이 스위트는 순수 함수 위주라 2개로도 3초면 끝난다.
    maxWorkers: 2,
    // 환경변수를 읽는 모듈(config.ts)이 import 시점에 검사를 돈다.
    // 테스트가 실제 키를 요구하지 않도록 자리표시자를 채운다.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
      NEXTAUTH_URL: 'http://localhost:3000',
      NEXTAUTH_SECRET: 'test-secret',
      VOYAGE_API_KEY: 'test-voyage',
      ANTHROPIC_API_KEY: 'test-anthropic',
    },
  },
});
