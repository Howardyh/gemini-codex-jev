import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(TESTS_DIR, '..');
const MCP_SERVER_PATH = join(PLUGIN_ROOT, 'server', 'mcp-server.mjs');
const JEV_CLIENT_URL = pathToFileURL(join(PLUGIN_ROOT, 'server', 'jev-client.mjs')).href;
const CODEX_QUOTA_URL = pathToFileURL(join(PLUGIN_ROOT, 'server', 'codex-quota.mjs')).href;

const { interpretJevAnswers, resolveSubprocessProxyEnv } = await import(JEV_CLIENT_URL);
const { formatResetDuration, normalizeAppServerRateLimits, normalizeRolloutRateLimits,
  findRecentRolloutFiles, readLatestRolloutRateLimits, reconcileExpiredWindows, peekCachedCodexQuotaSnapshot, resolveQuotaCachePath } =
  await import(CODEX_QUOTA_URL);
const { classifyQuotaTone, buildClientPayload, buildInjectedClientScript, resolveDevToolsPortCandidates, isAntigravityMainPageTarget } =
  await import('../server/capsule-daemon.mjs');

function runCapsuleChecks() {
  for (const [value, tone] of [
    [100, 'good'], [50, 'good'], [49, 'warn'], [20, 'warn'], [19, 'danger'], [0, 'danger'],
    [null, 'neutral'], [NaN, 'neutral'], [undefined, 'neutral'], ['50', 'neutral'],
  ]) assert.equal(classifyQuotaTone(value), tone);

  const nowMs = new Date(2030, 0, 2, 3, 4, 5).getTime();
  const quota = {
    ok: true, source: 'app_server_live', plan_type: 'plus', reset_credits_count: 3,
    primary_5h: { remaining_pct: 90, used_pct: 10, resets_at_sec: nowMs / 1000 + 18000 },
    secondary_weekly: { remaining_pct: 19, used_pct: 81, resets_at_sec: nowMs / 1000 + 7 * 86400 },
  };
  const payload = buildClientPayload(quota, { present: true }, nowMs);
  assert.deepEqual(payload, {
    quota, p5_reset_text: '5h 0m', p7_reset_text: '7d 0h', jev_ready: true, updated_label: '03:04:05',
  });
  assert.equal(payload.quota, quota);
  assert.deepEqual(buildClientPayload(null, null, nowMs), {
    quota: null, p5_reset_text: '--', p7_reset_text: '--', jev_ready: false, updated_label: '03:04:05',
  });
  assert.equal(buildClientPayload({ primary_5h: { resets_at_sec: nowMs / 1000 - 1 } }, {}, nowMs).p5_reset_text, '即将重置');
  assert.equal(buildClientPayload({ primary_5h: { resets_at_sec: nowMs / 1000 + 1 } }, {}, nowMs).p5_reset_text, '1m');

  const script = buildInjectedClientScript('0.3.0', payload);
  assert.doesNotThrow(() => new Function(script));
  assert.doesNotThrow(() => new Function(buildInjectedClientScript('0.3.0', null)));
  for (const marker of [
    'wm-capsule-btn', 'wm-cap-slot', 'wm-sep', 'wm-popover-in', 'anim-modern-pop-in',
    'is-instant', 'wm-spin-icon', 'ag-usage-monitor-portal', 'contextmenu', 'quota-pool-row',
    'data-color-scheme', 'data-modern-ui', 'data-font-scale', 'data-layout', 'syncHostAppearance',
    'wm-popover-in-up', 'anim-modern-pop-in-up', 'wm-pin-badge', 'refreshReqSeq',
    "removeEventListener('resize'", "removeEventListener('click'", "removeEventListener('keydown'",
  ]) assert.ok(script.includes(marker), `注入脚本缺少 ${marker}`);
  assert.ok(script.includes("if (!wasVisible && visible) cardEl.classList.remove('is-instant')"));
  assert.ok(script.includes('}, 40)'));
  assert.ok(script.includes('r="5.25" stroke-width="2"'));

  // 使用通用模式检查，不把本机身份写入测试夹具。
  const piiPatterns = [
    /[a-z]:[\\/]+users[\\/]+[^\\/\s"'<>]+/i,
    /\/(?:home|Users)\/[^/\s"'<>]+/,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    /\bsk-(?:proj-)?[a-z0-9_-]{16,}\b/i,
    /\b(?:Bearer\s+)[a-z0-9._-]{16,}\b/i,
    /\b[a-z0-9.]+_\d+\.\d+\.\d+\.\d+_(?:x64|arm64|x86)__[a-z0-9]+\b/i,
  ];
  for (const pattern of piiPatterns) assert.doesNotMatch(script, pattern);
  const guardedFiles = new Set();
  const collectFiles = (dir, relBase = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'local' || entry.name.startsWith('.offline-')) {
        continue;
      }
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) collectFiles(full, rel);
      else if (/\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|css|html|svg|ya?ml|txt|ps1)$/i.test(entry.name)) {
        guardedFiles.add(rel);
      }
    }
  };
  collectFiles(PLUGIN_ROOT);
  for (const extra of ['skills/tri/SKILL.md', 'skills/tri/logo.svg', 'assets/logo.svg']) guardedFiles.add(extra);
  const forbiddenSubstring = String.fromCharCode(102, 108, 111, 97, 116);
  for (const name of guardedFiles) {
    const content = readFileSync(join(PLUGIN_ROOT, name), 'utf8');
    for (const pattern of piiPatterns) assert.doesNotMatch(content, pattern, `${name} 包含身份信息`);
    assert.ok(!content.toLowerCase().includes(forbiddenSubstring), `${name} contains a prohibited substring`);
  }
  assert.equal(JSON.parse(readFileSync(join(PLUGIN_ROOT, 'plugin.json'), 'utf8')).version, '0.4.0');
  assert.equal(JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version, '0.4.0');
  for (const name of ['skills/tri/SKILL.md', 'skills/tri/logo.svg', 'assets/logo.svg']) {
    assert.ok(existsSync(join(PLUGIN_ROOT, name)), `Missing ${name}`);
  }

  const syncingPayload = buildClientPayload(quota, { present: true }, nowMs, { ackRefreshSeq: 3, syncing: true });
  assert.deepEqual(syncingPayload, { ...payload, ack_refresh_seq: 3, syncing: true });
  assert.deepEqual(buildClientPayload(quota, { present: true }, nowMs, {}), {
    ...payload, ack_refresh_seq: 0, syncing: false,
  });
  const currentScript = buildInjectedClientScript('0.4.0', syncingPayload);
  assert.doesNotThrow(() => new Function(currentScript));
  for (const marker of ['refreshReqSeq', 'ack_refresh_seq', '__AGCodexQuotaPeekRefreshSeq', 'lastLiveSyncMs', 'fetched_at_ms']) {
    assert.ok(currentScript.includes(marker), `Missing ${marker}`);
  }
  assert.notEqual(resolveQuotaCachePath(join(PLUGIN_ROOT, '.p1', 'sessions')), resolveQuotaCachePath(join(PLUGIN_ROOT, '.p2', 'sessions')));
  for (const url of [
    'http://127.0.0.1:9000/', 'https://localhost:9000', 'http://[::1]:9000/app',
    'vscode-file://vscode-app/app/out/workbench.html',
    'vscode-file://vscode-app/app/out/workbench.esm.html?mode=main',
    'vscode-file://vscode-app/app/out/workbench-jetski-agent.html#main',
  ]) assert.equal(isAntigravityMainPageTarget({ type: 'page', url }), true, url);
  for (const url of [
    'data:text/html,test', 'about:blank', 'vscode-webview://view/index.html',
    'http://localhost/app', 'http://localhost.example:9000/', 'http://127.0.0.1:9000.evil/',
    'https://example.invalid:9000/', 'vscode-file://vscode-app/app/workbench.html/extra',
  ]) assert.equal(isAntigravityMainPageTarget({ type: 'page', url }), false, url);
  assert.equal(isAntigravityMainPageTarget({ type: 'worker', url: 'http://localhost:9000/' }), false);
  assert.equal(isAntigravityMainPageTarget(null), false);
  assert.deepEqual(resolveSubprocessProxyEnv({ HTTPS_PROXY: '  ', http_proxy: 'http://localhost:9001' }), {});

  // 合成路径覆盖跨平台发现，不读取本机 DevTools 文件。
  assert.deepEqual(resolveDevToolsPortCandidates({ ANTIGRAVITY_DEVTOOLS_PORT_FILE: 'custom-port-file' }, 'linux', '/virtual'), ['custom-port-file']);
  assert.ok(resolveDevToolsPortCandidates({}, 'win32', '/virtual').some((file) => file.endsWith(join('AppData', 'Roaming', 'Antigravity', 'DevToolsActivePort'))));
  assert.ok(resolveDevToolsPortCandidates({}, 'darwin', '/virtual').includes(join('/virtual', 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort')));
  assert.ok(resolveDevToolsPortCandidates({ XDG_CONFIG_HOME: '/config' }, 'linux', '/virtual').includes(join('/config', 'Antigravity', 'DevToolsActivePort')));
  console.log('[PASS] capsule tone, payload, script syntax, theme/motion structure & zero-PII checks');
}

function runQuotaRecoveryChecks(tempDir) {
  const sessionsRoot = join(tempDir, 'sessions');
  const day = join(sessionsRoot, '2030', '01', '02');
  const olderDay = join(sessionsRoot, '2029', '12', '31');
  mkdirSync(day, { recursive: true });
  mkdirSync(olderDay, { recursive: true });
  const nowMs = Date.UTC(2030, 0, 2, 12);
  const newest = join(day, 'newest.jsonl');
  const usable = join(day, 'usable.jsonl');
  const older = join(olderDay, 'older.jsonl');
  const limits = {
    primary: { used_percent: 81, window_minutes: 300, resets_at: nowMs / 1000 - 1 },
    secondary: { used_percent: 27, window_minutes: 10080, resets_at: nowMs / 1000 + 86400 },
    plan_type: 'plus',
  };
  writeFileSync(newest, '{"payload":{"message":"no quota yet"}}\n');
  writeFileSync(usable, `${JSON.stringify({ payload: { rate_limits: limits } })}\n{broken\n`);
  writeFileSync(older, `${JSON.stringify({ rate_limits: limits })}\n`);
  for (const [file, delta] of [[newest, 0], [usable, 1000], [older, 2000]]) {
    utimesSync(file, new Date(nowMs - delta), new Date(nowMs - delta));
  }
  assert.deepEqual(findRecentRolloutFiles(sessionsRoot, 8).map((entry) => entry.path), [newest, usable, older]);
  assert.equal(findRecentRolloutFiles(sessionsRoot, 1)[0].path, newest);
  assert.deepEqual(findRecentRolloutFiles(sessionsRoot, 0), []);
  assert.deepEqual(findRecentRolloutFiles(join(tempDir, 'missing')), []);
  const snapshot = readLatestRolloutRateLimits(sessionsRoot, nowMs);
  assert.equal(snapshot.source, 'session_rollout');
  assert.equal(snapshot.observed_at_ms, nowMs - 1000);
  assert.equal(snapshot.primary_5h.used_pct, 0);
  assert.equal(snapshot.primary_5h.remaining_pct, 100);
  assert.equal(snapshot.primary_5h.resets_at_sec, null);
  assert.equal(snapshot.primary_5h.expired_reset_applied, true);
  assert.equal(snapshot.secondary_weekly.remaining_pct, 73);
  assert.equal(snapshot.needs_live_refresh, true);
  const raw = normalizeRolloutRateLimits(limits, nowMs);
  const reconciled = reconcileExpiredWindows(raw, nowMs);
  assert.notEqual(reconciled, raw);
  assert.equal(raw.primary_5h.used_pct, 81);
  assert.equal(reconciled.secondary_weekly, raw.secondary_weekly);
  assert.equal(reconcileExpiredWindows(raw, nowMs - 2000), raw);
  assert.equal(reconcileExpiredWindows(null, nowMs), null);
  const failure = { ok: false };
  assert.equal(reconcileExpiredWindows(failure, nowMs), failure);
  // Missing/corrupt files fall through to another day.
  writeFileSync(usable, '{broken\n');
  assert.equal(readLatestRolloutRateLimits(sessionsRoot, nowMs).observed_at_ms, nowMs - 2000);
  const cachePath = join(tempDir, 'quota.cache.json');
  assert.equal(peekCachedCodexQuotaSnapshot(nowMs, { sessionsRoot, cachePath }).observed_at_ms, nowMs - 2000);
  writeFileSync(cachePath, JSON.stringify({ ...raw, extra: 'discard', plan_type: 'untrusted' }));
  const peek = peekCachedCodexQuotaSnapshot(nowMs, { sessionsRoot, cachePath });
  assert.equal(peek.extra, undefined);
  assert.equal(peek.plan_type, null);
  assert.equal(peek.primary_5h.remaining_pct, 100);
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function createSolidPng(width, height) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rowSize = 1 + width * 3;
  const raw = Buffer.alloc(rowSize * height, 120);
  for (let y = 0; y < height; y += 1) raw[y * rowSize] = 0;
  const idat = deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

class McpTestClient {
  constructor(mode = 'line') {
    this.mode = mode;
    this.child = spawn(process.execPath, [MCP_SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, TRI_BRIDGE_DISABLE_CAPSULE: '1' },
    });
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';

    this.child.stderr.on('data', (d) => {
      this.stderr += d.toString('utf8');
    });
    this.child.stdout.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
  }

  drain() {
    while (this.buffer.length > 0) {
      if (this.mode === 'lsp') {
        const sep = this.buffer.indexOf('\r\n\r\n');
        if (sep === -1) break;
        const header = this.buffer.subarray(0, sep).toString('ascii');
        const m = header.match(/Content-Length:\s*(\d+)/i);
        const len = Number(m[1]);
        const end = sep + 4 + len;
        if (this.buffer.length < end) break;
        const body = this.buffer.subarray(sep + 4, end).toString('utf8');
        this.buffer = this.buffer.subarray(end);
        this.resolveMsg(JSON.parse(body));
      } else {
        const nl = this.buffer.indexOf('\n');
        if (nl === -1) break;
        const line = this.buffer.subarray(0, nl).toString('utf8').trim();
        this.buffer = this.buffer.subarray(nl + 1);
        if (line) this.resolveMsg(JSON.parse(line));
      }
    }
  }

  resolveMsg(msg) {
    const waiter = this.pending.get(msg.id);
    if (waiter) {
      this.pending.delete(msg.id);
      waiter.resolve(msg);
    }
  }

  sendRaw(obj) {
    const json = JSON.stringify(obj);
    if (this.mode === 'lsp') {
      const byteLen = Buffer.byteLength(json, 'utf8');
      this.child.stdin.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
    } else {
      this.child.stdin.write(`${json}\n`);
    }
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`Timeout waiting for ${method} (${this.mode})`));
      }, 8000);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolvePromise(msg);
        },
      });
      this.sendRaw({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params = {}) {
    this.sendRaw({ jsonrpc: '2.0', method, params });
  }

  async close() {
    this.child.stdin.end();
    await new Promise((resolvePromise) => this.child.once('exit', resolvePromise));
  }
}

