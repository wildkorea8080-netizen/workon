const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      { source: '/dashboard', destination: '/', permanent: false },
    ];
  },
};

export default nextConfig;
