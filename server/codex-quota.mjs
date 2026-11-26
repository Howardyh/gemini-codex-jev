/**
 * @fileoverview OpenAI Codex 剩余额度（5h 窗口 / 7d 周窗口 / 重置券）双源采集模块。
 * 数据源：
 * 1. 主动实时源：通过本机完整版 codex app-server --stdio 发送 JSON-RPC account/rateLimits/read；
 * 2. 本地零开销源：扫描 ~/.codex/sessions 最近修改的 rollout *.jsonl 尾部最后一条 rate_limits 事件。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, openSync, closeSync, readdirSync, readSync, statSync, mkdirSync, renameSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { discoverCodexBinary, discoverGitBinDir } from './codex-runner.mjs';
import { resolveSubprocessProxyEnv } from './jev-client.mjs';

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const SESSIONS_ROOT = join(CODEX_HOME, 'sessions');
const LIVE_CACHE_TTL_MS = 90_000;
const TAIL_READ_BYTES = 131_072;

let cachedSnapshot = null;
let lastLiveAttemptMs = 0;
let liveFailCount = 0;

function clampPct(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, Math.round(num * 10) / 10));
}

function normalizeWindowEntry(raw, fallbackMins) {
  if (!raw || typeof raw !== 'object') return null;
  const usedRaw = raw.usedPercent ?? raw.used_percent;
  const usedPct = clampPct(usedRaw);
  if (usedPct === null) return null;
  const remainingPct = Math.max(0, Math.min(100, Math.round((100 - usedPct) * 10) / 10));
  const windowMins = Number(raw.windowDurationMins ?? raw.window_minutes ?? fallbackMins) || fallbackMins;
  const resetsAtSec = Number(raw.resetsAt ?? raw.resets_at ?? 0) || null;
  return {
    used_pct: usedPct,
    remaining_pct: remainingPct,
    window_mins: windowMins,
    resets_at_sec: resetsAtSec,
  };
}

/**
 * 格式化距重置时间点剩余时长（例如 "2h 15m" 或 "3d 4h"）。
 * @param {number | null | undefined} resetsAtSec
 * @param {number} [nowMs=Date.now()]
 * @returns {string}
 */
