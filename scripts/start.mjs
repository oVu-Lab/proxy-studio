import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const root = process.cwd();
// Honour standard Next/npm CLI flags as well as PORT/HOST. With no flags or
// environment overrides, a normal local launch stays on 127.0.0.1:8088.
const args = process.argv.slice(2);
function option(long, short) {
  const index = args.findIndex((arg) => arg === long || arg === short || arg.startsWith(`${long}=`));
  if (index < 0) return undefined;
  return args[index].startsWith(`${long}=`) ? args[index].slice(long.length + 1) : args[index + 1];
}
const port = option("--port", "-p") || process.env.PORT || "8088";
const hostname = option("--hostname", "-H") || process.env.HOST || "127.0.0.1";

if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error("PORT must be a number between 1 and 65535.");
  process.exit(1);
}
if (!existsSync(path.join(root, ".next", "BUILD_ID"))) {
  console.log("\nFirst launch: building Proxy Studio. This happens once and requires no database.\n");
  const build = spawnSync(process.execPath, [nextBin, "build"], { stdio: "inherit", env: process.env });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
console.log(`\nProxy Studio is starting at http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${port}\n`);
const child = spawn(process.execPath, [nextBin, "start", "-p", port, "-H", hostname], { stdio: "inherit", env: { ...process.env, PORT: port } });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => { if (signal) process.exit(0); else process.exit(code ?? 1); });
