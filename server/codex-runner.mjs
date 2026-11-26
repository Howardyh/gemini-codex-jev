/**
 * @fileoverview 本地 OpenAI Codex CLI 0.165+ 桥接与子智能体生命周期控制模块。
 * 核心职责：
 * 1. 动态解析 WindowsApps 完整版 codex.exe（携带 codex-code-mode-host.exe 与 rg.exe），注入子进程 PATH；
 * 2. 读取 ~/.codex/models_cache.json 校验模型，默认选用 gpt-6.1-sol（规避 config.toml 中不兼容 ChatGPT 账号的 gpt-6.2-sol）；
 * 3. 通过 stdin + end() 防阻塞写入 Prompt，流式解析 --json 事件流并提纯结构化结果；
 * 4. 封装 exec / resume / fork / queue / review 与活跃进程管控。
 */

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveSubprocessProxyEnv } from './jev-client.mjs';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const CODEX_CONFIG_PATH = join(CODEX_HOME, 'config.toml');
const MODELS_CACHE_PATH = join(CODEX_HOME, 'models_cache.json');
const CODEX_EXE_NAME = process.platform === 'win32' ? 'codex.exe' : 'codex';
const CODE_MODE_HOST_NAME = process.platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host';
const RG_EXE_NAME = process.platform === 'win32' ? 'rg.exe' : 'rg';
const FALLBACK_SANDBOX_BIN = join(CODEX_HOME, '.sandbox-bin', CODEX_EXE_NAME);
const PREFERRED_DEFAULT_MODELS = ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-astra'];

const activeRuns = new Map();
let cachedWindowsAppsCodex = { checkedAtMs: 0, path: null };

/**
 * 探测 WindowsApps 中最新版本 OpenAI.Codex_* 的 app\resources\codex.exe。
 * WindowsApps 根目录默认禁止非特权列表枚举，因此先查 HKCU AppModel 注册表获知准确包名后再直接访问子路径。
 * @returns {string | null}
 */
function scanWindowsAppsCodex() {
  if (process.platform !== 'win32') return null;
  if (
    cachedWindowsAppsCodex.path &&
    Date.now() - cachedWindowsAppsCodex.checkedAtMs < 60_000 &&
    existsSync(cachedWindowsAppsCodex.path)
  ) {
    return cachedWindowsAppsCodex.path;
  }

  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const windowsAppsDir = join(programFiles, 'WindowsApps');
  const packageNames = new Set();

  try {
    const stdout = execFileSync(
      'reg.exe',
      [
        'query',
        'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages',
        '/f',
        'OpenAI.Codex_',
        '/k',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.trim().match(/\\(OpenAI\.Codex_[^\\\s]+)$/i);
      if (m?.[1]) packageNames.add(m[1]);
    }
  } catch {
    // 忽略注册表检索异常
  }

  try {
    if (existsSync(windowsAppsDir)) {
      for (const name of readdirSync(windowsAppsDir)) {
        if (/^OpenAI\.Codex_/i.test(name)) packageNames.add(name);
      }
    }
  } catch {
    // WindowsApps 目录受 ACL 保护时静默回退到注册表结果
  }

  const entries = Array.from(packageNames)
    .map((name) => {
      const exePath = join(windowsAppsDir, name, 'app', 'resources', 'codex.exe');
      if (!existsSync(exePath)) return null;
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(exePath).mtimeMs;
      } catch {
        // 忽略 stat 异常
      }
      return { name, exePath, mtimeMs };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  const picked = entries[0]?.exePath || null;
  cachedWindowsAppsCodex = { checkedAtMs: Date.now(), path: picked };
  return picked;
}

/**
 * 解析 config.toml 中的 CODEX_CLI_PATH 配置项。
 * @returns {string | null}
 */
function readCodexPathFromConfig() {
  try {
    if (!existsSync(CODEX_CONFIG_PATH)) return null;
    const raw = readFileSync(CODEX_CONFIG_PATH, 'utf8');
    const match = raw.match(/CODEX_CLI_PATH\s*=\s*['"]([^'"]+)['"]/);
    if (match?.[1] && existsSync(match[1])) {
      return match[1];
    }
  } catch {
    // 忽略读取异常
  }
  return null;
}

/**
 * 从当前进程 PATH 目录中查找全局安装的 Codex CLI。
 * @returns {string[]}
 */
function scanPathForCodex() {
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];
  const hits = [];
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const exe of names) {
      try {
        const candidate = join(dir, exe);
        if (existsSync(candidate)) hits.push(candidate);
      } catch {
        // 忽略无效 PATH 条目
      }
    }
  }
  return hits;
}

