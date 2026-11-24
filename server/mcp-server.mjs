/**
 * @fileoverview gemini-codex-jev Stdio MCP Server。
 * 兼容换行分隔 JSON 与 LSP Content-Length 双帧传输协议，零第三方依赖。
 * 暴露 5 个紧凑工具：jev_judge / codex_exec / codex_continue / codex_review / bridge_status。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cancelAllRuns,
  cancelRun,
  discoverCodexBinary,
  discoverGitBinDir,
  listActiveRuns,
  loadSupportedCodexModels,
  resolveCodexModel,
  runCodexContinue,
  runCodexExec,
  runCodexReview,
} from './codex-runner.mjs';
import { callJev, getTypeSafeKeyStatus } from './jev-client.mjs';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_MANIFEST_PATH = join(dirname(SERVER_DIR), 'plugin.json');

const SUPPORTED_MCP_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);
const DEFAULT_MCP_VERSION = '2025-03-26';

function readServerVersion() {
  try {
    if (existsSync(PLUGIN_MANIFEST_PATH)) {
      const parsed = JSON.parse(readFileSync(PLUGIN_MANIFEST_PATH, 'utf8'));
      if (typeof parsed?.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    }
  } catch {
    // 忽略版本读取异常
  }
  return '0.1.0';
}

export const TOOLS = [
  {
    name: 'jev_judge',
    description:
      'Call TypeSafe Jev (System One non-generative model) for millisecond-level calibrated probability judgments (choice/noul/score/box) or built-in presets (task_route, patch_gate). Supports PNG images and dry_run.',
    inputSchema: {
      type: 'object',
      properties: {
        preset: {
          type: 'string',
          enum: ['task_route', 'patch_gate'],
          description: 'Optional built-in judgment template for task routing or patch quality gating.',
        },
        summary: {
          type: 'string',
          description: 'Concise de-sensitized summary/goal required when using preset or shorthand state.',
        },
        state: {
          type: 'object',
          description: 'Structured application state JSON object referenced by questions.',
        },
        questions: {
          type: 'object',
          description: 'Custom typed Jev questions map (choice, noul, score, box). Optional if preset is set.',
        },
        images: {
          type: 'object',
          description: 'Map of state field name to local PNG file path (280..1568 px per side).',
        },
        model: {
          type: 'string',
          description: 'Jev model name (defaults to jev-latest).',
        },
        task_id: {
          type: 'string',
          description: 'Stable task identifier used to cache identical requests and guard per-task budget.',
        },
        allow_multiple: {
          type: 'boolean',
          description: 'Set true to allow distinct requests under the same task_id (e.g. route then patch_gate).',
        },
        timeout_sec: {
          type: 'number',
          description: 'HTTP timeout in seconds (3..60, default 20).',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview request payload, image dimensions, and SHA-256 without sending API traffic.',
        },
      },
    },
  },
  {
    name: 'codex_exec',
    description:
      'Execute a coding, debugging, or exploration task via local OpenAI Codex CLI 0.165+ in non-interactive JSONL mode. Returns thread_id for follow-up control and a distilled summary.',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          description: 'Clear task instructions and acceptance criteria passed via stdin.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory path for Codex execution.',
        },
        sandbox: {
          type: 'string',
          enum: ['read-only', 'workspace-write', 'danger-full-access'],
          description: 'Codex execution sandbox policy (default: workspace-write).',
        },
        model: {
          type: 'string',
          description: 'Codex model slug (defaults to local supported gpt-6.1-sol).',
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          description: 'Reasoning effort level (default: medium).',
        },
        enable_subagents: {
          type: 'boolean',
          description: 'Enable Codex internal multi_agent_v2 subagents (explorer/worker) for parallel tasks.',
        },
        worktree: {
          type: 'boolean',
          description: 'Run inside a managed isolated Git worktree.',
        },
        ephemeral: {
          type: 'boolean',
          description: 'Run without persisting session rollout files to disk.',
        },
        enable_codex_mcp: {
          type: 'boolean',
          description: 'Keep Codex external MCP servers (like context7) enabled; default false for fast startup.',
        },
        output_schema: {
          type: 'object',
          description: 'Optional JSON Schema constraining Codex final response.',
        },
        timeout_sec: {
          type: 'number',
          description: 'Process timeout in seconds (10..1800, default 300).',
        },
      },
    },
  },
  {
    name: 'codex_continue',
    description:
      'Control an existing Codex session thread: resume (follow-up/fix in same context), fork (branch exploration), or queue (enqueue message to running thread).',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        action: {
          type: 'string',
          enum: ['resume', 'fork', 'queue'],
          description: 'Thread control operation (default: resume).',
        },
        thread_id: {
          type: 'string',
          description: 'Target Codex session UUID/name, or "last" for resume.',
        },
        prompt: {
          type: 'string',
          description: 'Follow-up instruction, steering feedback, or fix request.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the resumed/forked session.',
        },
        sandbox: {
          type: 'string',
          enum: ['read-only', 'workspace-write', 'danger-full-access'],
          description: 'Sandbox override applied via -c sandbox_mode (default: workspace-write).',
        },
        model: {
          type: 'string',
          description: 'Optional Codex model slug override.',
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          description: 'Reasoning effort level (default: medium).',
        },
        enable_subagents: {
          type: 'boolean',
          description: 'Enable multi_agent_v2 subagents during resume/fork.',
        },
        worktree: {
          type: 'boolean',
          description: 'Run inside a managed Git worktree.',
        },
        ephemeral: {
          type: 'boolean',
          description: 'Run without persisting new rollout files.',
        },
        timeout_sec: {
          type: 'number',
          description: 'Process timeout in seconds (10..1800, default 300).',
        },
      },
    },
  },
  {
    name: 'codex_review',
    description:
      'Run an independent non-interactive Codex code review (Review Gate) against uncommitted changes, a base branch, a commit SHA, or custom review instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Git repository directory to review.',
        },
        uncommitted: {
          type: 'boolean',
          description: 'Review staged, unstaged, and untracked changes (default true when no base/commit/prompt).',
        },
        base: {
          type: 'string',
          description: 'Review changes against the specified base branch.',
        },
        commit: {
          type: 'string',
          description: 'Review changes introduced by a specific commit SHA.',
        },
        title: {
          type: 'string',
          description: 'Optional commit title for review summary.',
        },
        prompt: {
          type: 'string',
          description: 'Custom review instructions (mutually exclusive with --uncommitted/--base/--commit in Codex CLI).',
        },
        model: {
          type: 'string',
          description: 'Codex model slug (defaults to local supported gpt-6.1-sol).',
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          description: 'Reasoning effort level (default: medium).',
        },
        ephemeral: {
          type: 'boolean',
          description: 'Run review ephemerally (default: true).',
        },
        timeout_sec: {
          type: 'number',
          description: 'Process timeout in seconds (10..1800, default 300).',
        },
      },
    },
  },
  {
    name: 'bridge_status',
    description:
      'Inspect local Codex binary/model readiness and TypeSafe Jev key status (doctor), list active Codex processes (active), or kill a stuck run (cancel).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['doctor', 'active', 'cancel'],
          description: 'Diagnostic or control action (default: doctor).',
        },
        run_id: {
          type: 'string',
          description: 'Required when action="cancel": target run_id returned by active.',
        },
      },
    },
  },
];

async function executeTool(name, args = {}) {
  switch (name) {
    case 'jev_judge':
      return await callJev(args);
    case 'codex_exec':
      return await runCodexExec(args);
    case 'codex_continue':
      return await runCodexContinue(args);
    case 'codex_review':
      return await runCodexReview(args);
    case 'bridge_status': {
      const action = args?.action || 'doctor';
      if (action === 'active') {
        return { ok: true, active_runs: listActiveRuns() };
      }
      if (action === 'cancel') {
        if (!args?.run_id) {
          return { ok: false, error: 'missing_run_id', message: 'cancel 操作必须传入 run_id' };
        }
        return cancelRun(args.run_id);
      }
      const binary = discoverCodexBinary();
      const cache = loadSupportedCodexModels();
      const defaultPick = resolveCodexModel(null);
      const jevKey = getTypeSafeKeyStatus();
      return {
        ok: binary.found,
        codex: {
          found: binary.found,
          path: binary.codexPath,
          bin_dir: binary.binDir,
          has_code_mode_host: binary.hasCodeModeHost,
          has_bundled_rg: binary.hasBundledRg,
          git_bin_dir: discoverGitBinDir(),
          default_model: defaultPick.model,
          supported_models: cache.models,
        },
        jev: {
          endpoint: 'https://api.typesafe.ai/v1/systemone',
          typesafe_key_present: jevKey.present,
          key_source: jevKey.source,
          default_model: 'jev-latest',
        },
        active_runs: listActiveRuns(),
      };
    }
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

export async function handleJsonRpcMessage(msg, serverVersion = readServerVersion()) {
  if (!msg || typeof msg !== 'object') return null;
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined && msg.id !== null;
  if (!hasId) {
    return null;
  }

  const { id } = msg;
  const method = String(msg.method || '');

  if (method === 'initialize') {
    const requested = String(msg.params?.protocolVersion || '').trim();
    const protocolVersion = SUPPORTED_MCP_VERSIONS.has(requested) ? requested : DEFAULT_MCP_VERSION;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'gemini-codex-jev-bridge',
          version: serverVersion,
        },
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'resources/list') {
    return { jsonrpc: '2.0', id, result: { resources: [] } };
  }

  if (method === 'resources/templates/list') {
    return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
  }

  if (method === 'prompts/list') {
    return { jsonrpc: '2.0', id, result: { prompts: [] } };
  }

  if (method === 'tools/call') {
    const toolName = msg.params?.name;
    const toolArgs = msg.params?.arguments || {};
    try {
      const result = await executeTool(toolName, toolArgs);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: result?.ok === false,
        },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: err?.name || 'ToolExecutionError',
                message: String(err?.message || err),
              }),
            },
          ],
          isError: true,
        },
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`,
    },
  };
}

function startStdioServer() {
  const serverVersion = readServerVersion();
  let framingMode = null;
  let rawBuffer = Buffer.alloc(0);
  let activeRequests = 0;
  let stdinClosed = false;

  function writeJsonRpcResponse(payload, mode) {
    const serialized = JSON.stringify(payload);
    if (mode === 'lsp') {
      const byteLen = Buffer.byteLength(serialized, 'utf8');
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${serialized}`);
    } else {
      process.stdout.write(`${serialized}\n`);
    }
  }

  let exiting = false;

  function maybeExit() {
    if (stdinClosed && activeRequests === 0 && !exiting) {
      exiting = true;
      cancelAllRuns();
      setImmediate(() => process.exit(0));
    }
  }

  function dispatchMessage(msg, mode) {
    activeRequests += 1;
    Promise.resolve(handleJsonRpcMessage(msg, serverVersion))
      .then((response) => {
        if (response) {
          writeJsonRpcResponse(response, mode);
        }
      })
      .catch((err) => {
        if (msg && msg.id !== undefined && msg.id !== null) {
          writeJsonRpcResponse(
            {
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32603, message: String(err?.message || err) },
            },
            mode,
          );
        }
      })
      .finally(() => {
        activeRequests -= 1;
        maybeExit();
      });
  }

  function parseIncomingFrames() {
    while (rawBuffer.length > 0) {
      const headerProbe = rawBuffer.subarray(0, Math.min(rawBuffer.length, 32)).toString('ascii');
      if (framingMode === 'lsp' || /^Content-Length:/i.test(headerProbe)) {
        framingMode = 'lsp';
        const crlfIdx = rawBuffer.indexOf('\r\n\r\n');
        const lfIdx = rawBuffer.indexOf('\n\n');
        let sepIdx = -1;
        let sepLen = 0;
        if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx < lfIdx)) {
          sepIdx = crlfIdx;
          sepLen = 4;
        } else if (lfIdx !== -1) {
          sepIdx = lfIdx;
          sepLen = 2;
        }
        if (sepIdx === -1) break;

        const headerText = rawBuffer.subarray(0, sepIdx).toString('ascii');
        const match = headerText.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          rawBuffer = rawBuffer.subarray(sepIdx + sepLen);
          continue;
        }
        const contentLen = Number(match[1]);
        const totalLen = sepIdx + sepLen + contentLen;
        if (rawBuffer.length < totalLen) break;

        const bodyText = rawBuffer.subarray(sepIdx + sepLen, totalLen).toString('utf8');
        rawBuffer = rawBuffer.subarray(totalLen);
        try {
          const msg = JSON.parse(bodyText);
          dispatchMessage(msg, 'lsp');
        } catch {
          // 忽略格式损坏的 JSON 帧
        }
      } else {
        const nlIdx = rawBuffer.indexOf('\n');
        if (nlIdx === -1) break;
        const lineText = rawBuffer.subarray(0, nlIdx).toString('utf8').trim();
        rawBuffer = rawBuffer.subarray(nlIdx + 1);
        if (!lineText) continue;
        if (!framingMode) framingMode = 'line';
        try {
          const msg = JSON.parse(lineText);
          dispatchMessage(msg, framingMode);
        } catch {
          // 忽略无法解析的非 JSON 行
        }
      }
    }
  }

  process.stdin.on('data', (chunk) => {
    rawBuffer = Buffer.concat([rawBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    parseIncomingFrames();
  });

  process.stdin.on('end', () => {
    stdinClosed = true;
    maybeExit();
  });

  process.stdin.on('close', () => {
    stdinClosed = true;
    maybeExit();
  });

  process.on('SIGINT', () => {
    cancelAllRuns();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    cancelAllRuns();
    process.exit(0);
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase()
) {
  startStdioServer();
}
