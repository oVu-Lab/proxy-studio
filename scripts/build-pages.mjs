/**
 * Builds a pure static `./out` bundle ready to deploy globally on Cloudflare Pages
 * (unlimited free bandwidth, zero Workers quota consumption, 100% browser-isolated
 * localStorage + 1-click Personal Cloudflare Worker & Local Proxy exporter).
 *
 * Usage:
 *   npm run build:pages
 *   npx wrangler pages deploy out --project-name=proxy-studio
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const root = process.cwd();
const appDir = path.join(root, "src", "app");
const stash = mkdtempSync(path.join(os.tmpdir(), "proxy-studio-pages-"));
const movedDirs = ["api", "v1", "proxy"];
const pageFile = path.join(appDir, "page.tsx");
const origPageBackup = path.join(stash, "page.tsx.bak");

const STATIC_PAGE = `import Studio from "@/components/Studio";
import { BUNDLED_RUSHER, publicAdapter } from "@/lib/types";

export default function Home() {
  return (
    <Studio
      staticOnly
      initial={{
        adapters: [publicAdapter(BUNDLED_RUSHER)],
        logs: [],
        authRequired: false,
        envKey: false,
      }}
    />
  );
}
`;

// Cloudflare Pages baseline security headers for the static frontend
const PAGES_HEADERS = `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN
  Referrer-Policy: strict-origin-when-cross-origin
`;

console.log("\nBuilding global zero-quota Cloudflare Pages bundle -> ./out ...\n");

let status = 1;
try {
  // Temporarily stash server-only route handlers and swap page.tsx to static mode.
  for (const name of movedDirs) {
    const src = path.join(appDir, name);
    if (existsSync(src)) {
      renameSync(src, path.join(stash, name));
    }
  }
  cpSync(pageFile, origPageBackup);
  writeFileSync(pageFile, STATIC_PAGE, "utf8");

  // Use a separate .next cache cleanup only for stale route types while running build
  const typesDir = path.join(root, ".next", "types");
  const devTypesDir = path.join(root, ".next", "dev");
  rmSync(typesDir, { recursive: true, force: true });
  rmSync(devTypesDir, { recursive: true, force: true });
  rmSync(path.join(root, "out"), { recursive: true, force: true });

  const env = {
    ...process.env,
    STATIC_EXPORT: "1",
    NEXT_PUBLIC_STUDIO_MODE: "global",
  };
  const result = spawnSync(process.execPath, [nextBin, "build"], {
    stdio: "inherit",
    env,
  });
  status = result.status ?? 1;

  if (status === 0 && existsSync(path.join(root, "out"))) {
    writeFileSync(path.join(root, "out", "_headers"), PAGES_HEADERS, "utf8");
    mkdirSync(path.join(root, "out"), { recursive: true });
    console.log("\n✅ Static global bundle ready at ./out");
    console.log("   Deploy free (unlimited requests): npx wrangler pages deploy out --project-name=proxy-studio\n");
  }
} finally {
  // Always restore the original server-enabled application cleanly!
  if (existsSync(origPageBackup)) {
    cpSync(origPageBackup, pageFile);
  }
  for (const name of movedDirs) {
    const stashed = path.join(stash, name);
    const dest = path.join(appDir, name);
    if (existsSync(stashed) && !existsSync(dest)) {
      renameSync(stashed, dest);
    }
  }
  rmSync(stash, { recursive: true, force: true });
}

process.exit(status);
