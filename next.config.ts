import type { NextConfig } from "next";

/**
 * Static-export configuration (GitHub Pages compatible).
 *
 * GitHub Pages serves a project site from https://<user>.github.io/<repo>/, so
 * the app must know its sub-path. Set NEXT_PUBLIC_BASE_PATH at build time:
 *
 *   - local dev / user site (<user>.github.io):   leave unset  -> served from "/"
 *   - project site:                               NEXT_PUBLIC_BASE_PATH=/<repo>
 *
 * The GitHub Actions workflow in .github/workflows/deploy-pages.yml sets this
 * automatically from the repository name.
 */
const rawBasePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").trim();
const basePath = rawBasePath && rawBasePath !== "/"
  ? `/${rawBasePath.replace(/^\/+|\/+$/g, "")}`
  : "";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  images: { unoptimized: true },
  reactStrictMode: false,
};

export default nextConfig;
