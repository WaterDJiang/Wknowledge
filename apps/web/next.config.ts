import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1"],
  experimental: { externalDir: true },
  serverExternalPackages: ["pg", "pg-boss"]
};

export default nextConfig;
