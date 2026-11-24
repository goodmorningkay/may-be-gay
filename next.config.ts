import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  outputFileTracingIncludes: {
    "/*": [
      "./src/server/media/parser.cjs", "./node_modules/sharp/**/*",
      "./node_modules/@img/**/*", "./node_modules/detect-libc/**/*", "./node_modules/semver/**/*",
    ],
  },
  allowedDevOrigins: ["may-be.localhost", "*.may-be.localhost"],
};

export default nextConfig;
