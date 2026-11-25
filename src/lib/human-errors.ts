import type { CaptureErrorCode } from "@/lib/types";

export type HumanError = {
  code: CaptureErrorCode;
  title: string;
  message: string;
  actionTip: string;
  recommendedAction?: "paste-fallback" | "copy-curl" | "check-iframe" | "retry";
};

/**
 * Translates raw probe/network/capture errors into calm, beginner-friendly plain English
 * with a single concrete next action (no cryptic HTTP codes or vague "Probe failed" lines).
 */
export function translateProbeError(opts: {
  statusCode?: number;
  rawMessage?: string;
  transport?: string;
  timedOut?: boolean;
}): HumanError {
  const code = opts.statusCode;
  const raw = (opts.rawMessage || "").toLowerCase();

  // 1. Auth / HttpOnly login cookies / Origin rejection (401 / 403)
  if (code === 401 || code === 403 || /\b(401|403|unauthorized|forbidden)\b/.test(raw)) {
    return {
      code: "auth_required",
      title: "Login cookies or auth headers required",
      message:
        "This site requires login cookies (HttpOnly) that Console scripts can't read. Switch to DevTools → Network → Fetch/XHR → Right-click the chat request → Copy as cURL, and paste it below.",
      actionTip: "Open the Manual Paste Fallback tab below and paste your Copy as cURL command.",
      recommendedAction: "copy-curl",
    };
  }

  // 2. Explicit CSP / Mixed Content / Private Network failure
  if (/csp|content-security-policy|mixed content|private network|blocked by.*policy|failed to fetch/.test(raw)) {
    return {
      code: "csp_blocked",
      title: "Website blocked automatic send (CSP)",
      message:
        "The website blocked direct sending. Type copy(__proxyCapture.last) in Console and press Enter, then paste it into the fallback box below.",
      actionTip: "Run copy(__proxyCapture.last) in Console, then paste in Manual Paste Fallback.",
      recommendedAction: "paste-fallback",
    };
  }

  // 3. Timeout
  if (opts.timedOut || code === 408 || code === 504 || /timed out|timeout|aborted/.test(raw)) {
    return {
      code: "timeout",
      title: "Endpoint took too long to reply",
      message:
        "The chat server didn't respond within 25 seconds. Some free models warm up slowly, or the chat may live in an embedded iframe. Wait a moment and send one more chat message, or paste a fresh Copy as cURL below.",
      actionTip: "Try sending 1 message again, or check if the chat runs inside an iframe.",
      recommendedAction: "check-iframe",
    };
  }

  // 4. Rate limited
  if (code === 429 || /rate limit|too many requests/.test(raw)) {
    return {
      code: "rate_limited",
      title: "Rate limit hit temporarily",
      message:
        "The website asked us to slow down right now. Wait 15–30 seconds and send another test message, or click Retry.",
      actionTip: "Wait a moment, then send one new chat message or paste the request again.",
      recommendedAction: "retry",
    };
  }

  // 5. Wrong endpoint / non-chat route (404 / 405 / 400 / 422)
  if (code === 404 || code === 405 || code === 400 || code === 422) {
    return {
      code: "not_found",
      title: "Caught a request, but it wasn't replayable as chat",
      message:
        code === 400 || code === 422
          ? "The site turned down our test message — it probably needs a fresh one-time token or an extra field from the page. Try right-clicking the real chat call in DevTools → Network → Copy as cURL and paste it below."
          : "That endpoint wasn't the main chat URL (probably a background call). Keep this panel open and type a new chat message on the site.",
      actionTip:
        code === 400 || code === 422
          ? "Paste Copy as cURL in Manual Paste Fallback below, or send another message."
          : "Still listening — send 1 real message in the chat window.",
      recommendedAction: code === 400 || code === 422 ? "copy-curl" : "retry",
    };
  }

  // 6. SSRF / private loopback safety guard
  if (/private|loopback|link-local/.test(raw)) {
    return {
      code: "blocked_host",
      title: "Local network address blocked for safety",
      message:
        "Proxy Studio blocks private/localhost upstreams by default to protect your machine. If you intentionally want to connect a local AI server, launch Proxy Studio with STUDIO_ALLOW_PRIVATE_TARGETS=1.",
      actionTip: "Only connect public sites, or restart with STUDIO_ALLOW_PRIVATE_TARGETS=1.",
    };
  }

  // 7. WebSocket handshake failure
  if (opts.transport === "websocket") {
    return {
      code: "websocket_info",
      title: "WebSocket couldn't be replayed automatically",
      message:
        "We saw the site's WebSocket chat connection, but it rejected our direct replay (usually due to login cookies or single-use handshake tokens). Send another message or paste a full Copy as cURL if the site also uses an HTTP endpoint.",
      actionTip: "Try sending another chat message, or use Paste cURL for cookie-gated sites.",
      recommendedAction: "copy-curl",
    };
  }

  // 8. Unrecognized chat payload shape
  if (/recognizable|no recognizable|reply field/.test(raw)) {
    return {
      code: "unrecognized_response",
      title: "Endpoint answered, but not like a chat message",
      message:
        "We reached that endpoint, but its reply didn't contain AI chat text — it was likely a helper call (like loading a thread or checking credits). Keep listening and send one new chat message.",
      actionTip: "Send 1 real message in the chat, or switch the Console 'top' dropdown if the chat is in an iframe.",
      recommendedAction: "check-iframe",
    };
  }

  // 9. Generic server/network issue
  return {
    code: "network",
    title: "Couldn't reach that chat endpoint",
    message:
      "The website returned an unexpected response when Proxy Studio ran a safe reply test. Send one more message in the chat tab, or paste Copy as cURL into the Manual Paste Fallback tab below.",
    actionTip: "Still listening — send 1 message or paste your request in Manual Paste Fallback.",
    recommendedAction: "paste-fallback",
  };
}

export const NO_TRAFFIC_HINT =
  'No chat request received yet. Make sure you sent a message, or check if the chat is inside an iframe (click "top" at the top-left of DevTools Console, pick the chat iframe, and paste the script again).';

export const CSP_FALLBACK_HINT =
  "The website blocked direct sending. Type copy(__proxyCapture.last) in Console and press Enter, then paste it into the Manual Paste Fallback box below.";

export const AUTH_COOKIE_HINT =
  "This site requires login cookies (HttpOnly) that Console scripts can't read. Switch to DevTools → Network → Fetch/XHR → Right-click the chat request → Copy as cURL, and paste it below.";
