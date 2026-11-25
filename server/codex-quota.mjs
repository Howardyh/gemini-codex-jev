/**
 * @fileoverview OpenAI Codex 剩余额度（5h 窗口 / 7d 周窗口 / 重置券）双源采集模块。
 * 数据源：
 * 1. 主动实时源：通过本机完整版 codex app-server --stdio 发送 JSON-RPC account/rateLimits/read；
 * 2. 本地零开销源：扫描 ~/.codex/sessions 最近修改的 rollout *.jsonl 尾部最后一条 rate_limits 事件。
 */

import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { discoverCodexBinary, discoverGitBinDir } from './codex-runner.mjs';

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const SESSIONS_ROOT = join(CODEX_HOME, 'sessions');
const LIVE_CACHE_TTL_MS = 180_000;
const TAIL_READ_BYTES = 131_072;

let cachedSnapshot = null;

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

/**
 * 查找 ~/.codex/sessions 下最新修改的 .jsonl 会话文件（只检查最近年份/月份/日期目录）。
 * @param {string} [sessionsRoot=SESSIONS_ROOT]
 * @returns {{ path: string, mtimeMs: number } | null}
 */
function findLatestRolloutFile(sessionsRoot = SESSIONS_ROOT) {
  if (!existsSync(sessionsRoot)) return null;
  try {
    const years = readdirSync(sessionsRoot)
      .filter((n) => /^\d{4}$/.test(n))
      .sort((a, b) => b.localeCompare(a));
    for (const y of years) {
      const yDir = join(sessionsRoot, y);
      const months = readdirSync(yDir)
        .filter((n) => /^\d{2}$/.test(n))
        .sort((a, b) => b.localeCompare(a));
      for (const m of months) {
        const mDir = join(yDir, m);
        const days = readdirSync(mDir)
          .filter((n) => /^\d{2}$/.test(n))
          .sort((a, b) => b.localeCompare(a));
        for (const d of days) {
          const dDir = join(mDir, d);
          const files = readdirSync(dDir)
            .filter((n) => n.endsWith('.jsonl'))
            .map((n) => {
              const p = join(dDir, n);
              try {
                return { path: p, mtimeMs: statSync(p).mtimeMs };
              } catch {
                return null;
              }
            })
            .filter(Boolean)
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
          if (files.length > 0) return files[0];
        }
      }
    }
  } catch {
    // 忽略扫描异常
  }
  return null;
}

/**
 * 读取最新 Codex rollout 会话尾部中的 rate_limits 记录（零子进程开销）。
 * @param {string} [sessionsRoot=SESSIONS_ROOT]
 */
export function readLatestRolloutRateLimits(sessionsRoot = SESSIONS_ROOT) {
  const latest = findLatestRolloutFile(sessionsRoot);
  if (!latest) return null;

  let fd;
  try {
    const stat = statSync(latest.path);
    const size = stat.size;
    if (size <= 0) return null;
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
          if (normalized) return normalized;
        }
      } catch {
        // 忽略截断首行或损坏 JSON
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 忽略关闭异常
      }
    }
  }
  return null;
}

/**
 * 通过 codex app-server --stdio 实时拉取官方剩余额度与重置券信息。
 * @param {number} [timeoutMs=8000]
 */
export function fetchLiveCodexRateLimits(timeoutMs = 8000) {
  const binary = discoverCodexBinary();
  if (!binary.found) {
    return Promise.resolve({
      ok: false,
      error: 'codex_binary_not_found',
      message: '未找到可用的 codex 可执行文件。',
    });
  }

  const childEnv = { ...process.env };
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
          params: { clientInfo: { name: 'gemini-codex-jev-quota', version: '0.2.0' } },
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
  const cacheExpired =
    !cachedSnapshot ||
    nowMs - cachedSnapshot.fetched_at_ms >= LIVE_CACHE_TTL_MS ||
    isPastReset(cachedSnapshot, nowMs);

  if (forceLive || cacheExpired) {
    const live = await fetchLiveCodexRateLimits(8000);
    if (live?.ok) {
      cachedSnapshot = live;
      return live;
    }
    const rollout = readLatestRolloutRateLimits();
    if (rollout) {
      return {
        ...rollout,
        fallback_reason: live?.message || 'app_server_unavailable',
        reset_credits_count: cachedSnapshot?.reset_credits_count ?? null,
      };
    }
    return cachedSnapshot || live;
  }

  // 在 3 分钟缓存窗口内，如最新本地 rollout 刚更新过 rate_limits，零开销同步最新百分比
  const rollout = readLatestRolloutRateLimits();
  if (rollout && rollout.observed_at_ms > cachedSnapshot.fetched_at_ms) {
    cachedSnapshot = {
      ...cachedSnapshot,
      source: 'live+rollout',
      primary_5h: rollout.primary_5h || cachedSnapshot.primary_5h,
      secondary_weekly: rollout.secondary_weekly || cachedSnapshot.secondary_weekly,
      plan_type: rollout.plan_type || cachedSnapshot.plan_type,
      fetched_at_ms: rollout.observed_at_ms,
    };
  }

  return cachedSnapshot;
}
