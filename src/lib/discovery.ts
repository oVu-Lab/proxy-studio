import { safeFetch, readTextLimited, validateUrl } from "@/lib/network";
import { probeAdapter } from "@/lib/proxy";
import type { Adapter, Model } from "@/lib/types";

type ScanReport = { page: string; bundlesScanned: number; candidates: string[]; fields: string[]; models: Model[]; attempts: { endpoint: string; message: string }[] };

function linkedAssets(html: string, base: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    try {
      const url = new URL(match[1], base);
      if (/\.(?:m?js|css)(?:$|\?)/i.test(url.pathname + url.search) && /^https?:$/.test(url.protocol)) urls.push(url.toString());
    } catch { /* ignore malformed URL */ }
  }
  return [...new Set(urls)].slice(0, 12);
}

function findModels(text: string): Model[] {
  const found: Model[] = [];
  const seen = new Set<string>();
  const pattern = /["']?id["']?\s*:\s*["']([a-zA-Z0-9][a-zA-Z0-9._:/-]{1,79})["']\s*,\s*["']?name["']?\s*:\s*["']([^"'\n]{1,90})["']/g;
  for (const match of text.matchAll(pattern)) {
    const [, id, name] = match;
    if (!seen.has(id)) { seen.add(id); found.push({ id, name }); }
    if (found.length >= 80) break;
  }
  if (!found.length) {
    for (const match of text.matchAll(/modelId\s*[:=]\s*["']([a-zA-Z0-9][a-zA-Z0-9._:/-]{1,79})["']/g)) {
      if (!seen.has(match[1])) { seen.add(match[1]); found.push({ id: match[1], name: match[1] }); }
    }
  }
  return found;
}

function findCandidates(text: string, site: URL): string[] {
  const normalized = text.replace(/\\\//g, "/");
  const paths = new Set<string>();
  for (const match of normalized.matchAll(/\/(?:api\/)?(?:v\d+\/)?(?:chat\/completions|chat|completions|generate|inference)(?=[?"'`\s,)}]|$)/gi)) paths.add(match[0]);
  const sortedPaths = [...paths].sort((a, b) => scorePath(b) - scorePath(a)).slice(0, 8);
  const origins: string[] = [];
  const direct: string[] = [];
  for (const match of normalized.matchAll(/https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?(?:\/[a-zA-Z0-9_./-]*)?/g)) {
    try {
      const url = new URL(match[0]);
      if (/\/(?:chat\/completions|api\/chat|completions|generate|inference)\/?$/i.test(url.pathname)) direct.push(url.toString());
      if (/workers\.dev$|generativelanguage\.googleapis\.com$|^api\./i.test(url.hostname)) origins.push(url.origin);
    } catch { /* ignore */ }
  }
  const candidates = [...direct];
  for (const origin of [...new Set(origins)].slice(0, 8)) for (const p of sortedPaths.slice(0, 3)) candidates.push(origin + p);
  for (const p of sortedPaths.slice(0, 4)) candidates.push(site.origin + p);
  return [...new Set(candidates)].slice(0, 12);
}
function scorePath(path: string) { return path.includes("chat/completions") ? 5 : path.includes("api/chat") ? 4 : path.includes("completions") ? 3 : path.includes("generate") ? 2 : 1; }

export async function discoverSite(rawUrl: string): Promise<{ adapter: Adapter | null; report: ScanReport; message: string }> {
  const requestedSite = await validateUrl(rawUrl);
  const pageResponse = await safeFetch(requestedSite.toString(), { headers: { "User-Agent": "ProxyStudio/1.0 (static discovery)", Accept: "text/html" } }, 20_000);
  if (!pageResponse.ok) throw new Error(`Site returned HTTP ${pageResponse.status} while fetching the page.`);
  // Resolve bundles and infer Origin from the final, validated page URL after redirects.
  const site = pageResponse.url ? new URL(pageResponse.url) : requestedSite;
  const html = await readTextLimited(pageResponse, 2_000_000);
  const assets = linkedAssets(html, site.toString());
  let corpus = html;
  let bundlesScanned = 0;
  // Static GET only; bounded concurrency and size. No browser or script execution.
  const results = await Promise.all(assets.map(async (asset) => {
    try {
      const response = await safeFetch(asset, {}, 15_000);
      if (!response.ok) return "";
      const body = await readTextLimited(response, 3_000_000);
      bundlesScanned++;
      return body;
    } catch { return ""; }
  }));
  corpus += "\n" + results.join("\n");
  const fields = ["messages", "modelId", "model", "stream", "thinking", "deepSearch"].filter((x) => new RegExp(`\\b${x}\\b`).test(corpus));
  const models = findModels(corpus);
  const candidates = findCandidates(corpus, site);
  const report: ScanReport = { page: site.toString(), bundlesScanned, candidates, fields, models, attempts: [] };
  if (!candidates.length) return { adapter: null, report, message: "No likely chat endpoint was found in the linked public bundles. Paste a captured cURL or fetch request instead." };
  const modelKey = fields.includes("modelId") ? "modelId" : "model";
  const name = site.hostname.replace(/^www\./, "").split(".")[0];
  const modelList = models.length ? models : [{ id: "default", name: "default" }];
  const schema = { messages: ["messages"], model: [modelKey], stream: ["stream"], thinking: fields.includes("thinking") ? ["thinking"] : null, deepSearch: fields.includes("deepSearch") ? ["deepSearch"] : null };
  const template: Record<string, unknown> = { messages: [], [modelKey]: modelList[0].id, stream: true };
  if (schema.thinking) template.thinking = false;
  if (schema.deepSearch) template.deepSearch = false;
  // Probe only a small number of likely inference endpoints with a minimal prompt.
  for (const endpoint of candidates.slice(0, 3)) {
    const adapter: Adapter = { id: "", name, siteUrl: site.toString(), endpoint, origin: site.origin, referer: site.toString(), enabled: true, source: "discovered", createdAt: new Date().toISOString(), verifiedAt: null, headers: { "Content-Type": "application/json" }, requestTemplate: template, schema, models: modelList };
    const result = await probeAdapter(adapter);
    report.attempts.push({ endpoint, message: result.message });
    if (result.ok) { adapter.verifiedAt = new Date().toISOString(); return { adapter, report, message: result.message }; }
  }
  return { adapter: null, report, message: "The candidates could not be verified. This site may require authentication, a different payload, or a dynamically generated token. Paste its cURL or fetch request instead." };
}
