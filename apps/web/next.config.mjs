/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared API contract is consumed straight from TypeScript source, so the
  // frontend and backend can never drift apart behind a stale build artefact.
  transpilePackages: ['@hotel/contracts'],
};

export default nextConfig;
