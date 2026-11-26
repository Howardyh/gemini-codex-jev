/**
 * @fileoverview Antigravity 顶栏 Codex 剩余额度胶囊守护进程 (`capsule-daemon.mjs`)。
 * 职责：
 * 1. 通过单实例租约防冲突启动，跨平台探测 Antigravity DevToolsActivePort；
 * 2. 定期采集 Codex 5h/7d 剩余额度（app-server + 本地 rollout 双源）与 Jev 密钥状态；
 * 3. 通过 CDP WebSocket 将 `#ag-codex-quota-capsule`（紧贴顶栏右侧胶囊）与 `#ag-codex-quota-portal`（body 悬浮详单）注入页面；
 * 4. 响应前端手动刷新请求并支持优雅卸载 DOM 退出。
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatResetDuration, getCodexQuotaSnapshot, peekCachedCodexQuotaSnapshot } from './codex-quota.mjs';
import { getTypeSafeKeyStatus } from './jev-client.mjs';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_MANIFEST_PATH = join(dirname(SERVER_DIR), 'plugin.json');
const LEASE_FILE = join(tmpdir(), 'agy-gemini-codex-jev-capsule.lease.json');
const POLL_INTERVAL_MS = 1500;
const LEASE_STALE_MS = 10_000;

function readPluginVersion() {
  try {
    if (existsSync(PLUGIN_MANIFEST_PATH)) {
      const parsed = JSON.parse(readFileSync(PLUGIN_MANIFEST_PATH, 'utf8'));
      if (typeof parsed?.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    }
  } catch {
    // 忽略清单读取失败
  }
  return '0.4.0';
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * 跨平台解析 Antigravity DevToolsActivePort 候选文件路径。
 */
export function resolveDevToolsPortCandidates(
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
) {
  const explicit = String(env?.ANTIGRAVITY_DEVTOOLS_PORT_FILE || '').trim();
  if (explicit) return [explicit];
  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };

  if (platform === 'win32') {
    const appData = env?.APPDATA || join(homeDir, 'AppData', 'Roaming');
    const localAppData = env?.LOCALAPPDATA || join(homeDir, 'AppData', 'Local');
    push(join(appData, 'Antigravity', 'DevToolsActivePort'));
    push(join(localAppData, 'Antigravity', 'DevToolsActivePort'));
    push(join(appData, 'Antigravity IDE', 'DevToolsActivePort'));
    push(join(localAppData, 'Antigravity IDE', 'DevToolsActivePort'));
    return out;
  }
  if (platform === 'darwin') {
    push(join(homeDir, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'));
    push(join(homeDir, 'Library', 'Application Support', 'Antigravity IDE', 'DevToolsActivePort'));
    push(join(homeDir, '.config', 'Antigravity', 'DevToolsActivePort'));
    return out;
  }
  const configHome = env?.XDG_CONFIG_HOME || join(homeDir, '.config');
  push(join(configHome, 'Antigravity', 'DevToolsActivePort'));
  push(join(configHome, 'Antigravity IDE', 'DevToolsActivePort'));
  push(join(configHome, 'antigravity', 'DevToolsActivePort'));
  return out;
}

function readActiveDevToolsPorts() {
  const ports = [];
  for (const filePath of resolveDevToolsPortCandidates()) {
    try {
      if (!existsSync(filePath)) continue;
      const lines = readFileSync(filePath, 'utf8').trim().split(/\r?\n/);
      const port = Number.parseInt(String(lines[0] || '').trim(), 10);
      if (Number.isInteger(port) && port > 0 && port <= 65535 && !ports.includes(port)) {
        ports.push(port);
      }
    } catch {
      // 忽略读取异常
    }
  }
  return ports;
}

export function isAntigravityMainPageTarget(target) {
  return target?.type === 'page' && (
    /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+(?:\/|$)/i.test(String(target.url || '')) ||
    /^vscode-file:\/\/vscode-app\/.+\/workbench(?:\.esm|-jetski-agent)?\.html(?:[?#]|$)/i.test(String(target.url || ''))
  );
}

async function listPageTargets(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  timer.unref?.();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal });
    if (!res.ok) return [];
    const list = await res.json();
    if (!Array.isArray(list)) return [];
    return list.filter(isAntigravityMainPageTarget).map((t) => ({ ...t,
      wsUrl: t.webSocketDebuggerUrl || `ws://127.0.0.1:${port}/devtools/page/${encodeURIComponent(String(t.id))}`,
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function evaluateCdp(wsUrl, expression, timeoutMs = 2500) {
  return new Promise((resolvePromise) => {
    let settled = false;
    let ws;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(val);
    };

    const timer = setTimeout(() => {
      try {
        ws?.close();
      } catch {
        // 忽略
      }
      finish(null);
    }, timeoutMs);
    timer.unref?.();

    try {
      ws = new WebSocket(wsUrl);
    } catch {
      finish(null);
      return;
    }

    let pendingResult = null;
    ws.onopen = () => {
      try {
        ws.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { returnByValue: true, expression },
          }),
        );
      } catch {
        finish(null);
      }
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data || '{}'));
        if (msg.id === 1) {
          pendingResult = msg?.result?.result?.value ?? null;
          try {
            ws.close();
          } catch {
            finish(pendingResult);
          }
        }
      } catch {
        // 忽略非 JSON 事件
      }
    };

    ws.onclose = () => finish(pendingResult);
    ws.onerror = () => finish(pendingResult);
  });
}

export function classifyQuotaTone(remainingPct) {
  if (typeof remainingPct !== 'number' || Number.isNaN(remainingPct)) return 'neutral';
  if (remainingPct >= 50) return 'good';
  if (remainingPct >= 20) return 'warn';
  return 'danger';
}

