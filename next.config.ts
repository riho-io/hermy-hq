import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel-compatible settings
  output: undefined, // default — Vercel handles this automatically
  images: {
    unoptimized: false,
  },
  // Jarvis moved from /jarvis to the home page (07.10); keep old bookmarks working.
  async redirects() {
    return [{ source: "/jarvis", destination: "/", permanent: false }];
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
};

export default nextConfig;
