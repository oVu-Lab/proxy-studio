"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Cloud,
  CloudUpload,
  Code2,
  Copy,
  Globe2,
  KeyRound,
  Laptop,
  LayoutGrid,
  Link2,
  LoaderCircle,
  LockKeyhole,
  MessageSquare,
  Network,
  Pencil,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import CaptureModal from "@/components/CaptureModal";
import ExportPanel from "@/components/ExportPanel";
import Playground from "@/components/Playground";
import {
  appendBrowserLog,
  clearBrowserLogs,
  createBrowserCaptureSession,
  deleteBrowserAdapter,
  ingestBrowserManualInput,
  loadBrowserAdapters,
  loadBrowserLogs,
  loadBrowserSettings,
  loadModePreference,
  patchBrowserAdapter,
  resetBrowserAdapters,
  saveBrowserSettings,
  saveModePreference,
} from "@/lib/browser-store";
import {
  publicAdapter,
  type Adapter,
  type CaptureSessionPublic,
  type PublicAdapter,
  type RequestLog,
  type StudioMode,
} from "@/lib/types";

export type StudioState = {
  adapters: PublicAdapter[];
  logs: RequestLog[];
  authRequired: boolean;
  envKey: boolean;
};

type View = "overview" | "export" | "playground" | "activity" | "settings" | "guide";
type Report = {
  bundlesScanned: number;
  candidates: string[];
  fields: string[];
  models: { id: string }[];
  attempts: { endpoint: string; message: string }[];
};
type Notice = { kind: "success" | "error"; text: string };

const STATIC_BUILD_MODE = process.env.NEXT_PUBLIC_STUDIO_MODE === "global";

