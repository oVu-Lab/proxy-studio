"use client";

import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bookmark,
  Check,
  CheckCircle2,
  CircleAlert,
  ClipboardPaste,
  CloudUpload,
  Copy,
  ExternalLink,
  GripVertical,
  LoaderCircle,
  Play,
  Radio,
  RefreshCw,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import { CSP_FALLBACK_HINT, NO_TRAFFIC_HINT } from "@/lib/human-errors";
import type { CaptureEventPublic, CaptureSessionPublic, ResponseFormat, StudioMode } from "@/lib/types";

const FORMAT_LABEL: Record<ResponseFormat, string> = {
  "openai-sse": "OpenAI SSE",
  "anthropic-sse": "Anthropic SSE",
  "custom-sse": "Custom SSE",
  ndjson: "NDJSON stream",
  json: "JSON",
  websocket: "WebSocket",
};

const KIND_LABEL: Record<CaptureEventPublic["kind"], string> = {
  telemetry: "Skipped",
  secondary: "Waiting",
  probe_failed: "Needs action",
  verified: "Verified",
};

function fmtTime(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtRemaining(expiresAt: string, now: number) {
  const ms = Math.max(0, Date.parse(expiresAt) - now);
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export default function CaptureModal({
  session,
  mode,
  base,
  copy,
  copied,
  onUpdate,
  onCompleted,
  onManualPaste,
  onClose,
  onCancel,
  onRestart,
  onOpenPlayground,
  onOpenExport,
}: {
  session: CaptureSessionPublic;
  mode: StudioMode;
  base: string;
  copy: (text: string, id: string) => void;
  copied: string;
  onUpdate: (next: CaptureSessionPublic) => void;
  onCompleted: (next: CaptureSessionPublic) => void;
  onManualPaste: (rawText: string) => Promise<{ ok: boolean; status?: string; message: string; actionTip?: string }>;
  onClose: () => void;
  onCancel: (id: string) => void;
  onRestart: (targetUrl: string) => void;
  onOpenPlayground: () => void;
  onOpenExport: () => void;
}) {
  const isGlobal = mode === "global" || session.mode === "global" || !session.callbackUrl;
  const [methodTab, setMethodTab] = useState<"console" | "bookmarklet" | "paste">("console");
  const [manualText, setManualText] = useState("");
  const [pasting, setPasting] = useState(false);
  const [pasteFeedback, setPasteFeedback] = useState<{
    kind: "error" | "info" | "success";
    message: string;
    actionTip?: string;
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [dragHint, setDragHint] = useState(false);
  const [quietWait, setQuietWait] = useState(false);
  const bookmarkRef = useRef<HTMLAnchorElement | null>(null);
  const completedRef = useRef(session.status === "completed");
  const callbacksRef = useRef({ onUpdate, onCompleted });
  callbacksRef.current = { onUpdate, onCompleted };

  // Bind javascript: href directly so drag-to-bookmarks-bar works natively without React URL warnings.
  useEffect(() => {
    const el = bookmarkRef.current;
    if (el && session.bookmarklet) {
      el.setAttribute("href", session.bookmarklet);
    }
  }, [session.bookmarklet, methodTab, session.status]);

  // Countdown clock & gentle "no traffic yet / check iframe" tip after 25s
  useEffect(() => {
    if (session.status === "completed" || session.status === "expired") return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [session.status]);

  useEffect(() => {
    if (isGlobal || session.status !== "listening" || session.events.length > 0) {
      setQuietWait(false);
      return;
    }
    const elapsed = Date.now() - Date.parse(session.createdAt);
    if (elapsed >= 25_000) {
      setQuietWait(true);
      return;
    }
    const timer = window.setTimeout(() => setQuietWait(true), Math.max(1000, 25_000 - elapsed));
    return () => window.clearTimeout(timer);
  }, [isGlobal, session.id, session.status, session.events.length, session.createdAt]);

  useEffect(() => {
    completedRef.current = session.status === "completed";
    setPasteFeedback(null);
    setManualText("");
  }, [session.id]);

  // Local mode: poll GET /api/capture/session/:id every 2 seconds while listening or probing
  useEffect(() => {
    if (isGlobal || session.status === "completed" || session.status === "expired") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/capture/session/${encodeURIComponent(session.id)}`, {
          cache: "no-store",
        });
        if (cancelled) return;
        if (res.status === 404) {
          callbacksRef.current.onUpdate({ ...session, status: "expired" });
          return;
        }
        if (!res.ok) return;
        const payload = (await res.json()) as { session?: CaptureSessionPublic };
        if (!payload.session || cancelled) return;
        callbacksRef.current.onUpdate(payload.session);
        if (payload.session.status === "completed" && !completedRef.current) {
          completedRef.current = true;
          callbacksRef.current.onCompleted(payload.session);
        }
      } catch {
        /* ignore transient poll error */
      }
    };
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isGlobal, session.id, session.status]);

  async function submitManualPaste() {
    if (!manualText.trim() || pasting) return;
    setPasting(true);
    setPasteFeedback(null);
    try {
      const res = await onManualPaste(manualText);
      if (res.ok && res.status === "completed") {
        setManualText("");
        setPasteFeedback({ kind: "success", message: res.message });
      } else {
        setPasteFeedback({
          kind: res.ok ? "info" : "error",
          message: res.message,
          actionTip: res.actionTip,
        });
      }
    } catch {
      setPasteFeedback({
        kind: "error",
        message: "Could not submit that payload right now. Make sure Proxy Studio is running and try again.",
      });
    } finally {
      setPasting(false);
    }
  }

  const active = session.status === "listening" || session.status === "probing";
  const isCompleted = session.status === "completed" && session.adapter;
  const isExpired = session.status === "expired";
  const canOpenTarget =
    /^https?:\/\//i.test(session.targetUrl) && session.targetHost !== "example.com" && session.targetHost !== "target site";

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal capture-modal card"
        role="dialog"
        aria-modal="true"
        aria-label="Live Browser Capture"
      >
        <div className="modal-head">
          <div className="capture-head-left">
            <div className="capture-head-row">
              <span className="section-eyebrow">
                <Radio size={12} /> LIVE BROWSER CAPTURE
              </span>
              <span className={`capture-pill ${session.status}`}>
                {session.status === "probing" ? (
                  <LoaderCircle size={11} className="spin" />
                ) : session.status === "completed" ? (
                  <CheckCircle2 size={11} />
                ) : (
                  <span className="capture-dot" />
                )}
                {session.status === "listening" &&
                  (isGlobal
                    ? "Browser-only · ready"
                    : `Listening · ${fmtRemaining(session.expiresAt, now)}`)}
                {session.status === "probing" && "Testing replay…"}
                {session.status === "completed" && (isGlobal ? "Saved in browser" : "Verified & saved")}
                {session.status === "expired" && "Session expired"}
              </span>
            </div>
            <h2>
              {isCompleted
                ? `${session.adapter!.name} is ready`
                : `Connect ${session.targetHost}`}
            </h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            title={active && !isGlobal ? "Keep listening in background" : "Close"}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body capture-body">
          {isCompleted && session.adapter ? (
            <div className="capture-done">
              <div className="capture-done-banner">
                <span className="capture-done-icon">
                  <CheckCircle2 size={20} />
                </span>
                <div>
                  <strong>
                    {isGlobal
                      ? "Saved privately in your browser (localStorage)"
                      : "Verified with a live test & saved to data/db.json"}
                  </strong>
                  <p>
                    {isGlobal ? (
                      <>
                        Only your browser can see this adapter and its headers. Export your own
                        free <strong>Cloudflare Worker</strong> or <strong>Local Proxy</strong> to
                        use it with zero quota cost on any client.
                      </>
                    ) : (
                      <>
                        Your adapter passed an independent replay probe
                        {session.analysis && session.analysis.latencyMs > 0
                          ? ` in ${session.analysis.latencyMs} ms`
                          : ""}{" "}
                        and is ready to use on <code>/v1/chat/completions</code> right now.
                      </>
                    )}
                  </p>
                </div>
              </div>

              {session.analysis && (
                <div className="capture-summary-grid">
                  <div className="capture-spec">
                    <span>ENDPOINT ({session.analysis.method})</span>
                    <code className="mono">{session.analysis.endpoint}</code>
                  </div>
                  <div className="capture-spec">
                    <span>DETECTED PROTOCOL</span>
                    <div className="capture-tags">
                      <span className="capture-tag green">
                        {FORMAT_LABEL[session.analysis.responseFormat]}
                      </span>
                      <span className="capture-tag">input: {session.analysis.inputMode}</span>
                      {session.analysis.bodyFormat !== "json" && (
                        <span className="capture-tag">{session.analysis.bodyFormat}</span>
                      )}
                      {session.analysis.hasCredentials && (
                        <span className="capture-tag">auth kept</span>
                      )}
                    </div>
                  </div>
                  <div className="capture-spec">
                    <span>INFERRED SCHEMA</span>
                    <div className="capture-tags">
                      {session.analysis.schemaFields.map((field) => (
                        <code className="capture-tag mono" key={field}>
                          {field}
                        </code>
                      ))}
                    </div>
                  </div>
                  <div className="capture-spec">
                    <span>MODELS ({session.adapter.models.length})</span>
                    <div className="capture-tags">
                      {session.adapter.models.slice(0, 8).map((m) => (
                        <code className="capture-tag mono" key={m.id}>
                          {session.adapter!.id}/{m.id}
                        </code>
                      ))}
                      {session.adapter.models.length > 8 && (
                        <span className="capture-tag">
                          +{session.adapter.models.length - 8} more
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {session.analysis?.responsePreview && (
                <div className="capture-preview">
                  <span>SAMPLE REPLY</span>
                  <p>{session.analysis.responsePreview}</p>
                </div>
              )}

              {!isGlobal && (
                <div className="isolated-url">
                  <span>ISOLATED BASE URL</span>
                  <div>
                    <code>{base}/proxy/{session.adapter.id}/v1</code>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => copy(`${base}/proxy/${session.adapter!.id}/v1`, "capture-iso")}
                      title="Copy isolated URL"
                    >
                      {copied === "capture-iso" ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : isExpired ? (
            <div className="capture-expired">
              <CircleAlert size={22} />
              <strong>This capture session timed out</strong>
              <p>
                Capture sessions automatically close after 15 minutes for safety. Click below to
                open a fresh listening session for {session.targetHost}.
              </p>
              <button
                type="button"
                className="button button-dark"
                onClick={() => onRestart(session.targetUrl)}
              >
                <RefreshCw size={14} /> Start new capture session
              </button>
            </div>
          ) : (
            <>
              <div className="capture-reason">
                <div className="capture-reason-text">
                  <CircleAlert size={15} />
                  <span>{session.reason}</span>
                </div>
                {canOpenTarget && (
                  <a
                    className="capture-open-link"
                    href={session.targetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open site <ExternalLink size={12} />
                  </a>
                )}
              </div>

              <ol className="capture-steps four" aria-label="Step-by-step capture instructions">
                <li>
                  <b>1</b>
                  <div>
                    <strong>Open Console</strong>
                    <span>Press <code>F12</code> (Mac: <code>⌥⌘I</code>) → Console tab</span>
                  </div>
                </li>
                <li>
                  <b>2</b>
                  <div>
                    <strong>Check iframe</strong>
                    <span>If embedded, change <code>top</code> dropdown to the chat iframe</span>
                  </div>
                </li>
                <li>
                  <b>3</b>
                  <div>
                    <strong>Paste &amp; Enter</strong>
                    <span>Run snippet below (or click Bookmarklet)</span>
                  </div>
                </li>
                <li>
                  <b>4</b>
                  <div>
                    <strong>Send 1 message</strong>
                    <span>
                      {isGlobal
                        ? <>Then type <code>copy(__proxyCapture.last)</code> &amp; paste</>
                        : "Auto-sends here & saves cleanly"}
                    </span>
                  </div>
                </li>
              </ol>

              <div className="tab-bar capture-tabs">
                <button
                  type="button"
                  className={methodTab === "console" ? "selected" : ""}
                  onClick={() => setMethodTab("console")}
                >
                  <Terminal size={14} /> DevTools Console
                </button>
                <button
                  type="button"
                  className={methodTab === "bookmarklet" ? "selected" : ""}
                  onClick={() => setMethodTab("bookmarklet")}
                >
                  <Bookmark size={14} /> Bookmarklet
                </button>
                <button
                  type="button"
                  className={methodTab === "paste" ? "selected" : ""}
                  onClick={() => setMethodTab("paste")}
                >
                  <ClipboardPaste size={14} /> Manual Paste Fallback
                </button>
              </div>

              {methodTab === "console" && (
                <div className="capture-snippet-box">
                  <div className="capture-snippet-bar">
                    <span>
                      Hooks <code>fetch</code>, <code>XHR</code>, <code>EventSource</code>,{" "}
                      <code>WebSocket</code> + iframes
                    </span>
                    <button
                      type="button"
                      className="button button-dark capture-copy-btn"
                      onClick={() => copy(session.consoleSnippet, "capture-snippet")}
                    >
                      {copied === "capture-snippet" ? <Check size={14} /> : <Copy size={14} />}
                      {copied === "capture-snippet" ? "Copied!" : "Copy snippet"}
                    </button>
                  </div>
                  <pre className="capture-code">
                    <code>{session.consoleSnippet}</code>
                  </pre>
                  <div className="capture-csp-tip">
                    <span>
                      {isGlobal ? (
                        <>
                          <strong>Global mode:</strong> After sending 1 message in chat, type{" "}
                          <code>copy(__proxyCapture.last)</code> in Console, press Enter, and paste
                          it in the fallback box.
                        </>
                      ) : (
                        <>
                          <strong>Blocked by CSP?</strong> If the console prints a red security
                          warning, run <code>copy(__proxyCapture.last)</code> and paste it here.
                        </>
                      )}
                    </span>
                    <button type="button" onClick={() => setMethodTab("paste")}>
                      Open paste box →
                    </button>
                  </div>
                </div>
              )}

              {methodTab === "bookmarklet" && (
                <div className="capture-bookmarklet-box">
                  <div className="bookmarklet-stage">
                    <a
                      ref={bookmarkRef}
                      draggable
                      className="bookmarklet-pill"
                      title="Drag onto your browser bookmarks bar"
                      onClick={(e) => {
                        e.preventDefault();
                        setDragHint(true);
                        copy(session.bookmarklet, "capture-bm");
                      }}
                    >
                      <GripVertical size={15} />
                      <span>Capture to Proxy Studio</span>
                    </a>
                    <button
                      type="button"
                      className="button button-outline"
                      onClick={() => copy(session.bookmarklet, "capture-bm")}
                    >
                      {copied === "capture-bm" ? <Check size={14} /> : <Copy size={14} />}
                      {copied === "capture-bm" ? "Copied URL!" : "Copy javascript: URL"}
                    </button>
                  </div>
                  <p className="capture-helper">
                    {dragHint
                      ? "Copied! Even faster: drag the dark button above onto your browser's bookmarks bar, open the AI chat tab, click it once, then send 1 message."
                      : `Drag the dark button straight onto your bookmarks bar. On ${session.targetHost}, click the bookmark once, watch for the green badge at bottom-right, then send 1 message.`}
                  </p>
                  <p className="capture-helper">
                    If the site blocks auto-send due to CSP, press <code>F12</code> → Console, type{" "}
                    <code>copy(__proxyCapture.last)</code>, and paste into{" "}
                    <button type="button" className="link-inline" onClick={() => setMethodTab("paste")}>
                      Manual Paste Fallback
                    </button>.
                  </p>
                </div>
              )}

              {methodTab === "paste" && (
                <div className="capture-paste-box">
                  <label className="field-label" htmlFor="manual-capture-input">
                    PASTE CAPTURED JSON, cURL, OR fetch()
                  </label>
                  <textarea
                    id="manual-capture-input"
                    className="field import-text"
                    rows={6}
                    value={manualText}
                    onChange={(e) => setManualText(e.target.value)}
                    placeholder={`Accepts any of:\n• Output of copy(__proxyCapture.last) or copy(__proxyCapture.all)\n• DevTools → Network → Fetch/XHR → Right-click → Copy as cURL\n• DevTools → Network → Copy as fetch(...)`}
                  />
                  <div className="capture-paste-actions">
                    <p className="capture-helper">
                      Handles JSON, <code>text/plain</code> JSON, <code>FormData</code>, URL-encoded forms,{" "}
                      <code>GET</code> params, <code>EventSource</code>, and <code>WebSocket</code>.
                    </p>
                    <button
                      type="button"
                      className="button button-dark"
                      disabled={!manualText.trim() || pasting}
                      onClick={() => void submitManualPaste()}
                    >
                      {pasting ? (
                        <LoaderCircle size={15} className="spin" />
                      ) : (
                        <ClipboardPaste size={15} />
                      )}
                      {pasting
                        ? isGlobal
                          ? "Analyzing…"
                          : "Analyzing & testing…"
                        : isGlobal
                          ? "Analyze & save"
                          : "Analyze & verify"}
                    </button>
                  </div>
                  {pasteFeedback && (
                    <div
                      className={`inline-message ${pasteFeedback.kind === "success" ? "success" : "error"}`}
                      role="status"
                    >
                      {pasteFeedback.kind === "success" ? (
                        <CheckCircle2 size={15} />
                      ) : (
                        <CircleAlert size={15} />
                      )}
                      <div>
                        <span>{pasteFeedback.message}</span>
                        {pasteFeedback.actionTip && (
                          <small className="feedback-tip">{pasteFeedback.actionTip}</small>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="capture-troubleshoot">
                    <strong>Quick cheatsheet:</strong>
                    <span>
                      <b>CSP blocked?</b> {CSP_FALLBACK_HINT}
                    </span>
                    <span>
                      <b>Login / 401 / 403 error?</b> Open DevTools → <b>Network</b> → filter{" "}
                      <b>Fetch/XHR</b> → right-click the chat call → <b>Copy as cURL</b> → paste above.
                    </span>
                  </div>
                </div>
              )}

              {!isGlobal && session.callbackUrl && (
                <div className="capture-callback-line">
                  <ShieldCheck size={13} />
                  <span>Auto-callback</span>
                  <code className="mono">{session.callbackUrl}</code>
                </div>
              )}

              {!isGlobal && (
                <div className="capture-feed">
                  <div className="capture-feed-head">
                    <span>
                      <Activity size={13} /> LIVE FEED
                    </span>
                    <small>
                      {session.events.length
                        ? `${session.events.length} received · still listening`
                        : "Checking every 2s · waiting for your message"}
                    </small>
                  </div>

                  {quietWait && session.events.length === 0 && (
                    <div className="capture-nudge" role="status">
                      <CircleAlert size={15} />
                      <div>
                        <strong>Still waiting for traffic</strong>
                        <p>{NO_TRAFFIC_HINT}</p>
                        <button type="button" onClick={() => setMethodTab("paste")}>
                          Blocked by CSP? Paste copy(__proxyCapture.last) or cURL →
                        </button>
                      </div>
                    </div>
                  )}

                  {session.events.length === 0 && !quietWait ? (
                    <div className="capture-feed-empty">
                      <span className="capture-pulse" />
                      <p>
                        Listening cleanly. Static assets, Firestore writes, Google Analytics, and
                        Sentry are skipped automatically — unknown chat APIs, forms, and WebSockets
                        are captured too.
                      </p>
                    </div>
                  ) : session.events.length > 0 ? (
                    <div className="capture-events">
                      {session.events.slice(0, 8).map((ev) => (
                        <div className={`capture-event ${ev.kind}`} key={ev.id}>
                          <div className="capture-event-top">
                            <span className={`event-badge ${ev.kind}`}>{KIND_LABEL[ev.kind]}</span>
                            <code className="mono">
                              {ev.method} {ev.endpoint}
                            </code>
                            <span className="capture-event-time">
                              {ev.status ? `${ev.status} · ` : ""}
                              {fmtTime(ev.at)}
                            </span>
                          </div>
                          <p>{ev.message}</p>
                          {ev.kind === "probe_failed" &&
                            (ev.errorCode === "auth_required" ||
                              ev.errorCode === "csp_blocked" ||
                              ev.errorCode === "not_found" ||
                              ev.errorCode === "websocket_info") && (
                              <button
                                type="button"
                                className="event-action-btn"
                                onClick={() => setMethodTab("paste")}
                              >
                                Open Manual Paste Fallback →
                              </button>
                            )}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          {active ? (
            <>
              <button
                type="button"
                className="delete-button"
                onClick={() => onCancel(session.id)}
              >
                {isGlobal ? "Cancel" : "Stop session"}
              </button>
              <div>
                {methodTab !== "paste" && (
                  <button
                    type="button"
                    className="button button-outline"
                    onClick={() => setMethodTab("paste")}
                  >
                    <ClipboardPaste size={14} /> Manual paste
                  </button>
                )}
                <button type="button" className="button button-dark" onClick={onClose}>
                  {isGlobal ? "Close" : "Listen in background"}
                </button>
              </div>
            </>
          ) : isCompleted ? (
            <>
              <button type="button" className="button button-outline" onClick={onClose}>
                Done
              </button>
              {isGlobal ? (
                <button type="button" className="button button-dark" onClick={onOpenExport}>
                  <CloudUpload size={14} /> Export Personal Gateway <ArrowRight size={14} />
                </button>
              ) : (
                <button type="button" className="button button-dark" onClick={onOpenPlayground}>
                  <Play size={14} fill="currentColor" /> Test in Playground <ArrowRight size={14} />
                </button>
              )}
            </>
          ) : (
            <>
              <span />
              <button type="button" className="button button-outline" onClick={onClose}>
                Close
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
