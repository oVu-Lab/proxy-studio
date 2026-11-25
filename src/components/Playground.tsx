"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  CircleAlert,
  Cloud,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  UserRound,
} from "lucide-react";
import {
  loadPlaygroundHistory,
  savePlaygroundHistory,
  type SavedTurn,
} from "@/lib/browser-store";
import type { PublicAdapter, StudioMode } from "@/lib/types";

export default function Playground({
  adapters,
  mode,
  authRequired,
  personalGatewayUrl,
  personalApiKey,
  preferredModel,
  onComplete,
  onRecordGlobalLog,
  onOpenExport,
}: {
  adapters: PublicAdapter[];
  mode: StudioMode;
  authRequired: boolean;
  personalGatewayUrl?: string;
  personalApiKey?: string;
  preferredModel?: string;
  onComplete: () => void;
  onRecordGlobalLog?: (entry: {
    adapterId: string;
    adapterName: string;
    model: string;
    status: number;
    durationMs: number;
    stream: boolean;
    error?: string;
  }) => void;
  onOpenExport?: () => void;
}) {
  const enabled = adapters.filter((a) => a.enabled);
  const choices = enabled.flatMap((a) =>
    a.models.map((m) => ({ id: `${a.id}/${m.id}`, name: m.name, adapter: a })),
  );
  const [selected, setSelected] = useState(preferredModel || "");
  const model = choices.some((c) => c.id === selected)
    ? selected
    : preferredModel && choices.some((c) => c.id === preferredModel)
      ? preferredModel
      : choices[0]?.id || "";
  const current = useMemo(() => choices.find((c) => c.id === model), [model, choices]);
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<SavedTurn[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [key, setKey] = useState(personalApiKey || "");
  const [thinking, setThinking] = useState(false);
  const [search, setSearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);

  // Per-user local conversation persistence in browser localStorage
  useEffect(() => {
    setTurns(loadPlaygroundHistory());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated && !busy) {
      savePlaygroundHistory(turns);
    }
  }, [turns, hydrated, busy]);

  useEffect(() => {
    if (mode === "global" && personalApiKey !== undefined) {
      setKey(personalApiKey);
    }
  }, [mode, personalApiKey]);

  const normalizedGateway = (personalGatewayUrl || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");
  const needsGlobalEndpoint = mode === "global" && !normalizedGateway;

  async function send() {
    if (!input.trim() || !model || busy) return;
    if (needsGlobalEndpoint) {
      setError(
        "Export and deploy your free personal Worker (or start local proxy.mjs), then save its URL in Export Gateway so chat never burns the host's quota.",
      );
      return;
    }
    if (mode === "local" && authRequired && !key) {
      setError("Enter your local API key on the right to send requests.");
      return;
    }

    const started = Date.now();
    const history: SavedTurn[] = [...turns, { role: "user", content: input.trim() }];
    setTurns([...history, { role: "assistant", content: "" }]);
    setInput("");
    setError("");
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;

    const chosen =
      model +
      (thinking && current?.adapter.schema.thinking ? "-think" : "") +
      (search && current?.adapter.schema.deepSearch ? "-search" : "");
    const endpoint =
      mode === "global"
        ? `${normalizedGateway}/v1/chat/completions`
        : "/v1/chat/completions";

    let finalStatus = 200;
    let errText = "";
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ model: chosen, messages: history, stream: true }),
      });
      finalStatus = response.status;
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error?.message || `Gateway returned HTTP ${response.status}.`);
      }
      if (!response.body) throw new Error("No response stream received from the gateway.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let payload: {
            choices?: { delta?: { content?: string } }[];
            error?: { message?: string };
          };
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }
          if (payload.error) throw new Error(payload.error.message || "Stream interrupted.");
          const text = payload.choices?.[0]?.delta?.content;
          if (text) {
            setTurns((old) =>
              old.map((turn, i) =>
                i === old.length - 1 ? { ...turn, content: turn.content + text } : turn,
              ),
            );
          }
        }
      }
    } catch (e) {
      if (!(e instanceof Error && e.name === "AbortError")) {
        errText =
          e instanceof Error
            ? e.message
            : "Could not reach your gateway. Double-check the URL is running and accessible.";
        if (finalStatus < 400) finalStatus = 502;
        setError(errText);
      } else {
        finalStatus = 499;
      }
      setTurns((old) =>
        old.filter((turn, i) => !(i === old.length - 1 && turn.role === "assistant" && !turn.content)),
      );
    } finally {
      setBusy(false);
      abort.current = null;
      if (mode === "global" && onRecordGlobalLog && current) {
        onRecordGlobalLog({
          adapterId: current.adapter.id,
          adapterName: current.adapter.name,
          model: chosen,
          status: finalStatus,
          durationMs: Date.now() - started,
          stream: true,
          ...(errText ? { error: errText.slice(0, 140) } : {}),
        });
      }
      onComplete();
    }
  }

  return (
    <div className="playground-layout">
      <div className="playground-main card">
        <div className="playground-top">
          <div>
            <span className="eyebrow">LIVE TEST</span>
            <h2>Try your gateway</h2>
            <p>
              {mode === "global"
                ? normalizedGateway
                  ? `Connected directly to your personal gateway (${normalizedGateway}/v1).`
                  : "Global zero-quota mode: attach your own exported Worker or Local Proxy to chat."
                : "Send a real request through your local OpenAI-compatible API. History saves privately in this browser."}
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            title="Clear conversation"
            onClick={() => {
              if (!busy) {
                setTurns([]);
                savePlaygroundHistory([]);
                setError("");
              }
            }}
          >
            <RotateCcw size={16} />
          </button>
        </div>

        {needsGlobalEndpoint && (
          <div className="global-pg-banner">
            <Cloud size={17} />
            <div>
              <strong>Connect your personal /v1 gateway (0 host quota)</strong>
              <p>
                Export your own free <code>worker.js</code> (100k/day free on your Cloudflare
                account) or download local <code>proxy.mjs</code>, then paste its URL to chat here.
              </p>
            </div>
            {onOpenExport && (
              <button type="button" className="button button-dark" onClick={onOpenExport}>
                Export gateway →
              </button>
            )}
          </div>
        )}

        <div className="chat-area">
          {turns.length === 0 ? (
            <div className="chat-empty">
              <div className="chat-empty-icon">
                <Sparkles size={22} />
              </div>
              <h3>Start a conversation</h3>
              <p>Choose a model, say hello, and watch the response stream in.</p>
              <button
                type="button"
                className="suggestion"
                onClick={() => setInput("Explain what an API gateway does in one sentence.")}
              >
                Explain what an API gateway does <span>↗</span>
              </button>
            </div>
          ) : (
            turns.map((turn, index) => (
              <div className={`turn ${turn.role}`} key={index}>
                <div className="turn-avatar">
                  {turn.role === "assistant" ? <Bot size={16} /> : <UserRound size={16} />}
                </div>
                <div>
                  <div className="turn-label">{turn.role === "assistant" ? "Assistant" : "You"}</div>
                  <div className="turn-content">
                    {turn.content ||
                      (busy && index === turns.length - 1 ? (
                        <span className="typing">
                          <i />
                          <i />
                          <i />
                        </span>
                      ) : (
                        ""
                      ))}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {error && (
          <div className="inline-message error">
            <CircleAlert size={15} />
            <span>{error}</span>
          </div>
        )}

        <div className="chat-composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={
              needsGlobalEndpoint
                ? "Connect your personal Worker or local proxy.mjs URL first…"
                : "Ask anything..."
            }
            rows={2}
          />
          <div className="composer-bottom">
            <span>Enter to send · Shift + Enter for a new line</span>
            {busy ? (
              <button
                type="button"
                className="send-button"
                onClick={() => abort.current?.abort()}
                title="Stop"
              >
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                className="send-button"
                disabled={!input.trim() || !model}
                onClick={() => void send()}
                title="Send message"
              >
                <Send size={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      <aside className="playground-settings card">
        <span className="eyebrow">CONFIGURATION</span>
        <h3>Request settings</h3>
        <p>Changes apply to your next message.</p>
        <label className="field-label">MODEL</label>
        <select
          className="field"
          value={model}
          onChange={(e) => {
            setSelected(e.target.value);
            setThinking(false);
            setSearch(false);
          }}
          disabled={!choices.length}
        >
          {!choices.length && <option>No enabled models</option>}
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.name} · {choice.adapter.name}
            </option>
          ))}
        </select>
        <p className="field-hint mono">{model || "Enable an adapter to get started"}</p>
        <div className="setting-separator" />
        <label className="check-row">
          <span>
            <strong>Thinking mode</strong>
            <small>
              Append <code>-think</code> to the model
            </small>
          </span>
          <input
            type="checkbox"
            checked={thinking}
            disabled={!current?.adapter.schema.thinking}
            onChange={(e) => setThinking(e.target.checked)}
          />
        </label>
        <label className="check-row">
          <span>
            <strong>Deep search</strong>
            <small>
              Append <code>-search</code> to the model
            </small>
          </span>
          <input
            type="checkbox"
            checked={search}
            disabled={!current?.adapter.schema.deepSearch}
            onChange={(e) => setSearch(e.target.checked)}
          />
        </label>
        <div className="setting-separator" />
        {mode === "global" || authRequired ? (
          <>
            <label className="field-label">
              {mode === "global" ? "GATEWAY API KEY (IF SET)" : "LOCAL API KEY"}
            </label>
            <input
              className="field"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={mode === "global" ? "Optional Bearer key" : "Enter your local key"}
            />
            <p className="field-hint">Sent only to your own gateway.</p>
          </>
        ) : (
          <div className="settings-note">
            <span className="status-dot" />
            No local API key required
          </div>
        )}
        <div className="playground-tip">
          <Sparkles size={15} />
          <p>
            Chat history is kept privately in your browser&apos;s <code>localStorage</code>. Model
            names and availability depend on each upstream website.
          </p>
        </div>
      </aside>
    </div>
  );
}
