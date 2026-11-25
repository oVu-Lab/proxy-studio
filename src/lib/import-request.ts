import JSON5 from "json5";
import type { Adapter, AdapterSchema } from "@/lib/types";

function shellWords(input: string): string[] {
  const src = input.replace(/\\\r?\n/g, " ");
  const out: string[] = [];
  let word = "", quote = "", started = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote === "'") { if (c === "'") quote = ""; else word += c; started = true; continue; }
    if (quote === '"') {
      if (c === '"') quote = "";
      else if (c === "\\" && i + 1 < src.length && /[\\"$`]/.test(src[i + 1])) word += src[++i];
      else word += c;
      started = true; continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; }
    else if (c === "\\" && i + 1 < src.length) { word += src[++i]; started = true; }
    else if (/\s/.test(c)) { if (started) { out.push(word); word = ""; started = false; } }
    else { word += c; started = true; }
  }
  if (quote) throw new Error("Unclosed quote in the cURL command.");
  if (started) out.push(word);
  return out;
}

function balanced(src: string, start: number): string {
  const opener = src[start], closer = opener === "{" ? "}" : opener === "[" ? "]" : ")";
  let depth = 0, quote = "", escape = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (escape) escape = false; else if (c === "\\") escape = true; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === opener) depth++;
    if (c === closer && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error("Could not parse the request object. Paste a literal JSON body, not variables.");
}

function findPath(obj: unknown, names: string[], depth = 0, prefix: string[] = []): string[] | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || depth > 4) return null;
  const record = obj as Record<string, unknown>;
  for (const key of names) if (Object.prototype.hasOwnProperty.call(record, key)) return [...prefix, key];
  for (const [key, value] of Object.entries(record)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    const found = findPath(value, names, depth + 1, [...prefix, key]);
    if (found) return found;
  }
  return null;
}
function atPath(obj: Record<string, unknown>, path: string[]): unknown {
  return path.reduce<unknown>((v, key) => v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined, obj);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The captured body must be a JSON object.");
  return value as Record<string, unknown>;
}

export function importRequest(input: string, name = "", overrideModel = ""): Adapter {
  let endpoint = "", body: Record<string, unknown> = {}, headers: Record<string, string> = {};
  if (/^\s*curl\b/.test(input)) {
    const args = shellWords(input);
    let data = "";
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (["-H", "--header"].includes(arg)) { const line = args[++i] || ""; const at = line.indexOf(":"); if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim(); }
      else if (arg.startsWith("--header=")) { const line = arg.slice(9), at = line.indexOf(":"); if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim(); }
      else if (["-d", "--data", "--data-raw", "--data-binary", "--data-ascii"].includes(arg)) data = args[++i] || "";
      else if (/^--data(?:-raw|-binary|-ascii)?=/.test(arg)) data = arg.slice(arg.indexOf("=") + 1);
      else if (["-b", "--cookie"].includes(arg)) headers.Cookie = args[++i] || "";
      else if (["-X", "--request"].includes(arg)) { if ((args[++i] || "").toUpperCase() !== "POST") throw new Error("Only POST chat requests are supported."); }
      else if (arg === "--url") endpoint = args[++i] || "";
      else if (/^https?:\/\//i.test(arg)) endpoint = arg;
    }
    if (!data || data.startsWith("@")) throw new Error("Paste a cURL command with an inline JSON --data-raw body.");
    try { body = object(JSON5.parse(data)); } catch { throw new Error("Could not parse the cURL JSON body."); }
  } else if (/\bfetch\s*\(/.test(input)) {
    const match = input.match(/\bfetch\s*\(\s*(['"])(https?:\/\/[\s\S]*?)\1/);
    if (!match) throw new Error("Use a fetch call with a literal URL in quotes.");
    endpoint = match[2];
    const h = /\bheaders\s*:\s*/g.exec(input);
    if (h) {
      const start = input.indexOf("{", h.index + h[0].length);
      if (start >= 0) { try { const parsed = object(JSON5.parse(balanced(input, start))); for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") headers[k] = v; } catch { throw new Error("Could not parse literal fetch headers."); } }
    }
    const b = /\bbody\s*:\s*/g.exec(input);
    if (!b) throw new Error("The fetch request needs a literal JSON body.");
    const after = input.slice(b.index + b[0].length).trimStart();
    try {
      if (/^JSON\.stringify\s*\(/.test(after)) {
        const open = after.indexOf("("); const inner = balanced(after, open).slice(1, -1); body = object(JSON5.parse(inner));
      } else if (after.startsWith("{") ) body = object(JSON5.parse(balanced(after, 0)));
      else if (after[0] === "'" || after[0] === '"') {
        const q = after[0]; let end = 1, esc = false;
        for (; end < after.length; end++) { if (esc) esc = false; else if (after[end] === "\\") esc = true; else if (after[end] === q) break; }
        body = object(JSON5.parse(JSON5.parse(after.slice(0, end + 1))));
      } else throw new Error("non-literal");
    } catch { throw new Error("Could not parse the fetch body. Use a literal object or JSON.stringify({...}); variables cannot be evaluated."); }
  } else throw new Error("Paste a cURL command or fetch(...) call.");
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("The request must contain an absolute endpoint URL."); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only HTTP and HTTPS endpoints are supported.");
  const messages = findPath(body, ["messages"]);
  if (!messages || !Array.isArray(atPath(body, messages))) throw new Error("The request body must contain a messages array. Other request formats are not yet supported.");
  const modelPath = findPath(body, ["modelId", "model", "model_id"]) || ["model"];
  const modelValue = overrideModel.trim() || (typeof atPath(body, modelPath) === "string" ? String(atPath(body, modelPath)) : "default");
  const schema: AdapterSchema = { messages, model: modelPath, stream: findPath(body, ["stream"]), thinking: findPath(body, ["thinking"]), deepSearch: findPath(body, ["deepSearch", "deep_search"]) };
  const getHeader = (key: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === key)?.[1];
  let origin = getHeader("origin") || url.origin;
  try { origin = new URL(origin).origin; } catch { throw new Error("The Origin header is invalid."); }
  const referer = getHeader("referer") || `${origin}/`;
  const siteName = name.trim() || new URL(origin).hostname.replace(/^www\./, "").split(".")[0];
  return { id: "", name: siteName.slice(0, 80), siteUrl: `${origin}/`, endpoint: url.toString(), origin, referer, enabled: true, source: "imported", createdAt: new Date().toISOString(), verifiedAt: null, headers, requestTemplate: body, schema, models: [{ id: modelValue, name: modelValue }] };
}
