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
import { formatResetDuration, getCodexQuotaSnapshot } from './codex-quota.mjs';
import { getTypeSafeKeyStatus } from './jev-client.mjs';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_MANIFEST_PATH = join(dirname(SERVER_DIR), 'plugin.json');
const LEASE_FILE = join(tmpdir(), 'agy-gemini-codex-jev-capsule.lease.json');
const POLL_INTERVAL_MS = 3000;

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
  return '0.2.0';
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

async function listPageTargets(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  timer.unref?.();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal });
    if (!res.ok) return [];
    const list = await res.json();
    if (!Array.isArray(list)) return [];
    return list.filter(
      (t) =>
        t?.type === 'page' &&
        typeof t?.webSocketDebuggerUrl === 'string' &&
        /^https?:\/\/(?:127\.0\.0\.1|localhost)/i.test(String(t?.url || '')),
    );
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

function buildInjectedClientScript(bundleVersion, initialPayload) {
  const verJson = JSON.stringify(bundleVersion);
  const initJson = JSON.stringify(initialPayload);
  return `(() => {
    try {
      const BUNDLE_VERSION = ${verJson};
      const CAPSULE_ID = 'ag-codex-quota-capsule';
      const PORTAL_ID = 'ag-codex-quota-portal';
      const UM_CAPSULE_ID = 'ag-usage-monitor-capsule';

      if (window.__AGCodexQuotaState && window.__AGCodexQuotaState.version === BUNDLE_VERSION) {
        if (typeof window.__AGCodexQuotaEnsureMounted === 'function') {
          window.__AGCodexQuotaEnsureMounted();
        }
        if (typeof window.__AGCodexQuotaUpdate === 'function') {
          window.__AGCodexQuotaUpdate(${initJson});
        }
        return { mounted: true, reused: true };
      }

      if (typeof window.__AGCodexQuotaDispose === 'function') {
        try { window.__AGCodexQuotaDispose(); } catch {}
      }

      const state = {
        version: BUNDLE_VERSION,
        payload: ${initJson},
        pinned: false,
        hoverOpen: false,
        hoverTimer: null,
        closeTimer: null,
        forceRefreshPending: false,
        observer: null,
        disposed: false,
      };
      window.__AGCodexQuotaState = state;

      function tierColor(remainingPct) {
        if (typeof remainingPct !== 'number' || Number.isNaN(remainingPct)) {
          return 'var(--muted-foreground, var(--vscode-descriptionForeground, #6b7280))';
        }
        if (remainingPct >= 50) return 'hsl(145 64% 41%)';
        if (remainingPct >= 20) return 'hsl(35 88% 47%)';
        return 'hsl(4 78% 55%)';
      }

      const capsuleStyles = \`
        :host {
          display: inline-flex;
          align-items: center;
          height: 28px;
          margin-right: 4px;
          flex-shrink: 0;
          vertical-align: middle;
          -webkit-app-region: no-drag;
          pointer-events: auto;
          user-select: none;
          font-family: "Google Sans Flex", "Google Sans", system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          font-size: 12px;
          font-weight: 450;
          line-height: 18px;
          letter-spacing: 0.015em;
          font-variant-numeric: tabular-nums;
          color: var(--vscode-titleBar-activeForeground, var(--foreground, var(--vscode-foreground, #1e293b)));
        }
        .cq-btn {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          height: 28px;
          padding: 0 8px;
          margin: 0;
          background: transparent;
          color: var(--vscode-titleBar-activeForeground, var(--muted-foreground, #475569));
          border: none;
          outline: none;
          border-radius: 4px;
          font-family: inherit;
          font-size: 12px;
          font-weight: 450;
          line-height: 18px;
          font-variant-numeric: tabular-nums;
          cursor: pointer;
          -webkit-app-region: no-drag;
          white-space: nowrap;
          transition: background-color 120ms ease, color 120ms ease;
        }
        .cq-btn:hover, .cq-btn.is-open {
          background: color-mix(in srgb, currentColor 9%, transparent);
          color: var(--foreground, var(--vscode-titleBar-activeForeground, #0f172a));
        }
        .cq-ring {
          width: 14px;
          height: 14px;
          flex-shrink: 0;
          transform: rotate(-90deg);
        }
        .cq-track {
          fill: none;
          stroke: color-mix(in srgb, currentColor 22%, transparent);
          stroke-width: 2.2;
        }
        .cq-fill {
          fill: none;
          stroke-width: 2.2;
          stroke-linecap: round;
          transition: stroke-dashoffset 220ms ease, stroke 180ms ease;
        }
        .cq-label {
          font-weight: 500;
          opacity: 0.88;
        }
        .cq-val-5h {
          font-weight: 600;
        }
        .cq-sep {
          opacity: 0.42;
          font-size: 11px;
        }
        .cq-val-7d {
          opacity: 0.82;
          font-size: 11.5px;
        }
      \`;

      const portalStyles = \`
        :host {
          position: fixed;
          z-index: 2147483000;
          pointer-events: none;
          font-family: "Google Sans Flex", "Google Sans", system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          font-variant-numeric: tabular-nums;
          -webkit-app-region: no-drag;
        }
        .cq-card {
          width: 296px;
          box-sizing: border-box;
          padding: 12px 14px;
          border-radius: 10px;
          background: var(--popover, var(--card, var(--vscode-editorWidget-background, #ffffff)));
          color: var(--popover-foreground, var(--foreground, var(--vscode-foreground, #0f172a)));
          border: 1px solid color-mix(in srgb, var(--border, var(--vscode-widget-border, #94a3b8)) 65%, transparent);
          box-shadow: 0 10px 30px -6px rgba(15, 23, 42, 0.22), 0 2px 8px -2px rgba(15, 23, 42, 0.12);
          pointer-events: auto;
          display: none;
          flex-direction: column;
          gap: 10px;
          font-size: 12px;
          line-height: 1.45;
        }
        .cq-card.is-visible {
          display: flex;
        }
        .cq-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .cq-title-wrap {
          display: flex;
          align-items: center;
          gap: 6px;
          font-weight: 600;
          font-size: 12.5px;
        }
        .cq-badge {
          font-size: 10px;
          font-weight: 600;
          padding: 1px 6px;
          border-radius: 999px;
          background: color-mix(in srgb, hsl(217 82% 51%) 14%, transparent);
          color: hsl(217 82% 51%);
          text-transform: uppercase;
        }
        .cq-refresh {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 3px 8px;
          border-radius: 6px;
          border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
          background: transparent;
          color: inherit;
          font-family: inherit;
          font-size: 11px;
          cursor: pointer;
        }
        .cq-refresh:hover {
          background: color-mix(in srgb, currentColor 7%, transparent);
        }
        .cq-row {
          display: flex;
          flex-direction: column;
          gap: 5px;
          padding: 8px 10px;
          border-radius: 8px;
          background: color-mix(in srgb, currentColor 4%, transparent);
        }
        .cq-row-top {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
        }
        .cq-row-name {
          font-weight: 500;
          opacity: 0.88;
        }
        .cq-row-pct {
          font-size: 14px;
          font-weight: 700;
        }
        .cq-bar-bg {
          height: 5px;
          border-radius: 999px;
          background: color-mix(in srgb, currentColor 12%, transparent);
          overflow: hidden;
        }
        .cq-bar-fill {
          height: 100%;
          border-radius: 999px;
          transition: width 220ms ease, background-color 180ms ease;
        }
        .cq-row-sub {
          display: flex;
          justify-content: space-between;
          font-size: 11px;
          opacity: 0.72;
        }
        .cq-foot {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 6px;
          padding-top: 4px;
          border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent);
          font-size: 11px;
          opacity: 0.75;
        }
        .cq-err {
          font-size: 11.5px;
          color: hsl(4 78% 55%);
          padding: 6px 8px;
          border-radius: 6px;
          background: color-mix(in srgb, hsl(4 78% 55%) 10%, transparent);
        }
      \`;

      const host = document.createElement('div');
      host.id = CAPSULE_ID;
      const hostShadow = host.attachShadow({ mode: 'open' });
      const R = 5.2;
      const CIRC = 2 * Math.PI * R;
      hostShadow.innerHTML = \`
        <style>\${capsuleStyles}</style>
        <button class="cq-btn" type="button" title="Codex 剩余额度（点击固定面板）">
          <svg class="cq-ring" viewBox="0 0 14 14" aria-hidden="true">
            <circle class="cq-track" cx="7" cy="7" r="\${R}"></circle>
            <circle class="cq-fill" cx="7" cy="7" r="\${R}" stroke-dasharray="\${CIRC.toFixed(2)}" stroke-dashoffset="\${CIRC.toFixed(2)}"></circle>
          </svg>
          <span class="cq-label">Codex</span>
          <span class="cq-val-5h">--</span>
          <span class="cq-sep">·</span>
          <span class="cq-val-7d">7d --</span>
        </button>
      \`;

      const portal = document.createElement('div');
      portal.id = PORTAL_ID;
      const portalShadow = portal.attachShadow({ mode: 'open' });
      portalShadow.innerHTML = \`
        <style>\${portalStyles}</style>
        <div class="cq-card" role="dialog" aria-label="Codex 剩余额度详情">
          <div class="cq-head">
            <div class="cq-title-wrap">
              <span>Codex 剩余额度</span>
              <span class="cq-badge" data-role="plan">--</span>
            </div>
            <button class="cq-refresh" type="button" data-role="refresh">↻ 刷新</button>
          </div>
          <div class="cq-err" data-role="err" style="display:none"></div>
          <div class="cq-row">
            <div class="cq-row-top">
              <span class="cq-row-name">5 小时窗口 (5h)</span>
              <span class="cq-row-pct" data-role="p5-rem">--</span>
            </div>
            <div class="cq-bar-bg"><div class="cq-bar-fill" data-role="p5-bar" style="width:0%"></div></div>
            <div class="cq-row-sub">
              <span data-role="p5-used">已用 --</span>
              <span data-role="p5-reset">--</span>
            </div>
          </div>
          <div class="cq-row">
            <div class="cq-row-top">
              <span class="cq-row-name">7 天周窗口 (7d)</span>
              <span class="cq-row-pct" data-role="p7-rem">--</span>
            </div>
            <div class="cq-bar-bg"><div class="cq-bar-fill" data-role="p7-bar" style="width:0%"></div></div>
            <div class="cq-row-sub">
              <span data-role="p7-used">已用 --</span>
              <span data-role="p7-reset">--</span>
            </div>
          </div>
          <div class="cq-foot">
            <span data-role="credits">重置券: --</span>
            <span data-role="jev">Jev: --</span>
            <span data-role="updated">--</span>
          </div>
        </div>
      \`;

      const btnEl = hostShadow.querySelector('.cq-btn');
      const ringFillEl = hostShadow.querySelector('.cq-fill');
      const val5hEl = hostShadow.querySelector('.cq-val-5h');
      const sepEl = hostShadow.querySelector('.cq-sep');
      const val7dEl = hostShadow.querySelector('.cq-val-7d');
      const cardEl = portalShadow.querySelector('.cq-card');

      const q = (role) => portalShadow.querySelector(\`[data-role="\${role}"]\`);

      function positionPortal() {
        const rect = host.getBoundingClientRect();
        if (!rect || rect.width === 0) return;
        const cardW = 296;
        const left = Math.max(8, Math.min(window.innerWidth - cardW - 8, rect.right - cardW));
        const top = Math.max(8, rect.bottom + 6);
        portal.style.left = left + 'px';
        portal.style.top = top + 'px';
      }

      function syncPortalVisibility() {
        const visible = state.pinned || state.hoverOpen;
        btnEl.classList.toggle('is-open', visible);
        cardEl.classList.toggle('is-visible', visible);
        if (visible) positionPortal();
      }

      function scheduleClose() {
        clearTimeout(state.closeTimer);
        state.closeTimer = setTimeout(() => {
          state.hoverOpen = false;
          syncPortalVisibility();
        }, 240);
      }

      btnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        state.pinned = !state.pinned;
        state.hoverOpen = false;
        syncPortalVisibility();
      });
      btnEl.addEventListener('mouseenter', () => {
        clearTimeout(state.closeTimer);
        clearTimeout(state.hoverTimer);
        state.hoverTimer = setTimeout(() => {
          state.hoverOpen = true;
          syncPortalVisibility();
        }, 160);
      });
      btnEl.addEventListener('mouseleave', () => {
        clearTimeout(state.hoverTimer);
        if (!state.pinned) scheduleClose();
      });
      cardEl.addEventListener('mouseenter', () => {
        clearTimeout(state.closeTimer);
      });
      cardEl.addEventListener('mouseleave', () => {
        if (!state.pinned) scheduleClose();
      });

      const refreshBtn = q('refresh');
      refreshBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.forceRefreshPending = true;
        refreshBtn.textContent = '刷新中...';
      });

      const onDocClick = (e) => {
        if (!state.pinned) return;
        const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
        if (path.includes(host) || path.includes(portal)) return;
        state.pinned = false;
        syncPortalVisibility();
      };
      document.addEventListener('click', onDocClick, true);

      function render(data) {
        state.payload = data;
        const quota = data?.quota || {};
        const p5 = quota.primary_5h;
        const p7 = quota.secondary_weekly;

        if (!quota.ok || (!p5 && !p7)) {
          val5hEl.textContent = '--';
          val5hEl.style.color = '';
          sepEl.style.display = 'none';
          val7dEl.style.display = 'none';
          ringFillEl.style.strokeDashoffset = CIRC.toFixed(2);
          q('err').style.display = 'block';
          q('err').textContent = quota.message || '暂未获取到 Codex 额度数据，请检查登录态';
        } else {
          q('err').style.display = 'none';
          const rem5 = p5 ? p5.remaining_pct : null;
          const rem7 = p7 ? p7.remaining_pct : null;
          const color5 = tierColor(rem5);

          if (rem5 !== null) {
            val5hEl.textContent = rem5 + '%';
            val5hEl.style.color = color5;
            const offset = CIRC * (1 - Math.max(0, Math.min(100, rem5)) / 100);
            ringFillEl.style.strokeDashoffset = offset.toFixed(2);
            ringFillEl.style.stroke = color5;
            q('p5-rem').textContent = rem5 + '% 剩余';
            q('p5-rem').style.color = color5;
            q('p5-bar').style.width = rem5 + '%';
            q('p5-bar').style.backgroundColor = color5;
            q('p5-used').textContent = '已用 ' + p5.used_pct + '%';
            q('p5-reset').textContent = (data?.p5_reset_text || '--') + ' 后重置';
          }

          if (rem7 !== null) {
            const color7 = tierColor(rem7);
            sepEl.style.display = '';
            val7dEl.style.display = '';
            val7dEl.textContent = '7d ' + rem7 + '%';
            q('p7-rem').textContent = rem7 + '% 剩余';
            q('p7-rem').style.color = color7;
            q('p7-bar').style.width = rem7 + '%';
            q('p7-bar').style.backgroundColor = color7;
            q('p7-used').textContent = '已用 ' + p7.used_pct + '%';
            q('p7-reset').textContent = (data?.p7_reset_text || '--') + ' 后重置';
          } else {
            sepEl.style.display = 'none';
            val7dEl.style.display = 'none';
          }
        }

        const planEl = q('plan');
        if (quota.plan_type) {
          planEl.style.display = '';
          planEl.textContent = String(quota.plan_type).toUpperCase();
        } else {
          planEl.style.display = 'none';
        }

        q('credits').textContent =
          typeof quota.reset_credits_count === 'number'
            ? '重置券: ' + quota.reset_credits_count + ' 张'
            : '重置券: --';
        q('jev').textContent = data?.jev_ready ? 'Jev: 就绪' : 'Jev: 未配置';
        q('updated').textContent = data?.updated_label || '';
        refreshBtn.textContent = '↻ 刷新';
        if (state.pinned || state.hoverOpen) positionPortal();
      }

      function ensureMounted() {
        if (state.disposed) return false;
        const um = document.getElementById(UM_CAPSULE_ID);
        if (um && um.parentElement) {
          if (host.parentElement !== um.parentElement || host.nextElementSibling !== um) {
            um.parentElement.insertBefore(host, um);
          }
        } else {
          const fallbackContainer =
            document.querySelector('.agy-layout-vars.flex.items-center.justify-end') ||
            document.querySelector('[class*="@container/titlebar"] > div:last-child');
          if (fallbackContainer && host.parentElement !== fallbackContainer) {
            fallbackContainer.prepend(host);
          }
        }
        if (document.body && portal.parentElement !== document.body) {
          document.body.appendChild(portal);
        }
        return Boolean(host.parentElement);
      }

      window.__AGCodexQuotaUpdate = render;
      window.__AGCodexQuotaEnsureMounted = ensureMounted;
      window.__AGCodexQuotaConsumeRefresh = () => {
        const flag = Boolean(state.forceRefreshPending);
        state.forceRefreshPending = false;
        return flag;
      };
      window.__AGCodexQuotaDispose = () => {
        state.disposed = true;
        clearTimeout(state.hoverTimer);
        clearTimeout(state.closeTimer);
        state.observer?.disconnect();
        document.removeEventListener('click', onDocClick, true);
        host.remove();
        portal.remove();
      };

      state.observer = new MutationObserver(() => {
        if (!state.disposed && (!host.isConnected || !portal.isConnected)) {
          ensureMounted();
        }
      });
      if (document.documentElement) {
        state.observer.observe(document.documentElement, { childList: true, subtree: true });
      }

      const mounted = ensureMounted();
      render(state.payload);
      return { mounted, reused: false };
    } catch (err) {
      return { mounted: false, error: String(err?.message || err) };
    }
  })()`;
}