async function runModeChecks(mode, validPng, smallPng) {
  const client = new McpTestClient(mode);
  try {
    const initResp = await client.request('initialize', { protocolVersion: '2025-03-26' });
    assert.equal(initResp.result.protocolVersion, '2025-03-26');
    assert.equal(initResp.result.serverInfo.name, 'gemini-codex-jev-bridge');
    client.notify('notifications/initialized', {});

    const pingResp = await client.request('ping', {});
    assert.deepEqual(pingResp.result, {});

    const listResp = await client.request('tools/list', {});
    const toolNames = listResp.result.tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, ['bridge_status', 'codex_continue', 'codex_exec', 'codex_review', 'jev_judge']);

    // Verify task_route dry_run preview
    const routePreview = await client.request('tools/call', {
      name: 'jev_judge',
      arguments: {
        preset: 'task_route',
        summary: 'Add retry backoff to API client',
        dry_run: true,
      },
    });
    const routeData = JSON.parse(routePreview.result.content[0].text);
    assert.equal(routeData.ok, true);
    assert.equal(routeData.dry_run, true);
    assert.equal(routeData.headers['TypeSafe-Danger-Zone-Images'], 'true');
    assert.equal(Boolean(routeData.headers.Authorization), false);
    assert.ok(routeData.payload.questions.execution_route);

    // Verify patch_gate dry_run preview
    const gatePreview = await client.request('tools/call', {
      name: 'jev_judge',
      arguments: {
        preset: 'patch_gate',
        summary: 'Verify retry backoff tests pass',
        state: { diff_or_test_summary: '4/4 tests passed' },
        dry_run: true,
      },
    });
    const gateData = JSON.parse(gatePreview.result.content[0].text);
    assert.equal(gateData.ok, true);
    assert.ok(gateData.payload.questions.goal_satisfied);
    assert.ok(gateData.payload.questions.has_unverified_risk);

    // Verify canonical SHA-256 across different key orderings
    const q1 = await client.request('tools/call', {
      name: 'jev_judge',
      arguments: {
        state: { alpha: 1, beta: 2 },
        questions: { q_a: { type: 'noul', instructions: 'Is alpha < beta?' } },
        dry_run: true,
      },
    });
    const q2 = await client.request('tools/call', {
      name: 'jev_judge',
      arguments: {
        state: { beta: 2, alpha: 1 },
        questions: { q_a: { instructions: 'Is alpha < beta?', type: 'noul' } },
        dry_run: true,
      },
    });
    const h1 = JSON.parse(q1.result.content[0].text).request_sha256;
    const h2 = JSON.parse(q2.result.content[0].text).request_sha256;
    assert.equal(h1, h2);

    // Verify valid 300x300 PNG multipart dry_run
    const imgDry = await client.request('tools/call', {
      name: 'jev_judge',
      arguments: {
        images: { screenshot: validPng },
        questions: {
          visible: { type: 'noul', instructions: 'Is content visible in `screenshot`?' },
        },
        dry_run: true,
      },
    });
    const imgData = JSON.parse(imgDry.result.content[0].text);
    assert.equal(imgData.multipart, true);
    assert.equal(imgData.images_meta[0].width, 300);
    assert.equal(imgData.images_meta[0].height, 300);

    // Verify undersized 100x100 PNG rejection
    const smallImgResp = await client.request('tools/call', {
      name: 'jev_judge',
      arguments: {
        images: { screenshot: smallPng },
        questions: { visible: { type: 'noul', instructions: 'Is content visible in `screenshot`?' } },
        dry_run: true,
      },
    });
    assert.equal(smallImgResp.result.isError, true);
    assert.match(smallImgResp.result.content[0].text, /280/);
  } finally {
    await client.close();
  }
}