export function buildInjectedClientScript(bundleVersion, initialPayload) {
  return `(${injectedClient.toString()})(${JSON.stringify(bundleVersion)}, ${JSON.stringify(initialPayload)}, ${classifyQuotaTone.toString()})`;
}

// 独立闭包经 CDP 注入，共享同一套主题令牌。
function injectedClient(bundleVersion, initialPayload, classifyQuotaTone) {
  try {
    const CAPSULE_ID = 'ag-codex-quota-capsule';
    const PORTAL_ID = 'ag-codex-quota-portal';
    const UM_CAPSULE_ID = 'ag-usage-monitor-capsule';
    const UM_PORTAL_ID = 'ag-usage-monitor-portal';
    if (window.__AGCodexQuotaState?.version === bundleVersion && !window.__AGCodexQuotaState.disposed) {
      window.__AGCodexQuotaEnsureMounted?.();
      window.__AGCodexQuotaUpdate?.(initialPayload);
      return { mounted: true, reused: true };
    }
    window.__AGCodexQuotaDispose?.();

    const state = {
      version: bundleVersion, payload: initialPayload, pinned: false, hoverOpen: false,
      closeTimer: null, refreshTimer: null, animationTimer: null, wasVisible: false,
      refreshReqSeq: 0, ackRefreshSeq: 0, lastLiveSyncMs: 0, refreshing: false, disposed: false,
      appearanceTargets: [], appearanceObservers: [], observer: null,
    };
    state.refreshReqSeq = Number(initialPayload?.ack_refresh_seq || 0);
    window.__AGCodexQuotaState = state;

    const tokens = `
      :host {
        --font-sans: var(--font-ui-sans, "Google Sans Flex", "Google Sans", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif);
        --font-mono: var(--font-ui-mono, "JetBrains Mono", "Cascadia Code", Consolas, monospace);
        --ui-font-scale: 1;
        --ui-panel-scale: calc(1 + (var(--ui-font-scale, 1) - 1) * 0.75);
        --fs-xs: calc(10px * var(--ui-font-scale, 1));
        --fs-sm: calc(10.5px * var(--ui-font-scale, 1));
        --fs-md: calc(11px * var(--ui-font-scale, 1));
        --fs-base-sm: calc(11.5px * var(--ui-font-scale, 1));
        --fs-base: calc(12px * var(--ui-font-scale, 1));
        --fs-lg: calc(13px * var(--ui-font-scale, 1));
        --surface-bg: var(--background, var(--vscode-sideBar-background, var(--vscode-editor-background, hsl(0 0% 100%))));
        --surface-panel: var(--card, var(--background, var(--vscode-editorWidget-background, var(--vscode-sideBar-background, hsl(0 0% 100%)))));
        --border-hairline: color-mix(in srgb, var(--border, var(--vscode-widget-border, hsl(214 20% 84%))) 82%, var(--surface-panel));
        --border-strong: color-mix(in srgb, var(--foreground, hsl(222 47% 11%)) 22%, var(--border-hairline));
        --text-primary: var(--foreground, var(--vscode-foreground, hsl(222 47% 11%)));
        --text-secondary: var(--muted-foreground, var(--vscode-descriptionForeground, hsl(215 16% 44%)));
        --text-muted: color-mix(in srgb, var(--text-secondary) 72%, var(--surface-bg));
        --accent-primary: var(--user-accent-primary, var(--primary, var(--vscode-textLink-foreground, hsl(217 82% 51%))));
        --accent-primary-soft: color-mix(in srgb, var(--accent-primary) 12%, transparent);
        --accent-primary-border: color-mix(in srgb, var(--accent-primary) 34%, transparent);
        --metric-ok: hsl(145 64% 41%);
        --metric-warn: hsl(35 88% 47%);
        --metric-danger: hsl(4 78% 55%);
        --shadow-overlay: 0 14px 34px rgb(15 23 42 / 0.14), 0 2px 8px rgb(15 23 42 / 0.08);
        --radius-xs: 3px; --radius-sm: 4px; --radius-pill: 999px;
        --ease-fast: cubic-bezier(0.22, 1, 0.36, 1);
        --dur-instant: 90ms; --dur-fast: 140ms; --dur-normal: 180ms;
      }
      :host([data-font-scale="sm"]),
      :host([data-font-scale="compact"]) { --ui-font-scale: 0.92; --ui-panel-scale: 1; }
      :host([data-font-scale="md"]) { --ui-font-scale: 1; --ui-panel-scale: 1; }
      :host([data-font-scale="lg"]),
      :host([data-font-scale="comfortable"]) { --ui-font-scale: 1.14; --ui-panel-scale: 1.09; }
      :host([data-font-scale="xl"]),
      :host([data-font-scale="large"]) { --ui-font-scale: 1.28; --ui-panel-scale: 1.18; }
      :host([data-color-scheme="dark"]) {
        --metric-ok: hsl(145 58% 49%); --metric-warn: hsl(38 92% 56%); --metric-danger: hsl(4 84% 63%);
        --shadow-overlay: 0 16px 38px rgb(0 0 0 / 0.45), 0 3px 10px rgb(0 0 0 / 0.28);
      }
      :host([data-modern-ui="true"]) {
        --radius-xs: 7px; --radius-sm: 10px;
        --ease-modern: cubic-bezier(0.16, 1, 0.3, 1); --dur-fast: 180ms; --dur-normal: 240ms;
        --modern-canvas-bg: color-mix(in srgb, var(--surface-bg) 95.5%, hsl(216 34% 48%) 4.5%);
        --modern-surface-card: #ffffff;
        --modern-surface-subtle: hsl(216 28% 95.8%);
        --modern-surface-hover: hsl(216 26% 93.2%);
        --modern-card-shadow: 0 1px 3px rgb(15 23 42 / 0.045), 0 1px 2px rgb(15 23 42 / 0.03);
        --modern-progress-track: hsl(216 22% 91%);
      }
      :host([data-modern-ui="true"][data-color-scheme="dark"]) {
        --modern-canvas-bg: var(--surface-bg);
        --modern-surface-card: color-mix(in srgb, var(--surface-panel) 95.2%, #ffffff 4.8%);
        --modern-surface-subtle: color-mix(in srgb, var(--surface-panel) 91%, #ffffff 9%);
        --modern-surface-hover: color-mix(in srgb, var(--surface-panel) 87.5%, #ffffff 12.5%);
        --modern-card-shadow: 0 2px 6px rgb(0 0 0 / 0.22);
        --modern-progress-track: rgb(255 255 255 / 0.08);
      }
    `;
    const spinStyles = `@keyframes wm-spin-icon { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
    const capsuleStyles = `${tokens}
      :host {
        display: inline-flex; align-items: center; gap: 6px; height: 28px; margin-right: 4px;
        flex-shrink: 0; vertical-align: middle; -webkit-app-region: no-drag; pointer-events: auto;
        user-select: none; font-family: var(--font-sans); font-size: 12px; font-weight: 450;
        line-height: 18px; letter-spacing: 0.015em; font-variant-numeric: tabular-nums;
      }
      .wm-capsule-btn {
        display: inline-flex; align-items: center; gap: 8px; height: 28px; padding: 0 9px; margin: 0;
        border: none; outline: none; border-radius: var(--radius-sm); background: transparent;
        color: var(--text-secondary); font-family: inherit; font-size: 12px; font-weight: 450;
        line-height: 18px; font-variant-numeric: tabular-nums; cursor: pointer; white-space: nowrap;
        transition: background-color var(--dur-instant) var(--ease-fast), color var(--dur-instant) var(--ease-fast);
      }
      .wm-capsule-btn:hover { background: color-mix(in srgb, var(--text-primary) 7%, transparent); color: var(--text-primary); }
      .wm-capsule-btn.is-open { background: color-mix(in srgb, var(--text-primary) 11%, transparent); color: var(--text-primary); }
      .wm-capsule-btn:focus-visible { box-shadow: inset 0 0 0 1px var(--accent-primary-border); }
      .wm-cap-slot { height: 18px; display: inline-flex; align-items: center; gap: 4px; }
      .wm-sep { width: 1px; height: 12px; background: color-mix(in srgb, var(--text-secondary) 26%, transparent); flex-shrink: 0; }
      .wm-ring-svg { width: 14px; height: 14px; flex-shrink: 0; transform: rotate(-90deg); }
      .wm-ring-track { fill: none; stroke: color-mix(in srgb, var(--text-secondary) 22%, transparent); }
      .wm-ring-fill { fill: none; stroke-linecap: round; transition: stroke-dashoffset var(--dur-normal) var(--ease-fast), stroke var(--dur-fast) var(--ease-fast); }
      .wm-slot-prefix { font-weight: 500; color: var(--text-secondary); }
      .wm-quota-text { font-weight: 500; color: var(--text-primary); }
      .tone-good .wm-ring-fill { stroke: var(--metric-ok); }
      .tone-warn .wm-ring-fill { stroke: var(--metric-warn); }
      .tone-danger .wm-ring-fill { stroke: var(--metric-danger); }
      .tone-neutral .wm-ring-fill { stroke: var(--text-muted); }
      .tone-good .wm-quota-text { color: var(--text-primary); }
      .tone-warn .wm-quota-text { color: var(--metric-warn); }
      .tone-danger .wm-quota-text { color: var(--metric-danger); }
      .tone-neutral .wm-quota-text { color: var(--text-muted); }
      :host([data-layout="compact"]) .wm-seg-secondary .wm-ring-svg { display: none; }
      :host([data-layout="tight"]) .wm-sep, :host([data-layout="tight"]) .wm-seg-secondary,
      :host([data-layout="minimal"]) .wm-sep, :host([data-layout="minimal"]) .wm-seg-secondary { display: none; }
      .is-refreshing .wm-seg-primary .wm-ring-svg { animation: wm-spin-icon 0.9s linear infinite; }
      ${spinStyles}
      @media (prefers-reduced-motion: reduce) { .wm-ring-svg, .wm-ring-fill { animation: none !important; transition: none !important; } }
    `;
    const portalStyles = `${tokens}
      :host {
        position: fixed; inset: 0; width: 0; height: 0; overflow: visible; pointer-events: none;
        z-index: 2147483000; font-family: var(--font-sans); font-size: var(--fs-base);
        line-height: 1.45; font-variant-numeric: tabular-nums;
      }
      @keyframes wm-popover-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes wm-popover-in-up { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes anim-modern-pop-in { from { opacity: 0; transform: translateY(-4px) scale(0.975); } to { opacity: 1; transform: translateY(0) scale(1); } }
      @keyframes anim-modern-pop-in-up { from { opacity: 0; transform: translateY(4px) scale(0.975); } to { opacity: 1; transform: translateY(0) scale(1); } }
      ${spinStyles}
      .wm-popover-card {
        position: fixed; width: min(calc(344px * var(--ui-panel-scale, 1)), calc(100vw - 24px));
        box-sizing: border-box; padding: 10px; background: var(--surface-bg); color: var(--text-primary);
        border: 1px solid var(--border-hairline); border-radius: var(--radius-sm); box-shadow: var(--shadow-overlay);
        pointer-events: auto; display: none; flex-direction: column; gap: 0; -webkit-app-region: no-drag;
      }
      .wm-popover-card.is-visible { display: flex; }
      .wm-popover-card.is-hover { animation: wm-popover-in var(--dur-instant) var(--ease-fast); transform-origin: top right; }
      .wm-popover-card.is-pinned { animation: wm-popover-in var(--dur-fast) var(--ease-fast); transform-origin: top right; }
      .wm-popover-card.is-above { transform-origin: bottom right; animation-name: wm-popover-in-up; }
      .wm-popover-card.is-instant { animation: none !important; }
      :host([data-modern-ui="true"]) .wm-popover-card { border-radius: 14px; border: none; background: var(--modern-canvas-bg); }
      :host([data-modern-ui="true"]) .wm-popover-card.is-hover,
      :host([data-modern-ui="true"]) .wm-popover-card.is-pinned { animation: anim-modern-pop-in 180ms var(--ease-modern); }
      :host([data-modern-ui="true"]) .wm-popover-card.is-above { animation-name: anim-modern-pop-in-up; }
      :host([data-modern-ui="true"]) .wm-popover-card.is-instant { animation: none !important; }
      .panel { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; background: var(--surface-panel); border: 1px solid var(--border-hairline); border-radius: var(--radius-sm); }
      :host([data-modern-ui="true"]) .panel { border: none; background: var(--modern-surface-card); box-shadow: var(--modern-card-shadow); }
      .panel-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .panel-title { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-base); font-weight: 600; }
      .panel-meta { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: var(--fs-sm); }
      .agent-badge, .wm-pin-badge { padding: 1px 5px; border-radius: var(--radius-xs); font-size: var(--fs-xs); font-weight: 500; white-space: nowrap; }
      .agent-badge { background: var(--accent-primary-soft); color: var(--accent-primary); }
      .wm-pin-badge { background: var(--accent-primary-soft); color: var(--text-secondary); }
      [hidden] { display: none !important; }
      .wm-updated { font-family: var(--font-mono); font-size: var(--fs-xs); white-space: nowrap; }
      .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; flex: 0 0 22px; padding: 0; border: none; border-radius: var(--radius-xs); background: transparent; color: var(--text-secondary); cursor: pointer; transition: background-color var(--dur-instant) var(--ease-fast), color var(--dur-instant) var(--ease-fast); }
      .icon-btn:hover { background: color-mix(in srgb, var(--text-primary) 7%, transparent); color: var(--text-primary); }
      .icon-btn:focus-visible { outline: 1px solid var(--accent-primary-border); outline-offset: 1px; }
      .wm-refresh-btn svg { width: 13px; height: 13px; }
      .wm-refresh-btn.is-spinning svg { animation: wm-spin-icon 0.9s linear infinite; }
      .wm-error-banner { padding: 6px 8px; border-radius: var(--radius-xs); color: var(--metric-danger); background: color-mix(in srgb, var(--metric-danger) 10%, transparent); font-size: var(--fs-base-sm); overflow-wrap: anywhere; }
      .quota-pool-row { display: flex; flex-direction: column; gap: 8px; }
      .quota-pool-row.has-divider { padding-top: 10px; border-top: 1px solid var(--border-hairline); }
      .quota-win-head { align-items: baseline; gap: 8px; min-width: 0; }
      .quota-win-left { display: inline-flex; align-items: baseline; gap: 5px; min-width: 0; flex: 1 1 auto; overflow: hidden; }
      .quota-win-title { font-size: var(--fs-base-sm); font-weight: 500; white-space: nowrap; flex-shrink: 0; }
      .quota-win-usage { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-sm); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
      .quota-win-meta { display: inline-flex; align-items: baseline; gap: 6px; white-space: nowrap; flex-shrink: 0; }
      .quota-rem-val { font-size: var(--fs-base); font-weight: 600; color: var(--text-primary); }
      .quota-rem-val.tone-warn { color: var(--metric-warn); }
      .quota-rem-val.tone-danger { color: var(--metric-danger); }
      .quota-rem-val.tone-neutral { color: var(--text-muted); }
      .progress-track { height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--text-primary) 9%, transparent); overflow: hidden; }
      :host([data-modern-ui="true"]) .progress-track { border-radius: var(--radius-pill); background: var(--modern-progress-track); }
      .progress-fill { height: 100%; width: 0%; background: var(--accent-primary); transition: width var(--dur-normal) var(--ease-fast), background-color var(--dur-fast) var(--ease-fast); }
      .progress-fill.tone-warn { background: var(--metric-warn); }
      .progress-fill.tone-danger { background: var(--metric-danger); }
      .progress-fill.tone-neutral { background: var(--text-muted); }
      .wm-hover-quota-foot { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; color: var(--text-secondary); font-size: var(--fs-xs); }
      @media (prefers-reduced-motion: reduce) { .wm-popover-card, .wm-refresh-btn svg, .progress-fill { animation: none !important; transition: none !important; } }
    `;

    const host = document.createElement('div');
    host.id = CAPSULE_ID;
    const hostShadow = host.attachShadow({ mode: 'open' });
    const CIRC = 2 * Math.PI * 5.25;
    const ring = `<svg class="wm-ring-svg" viewBox="0 0 14 14" aria-hidden="true"><circle class="wm-ring-track" cx="7" cy="7" r="5.25" stroke-width="2"></circle><circle class="wm-ring-fill" cx="7" cy="7" r="5.25" stroke-width="2" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}"></circle></svg>`;
    hostShadow.innerHTML = `<style>${capsuleStyles}</style>
      <button class="wm-capsule-btn" type="button" aria-expanded="false" aria-haspopup="dialog" title="Codex 剩余额度（点击固定，右键刷新）">
        <span class="wm-cap-slot wm-seg-primary tone-neutral">${ring}<span class="wm-slot-prefix">Codex</span><span class="wm-quota-text">--</span></span>
        <span class="wm-sep" aria-hidden="true"></span>
        <span class="wm-cap-slot wm-seg-secondary tone-neutral">${ring}<span class="wm-slot-prefix">7d</span><span class="wm-quota-text">--</span></span>
      </button>`;
    const portal = document.createElement('div');
    portal.id = PORTAL_ID;
    const portalShadow = portal.attachShadow({ mode: 'open' });
    const poolRow = (prefix, title, divider = '') => `<div class="quota-pool-row ${divider}">
      <div class="panel-header quota-win-head"><div class="quota-win-left"><span class="quota-win-title">${title}</span><span class="quota-win-usage" data-role="${prefix}-used">已用 --</span></div>
        <div class="panel-meta quota-win-meta"><span class="quota-rem-val" data-role="${prefix}-rem">--</span><span data-role="${prefix}-reset">--</span></div></div>
      <div class="progress-track"><div class="progress-fill" data-role="${prefix}-bar"></div></div></div>`;
    portalShadow.innerHTML = `<style>${portalStyles}</style>
      <div class="wm-popover-card" role="dialog" aria-label="Codex 可用额度">
        <div class="panel">
          <div class="panel-header"><div class="panel-title">Codex 可用额度<span class="agent-badge" data-role="plan">PLUS</span><span class="wm-pin-badge" data-role="pin-badge" hidden>已固定</span></div>
            <div class="panel-meta"><span class="wm-updated" data-role="updated">--</span><button class="icon-btn wm-refresh-btn" type="button" data-role="refresh" aria-label="刷新 Codex 额度"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 6a5.25 5.25 0 1 0 .1 3.5M13 2.5V6H9.5"/></svg></button></div></div>
          <div class="wm-error-banner" data-role="err" hidden></div>
          ${poolRow('p5', '5 小时窗口')}${poolRow('p7', '7 天周窗口', 'has-divider')}
          <div class="wm-hover-quota-foot"><span data-role="credits">重置券 -- 张</span><span aria-hidden="true">·</span><span data-role="source">--</span><span aria-hidden="true">·</span><span data-role="jev">Jev 未配置</span></div>
        </div>
      </div>`;
    const btnEl = hostShadow.querySelector('.wm-capsule-btn');
    const cardEl = portalShadow.querySelector('.wm-popover-card');
    const q = (role) => portalShadow.querySelector(`[data-role="${role}"]`);
    const refreshBtn = q('refresh');

    function setAttributeIfChanged(node, name, value) {
      if (value == null) {
        if (node.hasAttribute(name)) node.removeAttribute(name);
      } else if (node.getAttribute(name) !== value) node.setAttribute(name, value);
    }
    function setPropertyIfChanged(node, name, value) {
      if (node.style.getPropertyValue(name) === value) return;
      if (value) node.style.setProperty(name, value);
      else node.style.removeProperty(name);
    }

    function syncHostAppearance() {
      if (state.disposed) return;
      const umPortal = document.getElementById(UM_PORTAL_ID);
      const umCapsule = document.getElementById(UM_CAPSULE_ID);
      const workbench = document.querySelector('.monaco-workbench');
      const targets = [umPortal, umCapsule, workbench];
      if (targets.some((node, index) => node !== state.appearanceTargets[index])) {
        state.appearanceObservers.forEach((observer) => observer.disconnect());
        state.appearanceObservers = [];
        state.appearanceTargets = targets;
        // 只观察宿主来源，避免自身属性写入形成反馈环。
        targets.filter(Boolean).forEach((node) => {
          const observer = new MutationObserver(() => {
            syncHostAppearance();
            syncPortalVisibility();
          });
          observer.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'data-color-scheme', 'data-modern-ui', 'data-font-scale', 'data-layout'] });
          state.appearanceObservers.push(observer);
        });
      }
      const sources = [workbench, document.documentElement, document.body].filter(Boolean);
      const styles = sources.map((node) => getComputedStyle(node));
      const readVar = (name) => styles.map((style) => style.getPropertyValue(name).trim()).find(Boolean) || '';
      let scheme = umPortal?.getAttribute('data-color-scheme');
      if (!scheme) {
        const darkClass = sources.some((node) => node.classList.contains('vs-dark') || node.classList.contains('hc-black'));
        const lightClass = sources.some((node) => node.classList.contains('vs') || node.classList.contains('hc-light'));
        const background = styles.map((style) => style.backgroundColor).find((color) => color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') || readVar('--vscode-editor-background');
        const rgb = background?.match(/[\d.]+/g)?.slice(0, 3).map(Number);
        const luminance = rgb?.length === 3 ? (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255 : 1;
        scheme = darkClass ? 'dark' : lightClass ? 'light' : luminance < 0.5 ? 'dark' : 'light';
      }
      const customProperties = ['--background', '--card', '--foreground', '--muted-foreground', '--border', '--primary', '--destructive', '--user-accent-primary', '--font-ui-sans', '--font-ui-mono'];
      const vscodeProperties = ['--vscode-sideBar-background', '--vscode-editor-background', '--vscode-editorWidget-background', '--vscode-widget-border', '--vscode-foreground', '--vscode-descriptionForeground', '--vscode-textLink-foreground'];
      [host, portal].forEach((node) => {
        setAttributeIfChanged(node, 'data-color-scheme', scheme);
        ['data-modern-ui', 'data-font-scale'].forEach((name) => setAttributeIfChanged(node, name, umPortal?.getAttribute(name) ?? null));
        customProperties.forEach((name) => setPropertyIfChanged(node, name, umPortal ? umPortal.style.getPropertyValue(name) : readVar(name)));
        vscodeProperties.forEach((name) => setPropertyIfChanged(node, name, readVar(name)));
      });
      setAttributeIfChanged(host, 'data-layout', umCapsule?.getAttribute('data-layout') ?? null);
    }

    function positionPortal() {
      const rect = host.getBoundingClientRect();
      if (!rect.width) return;
      // offset 尺寸不受入场 transform 影响。
      const width = cardEl.offsetWidth;
      const height = cardEl.offsetHeight;
      const above = rect.bottom + 6 + height > window.innerHeight - 8;
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
      const desiredTop = above ? rect.top - height - 6 : rect.bottom + 6;
      const top = Math.max(8, Math.min(window.innerHeight - height - 8, desiredTop));
      cardEl.classList.toggle('is-above', above);
      setPropertyIfChanged(cardEl, 'left', `${left}px`);
      setPropertyIfChanged(cardEl, 'top', `${top}px`);
    }
    function lockAnimation() {
      clearTimeout(state.animationTimer);
      if (state.wasVisible) cardEl.classList.add('is-instant');
    }
    function syncPortalVisibility() {
      const visible = state.pinned || state.hoverOpen;
      const wasVisible = state.wasVisible;
      if (!wasVisible && visible && Date.now() - state.lastLiveSyncMs > 20_000 && !state.refreshing) {
        state.refreshReqSeq += 1;
        setRefreshing(true);
      }
      // 仅从关闭到可见时播放；轮询、固定切换和重排均保持静止。
      if (!wasVisible && visible) cardEl.classList.remove('is-instant');
      else cardEl.classList.add('is-instant');
      btnEl.classList.toggle('is-open', visible);
      setAttributeIfChanged(btnEl, 'aria-expanded', String(visible));
      q('pin-badge').hidden = !state.pinned;
      cardEl.classList.toggle('is-visible', visible);
      cardEl.classList.toggle('is-hover', visible && !state.pinned);
      cardEl.classList.toggle('is-pinned', visible && state.pinned);
      state.wasVisible = visible;
      if (visible) positionPortal();
      if (!wasVisible && visible) {
        clearTimeout(state.animationTimer);
        state.animationTimer = setTimeout(lockAnimation, 260);
      }
    }
    cardEl.addEventListener('animationend', (event) => { if (event.target === cardEl) lockAnimation(); });
    function closePortal() {
      clearTimeout(state.closeTimer);
      state.pinned = false;
      state.hoverOpen = false;
      syncPortalVisibility();
    }
    function scheduleClose() {
      clearTimeout(state.closeTimer);
      state.closeTimer = setTimeout(() => {
        state.hoverOpen = false;
        syncPortalVisibility();
      }, 40);
    }
    btnEl.addEventListener('click', (event) => {
      event.stopPropagation();
      clearTimeout(state.closeTimer);
      state.pinned = !state.pinned;
      state.hoverOpen = false;
      syncPortalVisibility();
    });
    const hoverEnter = () => {
      clearTimeout(state.closeTimer);
      state.hoverOpen = true;
      syncPortalVisibility();
    };
    host.addEventListener('mouseenter', hoverEnter);
    host.addEventListener('mouseleave', scheduleClose);
    cardEl.addEventListener('mouseenter', hoverEnter);
    cardEl.addEventListener('mouseleave', scheduleClose);

    function setRefreshing(active) {
      state.refreshing = active;
      btnEl.classList.toggle('is-refreshing', active);
      refreshBtn.classList.toggle('is-spinning', active);
      setAttributeIfChanged(refreshBtn, 'aria-busy', String(active));
    }
    function requestRefresh(event) {
      event.preventDefault();
      event.stopPropagation();
      state.refreshReqSeq += 1;
      setRefreshing(true);
    }
    btnEl.addEventListener('contextmenu', requestRefresh);
    refreshBtn.addEventListener('click', requestRefresh);
    const onDocClick = (event) => {
      const path = event.composedPath?.() || [];
      if (!path.includes(host) && !path.includes(portal)) closePortal();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        const hadFocus = portalShadow.activeElement;
        closePortal();
        if (hadFocus) btnEl.focus();
      }
    };
    const onResize = () => { lockAnimation(); syncPortalVisibility(); };
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);

    function applyTone(node, tone) {
      ['good', 'warn', 'danger', 'neutral'].forEach((name) => node.classList.toggle(`tone-${name}`, name === tone));
    }
    function render(data) {
      if (state.disposed) return;
      state.payload = data;
      const quota = data?.quota || {};
      const p5 = quota.ok ? quota.primary_5h : null;
      const p7 = quota.ok ? quota.secondary_weekly : null;
      q('err').hidden = Boolean(quota.ok && (p5 || p7));
      q('err').textContent = q('err').hidden ? '' : quota.message || '暂未获取到 Codex 额度，请检查登录状态';
      [[p5, 'p5', '.wm-seg-primary'], [p7, 'p7', '.wm-seg-secondary']].forEach(([pool, prefix, selector]) => {
        const rem = pool?.remaining_pct;
        const valid = typeof rem === 'number' && Number.isFinite(rem);
        const tone = classifyQuotaTone(valid ? rem : null);
        const slot = hostShadow.querySelector(selector);
        applyTone(slot, tone);
        slot.querySelector('.wm-quota-text').textContent = valid ? `${rem}%` : '--';
        const pct = valid ? Math.max(0, Math.min(100, rem)) : 0;
        slot.querySelector('.wm-ring-fill').style.strokeDashoffset = String(CIRC * (1 - pct / 100));
        q(`${prefix}-rem`).textContent = valid ? `${rem}%` : '--';
        applyTone(q(`${prefix}-rem`), tone);
        q(`${prefix}-bar`).style.width = `${pct}%`;
        applyTone(q(`${prefix}-bar`), tone);
        q(`${prefix}-used`).textContent = `已用 ${typeof pool?.used_pct === 'number' && Number.isFinite(pool.used_pct) ? pool.used_pct + '%' : '--'}`;
        const reset = pool ? data?.[`${prefix}_reset_text`] : null;
        q(`${prefix}-reset`).textContent = !reset || reset === '--' ? '--' : reset === '即将重置' ? reset : `${reset} 后重置`;
      });
      q('plan').hidden = !quota.plan_type;
      q('plan').textContent = String(quota.plan_type || '').toUpperCase();
      q('credits').textContent = `重置券 ${Number.isFinite(quota.reset_credits_count) ? quota.reset_credits_count : '--'} 张`;
      q('source').textContent = quota.source === 'session_rollout' ? 'Session' : ['app_server_live', 'live+rollout'].includes(quota.source) ? 'Live' : '--';
      q('jev').textContent = data?.jev_ready ? 'Jev 就绪' : 'Jev 未配置';
      q('updated').textContent = data?.updated_label || '--';
      // 请求被守护进程消费后，下一份 payload 才结束刷新反馈。
      state.ackRefreshSeq = Math.max(state.ackRefreshSeq, Number(data?.ack_refresh_seq || 0));
      state.refreshReqSeq = Math.max(state.refreshReqSeq, state.ackRefreshSeq);
      if (data?.quota?.source === 'app_server_live') {
        const fetchedMs = Number(data?.quota?.fetched_at_ms || 0);
        if (fetchedMs > 0) state.lastLiveSyncMs = Math.max(state.lastLiveSyncMs, fetchedMs);
      }
      if (data?.syncing) setRefreshing(true);
      if (!data?.syncing && state.ackRefreshSeq >= state.refreshReqSeq) {
        clearTimeout(state.refreshTimer);
        setRefreshing(false);
      }
      syncHostAppearance();
      syncPortalVisibility();
    }
    function ensureMounted() {
      if (state.disposed) return false;
      const um = document.getElementById(UM_CAPSULE_ID);
      if (um?.parentElement) {
        if (host.parentElement !== um.parentElement || host.nextElementSibling !== um) um.parentElement.insertBefore(host, um);
      } else {
        const container = document.querySelector('.agy-layout-vars.flex.items-center.justify-end') || document.querySelector('[class*="@container/titlebar"] > div:last-child');
        if (container && host.parentElement !== container) container.prepend(host);
      }
      if (document.body && portal.parentElement !== document.body) document.body.appendChild(portal);
      syncHostAppearance();
      return Boolean(host.parentElement);
    }
    window.__AGCodexQuotaUpdate = render;
    window.__AGCodexQuotaEnsureMounted = ensureMounted;
    window.__AGCodexQuotaPeekRefreshSeq = () => Number(state.refreshReqSeq || 0);
    window.__AGCodexQuotaConsumeRefresh = () => state.refreshReqSeq > state.ackRefreshSeq;
    const dispose = () => {
      state.disposed = true;
      clearTimeout(state.closeTimer);
      clearTimeout(state.refreshTimer);
      clearTimeout(state.animationTimer);
      state.observer?.disconnect();
      state.appearanceObservers.forEach((observer) => observer.disconnect());
      state.appearanceObservers = [];
      state.appearanceTargets = [];
      window.removeEventListener('resize', onResize);
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKeyDown);
      host.remove();
      portal.remove();
      // 释放旧闭包，版本替换不会留下悬挂引用。
      if (window.__AGCodexQuotaDispose === dispose) {
        delete window.__AGCodexQuotaUpdate;
        delete window.__AGCodexQuotaEnsureMounted;
        delete window.__AGCodexQuotaConsumeRefresh;
        delete window.__AGCodexQuotaPeekRefreshSeq;
        delete window.__AGCodexQuotaDispose;
        delete window.__AGCodexQuotaState;
      }
    };
    window.__AGCodexQuotaDispose = dispose;
    state.observer = new MutationObserver(() => {
      if (!state.disposed) ensureMounted();
    });
    if (document.documentElement) state.observer.observe(document.documentElement, { childList: true, subtree: true });
    const mounted = ensureMounted();
    render(state.payload);
    return { mounted, reused: false };
  } catch (err) {
    window.__AGCodexQuotaDispose?.();
    return { mounted: false, error: String(err?.message || err) };
  }
}


