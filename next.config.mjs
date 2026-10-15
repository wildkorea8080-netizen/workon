const nextConfig = {
  reactStrictMode: true,
  experimental: {
    outputFileTracingIncludes: {
      '/api/chat': ['./assets/templates/**/*'],
    },
  },
  async redirects() {
    return [
      { source: '/dashboard', destination: '/', permanent: false },
    ];
  },
};

export default nextConfig;