function buildClientPayload(quotaSnapshot, jevStatus) {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return {
    quota: quotaSnapshot,
    p5_reset_text: formatResetDuration(quotaSnapshot?.primary_5h?.resets_at_sec, now.getTime()),
    p7_reset_text: formatResetDuration(quotaSnapshot?.secondary_weekly?.resets_at_sec, now.getTime()),
    jev_ready: Boolean(jevStatus?.present),
    updated_label: `${hh}:${mm}:${ss}`,
  };
}

/**
 * 启动 Antigravity 顶栏胶囊后台守护。
 */
export async function startCapsuleDaemon() {
  const version = readPluginVersion();

  // 检查单实例租约：若已有旧实例存活且版本一致则不重复启动；版本不同则替换旧实例
  try {
    if (existsSync(LEASE_FILE)) {
      const existing = JSON.parse(readFileSync(LEASE_FILE, 'utf8'));
      if (existing?.pid && existing.pid !== process.pid && isPidAlive(existing.pid)) {
        if (existing.version === version) {
          process.exit(0);
          return;
        }
        try {
          process.kill(existing.pid, 'SIGTERM');
        } catch {
          // 忽略无法强杀
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  } catch {
    // 忽略损坏的租约文件
  }

  try {
    writeFileSync(
      LEASE_FILE,
      JSON.stringify({ pid: process.pid, version, startedAt: new Date().toISOString() }),
      'utf8',
    );
  } catch {
    // 忽略租约写入异常
  }

  let shuttingDown = false;
  let syncInFlight = false;
  let cachedJevStatus = getTypeSafeKeyStatus();
  let lastJevCheckMs = Date.now();

  async function collectAllPageUrls() {
    const ports = readActiveDevToolsPorts();
    const urls = [];
    for (const port of ports) {
      const pages = await listPageTargets(port);
      for (const page of pages) {
        if (page.webSocketDebuggerUrl && !urls.includes(page.webSocketDebuggerUrl)) {
          urls.push(page.webSocketDebuggerUrl);
        }
      }
    }
    return urls;
  }

  async function syncOnce() {
    if (shuttingDown || syncInFlight) return;
    syncInFlight = true;
    try {
      const wsUrls = await collectAllPageUrls();
      if (wsUrls.length === 0) return;

      // 先检测页面内是否点击了“刷新”按钮
      let forceLive = false;
      for (const wsUrl of wsUrls) {
        const res = await evaluateCdp(wsUrl, 'Boolean(window.__AGCodexQuotaConsumeRefresh?.())');
        if (res === true) forceLive = true;
      }

      if (Date.now() - lastJevCheckMs > 30_000 || forceLive) {
        cachedJevStatus = getTypeSafeKeyStatus();
        lastJevCheckMs = Date.now();
      }

      const snapshot = await getCodexQuotaSnapshot({ forceLive });
      const payload = buildClientPayload(snapshot, cachedJevStatus);
      const script = buildInjectedClientScript(version, payload);

      await Promise.allSettled(wsUrls.map((wsUrl) => evaluateCdp(wsUrl, script)));
    } finally {
      syncInFlight = false;
    }
  }

  async function shutdown({ disposeUi = false } = {}) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(pollTimer);
    if (disposeUi) {
      try {
        const wsUrls = await collectAllPageUrls();
        await Promise.allSettled(
          wsUrls.map((wsUrl) => evaluateCdp(wsUrl, 'window.__AGCodexQuotaDispose?.(); true;')),
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
      if (stdinBuf.includes('SHUTDOWN_DISPOSE')) {
        void shutdown({ disposeUi: true });
      }
      if (stdinBuf.length > 4096) stdinBuf = stdinBuf.slice(-1024);
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
