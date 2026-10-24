import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["whatsapp-web.js", "puppeteer"],
};

export default nextConfig;