/**
 * 动态定位本机最完整的 Codex 可执行文件及伴生工具目录。
 */
export function discoverCodexBinary() {
  const seen = new Set();
  const candidates = [
    process.env.CODEX_CLI_PATH,
    readCodexPathFromConfig(),
    scanWindowsAppsCodex(),
    ...scanPathForCodex(),
    FALLBACK_SANDBOX_BIN,
  ].filter((p) => {
    if (typeof p !== 'string' || !p.trim() || !existsSync(p)) return false;
    const key = process.platform === 'win32' ? p.toLowerCase() : p;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const candidate of candidates) {
    const binDir = dirname(candidate);
    const hasCodeModeHost = existsSync(join(binDir, CODE_MODE_HOST_NAME));
    const hasBundledRg = existsSync(join(binDir, RG_EXE_NAME));
    // 优先选用包含 codex-code-mode-host 的完整发行目录
    if (hasCodeModeHost) {
      return {
        found: true,
        codexPath: candidate,
        binDir,
        hasCodeModeHost,
        hasBundledRg,
      };
    }
  }

  if (candidates.length > 0) {
    const first = candidates[0];
    const binDir = dirname(first);
    return {
      found: true,
      codexPath: first,
      binDir,
      hasCodeModeHost: existsSync(join(binDir, CODE_MODE_HOST_NAME)),
      hasBundledRg: existsSync(join(binDir, RG_EXE_NAME)),
    };
  }

  return {
    found: false,
    codexPath: process.platform === 'win32' ? 'codex.exe' : 'codex',
    binDir: null,
    hasCodeModeHost: false,
    hasBundledRg: false,
  };
}

/**
 * 探测可用的 Git 可执行文件所在目录：
 * 1. 先检查当前 PATH 各目录；
 * 2. 再扫描 GitHub Desktop 内置 git/cmd 目录及 Program Files\Git\cmd。
 * @returns {string | null}
 */
export function discoverGitBinDir() {
  const gitExe = process.platform === 'win32' ? 'git.exe' : 'git';
  const envDirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  for (const dir of envDirs) {
    try {
      if (existsSync(join(dir, gitExe))) return dir;
    } catch {
      // 忽略无效 PATH 条目
    }
  }

  if (process.platform !== 'win32') return null;

  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const ghDesktopDir = join(localAppData, 'GitHubDesktop');
  try {
    if (existsSync(ghDesktopDir)) {
      const appDirs = readdirSync(ghDesktopDir)
        .filter((name) => /^app-/i.test(name))
        .map((name) => {
          const cmdDir = join(ghDesktopDir, name, 'resources', 'app', 'git', 'cmd');
          const exe = join(cmdDir, 'git.exe');
          if (!existsSync(exe)) return null;
          let mtimeMs = 0;
          try {
            mtimeMs = statSync(exe).mtimeMs;
          } catch {
            // 忽略 stat 异常
          }
          return { name, cmdDir, mtimeMs };
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
      if (appDirs[0]?.cmdDir) return appDirs[0].cmdDir;
    }
  } catch {
    // 忽略扫描异常
  }

  const commonCmdDirs = [
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd'),
    join(localAppData, 'Programs', 'Git', 'cmd'),
  ];
  for (const dir of commonCmdDirs) {
    if (existsSync(join(dir, 'git.exe'))) return dir;
  }

  return null;
}

/**
 * 从指定目录向上探测是否处于 Git 仓库内。
 * @param {string} startDir
 * @returns {boolean}
 */
function hasGitRepo(startDir) {
  let curr = resolve(startDir);
  while (true) {
    if (existsSync(join(curr, '.git'))) return true;
    const parent = dirname(curr);
    if (parent === curr) return false;
    curr = parent;
  }
}

/**
 * 读取本地 ~/.codex/models_cache.json 中的可用模型。
 */
export function loadSupportedCodexModels() {
  try {
    if (!existsSync(MODELS_CACHE_PATH)) {
      return { models: [], slugs: new Set(), source: 'missing' };
    }
    const parsed = JSON.parse(readFileSync(MODELS_CACHE_PATH, 'utf8'));
    const models = Array.isArray(parsed?.models)
      ? parsed.models.map((m) => ({
          slug: m.slug,
          display_name: m.display_name,
          visibility: m.visibility,
          default_reasoning_level: m.default_reasoning_level,
          multi_agent_version: m.multi_agent_version || null,
        }))
      : [];
    return {
      models,
      slugs: new Set(models.map((m) => m.slug)),
      source: MODELS_CACHE_PATH,
    };
  } catch {
    return { models: [], slugs: new Set(), source: 'parse_error' };
  }
}

/**
 * 选择安全可用的 Codex 模型。
 * 未指定时优先按 PREFERRED_DEFAULT_MODELS 从 models_cache.json 选取，规避不可用模型。
 * @param {string} [requestedModel]
 */
export function resolveCodexModel(requestedModel) {
  const { models, slugs } = loadSupportedCodexModels();
  const req = typeof requestedModel === 'string' && requestedModel.trim() ? requestedModel.trim() : null;
  if (req) {
    return {
      model: req,
      in_local_cache: slugs.size === 0 ? null : slugs.has(req),
    };
  }
  for (const preferred of PREFERRED_DEFAULT_MODELS) {
    if (slugs.has(preferred)) {
      return { model: preferred, in_local_cache: true };
    }
  }
  const firstVisible = models.find((m) => m.visibility === 'list')?.slug || models[0]?.slug;
  return {
    model: firstVisible || 'gpt-6.1-sol',
    in_local_cache: Boolean(firstVisible),
  };
}

/**
 * 列出当前运行中的 Codex 受控任务。
 */
export function listActiveRuns() {
  return Array.from(activeRuns.values()).map((r) => ({
    run_id: r.runId,
    pid: r.pid,
    mode: r.mode,
    model: r.model,
    cwd: r.cwd,
    thread_id: r.threadId,
    started_at: r.startedAt,
    elapsed_ms: Date.now() - r.startedMs,
  }));
}

/**
 * 终止指定 run_id 的活跃 Codex 进程。
 * @param {string} runId
 */
export function cancelRun(runId) {
  const entry = activeRuns.get(runId);
  if (!entry) {
    return { ok: false, error: 'run_not_found', run_id: runId };
  }
  entry.killFn('manual_cancel');
  return { ok: true, cancelled: true, run_id: runId, pid: entry.pid };
}

/**
 * 在 MCP Server 退出时清理全部子进程。
 */
export function cancelAllRuns() {
  for (const entry of activeRuns.values()) {
    try {
      entry.killFn('server_shutdown');
    } catch {
      // 忽略强杀错误
    }
  }
}

/**
 * 限制长文本避免撑爆上下文。
 * @param {string} text
 * @param {number} maxLen
 */
function clipText(text, maxLen = 4000) {
  if (typeof text !== 'string') return '';
  if (text.length <= maxLen) return text;
  const half = Math.floor(maxLen / 2);
  return `${text.slice(0, half)}\n... [truncated ${text.length - maxLen} chars] ...\n${text.slice(-half)}`;
}

/**
 * 解析 Codex --json 输出的 JSONL 事件流并提纯结构化结果。
 * 刻意忽略中间大段 reasoning 推理噪音，仅保留核心回答、命令与变更摘要。
 * @param {string} stdoutText
 */
export function parseCodexJsonlEvents(stdoutText) {
  let threadId = null;
  let usage = null;
  let turnFailed = null;
  const messages = [];
  const commands = [];
  const fileChanges = [];
  const warnings = [];
  const rawNonJsonLines = [];

  for (const rawLine of String(stdoutText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      rawNonJsonLines.push(clipText(line, 400));
      continue;
    }

    if (evt.type === 'thread.started' && evt.thread_id) {
      threadId = evt.thread_id;
    } else if (evt.type === 'turn.completed' && evt.usage) {
      usage = evt.usage;
    } else if (evt.type === 'turn.failed') {
      turnFailed = evt.error?.message || JSON.stringify(evt.error || evt);
    } else if (evt.type === 'error') {
      warnings.push(clipText(evt.message || JSON.stringify(evt), 500));
    } else if (evt.type === 'item.completed' && evt.item) {
      const item = evt.item;
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        messages.push(item.text);
      } else if (item.type === 'error' && item.message) {
        warnings.push(clipText(item.message, 500));
      } else if (item.type === 'command_execution') {
        commands.push({
          command: clipText(item.command || '', 300),
          exit_code: item.exit_code ?? null,
          output_preview: clipText(item.aggregated_output || '', 600),
        });
      } else if (item.type === 'file_change') {
        fileChanges.push(item.changes || item.path || item);
      }
    }
  }

  return {
    threadId,
    finalMessage: messages.length > 0 ? messages[messages.length - 1] : '',
    allMessages: messages,
    commands: commands.slice(-20),
    fileChanges: fileChanges.slice(-30),
    warnings: warnings.slice(-15),
    nonJsonPreview: rawNonJsonLines.slice(-10),
    turnFailed,
    usage,
  };
}

/**
 * 构建通用的 -c 配置覆盖参数以规避桌面提示音与未启动依赖告警。
 */
function buildBaseConfigArgs({ effort, sandboxOverride, enableCodexMcp = false }) {
  const args = [
    '-c',
    'notify=[]',
    '-c',
    'suppress_unstable_features_warning=true',
    '-c',
    'mcp_servers.node_repl.enabled=false',
  ];
  if (!enableCodexMcp) {
    args.push('-c', 'mcp_servers.context7.enabled=false');
  }
  if (effort) {
    args.push('-c', `model_reasoning_effort="${effort}"`);
  }
  if (sandboxOverride) {
    args.push('-c', `sandbox_mode="${sandboxOverride}"`);
  }
  return args;
}

/**
 * 以受控异步方式拉起 Codex CLI 并收集结构化输出。
 */
function spawnCodexProcess({
  mode,
  args,
  cwd,
  stdinText,
  model,
  jsonMode = true,
  timeoutSec = 300,
  cleanupFiles = [],
}) {
  const binary = discoverCodexBinary();
  if (!binary.found) {
    for (const f of cleanupFiles) {
      try {
        unlinkSync(f);
      } catch {
        // 忽略清理失败
      }
    }
    return Promise.resolve({
      ok: false,
      error: 'codex_binary_not_found',
      message: '未在本机找到可用的 codex.exe 可执行文件。',
    });
  }

  const resolvedCwd = cwd ? resolve(cwd) : process.cwd();
  if (!existsSync(resolvedCwd)) {
    for (const f of cleanupFiles) {
      try {
        unlinkSync(f);
      } catch {
        // 忽略清理失败
      }
    }
    return Promise.resolve({
      ok: false,
      error: 'cwd_not_found',
      message: `工作目录不存在: ${resolvedCwd}`,
    });
  }

  const childEnv = { ...process.env };
  Object.assign(childEnv, resolveSubprocessProxyEnv(childEnv));
  const gitBinDir = discoverGitBinDir();
  const extraDirs = [binary.binDir, gitBinDir].filter(Boolean);
  if (extraDirs.length > 0) {
    childEnv.PATH = `${extraDirs.join(delimiter)}${delimiter}${childEnv.PATH || ''}`;
  }

  const runId = randomUUID();
  const startedMs = Date.now();
  const timeoutMs = Math.min(Math.max(Number(timeoutSec) || 300, 10), 1800) * 1000;

  return new Promise((resolvePromise) => {
    const child = spawn(binary.codexPath, args, {
      cwd: resolvedCwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    let cancelReason = null;

    const killFn = (reason) => {
      cancelReason = reason;
      try {
        child.kill('SIGTERM');
      } catch {
        // 忽略
      }
      setTimeout(() => {
        try {
          if (!child.killed) child.kill('SIGKILL');
        } catch {
          // 忽略
        }
      }, 1500).unref?.();
    };

    const runRecord = {
      runId,
      pid: child.pid || null,
      mode,
      model,
      cwd: resolvedCwd,
      threadId: null,
      startedAt: new Date(startedMs).toISOString(),
      startedMs,
      killFn,
    };
    activeRuns.set(runId, runRecord);

    const timer = setTimeout(() => killFn('timeout'), timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdoutBuf += text;
      // 动态提取 thread_id 以便 bridge_status 实时可见
      if (!runRecord.threadId) {
        const match = stdoutBuf.match(/"thread_id"\s*:\s*"([^"]+)"/);
        if (match?.[1]) runRecord.threadId = match[1];
      }
    });

    child.stderr?.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
    });

    // 关键防死锁：写入后立即关闭 stdin，防止 Windows 管道等待 EOF
    if (typeof stdinText === 'string' && stdinText.length > 0) {
      child.stdin?.write(stdinText, 'utf8');
    }
    child.stdin?.end();

    const finish = (code, spawnErr = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeRuns.delete(runId);

      for (const f of cleanupFiles) {
        try {
          unlinkSync(f);
        } catch {
          // 忽略临时文件清理异常
        }
      }

      const elapsedMs = Date.now() - startedMs;
      if (spawnErr) {
        resolvePromise({
          ok: false,
          run_id: runId,
          mode,
          model,
          cwd: resolvedCwd,
          error: 'spawn_failed',
          message: String(spawnErr.message || spawnErr),
          elapsed_ms: elapsedMs,
        });
        return;
      }

      if (!jsonMode) {
        const cleanOut = clipText(stdoutBuf.trim(), 12000);
        const cleanErr = clipText(stderrBuf.trim(), 4000);
        resolvePromise({
          ok: code === 0 && !cancelReason,
          run_id: runId,
          mode,
          model,
          cwd: resolvedCwd,
          exit_code: code,
          cancel_reason: cancelReason,
          output: cleanOut,
          stderr_preview: cleanErr || undefined,
          elapsed_ms: elapsedMs,
        });
        return;
      }

      const parsed = parseCodexJsonlEvents(stdoutBuf);
      const ok = code === 0 && !cancelReason && !parsed.turnFailed;
      resolvePromise({
        ok,
        run_id: runId,
        mode,
        model,
        cwd: resolvedCwd,
        codex_bin: binary.codexPath,
        has_code_mode_host: binary.hasCodeModeHost,
        thread_id: parsed.threadId || runRecord.threadId,
        exit_code: code,
        cancel_reason: cancelReason,
        final_message: clipText(parsed.finalMessage, 12000),
        commands: parsed.commands,
        file_changes: parsed.fileChanges,
        warnings: parsed.warnings,
        error_message: parsed.turnFailed || (ok ? undefined : clipText(stderrBuf.trim() || parsed.nonJsonPreview.join('\n'), 3000)),
        usage: parsed.usage,
        elapsed_ms: elapsedMs,
      });
    };

    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(code));
  });
}

