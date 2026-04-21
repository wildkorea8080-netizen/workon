const nextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  async redirects() {
    return [
      { source: '/dashboard', destination: '/', permanent: false },
    ];
  },
};

export default nextConfig;
