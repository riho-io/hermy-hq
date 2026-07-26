import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel-compatible settings
  output: undefined, // default — Vercel handles this automatically
  images: {
    unoptimized: false,
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
};

export default nextConfig;