/**
 * 1. 新建 Codex 非交互执行任务（可按需启用 multi_agent_v2 底层子智能体与 Git worktree）。
 */
export async function runCodexExec(opts = {}) {
  const {
    prompt,
    cwd,
    sandbox = 'workspace-write',
    model,
    effort = 'medium',
    enable_subagents: enableSubagents = false,
    worktree = false,
    ephemeral = false,
    enable_codex_mcp: enableCodexMcp = false,
    output_schema: outputSchema,
    timeout_sec: timeoutSec = 300,
  } = opts;

  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('codex_exec 需要非空 prompt 参数');
  }

  const { model: resolvedModel } = resolveCodexModel(model);
  const resolvedCwd = cwd ? resolve(cwd) : process.cwd();
  const cleanupFiles = [];

  const args = [
    'exec',
    '-m',
    resolvedModel,
    '-s',
    sandbox,
    '-C',
    resolvedCwd,
    ...buildBaseConfigArgs({ effort, enableCodexMcp }),
    '--skip-git-repo-check',
    '--json',
  ];

  if (enableSubagents) {
    args.push('--enable', 'multi_agent', '--enable', 'multi_agent_v2');
  } else {
    args.push('--disable', 'multi_agent_v2');
  }
  if (worktree) args.push('--worktree');
  if (ephemeral) args.push('--ephemeral');

  if (outputSchema !== undefined && outputSchema !== null) {
    const schemaPath = join(tmpdir(), `codex-schema-${randomUUID()}.json`);
    const schemaText = typeof outputSchema === 'string' ? outputSchema : JSON.stringify(outputSchema);
    writeFileSync(schemaPath, schemaText, 'utf8');
    cleanupFiles.push(schemaPath);
    args.push('--output-schema', schemaPath);
  }

  args.push('-');

  return spawnCodexProcess({
    mode: enableSubagents ? 'exec+subagents' : 'exec',
    args,
    cwd: resolvedCwd,
    stdinText: prompt,
    model: resolvedModel,
    jsonMode: true,
    timeoutSec,
    cleanupFiles,
  });
}