export function formatResetDuration(resetsAtSec, nowMs = Date.now()) {
  const sec = Number(resetsAtSec);
  if (!Number.isFinite(sec) || sec <= 0) return '--';
  const diffMs = sec * 1000 - nowMs;
  if (diffMs <= 0) return '即将重置';
  const totalMins = Math.ceil(diffMs / 60_000);
  const days = Math.floor(totalMins / (60 * 24));
  const hours = Math.floor((totalMins % (60 * 24)) / 60);
  const mins = totalMins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * 归一化 codex app-server account/rateLimits/read 响应。
 * @param {object} result
 * @param {number} [nowMs=Date.now()]
 */
export function normalizeAppServerRateLimits(result, nowMs = Date.now()) {
  const limits = result?.rateLimits || result?.rateLimitsByLimitId?.codex || null;
  if (!limits || typeof limits !== 'object') return null;
  const primary5h = normalizeWindowEntry(limits.primary, 300);
  const secondaryWeekly = normalizeWindowEntry(limits.secondary, 10080);
  if (!primary5h && !secondaryWeekly) return null;

  const creditsList = Array.isArray(result?.rateLimitResetCredits?.credits)
    ? result.rateLimitResetCredits.credits
    : [];
  const availableFromList = creditsList.filter((c) => c?.status === 'available').length;
  const resetCreditsCount = Number.isFinite(Number(result?.rateLimitResetCredits?.availableCount))
    ? Number(result.rateLimitResetCredits.availableCount)
    : availableFromList;

  return {
    ok: true,
    source: 'app_server_live',
    plan_type: typeof limits.planType === 'string' && limits.planType ? limits.planType : null,
    ordinary_usage_allowed: result?.ordinaryUsageAllowed !== false,
    primary_5h: primary5h,
    secondary_weekly: secondaryWeekly,
    reset_credits_count: resetCreditsCount,
    fetched_at_ms: nowMs,
  };
}

/**
 * 归一化本地 rollout jsonl 中的 rate_limits 结构。
 * @param {object} rateLimits
 * @param {number} [observedAtMs=Date.now()]
 */
export function normalizeRolloutRateLimits(rateLimits, observedAtMs = Date.now()) {
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const primary5h = normalizeWindowEntry(rateLimits.primary, 300);
  const secondaryWeekly = normalizeWindowEntry(rateLimits.secondary, 10080);
  if (!primary5h && !secondaryWeekly) return null;
  return {
    ok: true,
    source: 'session_rollout',
    plan_type: typeof rateLimits.plan_type === 'string' && rateLimits.plan_type ? rateLimits.plan_type : null,
    ordinary_usage_allowed: true,
    primary_5h: primary5h,
    secondary_weekly: secondaryWeekly,
    reset_credits_count: null,
    observed_at_ms: observedAtMs,
    fetched_at_ms: observedAtMs,
  };
}

/** Collect recent files across descending session dates. */
export function findRecentRolloutFiles(sessionsRoot = SESSIONS_ROOT, limit = 8) {
  const files = [];
  const count = Math.max(0, Math.trunc(Number(limit) || 0));
  if (!count) return files;
  const directories = (root, pattern) => {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
        .map((entry) => entry.name).sort((a, b) => b.localeCompare(a));
    } catch { return []; }
  };
  for (const year of directories(sessionsRoot, /^\d{4}$/)) {
    const yearDir = join(sessionsRoot, year);
    for (const month of directories(yearDir, /^\d{2}$/)) {
      const monthDir = join(yearDir, month);
      for (const day of directories(monthDir, /^\d{2}$/)) {
        const dayDir = join(monthDir, day);
        try {
          for (const entry of readdirSync(dayDir, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
            const path = join(dayDir, entry.name);
            try { files.push({ path, mtimeMs: statSync(path).mtimeMs }); } catch {}
          }
        } catch {}
        if (files.length >= count) return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, count);
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, count);
}
/**
 * 读取最新 Codex rollout 会话尾部中的 rate_limits 记录（零子进程开销）。
 * @param {string} [sessionsRoot=SESSIONS_ROOT]
 */
export function readLatestRolloutRateLimits(sessionsRoot = SESSIONS_ROOT, nowMs = Date.now()) {
  for (const latest of findRecentRolloutFiles(sessionsRoot, 8)) {

    let fd;
    try {
      const stat = statSync(latest.path);
      const size = stat.size;
      if (size <= 0) continue;
      const readLen = Math.min(size, TAIL_READ_BYTES);
      const startOffset = size - readLen;
      const buf = Buffer.allocUnsafe(readLen);
      fd = openSync(latest.path, 'r');
      const bytesRead = readSync(fd, buf, 0, readLen, startOffset);
      const text = buf.subarray(0, bytesRead).toString('utf8');
      const lines = text.split(/\r?\n/);

      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim();
        if (!line || !line.includes('"rate_limits"')) continue;
        try {
          const obj = JSON.parse(line);
          const rl = obj?.payload?.rate_limits || obj?.rate_limits;
          if (rl) {
            const normalized = normalizeRolloutRateLimits(rl, latest.mtimeMs);
            if (normalized) return reconcileExpiredWindows(normalized, nowMs);
          }
        } catch {
          // 忽略截断首行或损坏 JSON
        }
      }
    } catch {
      // Try another recent file.
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // 忽略关闭异常
        }
      }
    }
  }
  return null;
}

export function reconcileExpiredWindows(snapshot, nowMs = Date.now()) {
  if (!snapshot || !snapshot.ok) return snapshot;
  let needsRefresh = false;
  const reconcile = (win) => {
    if (win && win.resets_at_sec > 0 && nowMs >= win.resets_at_sec * 1000) {
      needsRefresh = true;
      return { ...win, used_pct: 0, remaining_pct: 100, resets_at_sec: null, expired_reset_applied: true };
    }
    return win;
  };
  const primary = reconcile(snapshot.primary_5h);
  const secondary = reconcile(snapshot.secondary_weekly);
  return needsRefresh ? { ...snapshot, primary_5h: primary, secondary_weekly: secondary, needs_live_refresh: true } : snapshot;
}

