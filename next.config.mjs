const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // 메모리가 작은 개발 PC에서 빌드 일꾼 수를 줄인다(NEXT_BUILD_CPUS=2 npm run build). 비우면 Next 기본값
    ...(process.env.NEXT_BUILD_CPUS ? { cpus: Number(process.env.NEXT_BUILD_CPUS) } : {}),
    outputFileTracingIncludes: {
      '/api/chat': ['./assets/templates/**/*'],
      '/api/apps/export': ['./assets/templates/**/*'],
      // 두 판 비교의 신구대비표 한글 파일 — 표준 보고서 양식을 읽는다(2026-11-05).
      // 키는 경로 글롭이라 '[id]'를 쓰면 글자 묶음으로 읽힌다 — 폴더 아래 전체로 건다
      '/api/documents/**': ['./assets/templates/**/*'],
      '/api/super/common-documents/**': ['./assets/templates/**/*'],
      // 업무 작업 — 생성·파일 만들기·양식 목록이 표준 양식 바이트와 검증 기록(verification.json)을 읽는다
      '/api/work/**': ['./assets/templates/**/*'],
    },
  },
  async redirects() {
    return [
      { source: '/dashboard', destination: '/', permanent: false },
    ];
  },
};

export default nextConfig;
