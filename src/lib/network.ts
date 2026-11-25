import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (ip.startsWith("::ffff:")) return isPrivateAddress(ip.slice(7));
  if (isIP(ip) === 4) {
    const n = ip.split(".").map(Number);
    return n[0] === 0 || n[0] === 10 || n[0] === 127 || n[0] >= 224 ||
      (n[0] === 169 && n[1] === 254) || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) ||
      (n[0] === 192 && n[1] === 168) || (n[0] === 100 && n[1] >= 64 && n[1] <= 127) ||
      (n[0] === 198 && (n[1] === 18 || n[1] === 19));
  }
  if (isIP(ip) === 6) return ip === "::" || ip === "::1" || /^(fc|fd|fe8|fe9|fea|feb|ff)/i.test(ip);
  return true;
}

/** Default-deny private and link-local targets. Local testing requires explicit opt-in. */
export async function validateUrl(value: string, allowWebSocket = false): Promise<URL> {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Enter a valid http or https URL."); }
  const allowedProto = allowWebSocket ? /^(?:https?|wss?):$/ : /^https?:$/;
  if (!allowedProto.test(url.protocol) || url.username || url.password) {
    throw new Error(allowWebSocket ? "Only http(s) and ws(s) URLs without embedded credentials are supported." : "Only http(s) URLs without embedded credentials are supported.");
  }
  if (process.env.STUDIO_ALLOW_PRIVATE_TARGETS !== "1") {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let addresses: { address: string }[];
    try { addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }); }
    catch { throw new Error(`Could not resolve ${host}.`); }
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
      throw new Error("Private, loopback and link-local addresses are blocked. Set STUDIO_ALLOW_PRIVATE_TARGETS=1 only for trusted local targets.");
    }
  }
  return url;
}

/** Bounded, manually redirected fetch. Each redirect is validated before following. */
export async function safeFetch(input: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  let target = input;
  let currentInit = init;
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  for (let i = 0; i < 4; i++) {
    await validateUrl(target);
    const response = await fetch(target, { ...currentInit, redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    // Do not forward captured credentials to a different host or turn a POST into a GET.
    const next = new URL(location, target);
    if (init.method && init.method.toUpperCase() !== "GET") throw new Error("Upstream redirected the POST; redirected chat requests are not followed.");
    if (new URL(target).origin !== next.origin && currentInit.headers) {
      const headers = new Headers(currentInit.headers);
      for (const name of [...headers.keys()]) {
        if (/authorization|cookie|token|api[-_]?key/i.test(name)) headers.delete(name);
      }
      currentInit = { ...currentInit, headers };
    }
    target = next.toString();
  }
  throw new Error("Too many redirects.");
}

export async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Response exceeded the scan size limit.");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}