function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? "small" : ""}`}>
      <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path d="M7 7.5h7.5v7.2H7zM17.5 7.5H25v7.2h-7.5zM7 17.4h7.5v7.2H7z" fill="currentColor" />
        <path d="M17.5 17.4H25v7.2h-7.5z" fill="currentColor" opacity=".52" />
      </svg>
    </span>
  );
}

function shortTime(value: string) {
  const date = new Date(value);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".local")
  );
}

export default function Studio({
  initial,
  staticOnly = false,
}: {
  initial: StudioState;
  staticOnly?: boolean;
}) {
  const forcedGlobal = staticOnly || STATIC_BUILD_MODE;
  const [view, setView] = useState<View>("overview");
  const [mode, setMode] = useState<StudioMode>(forcedGlobal ? "global" : "local");
  const [serverAvailable, setServerAvailable] = useState(!forcedGlobal);
  const [modePref, setModePref] = useState<"auto" | "local" | "global">("auto");
  const [data, setData] = useState<StudioState>(initial);
  const [browserAdapters, setBrowserAdapters] = useState<Adapter[]>([]);
  const [personalGatewayUrl, setPersonalGatewayUrl] = useState("");
  const [personalApiKey, setPersonalApiKey] = useState("");
  const [ready, setReady] = useState(true);
  const [base, setBase] = useState("http://localhost:8088");
  const [tab, setTab] = useState<"discover" | "import">("discover");
  const [url, setUrl] = useState("");
  const [pasted, setPasted] = useState("");
  const [importName, setImportName] = useState("");
  const [importModel, setImportModel] = useState("");
  const [working, setWorking] = useState(false);
  const [testing, setTesting] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [copied, setCopied] = useState("");
  const [codeTab, setCodeTab] = useState<"curl" | "python">("curl");
  const [edit, setEdit] = useState<PublicAdapter | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [captureSession, setCaptureSession] = useState<CaptureSessionPublic | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [preferredModel, setPreferredModel] = useState<string | undefined>(undefined);

  const syncBrowserState = useCallback(() => {
    const adapters = loadBrowserAdapters();
    const logs = loadBrowserLogs();
    const settings = loadBrowserSettings();
    setBrowserAdapters(adapters);
    setPersonalGatewayUrl(settings.personalGatewayUrl);
    setPersonalApiKey(settings.personalApiKey);
    setData({
      adapters: adapters.map(publicAdapter),
      logs,
      authRequired: Boolean(settings.personalApiKey),
      envKey: false,
    });
    setReady(true);
  }, []);

  const refreshLocal = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) throw new Error();
      setData(await res.json());
      setServerAvailable(true);
      setReady(true);
      return true;
    } catch {
      return false;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (mode === "global") {
      syncBrowserState();
      return;
    }
    const ok = await refreshLocal();
    if (!ok) {
      // Static Cloudflare Pages deploy (no backend API routes): smoothly auto-enter Global Zero-Quota Mode.
      setServerAvailable(false);
      setMode("global");
      syncBrowserState();
    }
  }, [mode, refreshLocal, syncBrowserState]);

  // Initial mount: smart dual-mode detection (Local on npm start; Global browser-isolated on Cloudflare Pages or user opt-in)
  useEffect(() => {
    setBase(window.location.origin);
    const pref = loadModePreference();
    setModePref(pref);
    const isPublicHost = !isLocalHostname(window.location.hostname);
    const params = new URLSearchParams(window.location.search);
    const queryGlobal = params.get("mode") === "global";

    if (forcedGlobal || queryGlobal || pref === "global") {
      setMode("global");
      if (forcedGlobal) setServerAvailable(false);
      syncBrowserState();
      return;
    }

    void (async () => {
      const ok = await refreshLocal();
      if (!ok) {
        setServerAvailable(false);
        setMode("global");
        syncBrowserState();
      } else if (isPublicHost && pref === "auto") {
        // Live Next.js backend reachable on a non-local preview host: stay in local mode with Export Gateway accessible.
        setMode("local");
      }
    })();
  }, [forcedGlobal, refreshLocal, syncBrowserState]);

  function switchMode(next: "local" | "global") {
    if (next === "local" && (forcedGlobal || !serverAvailable)) return;
    setCaptureOpen(false);
    setCaptureSession(null);
    setNotice(null);
    setReport(null);
    setMode(next);
    setModePref(next);
    saveModePreference(next);
    if (next === "global") {
      syncBrowserState();
    } else {
      void refreshLocal();
    }
  }

  const handleCaptureCompleted = useCallback(
    async (completed: CaptureSessionPublic) => {
      if (mode === "global") {
        syncBrowserState();
      } else {
        await refreshLocal();
      }
      if (completed.adapter) {
        setNotice({
          kind: "success",
          text:
            mode === "global"
              ? `${completed.adapter.name} saved privately to your browser! Export your personal Worker or Local Proxy to start calling /v1.`
              : `${completed.adapter.name} was captured, verified via live test, and saved to data/db.json.`,
        });
        if (completed.adapter.models[0]) {
          setPreferredModel(`${completed.adapter.id}/${completed.adapter.models[0].id}`);
        }
        setUrl("");
      }
    },
    [mode, refreshLocal, syncBrowserState],
  );

  // Background 2-second polling when Live Browser Capture is minimized in Local Mode
  useEffect(() => {
    if (mode === "global" || captureOpen || !captureSession || !captureSession.callbackUrl) return;
    if (captureSession.status !== "listening" && captureSession.status !== "probing") return;
    let stopped = false;
    const id = captureSession.id;
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch(`/api/capture/session/${encodeURIComponent(id)}`, {
          cache: "no-store",
        });
        if (stopped) return;
        if (res.status === 404) {
          setCaptureSession((old) => (old && old.id === id ? { ...old, status: "expired" } : old));
          return;
        }
        if (!res.ok) return;
        const payload = (await res.json()) as { session?: CaptureSessionPublic };
        if (!payload.session || stopped) return;
        setCaptureSession(payload.session);
        if (payload.session.status === "completed") {
          setCaptureOpen(true);
          void handleCaptureCompleted(payload.session);
        }
      } catch {
        /* ignore transient fetch failure while minimized */
      }
    }, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [mode, captureOpen, captureSession?.id, captureSession?.status, captureSession?.callbackUrl, handleCaptureCompleted]);

  const active = data.adapters.filter((a) => a.enabled);
  const modelCount = active.reduce((count, adapter) => count + adapter.models.length, 0);
  const firstModel = active[0]?.models[0]
    ? `${active[0].id}/${active[0].models[0].id}`
    : "rusherai/gpt-6-astra";
  const displayBase =
    mode === "global"
      ? personalGatewayUrl
        ? `${personalGatewayUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`
        : "http://127.0.0.1:8088/v1"
      : `${base}/v1`;
  const isGlobal = mode === "global";

  async function copy(text: string, id: string) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      setCopied(id);
      setTimeout(() => setCopied(""), 1800);
    } catch {
      setNotice({ kind: "error", text: "Could not copy to clipboard — try selecting and copying manually." });
    }
  }

  function goToAdapters() {
    setView("overview");
    setTimeout(
      () => document.getElementById("adapters")?.scrollIntoView({ behavior: "smooth", block: "start" }),
      50,
    );
  }

  async function discover() {
    if (!url.trim()) {
      setNotice({ kind: "error", text: "Enter a website URL to start discovery (e.g. https://rusherai.com/)." });
      return;
    }
    setNotice(null);
    setReport(null);

    if (isGlobal) {
      // Zero-quota global mode: instantly create a browser-isolated capture session with zero server hits!
      const session = createBrowserCaptureSession(url.trim());
      setCaptureSession(session);
      setCaptureOpen(true);
      return;
    }

    setWorking(true);
    try {
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), callbackOrigin: window.location.origin }),
      });
      const result = await res.json();
      setReport(result.report || null);
      if (!res.ok) {
        if (result.captureSession) {
          setCaptureSession(result.captureSession);
          setCaptureOpen(true);
          setNotice({
            kind: "error",
            text:
              result.error ||
              "Automatic scan couldn't verify this site — opened Live Browser Capture instead.",
          });
        } else {
          setNotice({ kind: "error", text: result.error || "Could not scan that URL." });
        }
      } else {
        setNotice({
          kind: "success",
          text: `${result.adapter.name} is verified and ready to use!`,
        });
        await refreshLocal();
      }
    } catch {
      // Fallback gracefully into browser-side capture if the local backend is offline.
      const session = createBrowserCaptureSession(url.trim());
      setCaptureSession(session);
      setCaptureOpen(true);
    } finally {
      setWorking(false);
    }
  }

  async function startLiveCapture(targetUrl?: string) {
    setNotice(null);
    const target = (targetUrl ?? url).trim();

    if (isGlobal) {
      const session = createBrowserCaptureSession(target);
      setCaptureSession(session);
      setCaptureOpen(true);
      return;
    }

    setWorking(true);
    try {
      const res = await fetch("/api/capture/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: target, callbackOrigin: window.location.origin }),
      });
      const result = await res.json();
      if (!res.ok || !result.session) {
        setNotice({ kind: "error", text: result.error || "Could not start live capture session." });
      } else {
        setCaptureSession(result.session);
        setCaptureOpen(true);
      }
    } catch {
      setNotice({ kind: "error", text: "Could not reach the local server to start capture." });
    } finally {
      setWorking(false);
    }
  }

  async function handleManualPaste(rawText: string) {
    if (!captureSession) {
      return { ok: false, message: "Open Live Browser Capture first to start a session." };
    }
    if (isGlobal || !captureSession.callbackUrl) {
      const result = ingestBrowserManualInput(rawText, captureSession.targetUrl, {
        source: "captured",
      });
      if (!result.ok) {
        return {
          ok: false,
          message: result.message,
          actionTip: result.actionTip,
        };
      }
      const completed: CaptureSessionPublic = {
        ...captureSession,
        status: "completed",
        adapter: publicAdapter(result.adapter),
        analysis: result.analysis,
        events: [result.event, ...captureSession.events],
      };
      setCaptureSession(completed);
      void handleCaptureCompleted(completed);
      return { ok: true, status: "completed", message: result.event.message };
    }

    // Local mode: route through the exact same /api/capture/ingest analyzer + live probe + data/db.json save!
    const res = await fetch(
      `/api/capture/ingest?sessionId=${encodeURIComponent(captureSession.id)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manualText: rawText }),
      },
    );
    const data = await res.json();
    // Refresh modal session state right away (don't even wait 2s for the next poll)
    const poll = await fetch(
      `/api/capture/session/${encodeURIComponent(captureSession.id)}`,
      { cache: "no-store" },
    ).catch(() => null);
    if (poll && poll.ok) {
      const pJson = (await poll.json()) as { session?: CaptureSessionPublic };
      if (pJson.session) {
        setCaptureSession(pJson.session);
        if (pJson.session.status === "completed") {
          void handleCaptureCompleted(pJson.session);
        }
      }
    }
    if (!res.ok) {
      return { ok: false, message: data.error || data.message || "Could not analyze pasted text.", actionTip: data.actionTip };
    }
    return {
      ok: data.status === "completed",
      status: data.status,
      message: data.message || "Analyzed request.",
      actionTip: data.actionTip,
    };
  }

  async function cancelCapture(id: string) {
    if (!isGlobal && captureSession?.callbackUrl) {
      await fetch(`/api/capture/session/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(
        () => {},
      );
    }
    setCaptureOpen(false);
    setCaptureSession(null);
  }

  async function importAdapter() {
    if (!pasted.trim()) {
      setNotice({
        kind: "error",
        text: "Paste a cURL command, fetch(...) call, or copy(__proxyCapture.last) JSON first.",
      });
      return;
    }
    setNotice(null);
    setReport(null);

    if (isGlobal) {
      const res = ingestBrowserManualInput(pasted, "", {
        name: importName,
        model: importModel,
        source: "imported",
      });
      if (!res.ok) {
        setNotice({ kind: "error", text: res.message });
      } else {
        setNotice({
          kind: "success",
          text: `${res.adapter.name} saved privately in your browser! Head to Export Gateway to deploy your personal /v1 endpoint.`,
        });
        setPasted("");
        setImportName("");
        setImportModel("");
        syncBrowserState();
      }
      return;
    }

    setWorking(true);
    try {
      const res = await fetch("/api/adapters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: pasted, name: importName, model: importModel }),
      });
      const result = await res.json();
      if (!res.ok) {
        setNotice({ kind: "error", text: result.error || "Could not import that request." });
      } else {
        setNotice({ kind: "success", text: `${result.adapter.name} passed verification and was added!` });
        setPasted("");
        setImportName("");
        setImportModel("");
        await refreshLocal();
      }
    } catch {
      setNotice({ kind: "error", text: "Could not reach the local server." });
    } finally {
      setWorking(false);
    }
  }

  async function testAdapter(adapter: PublicAdapter) {
    if (isGlobal) {
      if (!personalGatewayUrl) {
        setNotice({
          kind: "error",
          text: `In Global Mode, export your own Worker or Local Proxy to live-test ${adapter.name} with zero host quota (browser security prevents direct Origin spoofing).`,
        });
        return;
      }
      setTesting(adapter.id);
      setNotice(null);
      const started = Date.now();
      const baseGw = personalGatewayUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
      try {
        const res = await fetch(`${baseGw}/proxy/${encodeURIComponent(adapter.id)}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(personalApiKey ? { Authorization: `Bearer ${personalApiKey}` } : {}),
          },
          body: JSON.stringify({
            model: adapter.models[0]?.id || "default",
            messages: [{ role: "user", content: "Reply with OK." }],
            stream: false,
          }),
        });
        const ms = Date.now() - started;
        if (res.ok) {
          setNotice({ kind: "success", text: `${adapter.name}: Valid response from your personal gateway (${ms} ms).` });
        } else {
          setNotice({ kind: "error", text: `${adapter.name}: Your gateway returned HTTP ${res.status}. Re-export if you recently edited adapters.` });
        }
      } catch {
        setNotice({ kind: "error", text: `Could not reach ${baseGw}. Make sure your Worker is deployed or proxy.mjs is running.` });
      } finally {
        setTesting("");
      }
      return;
    }

    setTesting(adapter.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/adapters/${adapter.id}/test`, { method: "POST" });
      const result = await res.json();
      setNotice({
        kind: res.ok ? "success" : "error",
        text: `${adapter.name}: ${result.message}${result.latencyMs != null ? ` (${result.latencyMs} ms)` : ""}`,
      });
      await refreshLocal();
    } catch {
      setNotice({ kind: "error", text: "Could not test that adapter right now." });
    } finally {
      setTesting("");
    }
  }

  async function toggle(adapter: PublicAdapter) {
    if (isGlobal) {
      patchBrowserAdapter(adapter.id, { enabled: !adapter.enabled });
      syncBrowserState();
      return;
    }
    const res = await fetch(`/api/adapters/${adapter.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !adapter.enabled }),
    });
    if (!res.ok) setNotice({ kind: "error", text: "Could not update adapter." });
    await refreshLocal();
  }

  async function remove(adapter: PublicAdapter) {
    if (!window.confirm(`Remove ${adapter.name}? This cannot be undone.`)) return;
    if (isGlobal) {
      deleteBrowserAdapter(adapter.id);
      setEdit(null);
      syncBrowserState();
      setNotice({ kind: "success", text: `${adapter.name} removed from your browser.` });
      return;
    }
    await fetch(`/api/adapters/${adapter.id}`, { method: "DELETE" });
    setEdit(null);
    await refreshLocal();
    setNotice({ kind: "success", text: `${adapter.name} removed.` });
  }

  async function saveKey() {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localApiKey: keyInput }),
    });
    const result = await res.json();
    setNotice({
      kind: res.ok ? "success" : "error",
      text: res.ok
        ? keyInput
          ? "Local API key saved. Supply it as a Bearer token in your clients."
          : "Local API key removed."
        : result.error,
    });
    await refreshLocal();
  }

  function generateKey() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    setKeyInput("ps-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
  }

  function savePersonalGateway(nextUrl: string, nextKey: string) {
    saveBrowserSettings({ personalGatewayUrl: nextUrl, personalApiKey: nextKey });
    setPersonalGatewayUrl(nextUrl);
    setPersonalApiKey(nextKey);
    setData((old) => ({ ...old, authRequired: Boolean(nextKey) }));
  }

  const curl = `curl ${displayBase}/chat/completions \\\n  -H "Content-Type: application/json"${
    data.authRequired ? ' \\\n  -H "Authorization: Bearer YOUR_API_KEY"' : ""
  } \\\n  -d '{\n    "model": "${firstModel}",\n    "messages": [{"role": "user", "content": "Hello!"}],\n    "stream": true\n  }'`;
  const python = `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${displayBase}",\n    api_key="${data.authRequired ? "YOUR_API_KEY" : "not-needed"}",\n)\n\nresponse = client.chat.completions.create(\n    model="${firstModel}",\n    messages=[{"role": "user", "content": "Hello!"}],\n)\nprint(response.choices[0].message.content)`;
  const code = codeTab === "curl" ? curl : python;

  const pageName: Record<View, string> = {
    overview: "Overview",
    export: "Export Gateway",
    playground: "Playground",
    activity: "Activity",
    settings: "Settings",
    guide: "Quickstart",
  };
  const backgroundListening = Boolean(
    captureSession &&
      !captureOpen &&
      (captureSession.status === "listening" || captureSession.status === "probing"),
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Mark />
          <div>
            <strong>
              proxy<span>studio</span>
            </strong>
            <small>UNIVERSAL AI GATEWAY</small>
          </div>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="side-nav">
          <button
            type="button"
            className={view === "overview" ? "active" : ""}
            onClick={() => setView("overview")}
          >
            <LayoutGrid size={17} /> Overview
          </button>
          <button type="button" onClick={goToAdapters}>
            <Network size={17} /> Adapters <span className="nav-count">{data.adapters.length}</span>
          </button>
          <button
            type="button"
            className={view === "export" ? "active" : ""}
            onClick={() => setView("export")}
          >
            <CloudUpload size={17} /> Export Gateway
          </button>
          <button
            type="button"
            className={view === "playground" ? "active" : ""}
            onClick={() => setView("playground")}
          >
            <MessageSquare size={17} /> Playground
          </button>
          <button
            type="button"
            className={view === "activity" ? "active" : ""}
            onClick={() => setView("activity")}
          >
            <Activity size={17} /> Activity
          </button>
        </nav>
        <div className="workspace-label resources">RESOURCES</div>
        <nav className="side-nav">
          <button
            type="button"
            className={view === "settings" ? "active" : ""}
            onClick={() => setView("settings")}
          >
            <Settings2 size={17} /> Settings
          </button>
          <button
            type="button"
            className={view === "guide" ? "active" : ""}
            onClick={() => setView("guide")}
          >
            <BookOpen size={17} /> Quickstart
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="local-card">
            <div className="local-card-title">
              <span className="live-dot" /> {isGlobal ? "Global zero-quota" : "Running locally"}
            </div>
            <p>
              {isGlobal
                ? "Private to your browser only. Export your own free /v1 gateway."
                : "Your workspace stays on this machine."}
            </p>
            <div className="local-card-line">
              <span>STORAGE</span>
              <strong>{isGlobal ? "localStorage" : "data/db.json"}</strong>
            </div>
          </div>
          <div className="side-footer">
            <span>PROXY STUDIO</span>
            <span>
              v2.0 <span className="green-dot">●</span>
            </span>
          </div>
        </div>
      </aside>

      <div className="main-wrap">
        <header className="topbar">
          <div className="mobile-brand">
            <Mark small />
            <strong>
              proxy<span>studio</span>
            </strong>
          </div>
          <div className="breadcrumbs">
            <span>Workspace</span>
            <span className="crumb-slash">/</span>
            <strong>{pageName[view]}</strong>
          </div>
          <div className="top-actions">
            {backgroundListening && captureSession && (
              <button
                type="button"
                className="capture-resume-chip"
                onClick={() => setCaptureOpen(true)}
              >
                <span className="capture-dot" /> Listening · {captureSession.targetHost}
              </button>
            )}
            {!forcedGlobal && serverAvailable && (
              <button
                type="button"
                className={`mode-chip ${isGlobal ? "global" : ""}`}
                onClick={() => switchMode(isGlobal ? "local" : "global")}
                title={
                  isGlobal
                    ? "Browser-isolated Global mode (click to switch to Local Server mode)"
                    : "Local JSON Server mode (click to preview Global Browser-Isolated mode)"
                }
              >
                {isGlobal ? <Cloud size={12} /> : <Laptop size={12} />}
                {isGlobal ? "Global mode" : "Local mode"}
              </button>
            )}
            <div className={`top-status ${ready ? "" : "offline"}`}>
              <span className="status-dot" />
              {isGlobal
                ? "Browser-isolated"
                : ready
                  ? "Local server online"
                  : "Connecting..."}
            </div>
            <button
              type="button"
              className="top-help"
              onClick={() => setView("guide")}
              title="Quickstart"
            >
              <BookOpen size={17} />
            </button>
            <span className="avatar">PS</span>
          </div>
        </header>

        <main className="main-content">
          {view === "overview" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="heading-kicker">
                    <span className="kicker-icon">
                      <Sparkles size={12} />
                    </span>{" "}
                    {isGlobal ? "ZERO-QUOTA BROWSER STUDIO" : "YOUR LOCAL AI WORKSPACE"}
                  </div>
                  <h1>
                    All your AI chats. <span>One API.</span>
                  </h1>
                  <p>
                    {isGlobal
                      ? "Private per-browser capture studio. Discover chat sites, then export your own free Worker or local proxy."
                      : "Connect chat sites to the tools you already use. Simple, local, yours."}
                  </p>
                </div>
                <div className="heading-actions">
                  {isGlobal ? (
                    <button
                      type="button"
                      className="button button-dark"
                      onClick={() => setView("export")}
                    >
                      <CloudUpload size={15} /> Export /v1 Gateway <ArrowUpRight size={15} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="button button-dark"
                      onClick={() => setView("playground")}
                    >
                      <Play size={15} fill="currentColor" /> Open playground{" "}
                      <ArrowUpRight size={15} />
                    </button>
                  )}
                </div>
              </div>

              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-top">
                    <span>CONNECTED ADAPTERS</span>
                    <span className="stat-icon lavender">
                      <Network size={17} />
                    </span>
                  </div>
                  <div className="stat-value">
                    {String(active.length).padStart(2, "0")}{" "}
                    <span className="stat-sub">active</span>
                  </div>
                  <p>
                    <span className="tiny-dot" /> {data.adapters.length} total{" "}
                    {isGlobal ? "in your browser" : "configured"}
                  </p>
                </div>
                <div className="stat-card">
                  <div className="stat-top">
                    <span>AVAILABLE MODELS</span>
                    <span className="stat-icon peach">
                      <Sparkles size={17} />
                    </span>
                  </div>
                  <div className="stat-value">
                    {String(modelCount).padStart(2, "0")} <span className="stat-sub">models</span>
                  </div>
                  <p>Plus -think &amp; -search suffixes</p>
                </div>
                <div className="stat-card">
                  <div className="stat-top">
                    <span>{isGlobal ? "PRIVACY & QUOTA" : "LOCAL GATEWAY"}</span>
                    <span className="stat-icon lime">
                      <Radio size={17} />
                    </span>
                  </div>
                  <div className="stat-value status-value">
                    <span className="big-status-dot" />
                    {isGlobal ? "Zero quota" : ready ? "Ready" : "Connecting"}
                  </div>
                  <p>
                    {isGlobal
                      ? "Private browser storage · 0 host reqs"
                      : `OpenAI-compatible · ${data.authRequired ? "Key protected" : "No key required"}`}
                  </p>
                </div>
              </div>

              {isGlobal ? (
                <div className="gateway-strip export-strip">
                  <div className="gateway-strip-icon">
                    <CloudUpload size={19} />
                  </div>
                  <div className="gateway-text">
                    <div>
                      <span className="gateway-label">
                        EXPORT PERSONAL /v1 GATEWAY (ZERO HOST QUOTA)
                      </span>
                      <span className="compatible-pill">
                        <span /> 100% PRIVATE
                      </span>
                    </div>
                    <code>
                      {personalGatewayUrl
                        ? displayBase
                        : "Deploy your own free Worker (100k/day) or local proxy.mjs →"}
                    </code>
                  </div>
                  <button
                    type="button"
                    className="button button-dark"
                    onClick={() => setView("export")}
                  >
                    <CloudUpload size={15} /> Export gateway
                  </button>
                </div>
              ) : (
                <div className="gateway-strip">
                  <div className="gateway-strip-icon">
                    <Link2 size={19} />
                  </div>
                  <div className="gateway-text">
                    <div>
                      <span className="gateway-label">YOUR LOCAL BASE URL</span>
                      <span className="compatible-pill">
                        <span /> OPENAI COMPATIBLE
                      </span>
                    </div>
                    <code>{base}/v1</code>
                  </div>
                  <button
                    type="button"
                    className="button copy-url"
                    onClick={() => copy(`${base}/v1`, "base")}
                  >
                    {copied === "base" ? <Check size={15} /> : <Copy size={15} />}{" "}
                    {copied === "base" ? "Copied" : "Copy URL"}
                  </button>
                </div>
              )}

              <div className="content-grid">
                <div className="content-primary">
                  <section className="card connect-card" id="discover">
                    <div className="section-header">
                      <div>
                        <div className="section-eyebrow">
                          <span className="number-icon">01</span> CONNECT A SITE
                        </div>
                        <h2>Bring your own chat.</h2>
                        <p>
                          {isGlobal
                            ? "Capture any site via Console snippet, Bookmarklet, or cURL. Saved strictly in your own browser."
                            : "Static scan tries first; embedded iframes, auth walls, WebSockets & CSP sites fall back automatically to Live Capture."}
                        </p>
                      </div>
                      <div className="illustration-icon">
                        <Globe2 size={22} />
                        <span>
                          <Plus size={12} />
                        </span>
                      </div>
                    </div>
                    <div className="tab-bar">
                      <button
                        type="button"
                        className={tab === "discover" ? "selected" : ""}
                        onClick={() => {
                          setTab("discover");
                          setNotice(null);
                        }}
                      >
                        <Search size={15} /> {isGlobal ? "Capture site" : "Auto-discover"}
                      </button>
                      <button
                        type="button"
                        className={tab === "import" ? "selected" : ""}
                        onClick={() => {
                          setTab("import");
                          setNotice(null);
                        }}
                      >
                        <Terminal size={15} /> Paste cURL / JSON
                      </button>
                      <button
                        type="button"
                        className="tab-capture-btn"
                        onClick={() => {
                          if (backgroundListening) setCaptureOpen(true);
                          else void startLiveCapture();
                        }}
                        disabled={working}
                      >
                        <Radio size={14} />{" "}
                        {backgroundListening ? "Resume live capture" : "Live capture"}
                      </button>
                    </div>
                    {tab === "discover" ? (
                      <div className="connect-form">
                        <label className="field-label">WEBSITE URL</label>
                        <div className="url-row">
                          <div className="url-field">
                            <Globe2 size={17} />
                            <input
                              value={url}
                              onChange={(e) => setUrl(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void discover();
                              }}
                              placeholder="https://rusherai.com/ or https://perchance.org/ai-chat"
                            />
                          </div>
                          <button
                            type="button"
                            className="button button-dark discover-button"
                            onClick={() => void discover()}
                            disabled={working}
                          >
                            {working ? (
                              <LoaderCircle className="spin" size={16} />
                            ) : (
                              <Zap size={16} />
                            )}{" "}
                            {working
                              ? "Scanning..."
                              : isGlobal
                                ? "Start capture"
                                : "Discover site"}
                          </button>
                        </div>
                        <p className="form-hint">
                          <ShieldCheck size={14} />{" "}
                          {isGlobal
                            ? "Generates a snippet & bookmarklet hooking fetch, XHR, EventSource, WebSocket & iframes — saves straight to localStorage."
                            : "Static scan first; auto-opens Live Browser Capture (fetch, XHR, EventSource, WebSocket, iframes + CSP fallback) if gated."}
                        </p>
                      </div>
                    ) : (
                      <div className="connect-form">
                        <label className="field-label">
                          CAPTURED REQUEST (cURL, fetch, OR copy(__proxyCapture.last))
                        </label>
                        <textarea
                          className="field import-text"
                          value={pasted}
                          onChange={(e) => setPasted(e.target.value)}
                          placeholder={
                            'Paste any of:\n• curl \'https://example.com/api/chat\' -H \'Content-Type: application/json\' --data-raw \'{"model":"...","messages":[...]}\'\n• fetch("https://example.com/api/chat", { ... })\n• JSON copied via copy(__proxyCapture.last)'
                          }
                        />
                        <div className="import-grid">
                          <input
                            className="field"
                            value={importName}
                            onChange={(e) => setImportName(e.target.value)}
                            placeholder="Adapter name (optional)"
                          />
                          <input
                            className="field"
                            value={importModel}
                            onChange={(e) => setImportModel(e.target.value)}
                            placeholder="Model ID (optional)"
                          />
                          <button
                            type="button"
                            className="button button-dark"
                            disabled={working}
                            onClick={() => void importAdapter()}
                          >
                            {working ? (
                              <LoaderCircle className="spin" size={16} />
                            ) : (
                              <Plus size={16} />
                            )}{" "}
                            {working
                              ? "Testing..."
                              : isGlobal
                                ? "Analyze & save"
                                : "Test & add"}
                          </button>
                        </div>
                        <p className="form-hint">
                          <LockKeyhole size={14} />{" "}
                          {isGlobal
                            ? "Stored strictly inside your own browser's localStorage — never sent to any shared server."
                            : "Supports JSON, text/plain, FormData, URL-encoded forms, GET & WebSocket. Stored locally in data/db.json."}
                        </p>
                      </div>
                    )}
                    {backgroundListening && captureSession && (
                      <div className="capture-banner">
                        <span className="capture-dot" />
                        <div>
                          <strong>Live Browser Capture active</strong> for{" "}
                          <span>{captureSession.targetHost}</span> ({captureSession.events.length}{" "}
                          received · checking every 2s)
                        </div>
                        <button type="button" onClick={() => setCaptureOpen(true)}>
                          Open panel →
                        </button>
                      </div>
                    )}
                    {notice && (
                      <div className={`inline-message ${notice.kind}`} role="status">
                        {notice.kind === "success" ? (
                          <CheckCircle2 size={15} />
                        ) : (
                          <CircleAlert size={15} />
                        )}
                        <span>{notice.text}</span>
                        {notice.kind === "error" &&
                          tab === "discover" &&
                          captureSession &&
                          !captureOpen && (
                            <button type="button" onClick={() => setCaptureOpen(true)}>
                              Open live capture →
                            </button>
                          )}
                        {notice.kind === "error" && tab === "discover" && !captureSession && (
                          <button
                            type="button"
                            onClick={() => {
                              setTab("import");
                              setNotice(null);
                            }}
                          >
                            Paste request instead →
                          </button>
                        )}
                      </div>
                    )}
                    {report && (
                      <details className="scan-report">
                        <summary>
                          Scan details · {report.bundlesScanned} bundles ·{" "}
                          {report.candidates.length} candidates <ChevronDown size={14} />
                        </summary>
                        <p>
                          <strong>Fields:</strong> {report.fields.join(", ") || "none found"} ·{" "}
                          <strong>Models:</strong> {report.models.length}
                        </p>
                        {report.attempts.map((a) => (
                          <p className="mono" key={a.endpoint}>
                            {a.endpoint} — {a.message}
                          </p>
                        ))}
                      </details>
                    )}
                  </section>

                  <section className="card adapters-card" id="adapters">
                    <div className="section-title-row">
                      <div>
                        <div className="section-eyebrow">
                          <span className="number-icon">02</span> YOUR CONNECTIONS
                        </div>
                        <h2>
                          Connected adapters{" "}
                          <span className="count-badge">{data.adapters.length}</span>
                        </h2>
                        <p>
                          {isGlobal
                            ? "Private to this browser. Enabled adapters are included in your exported gateway."
                            : "Manage the sites powering your local gateway."}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="text-action"
                        onClick={() => {
                          setTab("discover");
                          document.getElementById("discover")?.scrollIntoView({ behavior: "smooth" });
                        }}
                      >
                        <Plus size={15} /> Add new
                      </button>
                    </div>
                    <div className="adapter-table-head">
                      <span>ADAPTER</span>
                      <span>STATUS</span>
                      <span>MODELS</span>
                      <span>ACTIONS</span>
                    </div>
                    <div className="adapter-list">
                      {data.adapters.length === 0 ? (
                        <div className="empty-row">
                          No adapters yet. Discover or capture a site above to get started.
                        </div>
                      ) : (
                        data.adapters.map((adapter) => (
                          <div className="adapter-row" key={adapter.id}>
                            <div className="adapter-identity">
                              <div className="adapter-logo">
                                {adapter.name.charAt(0).toUpperCase()}
                              </div>
                              <div className="adapter-name">
                                <strong>
                                  {adapter.name}{" "}
                                  {adapter.source === "bundled" && (
                                    <span className="default-badge">DEFAULT</span>
                                  )}
                                  {adapter.source === "captured" && (
                                    <span className="captured-badge">CAPTURED</span>
                                  )}
                                </strong>
                                <span>
                                  {(() => {
                                    try {
                                      return new URL(adapter.siteUrl).hostname;
                                    } catch {
                                      return adapter.siteUrl;
                                    }
                                  })()}
                                </span>
                              </div>
                            </div>
                            <div>
                              <span
                                className={`status-pill ${adapter.enabled ? "" : "disabled"}`}
                              >
                                <span />
                                {adapter.enabled ? "Enabled" : "Disabled"}
                              </span>
                              {!adapter.verifiedAt && (
                                <small className="not-verified">
                                  {isGlobal ? "Ready to export" : "Not verified"}
                                </small>
                              )}
                            </div>
                            <div className="model-cell">
                              <strong>{String(adapter.models.length).padStart(2, "0")}</strong>
                              <span> models</span>
                            </div>
                            <div className="adapter-actions">
                              <button
                                type="button"
                                className="icon-button"
                                title={
                                  isGlobal
                                    ? "Test via your personal gateway"
                                    : "Test adapter live"
                                }
                                disabled={testing === adapter.id}
                                onClick={() => void testAdapter(adapter)}
                              >
                                {testing === adapter.id ? (
                                  <LoaderCircle className="spin" size={16} />
                                ) : (
                                  <Play size={15} />
                                )}
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                title="Edit adapter"
                                onClick={() => setEdit(adapter)}
                              >
                                <Pencil size={15} />
                              </button>
                              <button
                                type="button"
                                className={`toggle ${adapter.enabled ? "on" : ""}`}
                                role="switch"
                                aria-checked={adapter.enabled}
                                aria-label={`${adapter.enabled ? "Disable" : "Enable"} ${adapter.name}`}
                                onClick={() => void toggle(adapter)}
                              >
                                <span />
                              </button>
                            </div>
                            <div className="adapter-expanded">
                              <span>
                                Endpoint <code>{adapter.endpoint}</code>
                                {adapter.schema.responseFormat && (
                                  <em className="format-chip">{adapter.schema.responseFormat}</em>
                                )}
                                {adapter.schema.bodyFormat &&
                                  adapter.schema.bodyFormat !== "json" && (
                                    <em className="format-chip">{adapter.schema.bodyFormat}</em>
                                  )}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  copy(
                                    `${displayBase.replace(/\/v1$/, "")}/proxy/${adapter.id}/v1`,
                                    adapter.id,
                                  )
                                }
                              >
                                {copied === adapter.id ? "Copied!" : "Copy isolated URL"}{" "}
                                <Copy size={12} />
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="table-footer">
                      <ShieldCheck size={14} />{" "}
                      {isGlobal
                        ? "Isolated per visitor — never uploaded to any shared DB."
                        : "Adapters only run when you send a request."}
                      <span>{isGlobal ? "Browser localStorage" : "Local storage · data/db.json"}</span>
                    </div>
                  </section>
                </div>

                <aside className="content-secondary">
                  <section className="card quick-card">
                    <div className="quick-icon">
                      <Code2 size={18} />
                    </div>
                    <div className="section-eyebrow">QUICK CONNECT</div>
                    <h2>{isGlobal ? "Your own free /v1." : "Ready when you are."}</h2>
                    <p>
                      {isGlobal
                        ? "Export a personal Cloudflare Worker (100k/day free) or zero-install local proxy.mjs."
                        : "Point your favorite client at the local URL, or export your own zero-quota Worker."}
                    </p>
                    <div className="client-tags">
                      <span>Cherry Studio</span>
                      <span>Magpie</span>
                      <span>OpenAI SDK</span>
                    </div>
                    <div className="code-window">
                      <div className="code-toolbar">
                        <div>
                          <button
                            type="button"
                            className={codeTab === "curl" ? "active" : ""}
                            onClick={() => setCodeTab("curl")}
                          >
                            cURL
                          </button>
                          <button
                            type="button"
                            className={codeTab === "python" ? "active" : ""}
                            onClick={() => setCodeTab("python")}
                          >
                            Python
                          </button>
                        </div>
                        <button
                          type="button"
                          className="copy-code"
                          onClick={() => copy(code, "code")}
                          title="Copy code"
                        >
                          {copied === "code" ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                      </div>
                      <pre>
                        <code>{code}</code>
                      </pre>
                    </div>
                    <div className="quick-links-row">
                      <button
                        type="button"
                        className="quick-link"
                        onClick={() => setView("export")}
                      >
                        Export Worker / local proxy <ArrowRight size={15} />
                      </button>
                    </div>
                  </section>

                  <section className="card activity-card">
                    <div className="activity-heading">
                      <div>
                        <div className="section-eyebrow">ACTIVITY</div>
                        <h2>Recent requests</h2>
                      </div>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => void refresh()}
                        title="Refresh activity"
                      >
                        <RefreshCw size={15} />
                      </button>
                    </div>
                    {data.logs.length ? (
                      <div className="recent-list">
                        {data.logs.slice(0, 3).map((log) => (
                          <div className="recent-row" key={log.id}>
                            <span
                              className={
                                log.status >= 400 ? "request-status bad" : "request-status"
                              }
                            >
                              <Activity size={15} />
                            </span>
                            <div>
                              <strong>{log.adapterName}</strong>
                              <small>
                                {shortTime(log.at)} · {log.model}
                              </small>
                            </div>
                            <span
                              className={log.status >= 400 ? "request-code bad" : "request-code"}
                            >
                              {log.status}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="activity-empty">
                        <div>
                          <Activity size={18} />
                        </div>
                        <strong>No requests yet</strong>
                        <p>Your API activity will appear here.</p>
                      </div>
                    )}
                    <button
                      type="button"
                      className="quick-link activity-link"
                      onClick={() => setView("activity")}
                    >
                      View all activity <ArrowRight size={15} />
                    </button>
                  </section>
                </aside>
              </div>

              <div className="bottom-note">
                <span>
                  <ShieldCheck size={15} />{" "}
                  {isGlobal
                    ? "Per-user browser isolation · Zero host Workers quota"
                    : "Built for your local workspace · Ready to deploy globally"}
                </span>
                <span>Model names are supplied by each website; actual backends may differ.</span>
              </div>
            </>
          )}

          {view !== "overview" && (
            <div className="subpage-heading">
              <div className="heading-kicker">
                <span className="kicker-icon">
                  <Sparkles size={12} />
                </span>{" "}
                {isGlobal ? "ZERO-QUOTA BROWSER STUDIO" : "YOUR LOCAL AI WORKSPACE"}
              </div>
              <h1>{pageName[view]}</h1>
              <p>
                {view === "export"
                  ? "Generate your own standalone Cloudflare Worker or local Mac/Windows proxy with zero host quota."
                  : view === "playground"
                    ? "Test your adapters live. Conversations save privately in your browser."
                    : view === "activity"
                      ? isGlobal
                        ? "Requests sent from this browser (saved locally, never shared)."
                        : "A local record of requests routed through your gateway."
                      : view === "settings"
                        ? "Configure storage mode, personal gateway URL, and optional API key."
                        : "Everything you need to capture sites and connect Magpie, Cherry Studio, or any OpenAI client."}
              </p>
            </div>
          )}

          {view === "export" && (
            <ExportPanel
              mode={mode}
              browserAdapters={browserAdapters}
              personalGatewayUrl={personalGatewayUrl}
              personalApiKey={personalApiKey}
              onSavePersonalGateway={savePersonalGateway}
              copy={copy}
              copied={copied}
            />
          )}

          {view === "playground" && (
            <Playground
              adapters={data.adapters}
              mode={mode}
              authRequired={data.authRequired}
              personalGatewayUrl={personalGatewayUrl}
              personalApiKey={personalApiKey}
              preferredModel={preferredModel}
              onComplete={() => void refresh()}
              onRecordGlobalLog={(entry) => {
                const logs = appendBrowserLog(entry);
                setData((old) => ({ ...old, logs }));
              }}
              onOpenExport={() => setView("export")}
            />
          )}

          {view === "activity" && (
            <section className="card full-card">
              <div className="section-title-row">
                <div>
                  <h2>Request history</h2>
                  <p>
                    Only metadata is recorded — prompts, replies, and authorization headers are
                    never logged.
                  </p>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  {isGlobal && data.logs.length > 0 && (
                    <button
                      type="button"
                      className="button button-outline"
                      onClick={() => {
                        clearBrowserLogs();
                        syncBrowserState();
                      }}
                    >
                      Clear
                    </button>
                  )}
                  <button
                    type="button"
                    className="button button-outline"
                    onClick={() => void refresh()}
                  >
                    <RefreshCw size={15} /> Refresh
                  </button>
                </div>
              </div>
              {data.logs.length ? (
                <div className="history-table">
                  <div className="history-head">
                    <span>TIME</span>
                    <span>ADAPTER / MODEL</span>
                    <span>TYPE</span>
                    <span>STATUS</span>
                    <span>DURATION</span>
                  </div>
                  {data.logs.map((log) => (
                    <div className="history-row" key={log.id}>
                      <span>{shortTime(log.at)}</span>
                      <span>
                        <strong>{log.adapterName}</strong>
                        <small>{log.model}</small>
                      </span>
                      <span>{log.stream ? "Streaming" : "JSON"}</span>
                      <span>
                        <i className={`status-dot ${log.status >= 400 ? "red" : ""}`} />{" "}
                        {log.status}
                      </span>
                      <span>{log.durationMs.toLocaleString()} ms</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="large-empty">
                  <Activity size={22} />
                  <strong>No requests yet</strong>
                  <p>Try the playground to send your first test message.</p>
                  <button
                    type="button"
                    className="button button-dark"
                    onClick={() => setView("playground")}
                  >
                    Open playground <ArrowRight size={14} />
                  </button>
                </div>
              )}
            </section>
          )}

          {view === "settings" && (
            <div className="settings-layout">
              {isGlobal ? (
                <section className="card full-card">
                  <div className="setting-heading-icon green">
                    <Cloud size={20} />
                  </div>
                  <h2>Browser-isolated storage</h2>
                  <p>
                    Your adapters, credentials, captured endpoints, and Playground chats are stored
                    strictly inside this browser&apos;s <code>localStorage</code>. Nothing is sent
                    to any shared database, and zero server quota is used.
                  </p>
                  <div className="settings-status">
                    <span className="status-dot" /> Global Zero-Quota Mode active
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="button button-dark"
                      onClick={() => setView("export")}
                    >
                      <CloudUpload size={14} /> Export Personal Gateway
                    </button>
                    <button
                      type="button"
                      className="button button-outline"
                      onClick={() => {
                        if (window.confirm("Reset browser adapters back to the default RusherAI starter?")) {
                          resetBrowserAdapters();
                          syncBrowserState();
                          setNotice({ kind: "success", text: "Reset browser storage to the bundled RusherAI adapter." });
                        }
                      }}
                    >
                      <RotateCcw size={14} /> Reset to defaults
                    </button>
                  </div>
                  {notice && (
                    <div className={`inline-message ${notice.kind}`}>
                      <CheckCircle2 size={15} /> {notice.text}
                    </div>
                  )}
                </section>
              ) : (
                <section className="card full-card">
                  <div className="setting-heading-icon">
                    <KeyRound size={20} />
                  </div>
                  <h2>Local API key</h2>
                  <p>
                    Optionally require a Bearer token for all local <code>/v1</code> requests. Leave
                    empty for open access on your own machine.
                  </p>
                  <div className="settings-status">
                    <span className="status-dot" />
                    {data.authRequired ? "Authentication enabled" : "Authentication is off"}
                  </div>
                  <label className="field-label">
                    {data.authRequired ? "REPLACE OR REMOVE KEY" : "NEW LOCAL KEY"}
                  </label>
                  <div className="key-row">
                    <input
                      className="field"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      type="text"
                      placeholder="Enter a key, or generate one"
                      disabled={data.envKey}
                    />
                    <button
                      type="button"
                      className="button button-outline"
                      onClick={generateKey}
                      disabled={data.envKey}
                    >
                      Generate
                    </button>
                    <button
                      type="button"
                      className="button button-dark"
                      onClick={() => void saveKey()}
                      disabled={data.envKey}
                    >
                      Save key
                    </button>
                  </div>
                  <p className="form-hint">
                    <LockKeyhole size={14} /> Stored locally in <code>data/db.json</code>. Leave
                    blank and click Save to remove.
                  </p>
                  {data.envKey && (
                    <div className="inline-message error">
                      <CircleAlert size={15} /> STUDIO_API_KEY is set in your server environment and
                      takes precedence.
                    </div>
                  )}
                  {notice && (
                    <div className={`inline-message ${notice.kind}`}>
                      {notice.kind === "success" ? (
                        <CheckCircle2 size={15} />
                      ) : (
                        <CircleAlert size={15} />
                      )}{" "}
                      {notice.text}
                    </div>
                  )}
                </section>
              )}

              <section className="card full-card">
                <div className="setting-heading-icon green">
                  <ShieldCheck size={20} />
                </div>
                <h2>Architecture &amp; mode</h2>
                <p>
                  Runs seamlessly as a local JSON server (<code>npm start</code> on port{" "}
                  <code>8088</code>) <strong>and</strong> as a zero-quota global Cloudflare Pages
                  site (each visitor stays isolated in <code>localStorage</code> and exports their
                  own Worker / companion).
                </p>
                {!forcedGlobal && serverAvailable && (
                  <div className="mode-toggle-box">
                    <button
                      type="button"
                      className={`button ${mode === "local" ? "button-dark" : "button-outline"}`}
                      onClick={() => switchMode("local")}
                    >
                      <Laptop size={14} /> Local Server (db.json)
                    </button>
                    <button
                      type="button"
                      className={`button ${mode === "global" ? "button-dark" : "button-outline"}`}
                      onClick={() => switchMode("global")}
                    >
                      <Cloud size={14} /> Global (localStorage)
                    </button>
                  </div>
                )}
                <div className="detail-list">
                  <span>
                    Active mode <code>{isGlobal ? "global (browser-isolated)" : `local (${modePref})`}</code>
                  </span>
                  <span>
                    Storage <code>{isGlobal ? "window.localStorage" : "./data/db.json"}</code>
                  </span>
                  <span>
                    Default local port <code>8088</code>
                  </span>
                  <span>
                    Capture CORS <code>* + Private-Network</code>
                  </span>
                  <span>
                    Static export <code>npm run build:pages</code>
                  </span>
                </div>
              </section>
            </div>
          )}

          {view === "guide" && (
            <div className="guide-layout">
              <section className="card full-card">
                <span className="section-eyebrow">GET CONNECTED</span>
                <h2>One endpoint, anywhere.</h2>
                <p>
                  In Magpie, Cherry Studio, Cursor, or any OpenAI SDK, paste the base URL below. If
                  no key is required, put any placeholder text.
                </p>
                <div className="guide-url">
                  <code>{displayBase}</code>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => copy(displayBase, "guide")}
                  >
                    {copied === "guide" ? <Check size={15} /> : <Copy size={15} />}
                  </button>
                </div>
                <ol className="guide-steps">
                  <li>
                    <b>1</b>
                    <div>
                      <strong>Auto-discover or Live Capture any AI chat</strong>
                      <p>
                        RusherAI is pre-loaded. Paste any website URL: if static discovery can&apos;t
                        verify it, Live Browser Capture opens automatically with a Console snippet
                        &amp; draggable Bookmarklet hooking <code>fetch</code>, <code>XHR</code>,{" "}
                        <code>EventSource</code>, <code>WebSocket</code>, and same-origin iframes.
                      </p>
                    </div>
                  </li>
                  <li>
                    <b>2</b>
                    <div>
                      <strong>Resilient against iframes, CSP &amp; cookies</strong>
                      <p>
                        Cross-origin iframes (like <code>perchance.org</code>) print a bright yellow
                        hint to switch the <code>top</code> Console dropdown. If CSP blocks
                        auto-send, type <code>copy(__proxyCapture.last)</code> and paste it in
                        Manual Paste Fallback. For HttpOnly cookies, paste <b>Copy as cURL</b>.
                      </p>
                    </div>
                  </li>
                  <li>
                    <b>3</b>
                    <div>
                      <strong>Export your own zero-quota /v1 gateway</strong>
                      <p>
                        Open <strong>Export Gateway</strong> to download your personal{" "}
                        <code>worker.js</code> (100k/day free on your own Cloudflare account) or
                        zero-install local <code>proxy.mjs</code> + <code>start-mac.command</code>.
                      </p>
                    </div>
                  </li>
                </ol>
              </section>
              <section className="card full-card">
                <span className="section-eyebrow">MODEL FLAGS &amp; TIPS</span>
                <h2>Control thinking &amp; search.</h2>
                <p>
                  For a single isolated adapter, use <code>/proxy/ADAPTER_ID/v1</code>. When an
                  adapter supports reasoning or search toggles, append <code>-think</code>,{" "}
                  <code>-search</code>, or <code>-think-search</code> directly to any model ID
                  (e.g. <code>{firstModel}-think</code>).
                </p>
                <div className="guide-callout">
                  <CircleAlert size={17} />
                  <span>
                    All static files, Firestore database writes, Sentry, and Google Analytics calls
                    are filtered out automatically while non-standard POST, FormData, URL-encoded,
                    text/plain, GET, and WebSocket chats still pass cleanly through the analyzer.
                  </span>
                </div>
              </section>
            </div>
          )}
        </main>
      </div>

      {captureOpen && captureSession && (
        <CaptureModal
          session={captureSession}
          mode={mode}
          base={base}
          copy={copy}
          copied={copied}
          onUpdate={(next) => setCaptureSession(next)}
          onCompleted={(next) => void handleCaptureCompleted(next)}
          onManualPaste={handleManualPaste}
          onClose={() => {
            setCaptureOpen(false);
            if (captureSession.status === "completed" || captureSession.status === "expired") {
              setCaptureSession(null);
            }
          }}
          onCancel={(id) => void cancelCapture(id)}
          onRestart={(targetUrl) => void startLiveCapture(targetUrl)}
          onOpenPlayground={() => {
            const modelId = captureSession.adapter?.models[0]
              ? `${captureSession.adapter.id}/${captureSession.adapter.models[0].id}`
              : undefined;
            if (modelId) setPreferredModel(modelId);
            setCaptureOpen(false);
            setCaptureSession(null);
            setView("playground");
          }}
          onOpenExport={() => {
            setCaptureOpen(false);
            setCaptureSession(null);
            setView("export");
          }}
        />
      )}

      {edit && (
        <EditModal
          adapter={edit}
          mode={mode}
          base={displayBase.replace(/\/v1$/, "")}
          onClose={() => setEdit(null)}
          onRemove={() => void remove(edit)}
          onSaved={async () => {
            setEdit(null);
            await refresh();
            setNotice({
              kind: "success",
              text: isGlobal
                ? "Adapter saved in your browser. Re-export your gateway to apply edits."
                : "Adapter updated. Click Play to re-verify your changes.",
            });
          }}
          copy={copy}
          copied={copied}
        />
      )}
    </div>
  );
}

function EditModal({
  adapter,
  mode,
  base,
  onClose,
  onRemove,
  onSaved,
  copy,
  copied,
}: {
  adapter: PublicAdapter;
  mode: StudioMode;
  base: string;
  onClose: () => void;
  onRemove: () => void;
  onSaved: () => void;
  copy: (value: string, id: string) => void;
  copied: string;
}) {
  const [name, setName] = useState(adapter.name);
  const [endpoint, setEndpoint] = useState(adapter.endpoint);
  const [origin, setOrigin] = useState(adapter.origin);
  const [referer, setReferer] = useState(adapter.referer);
  const [models, setModels] = useState(adapter.models.map((m) => m.id).join("\n"));
  const [headers, setHeaders] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setError("");
    setBusy(true);
    try {
      const modelList = models
        .split(/[\n,]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      let parsedHeaders: Record<string, string> | undefined;
      if (headers.trim()) {
        try {
          const obj = JSON.parse(headers);
          if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error();
          parsedHeaders = obj as Record<string, string>;
        } catch {
          throw new Error('Replacement headers must be a JSON object, e.g. {"Authorization": "Bearer ..."}.');
        }
      }
      if (mode === "global") {
        patchBrowserAdapter(adapter.id, {
          name,
          endpoint,
          origin,
          referer,
          models: modelList,
          ...(parsedHeaders ? { headers: parsedHeaders } : {}),
        });
        onSaved();
        return;
      }
      const patch: Record<string, unknown> = {
        name,
        endpoint,
        origin,
        referer,
        models: modelList,
        ...(parsedHeaders ? { headers: parsedHeaders } : {}),
      };
      const res = await fetch(`/api/adapters/${adapter.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Could not save changes.");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save changes.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal card" role="dialog" aria-modal="true" aria-label="Edit adapter">
        <div className="modal-head">
          <div>
            <span className="section-eyebrow">ADAPTER SETTINGS</span>
            <h2>Edit {adapter.name}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          <label className="field-label">NAME</label>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
          <label className="field-label">CHAT ENDPOINT</label>
          <input
            className="field mono"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
          <div className="two-fields">
            <div>
              <label className="field-label">ORIGIN</label>
              <input
                className="field mono"
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label">REFERER</label>
              <input
                className="field mono"
                value={referer}
                onChange={(e) => setReferer(e.target.value)}
              />
            </div>
          </div>
          <label className="field-label">
            MODEL IDS <span>(ONE PER LINE)</span>
          </label>
          <textarea
            className="field mono"
            rows={4}
            value={models}
            onChange={(e) => setModels(e.target.value)}
          />
          <details className="headers-details">
            <summary>
              Replace request headers <ChevronDown size={14} />
            </summary>
            <p>
              Leave blank to keep existing headers ({adapter.headerNames.join(", ") || "none"}).
              Existing secret values stay hidden for safety.
            </p>
            <textarea
              className="field mono"
              rows={4}
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder='{"Content-Type": "application/json", "Authorization": "Bearer ..."}'
            />
          </details>
          <div className="isolated-url">
            <span>ISOLATED BASE URL</span>
            <div>
              <code>
                {base}/proxy/{adapter.id}/v1
              </code>
              <button
                type="button"
                className="icon-button"
                onClick={() => copy(`${base}/proxy/${adapter.id}/v1`, "modal")}
                title="Copy isolated URL"
              >
                {copied === "modal" ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          </div>
          {error && (
            <div className="inline-message error">
              <CircleAlert size={15} />
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="delete-button" onClick={onRemove}>
            <Trash2 size={15} /> Remove
          </button>
          <div>
            <button type="button" className="button button-outline" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="button button-dark"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? "Saving..." : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
