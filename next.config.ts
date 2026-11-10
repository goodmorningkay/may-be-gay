import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  allowedDevOrigins: ["may-be.localhost", "*.may-be.localhost"],
};

export default nextConfig;
