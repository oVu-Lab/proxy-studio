import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Adapter, RequestLog, StudioDB } from "@/lib/types";

const DIRECTORY = path.join(process.cwd(), "data");
const FILE = path.join(DIRECTORY, "db.json");
const LOCK = path.join(DIRECTORY, ".db.lock");

import { BUNDLED_RUSHER } from "@/lib/types";
export const RUSHER: Adapter = BUNDLED_RUSHER;

function initialDB(): StudioDB {
  return { version: 1, settings: { localApiKey: "" }, adapters: [structuredClone(RUSHER)], logs: [] };
}

async function ensureFile() {
  await fs.mkdir(DIRECTORY, { recursive: true });
  try {
    await fs.writeFile(FILE, JSON.stringify(initialDB(), null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export async function readDB(): Promise<StudioDB> {
  await ensureFile();
  const data = JSON.parse(await fs.readFile(FILE, "utf8")) as StudioDB;
  if (!data || !Array.isArray(data.adapters) || !Array.isArray(data.logs) || !data.settings) {
    throw new Error("data/db.json is invalid. Restore it from a backup or remove it to regenerate the defaults.");
  }
  return data;
}

async function acquireLock(): Promise<() => Promise<void>> {
  await ensureFile();
  for (let i = 0; i < 250; i++) {
    try {
      const handle = await fs.open(LOCK, "wx", 0o600);
      return async () => { await handle.close(); await fs.unlink(LOCK).catch(() => {}); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.stat(LOCK).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 30_000) await fs.unlink(LOCK).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("Timed out waiting for the local data file lock.");
}

/** Read-modify-write under a process-independent lock; replace atomically. */
export async function updateDB<T>(fn: (db: StudioDB) => T | Promise<T>): Promise<T> {
  const unlock = await acquireLock();
  let temp = "";
  try {
    const db = await readDB();
    const value = await fn(db);
    temp = `${FILE}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(db, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(temp, FILE);
    return value;
  } finally {
    if (temp) await fs.unlink(temp).catch(() => {});
    await unlock();
  }
}

export async function appendLog(log: Omit<RequestLog, "id" | "at">) {
  await updateDB((db) => {
    db.logs.unshift({ ...log, id: randomUUID(), at: new Date().toISOString() });
    db.logs = db.logs.slice(0, 200);
  });
}

export function uniqueId(name: string, existing: Adapter[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "adapter";
  let id = base;
  let count = 2;
  while (existing.some((a) => a.id === id)) id = `${base}-${count++}`;
  return id;
}
