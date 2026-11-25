"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  CheckCircle2,
  CircleAlert,
  Cloud,
  Copy,
  Download,
  FileCode2,
  KeyRound,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import {
  generateCloudflareWorker,
  generateLocalProxyScript,
  generateMacCompanionLauncher,
  generateWindowsCompanionLauncher,
  generateWranglerToml,
} from "@/lib/exporters";
import type { Adapter, StudioMode } from "@/lib/types";

type Bundle = {
  enabledCount: number;
  modelCount: number;
  hasHiddenCredentials: boolean;
  workerJs: string;
  wranglerToml: string;
  proxyMjs: string;
  macLauncher: string;
  windowsLauncher: string;
};

function downloadFile(filename: string, content: string, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ExportPanel({
  mode,
  browserAdapters,
  personalGatewayUrl,
  personalApiKey,
  onSavePersonalGateway,
  copy,
  copied,
}: {
  mode: StudioMode;
  browserAdapters: Adapter[];
  personalGatewayUrl: string;
  personalApiKey: string;
  onSavePersonalGateway?: (url: string, key: string) => void;
  copy: (text: string, id: string) => void;
  copied: string;
}) {
  const [target, setTarget] = useState<"cloudflare" | "local">("cloudflare");
  const [workerName, setWorkerName] = useState("my-ai-proxy");
  const [port, setPort] = useState(8088);
  const [apiKey, setApiKey] = useState("");
  const [includeCreds, setIncludeCreds] = useState(false);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [gatewayInput, setGatewayInput] = useState(personalGatewayUrl);
  const [gatewayKeyInput, setGatewayKeyInput] = useState(personalApiKey);
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    setGatewayInput(personalGatewayUrl);
    setGatewayKeyInput(personalApiKey);
  }, [personalGatewayUrl, personalApiKey]);

  const buildBundle = useCallback(async () => {
    setError("");
    if (mode === "global") {
      const enabled = browserAdapters.filter((a) => a.enabled);
      const hasCreds = enabled.some((a) =>
        Object.keys(a.headers || {}).some((k) =>
          /^(authorization|cookie|set-cookie|x-api-key|api-key|x-auth|x-session|x-token)/i.test(k),
        ),
      );
      setBundle({
        enabledCount: enabled.length,
        modelCount: enabled.reduce((s, a) => s + a.models.length, 0),
        hasHiddenCredentials: hasCreds,
        workerJs: generateCloudflareWorker(enabled, { includeCredentials: includeCreds, apiKey }),
        wranglerToml: generateWranglerToml(workerName),
        proxyMjs: generateLocalProxyScript(enabled, { includeCredentials: includeCreds, apiKey, port }),
        macLauncher: generateMacCompanionLauncher(port),
        windowsLauncher: generateWindowsCompanionLauncher(port),
      });
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          includeCredentials: includeCreds,
          apiKey,
          workerName,
          port,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not export adapters.");
      setBundle({
        enabledCount: data.enabledCount,
        modelCount: data.modelCount,
        hasHiddenCredentials: data.hasHiddenCredentials,
        workerJs: data.workerJs,
        wranglerToml: data.wranglerToml,
        proxyMjs: data.proxyMjs,
        macLauncher: data.macLauncher,
        windowsLauncher: data.windowsLauncher,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build exported gateway files.");
    } finally {
      setLoading(false);
    }
  }, [mode, browserAdapters, includeCreds, apiKey, workerName, port]);

  useEffect(() => {
    void buildBundle();
  }, [buildBundle]);

  function generateKey() {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    setApiKey("sk-my-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
  }

  function handleSaveGateway() {
    if (!onSavePersonalGateway) return;
    onSavePersonalGateway(gatewayInput.trim().replace(/\/+$/, ""), gatewayKeyInput.trim());
    setSavedNotice(true);
    window.setTimeout(() => setSavedNotice(false), 2200);
  }

  const enabledCount = bundle?.enabledCount ?? 0;
  const modelCount = bundle?.modelCount ?? 0;

  return (
    <div className="export-layout">
      <section className="card full-card export-main">
        <div className="section-title-row">
          <div>
            <div className="section-eyebrow">ZERO HOST QUOTA · PERSONAL /v1 GATEWAY</div>
            <h2>Export your own OpenAI endpoint</h2>
            <p>
              Bake your <strong>{enabledCount}</strong> enabled adapter
              {enabledCount === 1 ? "" : "s"} ({modelCount} models + <code>-think</code> /{" "}
              <code>-search</code> flags) into a zero-dependency script you completely own. Uses
              your own free quota — never shares traffic or credentials with anyone else.
            </p>
          </div>
        </div>

        <div className="tab-bar export-tabs">
          <button
            type="button"
            className={target === "cloudflare" ? "selected" : ""}
            onClick={() => setTarget("cloudflare")}
          >
            <Cloud size={15} /> Cloudflare Worker (100k/day free)
          </button>
          <button
            type="button"
            className={target === "local" ? "selected" : ""}
            onClick={() => setTarget("local")}
          >
            <Laptop size={15} /> Local Mac / Windows Proxy
          </button>
        </div>

        <div className="export-options">
          {target === "cloudflare" ? (
            <div>
              <label className="field-label" htmlFor="export-worker-name">
                WORKER NAME
              </label>
              <input
                id="export-worker-name"
                className="field mono"
                value={workerName}
                onChange={(e) => setWorkerName(e.target.value)}
                placeholder="my-ai-proxy"
              />
            </div>
          ) : (
            <div>
              <label className="field-label" htmlFor="export-port">
                LOCAL PORT
              </label>
              <input
                id="export-port"
                className="field mono"
                type="number"
                min={1024}
                max={65535}
                value={port}
                onChange={(e) => setPort(Math.min(65535, Math.max(1, Number(e.target.value) || 8088)))}
              />
            </div>
          )}
          <div>
            <label className="field-label" htmlFor="export-api-key">
              PROTECT WITH API KEY <span>(OPTIONAL)</span>
            </label>
            <div className="export-key-row">
              <input
                id="export-api-key"
                className="field mono"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Leave blank, or set in Worker Secrets"
              />
              <button
                type="button"
                className="button button-outline"
                onClick={generateKey}
                title="Generate a random key"
              >
                <KeyRound size={14} /> Generate
              </button>
            </div>
          </div>
        </div>

        <label className="export-cred-check">
          <input
            type="checkbox"
            checked={includeCreds}
            onChange={(e) => setIncludeCreds(e.target.checked)}
          />
          <span>
            Include captured auth headers / cookies in the exported file
            {bundle?.hasHiddenCredentials
              ? " (recommended for your login-protected adapters — keep downloaded file private)"
              : " (none currently stored)"}
          </span>
        </label>

        {error && (
          <div className="inline-message error">
            <CircleAlert size={15} />
            <span>{error}</span>
          </div>
        )}

        {enabledCount === 0 && (
          <div className="inline-message error">
            <CircleAlert size={15} />
            <span>Enable at least one adapter first so the exported gateway has models to serve.</span>
          </div>
        )}

        {loading || !bundle ? (
          <div className="export-loading">
            <LoaderCircle size={18} className="spin" /> Generating standalone gateway…
          </div>
        ) : target === "cloudflare" ? (
          <div className="export-panel-body">
            <div className="export-actions">
              <button
                type="button"
                className="button button-dark"
                disabled={enabledCount === 0}
                onClick={() => copy(bundle.workerJs, "exp-worker")}
              >
                {copied === "exp-worker" ? <Check size={15} /> : <Copy size={15} />}
                {copied === "exp-worker" ? "Copied worker.js!" : "Copy Worker Code"}
              </button>
              <button
                type="button"
                className="button button-outline"
                disabled={enabledCount === 0}
                onClick={() => downloadFile("worker.js", bundle.workerJs, "application/javascript;charset=utf-8")}
              >
                <Download size={15} /> Download worker.js
              </button>
              <button
                type="button"
                className="button button-outline"
                onClick={() => downloadFile("wrangler.toml", bundle.wranglerToml)}
              >
                <FileCode2 size={15} /> Download wrangler.toml
              </button>
            </div>

            <div className="code-window export-code">
              <div className="code-toolbar">
                <div>
                  <button type="button" className="active">worker.js</button>
                </div>
                <span className="export-size">
                  {(bundle.workerJs.length / 1024).toFixed(1)} KB · zero dependencies
                </span>
              </div>
              <pre>
                <code>{bundle.workerJs.slice(0, 1800) + (bundle.workerJs.length > 1800 ? "\n// … click Copy Worker Code or Download worker.js for the full file" : "")}</code>
              </pre>
            </div>

            <ol className="guide-steps export-steps">
              <li>
                <b>1</b>
                <div>
                  <strong>Deploy in 30 seconds (no terminal needed)</strong>
                  <p>
                    Log in to your free <strong>dash.cloudflare.com</strong> account →{" "}
                    <strong>Workers &amp; Pages</strong> → <strong>Create Worker</strong> →{" "}
                    <strong>Edit code</strong> → paste <code>worker.js</code> →{" "}
                    <strong>Deploy</strong>. Or put both files in a folder and run{" "}
                    <code>npx wrangler deploy</code>.
                  </p>
                </div>
              </li>
              <li>
                <b>2</b>
                <div>
                  <strong>Optional: lock it down with your own key</strong>
                  <p>
                    In Worker Settings → Variables &amp; Secrets, add secret <code>API_KEY</code>{" "}
                    (or run <code>npx wrangler secret put API_KEY</code>).
                  </p>
                </div>
              </li>
              <li>
                <b>3</b>
                <div>
                  <strong>Paste into Magpie, Cherry Studio, or any OpenAI SDK</strong>
                  <p>
                    Base URL: <code>https://{workerName || "my-ai-proxy"}.&lt;you&gt;.workers.dev/v1</code>
                    {" "}— uses your own free 100,000 requests/day quota.
                  </p>
                </div>
              </li>
            </ol>
          </div>
        ) : (
          <div className="export-panel-body">
            <div className="export-actions">
              <button
                type="button"
                className="button button-dark"
                disabled={enabledCount === 0}
                onClick={() => downloadFile("proxy.mjs", bundle.proxyMjs, "application/javascript;charset=utf-8")}
              >
                <Download size={15} /> Download proxy.mjs
              </button>
              <button
                type="button"
                className="button button-outline"
                onClick={() => downloadFile("start-mac.command", bundle.macLauncher, "text/x-shellscript;charset=utf-8")}
              >
                <Terminal size={15} /> start-mac.command
              </button>
              <button
                type="button"
                className="button button-outline"
                onClick={() => downloadFile("start-windows.bat", bundle.windowsLauncher)}
              >
                <Download size={15} /> start-windows.bat
              </button>
              <button
                type="button"
                className="button button-outline"
                disabled={enabledCount === 0}
                onClick={() => copy(bundle.proxyMjs, "exp-proxy")}
              >
                {copied === "exp-proxy" ? <Check size={14} /> : <Copy size={14} />}
                {copied === "exp-proxy" ? "Copied!" : "Copy"}
              </button>
            </div>

            <div className="code-window export-code">
              <div className="code-toolbar">
                <div>
                  <button type="button" className="active">proxy.mjs</button>
                </div>
                <span className="export-size">
                  Node.js 18+ · 0 npm packages · port {port}
                </span>
              </div>
              <pre>
                <code>{bundle.proxyMjs.slice(0, 1700) + (bundle.proxyMjs.length > 1700 ? "\n// … click Download proxy.mjs for the complete standalone server" : "")}</code>
              </pre>
            </div>

            <ol className="guide-steps export-steps">
              <li>
                <b>1</b>
                <div>
                  <strong>Save into one folder</strong>
                  <p>
                    Put <code>proxy.mjs</code> next to <code>start-mac.command</code> (macOS) or{" "}
                    <code>start-windows.bat</code> (Windows). Zero <code>npm install</code> needed.
                  </p>
                </div>
              </li>
              <li>
                <b>2</b>
                <div>
                  <strong>Double-click to launch (macOS tip)</strong>
                  <p>
                    Double-click <code>start-mac.command</code> (first run on Mac: run{" "}
                    <code>chmod +x start-mac.command</code> once or open Terminal and run{" "}
                    <code>node proxy.mjs</code>).
                  </p>
                </div>
              </li>
              <li>
                <b>3</b>
                <div>
                  <strong>Connect Magpie / Cherry Studio</strong>
                  <p>
                    Use Base URL <code>http://127.0.0.1:{port}/v1</code> — unlimited local traffic,
                    zero cloud quota, keeps all headers strictly on your computer.
                  </p>
                </div>
              </li>
            </ol>
          </div>
        )}
      </section>

      <aside className="export-side">
        <section className="card full-card">
          <div className="setting-heading-icon green">
            <ShieldCheck size={20} />
          </div>
          <h2>Why zero-quota export?</h2>
          <p>
            Cloudflare Pages serves this studio statically with unlimited free bandwidth, while every
            user&apos;s actual <code>/v1/chat/completions</code> traffic goes straight through their
            own Worker (100k/day free each) or local computer — zero bottleneck, complete privacy.
          </p>
          <div className="detail-list">
            <span>Host Worker quota used <code>0 req/day</code></span>
            <span>Storage isolation <code>{mode === "global" ? "Your browser only" : "Your local data/db.json"}</code></span>
            <span>Baked routes <code>/v1/* &amp; /proxy/:id/v1/*</code></span>
            <span>Suffix auto-toggle <code>-think · -search</code></span>
          </div>
        </section>

        {mode === "global" && onSavePersonalGateway && (
          <section className="card full-card">
            <div className="setting-heading-icon">
              <Cloud size={19} />
            </div>
            <h2>Connect Playground</h2>
            <p>
              Paste your deployed Worker URL or local <code>proxy.mjs</code> address so the built-in
              Playground tests your own endpoint directly.
            </p>
            <label className="field-label" style={{ marginTop: 14 }}>
              PERSONAL GATEWAY URL
            </label>
            <input
              className="field mono"
              value={gatewayInput}
              onChange={(e) => setGatewayInput(e.target.value)}
              placeholder="https://my-ai-proxy.you.workers.dev"
            />
            <label className="field-label" style={{ marginTop: 10 }}>
              API KEY <span>(IF SET)</span>
            </label>
            <input
              className="field mono"
              type="password"
              value={gatewayKeyInput}
              onChange={(e) => setGatewayKeyInput(e.target.value)}
              placeholder="Optional Bearer token"
            />
            <button
              type="button"
              className="button button-dark"
              style={{ marginTop: 12, width: "100%" }}
              onClick={handleSaveGateway}
            >
              {savedNotice ? <CheckCircle2 size={15} /> : <LockKeyhole size={14} />}
              {savedNotice ? "Saved to this browser!" : "Save my gateway URL"}
            </button>
          </section>
        )}
      </aside>
    </div>
  );
}