/**
 * 2. 操控已有 Codex 会话线程：resume（原线程续接纠偏）、fork（热分叉）或 queue（排队投递消息）。
 * 注意：codex exec resume / fork 不接受 -C 与 -s 参数，因此通过 spawn cwd 与 -c sandbox_mode 传入。
 */
export async function runCodexContinue(opts = {}) {
  const {
    action = 'resume',
    thread_id: threadId = 'last',
    prompt,
    cwd,
    sandbox = 'workspace-write',
    model,
    effort = 'medium',
    enable_subagents: enableSubagents = false,
    worktree = false,
    ephemeral = false,
    enable_codex_mcp: enableCodexMcp = false,
    timeout_sec: timeoutSec = 300,
  } = opts;

  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('codex_continue 需要非空 prompt 参数');
  }

  const { model: resolvedModel } = resolveCodexModel(model);
  const resolvedCwd = cwd ? resolve(cwd) : process.cwd();
  const isLast = !threadId || threadId === 'last' || threadId === '--last';

  if (action === 'queue') {
    if (isLast) {
      throw new Error('codex_continue(action="queue") 必须提供明确的 thread_id（不能为 last）');
    }
    const args = [
      'queue',
      '--thread',
      threadId,
      '--message',
      prompt,
      '-m',
      resolvedModel,
      '-s',
      sandbox,
      '-C',
      resolvedCwd,
      ...buildBaseConfigArgs({ effort, enableCodexMcp }),
    ];
    return spawnCodexProcess({
      mode: 'queue',
      args,
      cwd: resolvedCwd,
      stdinText: '',
      model: resolvedModel,
      jsonMode: false,
      timeoutSec,
    });
  }

  if (action === 'fork') {
    if (isLast) {
      throw new Error('codex_continue(action="fork") 必须提供明确的 thread_id');
    }
    const args = [
      'exec',
      'fork',
      '-m',
      resolvedModel,
      ...buildBaseConfigArgs({ effort, sandboxOverride: sandbox, enableCodexMcp }),
      '--skip-git-repo-check',
      '--json',
    ];
    if (enableSubagents) args.push('--enable', 'multi_agent', '--enable', 'multi_agent_v2');
    if (worktree) args.push('--worktree');
    if (ephemeral) args.push('--ephemeral');
    args.push(threadId, '-');

    return spawnCodexProcess({
      mode: 'fork',
      args,
      cwd: resolvedCwd,
      stdinText: prompt,
      model: resolvedModel,
      jsonMode: true,
      timeoutSec,
    });
  }

  if (action === 'resume') {
    const args = [
      'exec',
      'resume',
      '-m',
      resolvedModel,
      ...buildBaseConfigArgs({ effort, sandboxOverride: sandbox, enableCodexMcp }),
      '--skip-git-repo-check',
      '--json',
    ];
    if (enableSubagents) args.push('--enable', 'multi_agent', '--enable', 'multi_agent_v2');
    if (worktree) args.push('--worktree');
    if (ephemeral) args.push('--ephemeral');
    if (isLast) {
      args.push('--last', '-');
    } else {
      args.push(threadId, '-');
    }

    return spawnCodexProcess({
      mode: 'resume',
      args,
      cwd: resolvedCwd,
      stdinText: prompt,
      model: resolvedModel,
      jsonMode: true,
      timeoutSec,
    });
  }

  throw new Error(`未知 codex_continue action: ${action}，仅支持 resume / fork / queue`);
}