function computeProfileId(sessionsRoot = SESSIONS_ROOT) {
  const normalized = resolve(sessionsRoot || SESSIONS_ROOT);
  const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

export function resolveQuotaCachePath(sessionsRoot = SESSIONS_ROOT) {
  if (process.env.TRI_BRIDGE_QUOTA_CACHE_FILE) return process.env.TRI_BRIDGE_QUOTA_CACHE_FILE;
  return join(tmpdir(), `agy-gemini-codex-jev-quota-${computeProfileId(sessionsRoot)}.cache.json`);
}

function sanitizeQuota(snapshot) {
  if (!snapshot?.ok) return null;
  const numeric = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const window = (win) => {
    if (!win || numeric(win.used_pct) === null || numeric(win.remaining_pct) === null) return null;
    return { used_pct: clampPct(win.used_pct), remaining_pct: clampPct(win.remaining_pct),
      window_mins: numeric(win.window_mins), resets_at_sec: numeric(win.resets_at_sec) };
  };
  const primary = window(snapshot.primary_5h);
  const secondary = window(snapshot.secondary_weekly);
  if (!primary && !secondary) return null;
  return { ok: true,
    source: ['app_server_live', 'session_rollout', 'live+rollout'].includes(snapshot.source) ? snapshot.source : 'session_rollout',
    plan_type: ['free', 'go', 'plus', 'pro', 'team', 'business', 'enterprise', 'edu', 'unknown'].includes(snapshot.plan_type) ? snapshot.plan_type : null,
    ordinary_usage_allowed: snapshot.ordinary_usage_allowed !== false,
    primary_5h: primary, secondary_weekly: secondary,
    reset_credits_count: numeric(snapshot.reset_credits_count), fetched_at_ms: numeric(snapshot.fetched_at_ms) };
}

function persistQuotaSnapshot(snapshot, sessionsRoot = SESSIONS_ROOT) {
  const safe = sanitizeQuota(snapshot);
  if (!safe) return;
  const cachePath = resolveQuotaCachePath(sessionsRoot);
  const tempPath = `${cachePath}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const json = JSON.stringify({ ...safe, profile_id: computeProfileId(sessionsRoot) });
    writeFileSync(tempPath, json, 'utf8');
    try { renameSync(tempPath, cachePath); } catch { writeFileSync(cachePath, json, 'utf8'); }
  } catch {
    // Cache failures must not interrupt synchronization.
  } finally {
    try { unlinkSync(tempPath); } catch {}
  }
}

export function peekCachedCodexQuotaSnapshot(nowMs = Date.now(), { sessionsRoot, cachePath } = {}) {
  const activeSessionsRoot = sessionsRoot || SESSIONS_ROOT;
  const useDefaultProfile = !sessionsRoot && !cachePath;
  if (useDefaultProfile && cachedSnapshot?.ok) return reconcileExpiredWindows(cachedSnapshot, nowMs);
  try {
    const parsed = JSON.parse(readFileSync(cachePath || resolveQuotaCachePath(activeSessionsRoot), 'utf8'));
    if (parsed?.profile_id && parsed.profile_id !== computeProfileId(activeSessionsRoot)) {
      return reconcileExpiredWindows(readLatestRolloutRateLimits(activeSessionsRoot, nowMs), nowMs);
    }
    const disk = sanitizeQuota(parsed);
    if (disk) return reconcileExpiredWindows(disk, nowMs);
  } catch {}
  return reconcileExpiredWindows(readLatestRolloutRateLimits(activeSessionsRoot, nowMs), nowMs);
}

/**
 * 通过 codex app-server --stdio 实时拉取官方剩余额度与重置券信息。
 * @param {number} [timeoutMs=8000]
 */
export function fetchLiveCodexRateLimits(timeoutMs = 12000) {
  const binary = discoverCodexBinary();
  if (!binary.found) {
    return Promise.resolve({
      ok: false,
      error: 'codex_binary_not_found',
      message: '未找到可用的 codex 可执行文件。',
    });
  }

  const childEnv = { ...process.env };
  Object.assign(childEnv, resolveSubprocessProxyEnv(childEnv));
  const gitBinDir = discoverGitBinDir();
  const extraDirs = [binary.binDir, gitBinDir].filter(Boolean);
  if (extraDirs.length > 0) {
    childEnv.PATH = `${extraDirs.join(delimiter)}${delimiter}${childEnv.PATH || ''}`;
  }

  const args = [
    'app-server',
    '--stdio',
    '-c',
    'mcp_servers.node_repl.enabled=false',
    '-c',
    'mcp_servers.context7.enabled=false',
  ];

  return new Promise((resolvePromise) => {
    let settled = false;
    let buf = '';

    const child = spawn(binary.codexPath, args, {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });

    const cleanup = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin?.end();
      } catch {
        // 忽略
      }
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 忽略
        }
      }, 30).unref?.();
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      cleanup({
        ok: false,
        error: 'app_server_timeout',
        message: '读取 Codex 实时额度超时。',
      });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk) => {
      try {
        buf += chunk.toString('utf8');
        while (true) {
          const nl = buf.indexOf('\n');
          if (nl === -1) break;
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }

          if (msg.id === 1) {
            try {
              child.stdin?.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
              child.stdin?.write(
                `${JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: {} })}\n`,
              );
            } catch (err) {
              cleanup({
                ok: false,
                error: 'app_server_write_error',
                message: String(err?.message || err),
              });
            }
          } else if (msg.id === 2) {
            if (msg.error) {
              cleanup({
                ok: false,
                error: 'app_server_rpc_error',
                message: msg.error?.message || JSON.stringify(msg.error),
              });
              return;
            }
            const normalized = normalizeAppServerRateLimits(msg.result);
            if (normalized) {
              cleanup(normalized);
            } else {
              cleanup({
                ok: false,
                error: 'rate_limits_unavailable',
                message: 'Codex app-server 未返回有效 rateLimits 数据（可能尚未登录）。',
              });
            }
          }
        }
      } catch (err) {
        cleanup({
          ok: false,
          error: 'app_server_parse_error',
          message: String(err?.message || err),
        });
      }
    });

    child.on('error', (err) => {
      cleanup({
        ok: false,
        error: 'app_server_spawn_error',
        message: String(err?.message || err),
      });
    });

    child.on('close', (code) => {
      if (!settled) {
        cleanup({
          ok: false,
          error: 'app_server_closed',
          message: `codex app-server 提前退出 (code=${code})`,
        });
      }
    });

    try {
      child.stdin?.write(
        `${JSON.stringify({
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'gemini-codex-jev-quota', version: '0.4.0' } },
        })}\n`,
      );
    } catch (err) {
      cleanup({
        ok: false,
        error: 'app_server_init_write_error',
        message: String(err?.message || err),
      });
    }
  });
}

function isPastReset(snapshot, nowMs) {
  const pReset = snapshot?.primary_5h?.resets_at_sec;
  if (pReset && nowMs >= pReset * 1000) return true;
  const sReset = snapshot?.secondary_weekly?.resets_at_sec;
  if (sReset && nowMs >= sReset * 1000) return true;
  return false;
}

/**
 * 综合获取 Codex 剩余额度快照（内存缓存 + 跨重置点/超时主动刷新 + rollout 零开销秒级跟随）。
 * @param {{ forceLive?: boolean }} [opts]
 */
export async function getCodexQuotaSnapshot({ forceLive = false } = {}) {
  const nowMs = Date.now();
  if (!forceLive && cachedSnapshot?.source === 'app_server_live' &&
    nowMs - cachedSnapshot.fetched_at_ms < LIVE_CACHE_TTL_MS &&
    !cachedSnapshot.needs_live_refresh && !isPastReset(cachedSnapshot, nowMs)) {
    const rollout = readLatestRolloutRateLimits(SESSIONS_ROOT, nowMs);
    if (rollout && rollout.observed_at_ms > cachedSnapshot.fetched_at_ms) {
      cachedSnapshot = { ...cachedSnapshot,
        primary_5h: rollout.primary_5h || cachedSnapshot.primary_5h,
        secondary_weekly: rollout.secondary_weekly || cachedSnapshot.secondary_weekly,
        plan_type: rollout.plan_type || cachedSnapshot.plan_type,
        needs_live_refresh: Boolean(rollout.needs_live_refresh) };
    }
    return reconcileExpiredWindows(cachedSnapshot, nowMs);
  }
  if (!forceLive && liveFailCount > 0) {
    const backoff = Math.min(30_000, 3000 * 2 ** Math.min(liveFailCount - 1, 3));
    if (nowMs - lastLiveAttemptMs < backoff) {
      return peekCachedCodexQuotaSnapshot(nowMs) || cachedSnapshot ||
        { ok: false, error: 'live_backoff', message: '正在等待重试同步 Codex 额度' };
    }
  }
  const live = await fetchLiveCodexRateLimits(12000);
  lastLiveAttemptMs = Date.now();
  if (live?.ok) {
    liveFailCount = 0;
    cachedSnapshot = live;
    persistQuotaSnapshot(live);
    return live;
  }
  liveFailCount += 1;
  const fallback = readLatestRolloutRateLimits(SESSIONS_ROOT, nowMs) || peekCachedCodexQuotaSnapshot(nowMs);
  if (fallback) {
    cachedSnapshot = reconcileExpiredWindows({ ...fallback,
      reset_credits_count: cachedSnapshot?.reset_credits_count ?? null }, Date.now());
    return cachedSnapshot;
  }
  return reconcileExpiredWindows(cachedSnapshot || live, Date.now());
}