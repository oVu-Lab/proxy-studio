"use client";

import { useEffect, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  CloudUpload,
  Globe2,
  LoaderCircle,
  Play,
} from "lucide-react";
import "@/components/overview-hero.css";

type Line = { t: string; k?: "prompt" | "model" };

const SCENARIOS: { id: string; label: string; found: string; lines: Line[] }[] = [
  {
    id: "json",
    label: "JSON chat",
    found: "The prompt goes in messages and the model in modelId.",
    lines: [
      { t: "POST /api/chat" },
      { t: "{" },
      { t: '  "modelId": "gpt-6-astra",', k: "model" },
      { t: '  "messages": [ … ],', k: "prompt" },
      { t: '  "deepSearch": false' },
      { t: "}" },
    ],
  },
  {
    id: "text",
    label: "Plain text",
    found: "The whole request body is the prompt.",
    lines: [
      { t: "POST /ask" },
      { t: "Content-Type: text/plain" },
      { t: "" },
      { t: "What is an API gateway?", k: "prompt" },
    ],
  },
  {
    id: "ws",
    label: "WebSocket",
    found: "The prompt goes in say and the model in bot.",
    lines: [
      { t: "WS wss://chat.example/live" },
      { t: "{" },
      { t: '  "bot": "nova",', k: "model" },
      { t: '  "say": "What is an API gateway?"', k: "prompt" },
      { t: "}" },
    ],
  },
];

const STANDARD: Line[] = [
  { t: "POST /v1/chat/completions" },
  { t: "{" },
  { t: '  "model": "site/model",', k: "model" },
  { t: '  "messages": [ … ],', k: "prompt" },
  { t: '  "stream": true' },
  { t: "}" },
];

function CodeLines({ lines }: { lines: Line[] }) {
  return (
    <pre className="ov-code">
      {lines.map((l, i) => (
        <span key={i} className={l.k ? "ov-line ov-hit" : "ov-line"}>
          {l.t || " "}
        </span>
      ))}
    </pre>
  );
}

export default function OverviewHero({
  isGlobal,
  url,
  setUrl,
  working,
  onDiscover,
  adapterCount,
  modelCount,
  notice,
  showNotice,
  hasBackgroundCapture,
  onOpenCapture,
  onPasteInstead,
  onOpenPlayground,
  onOpenExport,
}: {
  isGlobal: boolean;
  url: string;
  setUrl: (v: string) => void;
  working: boolean;
  onDiscover: () => void;
  adapterCount: number;
  modelCount: number;
  notice: { kind: "success" | "error"; text: string } | null;
  showNotice: boolean;
  hasBackgroundCapture: boolean;
  onOpenCapture: () => void;
  onPasteInstead: () => void;
  onOpenPlayground: () => void;
  onOpenExport: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  useEffect(() => {
    if (paused || reduced) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % SCENARIOS.length), 4800);
    return () => window.clearInterval(timer);
  }, [paused, reduced]);

  const scenario = SCENARIOS[index];

  return (
    <section className="ov-hero" aria-labelledby="ov-title">
      <div className="ov-copy">
        <h1 id="ov-title" className="ov-title">
          Any AI chat site becomes an OpenAI API.
        </h1>
        <p className="ov-lede">
          {isGlobal
            ? "Paste a chat site’s address. Proxy Studio finds the request it sends, learns its shape, and saves it in this browser. Export a gateway and your tools can call it."
            : "Paste a chat site’s address. Proxy Studio finds the request it sends and serves it at /v1 on this machine, ready for Cherry Studio, Magpie, or the OpenAI SDK."}
        </p>

        <form
          className="ov-form"
          onSubmit={(e) => {
            e.preventDefault();
            onDiscover();
          }}
        >
          <label className="ov-field">
            <Globe2 size={18} aria-hidden="true" />
            <span className="ov-sr">Chat website address</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://rusherai.com/"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button type="submit" className="ov-go" disabled={working}>
            {working ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}
            {working ? "Scanning…" : isGlobal ? "Start capture" : "Connect site"}
          </button>
        </form>

        {showNotice && notice && (
          <div className={`inline-message ${notice.kind} ov-notice`} role="status">
            {notice.kind === "success" ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
            <span>{notice.text}</span>
            {notice.kind === "error" && hasBackgroundCapture && (
              <button type="button" onClick={onOpenCapture}>
                Open live capture
              </button>
            )}
            {notice.kind === "error" && !hasBackgroundCapture && (
              <button type="button" onClick={onPasteInstead}>
                Paste a request instead
              </button>
            )}
          </div>
        )}

        <div className="ov-links">
          <button type="button" onClick={onPasteInstead}>
            Paste a cURL or fetch request instead
          </button>
          {isGlobal ? (
            <button type="button" onClick={onOpenExport}>
              <CloudUpload size={14} /> Export your gateway
            </button>
          ) : (
            <button type="button" onClick={onOpenPlayground}>
              <Play size={13} fill="currentColor" /> Try the playground
            </button>
          )}
        </div>

        <p className="ov-status">
          <span className="status-dot" />
          {adapterCount} {adapterCount === 1 ? "adapter" : "adapters"} ready, {modelCount}{" "}
          {modelCount === 1 ? "model" : "models"} available.{" "}
          {isGlobal ? "Everything stays in this browser." : "Everything stays on this machine."}
        </p>
      </div>

      <div
        className="ov-morph"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={() => setPaused(false)}
      >
        <div className="ov-tabs" role="tablist" aria-label="Kinds of chat request">
          {SCENARIOS.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              className="ov-tab"
              onClick={() => setIndex(i)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="ov-stage">
          <div className="ov-side ov-site">
            <h2>What the site sends</h2>
            <div key={scenario.id} className="ov-swap">
              <CodeLines lines={scenario.lines} />
            </div>
          </div>
          <div className="ov-seam" aria-hidden="true">
            <span>
              <svg viewBox="0 0 32 32" width="20" height="20" fill="none">
                <path d="M7 7.5h7.5v7.2H7zM17.5 7.5H25v7.2h-7.5zM7 17.4h7.5v7.2H7z" fill="currentColor" />
                <path d="M17.5 17.4H25v7.2h-7.5z" fill="currentColor" opacity=".52" />
              </svg>
            </span>
          </div>
          <div className="ov-side ov-std">
            <h2>What your tools send</h2>
            <CodeLines lines={STANDARD} />
          </div>
        </div>

        <p className="ov-found" aria-live="polite">
          <span className="ov-found-label">Proxy Studio learned</span>
          <span key={scenario.id} className="ov-swap">
            {scenario.found}
          </span>
        </p>
      </div>
    </section>
  );
}