/**
 * 3. 调用 codex exec review 进行非交互式代码审查。
 * 注意 CLI 限制：--uncommitted / --base / --commit 与自定义 [PROMPT] 互斥。
 */
export async function runCodexReview(opts = {}) {
  const {
    cwd,
    uncommitted = true,
    base,
    commit,
    title,
    prompt,
    model,
    effort = 'medium',
    ephemeral = true,
    timeout_sec: timeoutSec = 300,
  } = opts;

  const { model: resolvedModel } = resolveCodexModel(model);
  const resolvedCwd = cwd ? resolve(cwd) : process.cwd();

  const args = [
    'exec',
    'review',
    '-m',
    resolvedModel,
    ...buildBaseConfigArgs({ effort, enableCodexMcp: false }),
    '--skip-git-repo-check',
    '--json',
  ];
  if (ephemeral) args.push('--ephemeral');

  let stdinText = '';
  let note;

  if (base && String(base).trim()) {
    args.push('--base', String(base).trim());
    if (prompt && prompt.trim()) {
      note = 'codex exec review 不允许 --base 与自定义 prompt 并用，已按 --base 分支对比执行标准审查。';
    }
  } else if (commit && String(commit).trim()) {
    args.push('--commit', String(commit).trim());
    if (title && String(title).trim()) args.push('--title', String(title).trim());
    if (prompt && prompt.trim()) {
      note = 'codex exec review 不允许 --commit 与自定义 prompt 并用，已按 --commit 执行标准审查。';
    }
  } else if (prompt && prompt.trim()) {
    stdinText = prompt.trim();
    args.push('-');
  } else if (hasGitRepo(resolvedCwd) && Boolean(discoverGitBinDir())) {
    args.push('--uncommitted');
  } else {
    stdinText =
      'Review the source and test files in the current directory for correctness, edge cases, potential bugs, and test quality.';
    args.push('-');
    note = '目标目录非 Git 仓库或缺少 Git，已自动降级为目录文件代码审查模式。';
  }

  const res = await spawnCodexProcess({
    mode: 'review',
    args,
    cwd: resolvedCwd,
    stdinText,
    model: resolvedModel,
    jsonMode: true,
    timeoutSec,
  });

  if (note) res.note = note;
  return res;
}
