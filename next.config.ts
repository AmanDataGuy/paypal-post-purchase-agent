import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships WASM and optional native requires; load it from node_modules at runtime instead of bundling.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
