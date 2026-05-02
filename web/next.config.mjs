/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const apiBase = process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8000";
    return [
      { source: "/api/:path*", destination: `${apiBase}/:path*` },
    ];
  },
};
export default nextConfig;