export function buildClientPayload(quotaSnapshot, jevStatus, nowMs = Date.now(), opts = undefined) {
  const now = new Date(nowMs);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return {
    quota: quotaSnapshot,
    p5_reset_text: formatResetDuration(quotaSnapshot?.primary_5h?.resets_at_sec, now.getTime()),
    p7_reset_text: formatResetDuration(quotaSnapshot?.secondary_weekly?.resets_at_sec, now.getTime()),
    jev_ready: Boolean(jevStatus?.present),
    updated_label: `${hh}:${mm}:${ss}`,
    ...(opts === undefined ? {} : {
      ack_refresh_seq: Number(opts.ackRefreshSeq || 0), syncing: Boolean(opts.syncing),
    }),
  };
}

async function tryAcquireOrRenewLease(version) {
  let existing = null;
  try { existing = JSON.parse(readFileSync(LEASE_FILE, 'utf8')); } catch {}
  const alive = isPidAlive(existing?.pid);
  const nowMs = Date.now();
  const stale = !Number.isFinite(Number(existing?.heartbeatAt)) ||
    nowMs - Number(existing?.heartbeatAt || 0) > LEASE_STALE_MS;
  if (existing?.pid !== process.pid && alive && !stale && existing.version === version) return false;
  if (existing?.pid !== process.pid && alive && existing.version !== version) {
    try { process.kill(existing.pid, 'SIGTERM'); } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  }
  try {
    writeFileSync(LEASE_FILE, JSON.stringify({ pid: process.pid, version,
      startedAt: existing?.pid === process.pid ? existing.startedAt : nowMs,
      heartbeatAt: Date.now() }), 'utf8');
    return true;
  } catch { return false; }
}