async function main() {
  runCapsuleChecks();
  const tempDir = mkdtempSync(join(PLUGIN_ROOT, '.offline-'));
  const validPng = join(tempDir, 'valid-300.png');
  const smallPng = join(tempDir, 'small-100.png');
  writeFileSync(validPng, createSolidPng(300, 300));
  writeFileSync(smallPng, createSolidPng(100, 100));

  try {
    runQuotaRecoveryChecks(tempDir);
    const gates = interpretJevAnswers(
      {
        needs_write_sandbox: { type: 'noul', noul: 0.98 },
        needs_visual_evidence: { type: 'noul', noul: 0.04 },
        ambiguous_check: { type: 'noul', noul: 0.5 },
        execution_route: {
          type: 'choice',
          choice: 'codex_single',
          confidence: 1,
          probabilities: { codex_single: 1, codex_subagents: 0 },
        },
      },
      {
        needs_write_sandbox: { type: 'noul' },
        needs_visual_evidence: { type: 'noul' },
        ambiguous_check: { type: 'noul' },
        execution_route: { type: 'choice' },
      },
    );
    assert.equal(gates.needs_write_sandbox.probability_true, 0.98);
    assert.equal(gates.needs_write_sandbox.verdict, 'yes');
    assert.equal(gates.needs_visual_evidence.probability_true, 0.04);
    assert.equal(gates.needs_visual_evidence.verdict, 'no');
    assert.equal(gates.ambiguous_check.verdict, 'uncertain_escalate');
    assert.equal(gates.execution_route.top_option, 'codex_single');
    console.log('[PASS] interpretJevAnswers payload checks');

    const nowMs = 1_795_542_687_000;
    const liveQuota = normalizeAppServerRateLimits(
      {
        ordinaryUsageAllowed: true,
        rateLimits: {
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1795554795 },
          secondary: { usedPercent: 26, windowDurationMins: 10080, resetsAt: 1795869609 },
          planType: 'plus',
        },
        rateLimitResetCredits: { availableCount: 3 },
      },
      nowMs,
    );
    assert.equal(liveQuota.ok, true);
    assert.equal(liveQuota.primary_5h.remaining_pct, 90);
    assert.equal(liveQuota.secondary_weekly.remaining_pct, 74);
    assert.equal(liveQuota.reset_credits_count, 3);
    assert.equal(liveQuota.plan_type, 'plus');

    const rolloutQuota = normalizeRolloutRateLimits(
      {
        primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1795554795 },
        secondary: { used_percent: 30, window_minutes: 10080, resets_at: 1795869609 },
        plan_type: 'plus',
      },
      nowMs,
    );
    assert.equal(rolloutQuota.primary_5h.remaining_pct, 87.5);
    assert.equal(rolloutQuota.secondary_weekly.remaining_pct, 70);
    assert.equal(formatResetDuration(1795554795, nowMs), '3h 22m');
    assert.equal(formatResetDuration(1795869609, nowMs), '3d 18h');
    console.log('[PASS] codex-quota normalization & reset formatting checks');

    await runModeChecks('line', validPng, smallPng);
    console.log('[PASS] line-delimited JSON framing checks');
    await runModeChecks('lsp', validPng, smallPng);
    console.log('[PASS] LSP Content-Length framing checks');
    console.log('ALL OFFLINE CHECKS PASSED (0 network calls, 0 API spend)');
  } finally {
    assert.equal(dirname(tempDir), PLUGIN_ROOT);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