function holdsLease() {
  try { return JSON.parse(readFileSync(LEASE_FILE, 'utf8'))?.pid === process.pid; }
  catch { return false; }
}
/**
 * 启动 Antigravity 顶栏胶囊后台守护。
 */
export async function startCapsuleDaemon() {
  const version = readPluginVersion();

  let shuttingDown = false;
  let syncInFlight = false;
  let lastAckedRefreshSeq = 0;
  let pendingExternalForce = false;
  let cachedJevStatus = getTypeSafeKeyStatus();
  let lastJevCheckMs = Date.now();

  async function collectAllPageUrls() {
    const ports = readActiveDevToolsPorts();
    const urls = [];
    for (const port of ports) {
      const pages = await listPageTargets(port);
      for (const page of pages) {
        if (page.wsUrl && !urls.includes(page.wsUrl)) {
          urls.push(page.wsUrl);
        }
      }
    }
    return urls;
  }

  async function syncOnce({ externalForce = false } = {}) {
    pendingExternalForce ||= externalForce;
    if (shuttingDown || syncInFlight) return;
    syncInFlight = true;
    let heartbeatTimer;
    try {
      if (!(await tryAcquireOrRenewLease(version))) return;
      // Keep a fresh heartbeat while a live request is pending.
      heartbeatTimer = setInterval(() => {
        if (!shuttingDown && holdsLease()) void tryAcquireOrRenewLease(version);
      }, POLL_INTERVAL_MS);
      const wsUrls = await collectAllPageUrls();
      if (wsUrls.length === 0 || shuttingDown || !holdsLease()) return;
      let maxReqSeq = lastAckedRefreshSeq;
      await Promise.allSettled(wsUrls.map(async (wsUrl) => {
        const probe = await evaluateCdp(wsUrl, `({ mounted: Boolean(document.getElementById('ag-codex-quota-capsule')), reqSeq: Number(window.__AGCodexQuotaPeekRefreshSeq?.() || 0), ver: window.__AGCodexQuotaState?.version || '' })`);
        maxReqSeq = Math.max(maxReqSeq, Number(probe?.reqSeq || 0));
        if (!probe?.mounted || probe.ver !== version) {
          const peek = peekCachedCodexQuotaSnapshot();
          const initial = buildClientPayload(peek, cachedJevStatus, Date.now(), {
            ackRefreshSeq: lastAckedRefreshSeq, syncing: true,
          });
          if (!shuttingDown && holdsLease()) await evaluateCdp(wsUrl, buildInjectedClientScript(version, initial));
        }
      }));
      const forceLive = maxReqSeq > lastAckedRefreshSeq || pendingExternalForce;
      pendingExternalForce = false;
      if (Date.now() - lastJevCheckMs > 30_000 || forceLive) {
        cachedJevStatus = getTypeSafeKeyStatus();
        lastJevCheckMs = Date.now();
      }
      const snapshot = await getCodexQuotaSnapshot({ forceLive });
      if (shuttingDown || !holdsLease()) return;
      lastAckedRefreshSeq = maxReqSeq;
      const payload = buildClientPayload(snapshot, cachedJevStatus, Date.now(), {
        ackRefreshSeq: lastAckedRefreshSeq, syncing: false,
      });
      const script = buildInjectedClientScript(version, payload);
      await Promise.allSettled(wsUrls.map((wsUrl) => evaluateCdp(wsUrl, script)));
    } finally {
      clearInterval(heartbeatTimer);
      syncInFlight = false;
    }
  }
  async function shutdown({ disposeUi = false } = {}) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(pollTimer);
    if (disposeUi === true && holdsLease()) {
      try {
        const wsUrls = await collectAllPageUrls();
        await Promise.allSettled(
          wsUrls.map((wsUrl) => holdsLease() ? evaluateCdp(wsUrl, 'window.__AGCodexQuotaDispose?.(); true;') : null),
        );
      } catch {
        // 忽略卸载清理异常
      }
    }
    try {
      if (existsSync(LEASE_FILE)) {
        const curr = JSON.parse(readFileSync(LEASE_FILE, 'utf8'));
        if (curr?.pid === process.pid) unlinkSync(LEASE_FILE);
      }
    } catch {
      // 忽略
    }
    setImmediate(() => process.exit(0));
  }

  // 监听 stdin 控制信号
  if (process.stdin && !process.stdin.destroyed) {
    let stdinBuf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      stdinBuf += String(chunk || '');
      let newline;
      while ((newline = stdinBuf.indexOf('\n')) !== -1) {
        const command = stdinBuf.slice(0, newline).trim();
        stdinBuf = stdinBuf.slice(newline + 1);
        if (command === 'SHUTDOWN_DISPOSE') void shutdown({ disposeUi: true });
        if (command === 'FORCE_REFRESH') void syncOnce({ externalForce: true });
      }
      if (stdinBuf.length > 4096) stdinBuf = '';
    });
    process.stdin.on('end', () => void shutdown({ disposeUi: false }));
    process.stdin.on('close', () => void shutdown({ disposeUi: false }));
    process.stdin.resume();
  }

  process.on('SIGTERM', () => void shutdown({ disposeUi: true }));
  process.on('SIGINT', () => void shutdown({ disposeUi: true }));

  void syncOnce();
  const pollTimer = setInterval(() => void syncOnce(), POLL_INTERVAL_MS);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase()
) {
  void startCapsuleDaemon();
}
