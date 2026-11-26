/**
 * @fileoverview TypeSafe System One (Jev) 轻量零依赖客户端。
 * 职责：
 * 1. 优先从 Windows HKCU 用户环境变量读取最新 TYPESAFE_API_KEY，严禁泄露密钥；
 * 2. 构造规范化有序 JSON 与 SHA-256 哈希，提供单任务预算保护与并发锁；
 * 3. 校验 PNG 图像尺寸与静态帧格式，支持 multipart 图像与 Box 定位请求；
 * 4. 内置 task_route（任务路由）与 patch_gate（补丁门禁）预设及校准概率解读。
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_JEV_MODEL = 'jev-latest';
export const IMAGE_DANGER_HEADER = { 'TypeSafe-Danger-Zone-Images': 'true' };
export const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_PNG_BYTES = 16 * 1024 * 1024;
export const MIN_IMAGE_SIDE = 280;
export const MAX_IMAGE_SIDE = 1568;

const CACHE_ROOT = join(tmpdir(), 'agy-gemini-codex-jev-cache');
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * 递归排序对象键以生成确定性 JSON 字符串，消除跨宿主/属性顺序差异。
 * @param {unknown} value
 * @returns {unknown}
 */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) {
        sorted[key] = sortKeysDeep(item);
      }
    }
    return sorted;
  }
  return value;
}

/**
 * 生成确定性紧凑 JSON。
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * 计算 UTF-8 字符串或 Buffer 的 SHA-256 小写十六进制摘要。
 * @param {string|Buffer} input
 * @returns {string}
 */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * 从 Windows HKCU 注册表或进程环境解析 TYPESAFE_API_KEY。
 * 密钥仅在内存短期存在，绝不写入日志或返回值。
 * @returns {{ key: string | null, source: 'hkcu_registry' | 'process_env' | 'none' }}
 */
function resolveApiKeyInternal() {
  if (process.platform === 'win32') {
    try {
      const stdout = execFileSync(
        'reg.exe',
        ['query', 'HKCU\\Environment', '/v', 'TYPESAFE_API_KEY'],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const match = stdout.match(/^\s*TYPESAFE_API_KEY\s+REG_(?:EXPAND_)?SZ\s+(.+)\s*$/m);
      if (match && match[1] && match[1].trim()) {
        return { key: match[1].trim(), source: 'hkcu_registry' };
      }
    } catch {
      // 注册表不存在该值时静默回退到当前进程环境变量
    }
  }
  const envVal = process.env.TYPESAFE_API_KEY;
  if (typeof envVal === 'string' && envVal.trim()) {
    return { key: envVal.trim(), source: 'process_env' };
  }
  return { key: null, source: 'none' };
}

/**
 * 对外暴露的非敏感密钥状态检测（绝不返回任何密钥字符或长度）。
 * @returns {{ present: boolean, source: 'hkcu_registry' | 'process_env' | 'none' }}
 */
export function getTypeSafeKeyStatus() {
  const { key, source } = resolveApiKeyInternal();
  const present = Boolean(key);
  return { present, source: present ? source : 'none' };
}

/**
 * 校验并加载本地 PNG 图像。
 * @param {string} imagePath
 * @returns {{ buffer: Buffer, filename: string, resolvedPath: string, width: number, height: number, bytes: number }}
 */
export function validateAndLoadPng(imagePath) {
  const resolvedPath = resolve(imagePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`图像文件不存在: ${resolvedPath}`);
  }
  const png = readFileSync(resolvedPath);
  if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`仅支持静态 PNG 文件（头校验失败）: ${resolvedPath}`);
  }
  if (png.length > MAX_PNG_BYTES) {
    throw new Error(`PNG 体积超过 16 MiB 上限: ${png.length} bytes`);
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (
    width < MIN_IMAGE_SIDE ||
    width > MAX_IMAGE_SIDE ||
    height < MIN_IMAGE_SIDE ||
    height > MAX_IMAGE_SIDE
  ) {
    throw new Error(
      `PNG 尺寸 (${width}x${height}) 超出允许范围 [${MIN_IMAGE_SIDE}, ${MAX_IMAGE_SIDE}] 像素`,
    );
  }
  for (let offset = 8; offset + 12 <= png.length; ) {
    const chunkLen = png.readUInt32BE(offset);
    if (offset + chunkLen + 12 > png.length) {
      throw new Error(`PNG 数据块截断损坏: ${resolvedPath}`);
    }
    const chunkType = png.toString('ascii', offset + 4, offset + 8);
    if (chunkType === 'acTL') {
      throw new Error(`不支持动态 APNG，请先导出静态帧: ${resolvedPath}`);
    }
    offset += chunkLen + 12;
  }
  return {
    buffer: png,
    filename: basename(resolvedPath),
    resolvedPath,
    width,
    height,
    bytes: png.length,
  };
}

/**
 * 构造内置预设（task_route / patch_gate）的有序 state 与 questions。
 * @param {'task_route'|'patch_gate'} preset
 * @param {string} summary
 * @param {Record<string, unknown>} [extraState]
 */
export function buildPresetPayload(preset, summary, extraState = {}) {
  const text = typeof summary === 'string' ? summary.trim() : '';
  if (!text) {
    throw new Error(`使用 preset="${preset}" 时必须提供非空 summary`);
  }

  if (preset === 'task_route') {
    return {
      state: {
        task_summary: text,
        ...(extraState && typeof extraState === 'object' ? extraState : {}),
      },
      questions: {
        execution_route: {
          type: 'choice',
          instructions: 'Which execution route best fits `task_summary`?',
          criteria: {
            gemini_direct:
              'Pure conceptual explanation, Q&A, or lightweight text analysis requiring no repository edits or shell execution.',
            codex_single:
              'Focused coding, debugging, script creation, or targeted modification inside one module or a few related files.',
            codex_subagents:
              'Large multi-module feature, cross-directory refactoring, or parallel audit best split across multiple worker subagents.',
            review_only:
              'Independent code review, diff inspection, or defect verification on existing changes without writing new features.',
          },
        },
        needs_write_sandbox: {
          type: 'noul',
          instructions:
            'Does fulfilling `task_summary` require modifying workspace files or creating new code artifacts?',
          criteria: {
            true: 'Files need to be created, edited, refactored, or patched on disk.',
            false: 'Only read-only inspection, explanation, planning, or code review is needed.',
          },
        },
        needs_visual_evidence: {
          type: 'noul',
          instructions:
            'Would inspecting a screenshot, diagram, or image asset provide necessary evidence for `task_summary`?',
          criteria: {
            true: 'Visual UI layout, rendered chart, or image content must be checked.',
            false: 'All required information is in text, code, or terminal output.',
          },
        },
      },
    };
  }

  if (preset === 'patch_gate') {
    return {
      state: {
        task_goal: text,
        ...(extraState && typeof extraState === 'object' ? extraState : {}),
      },
      questions: {
        goal_satisfied: {
          type: 'noul',
          instructions:
            'Do the changes and verification evidence in state satisfy the core requirements of `task_goal`?',
          criteria: {
            true: 'Requested behavior is implemented and directly supported by passing test or command evidence.',
            false: 'Core requirements are missing, unverified, or contradicted by test results.',
          },
        },
        has_unverified_risk: {
          type: 'noul',
          instructions:
            'Does state show failing tests, runtime errors, skipped assertions, or hardcoded shortcuts that bypass verification?',
          criteria: {
            true: 'There are explicit failures, error messages, or mocked/hardcoded workarounds.',
            false: 'Checks passed cleanly with no obvious error or bypass signal.',
          },
        },
      },
    };
  }

  throw new Error(`未知 preset: ${preset}，仅支持 task_route 或 patch_gate`);
}

/**
 * 将 Jev 原生 answers 映射为确定性代码可读门禁建议（不掩盖原始概率分布）。
 * 规则：Noul > 0.7 => yes，< 0.3 => no，中间区间 => uncertain_escalate。
 * @param {Record<string, any>} answers
 * @param {Record<string, any>} questions
 * @returns {Record<string, any>}
 */
export function interpretJevAnswers(answers, questions) {
  if (!answers || typeof answers !== 'object') return {};
  const interpreted = {};

  for (const [key, ans] of Object.entries(answers)) {
    const qType = questions?.[key]?.type || ans?.type || 'unknown';
    if (!ans || typeof ans !== 'object') {
      interpreted[key] = { type: qType, raw: ans };
      continue;
    }

    if (qType === 'noul' || typeof ans.noul === 'number' || typeof ans.probability === 'number') {
      const pTrue =
        typeof ans.noul === 'number'
          ? ans.noul
          : typeof ans.probability === 'number'
            ? ans.probability
            : typeof ans.probabilities?.true === 'number'
              ? ans.probabilities.true
              : typeof ans.true === 'number'
                ? ans.true
                : null;
      let verdict = 'unknown';
      if (typeof pTrue === 'number') {
        if (pTrue > 0.7) verdict = 'yes';
        else if (pTrue < 0.3) verdict = 'no';
        else verdict = 'uncertain_escalate';
      }
      interpreted[key] = {
        type: 'noul',
        probability_true: pTrue,
        verdict,
        confidence: ans.confidence ?? null,
      };
      continue;
    }

    if (qType === 'choice' || (ans.probabilities && typeof ans.probabilities === 'object' && !Array.isArray(ans.probabilities))) {
      const probs = ans.probabilities || {};
      let topOption = ans.choice ?? ans.answer ?? ans.selected ?? null;
      let topProb = typeof topOption === 'string' && typeof probs[topOption] === 'number' ? probs[topOption] : -1;
      for (const [opt, p] of Object.entries(probs)) {
        if (typeof p === 'number' && p > topProb) {
          topProb = p;
          topOption = opt;
        }
      }
      interpreted[key] = {
        type: 'choice',
        top_option: topOption,
        top_probability: topProb >= 0 ? topProb : null,
        confidence: ans.confidence ?? null,
      };
      continue;
    }

    if (qType === 'score' || typeof ans.position === 'number') {
      interpreted[key] = {
        type: 'score',
        position: ans.position ?? ans.score ?? null,
        probabilities: ans.probabilities ?? null,
        confidence: ans.confidence ?? null,
      };
      continue;
    }

    if (qType === 'box' || ans.box || typeof ans.x1 === 'number' || typeof ans.x === 'number') {
      interpreted[key] = {
        type: 'box',
        coordinates: ans.box ?? ans,
        note: 'Box 不自带缺失状态判断，请搭配独立 Noul 存在性检查后使用。',
      };
      continue;
    }

    interpreted[key] = { type: qType, raw: ans };
  }

  return interpreted;
}

/**
 * 解析 Windows 注册表中的代理配置（HKCU\Environment 与 Internet Settings）。
 * @returns {string}
 */
function readWindowsRegistryProxy() {
  if (process.platform !== 'win32') return '';
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    try {
      const out = execFileSync('reg.exe', ['query', 'HKCU\\Environment', '/v', name], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = out.match(/^\s*(?:HTTPS_PROXY|HTTP_PROXY)\s+REG_(?:EXPAND_)?SZ\s+(.+)\s*$/im);
      if (m?.[1]?.trim()) return m[1].trim();
    } catch {
      // 忽略缺失项
    }
  }
  try {
    const out = execFileSync(
      'reg.exe',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const enabledMatch = out.match(/^\s*ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/im);
    if (!enabledMatch || Number.parseInt(enabledMatch[1], 16) !== 1) return '';
    const serverMatch = out.match(/^\s*ProxyServer\s+REG_(?:EXPAND_)?SZ\s+(.+)\s*$/im);
    let server = serverMatch?.[1]?.trim() || '';
    if (!server) return '';
    if (server.includes('=')) {
      const parts = server.split(';').map((s) => s.trim());
      const httpsPart = parts.find((p) => /^https=/i.test(p));
      const httpPart = parts.find((p) => /^http=/i.test(p));
      server = (httpsPart || httpPart || parts[0] || '').replace(/^[a-z]+=/i, '');
    }
    if (!server) return '';
    return /^https?:\/\//i.test(server) ? server : `http://${server}`;
  } catch {
    return '';
  }
}

/**
 * 解析当前环境中的 HTTP(S) 代理地址（尊重 NO_PROXY，并支持 Windows 注册表回退）。
 * @param {string} targetUrl
 * @returns {{ url: URL | null, fromEnv: boolean }}
 */
let subprocessProxyCache = null;
let subprocessProxyCheckedAt = 0;

export function resolveSubprocessProxyEnv(baseEnv = process.env) {
  if (['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
    .some((name) => String(baseEnv[name] || '').trim())) return {};
  if (process.platform !== 'win32') return {};
  const nowMs = Date.now();
  if (subprocessProxyCache === null || nowMs - subprocessProxyCheckedAt >= 60_000) {
    subprocessProxyCheckedAt = nowMs;
    subprocessProxyCache = '';
    try {
      const proxy = new URL(readWindowsRegistryProxy());
      if (/^https?:$/.test(proxy.protocol) && proxy.hostname) subprocessProxyCache = proxy.href;
    } catch {
      // Invalid or unavailable system proxy.
    }
  }
  return subprocessProxyCache ? { HTTPS_PROXY: subprocessProxyCache, HTTP_PROXY: subprocessProxyCache } : {};
}

function resolveProxyInfo(targetUrl) {
  const target = new URL(targetUrl);
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const hostLower = target.hostname.toLowerCase();
  if (noProxy.some((entry) => entry === '*' || hostLower === entry || hostLower.endsWith(`.${entry.replace(/^\./, '')}`))) {
    return { url: null, fromEnv: false };
  }
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    '';
  if (envProxy.trim()) {
    try {
      return { url: new URL(envProxy.trim()), fromEnv: true };
    } catch {
      return { url: null, fromEnv: false };
    }
  }
  const regProxy = readWindowsRegistryProxy();
  if (regProxy) {
    try {
      return { url: new URL(regProxy), fromEnv: false };
    } catch {
      return { url: null, fromEnv: false };
    }
  }
  return { url: null, fromEnv: false };
}

/**
 * 在未开启 NODE_USE_ENV_PROXY 或环境变量未继承时通过纯 Node HTTP CONNECT 隧道兼容系统代理，
 * 避免独立/GUI 子进程直连遭遇区域 451 错误。
 */
async function postJsonOrForm(url, headers, body, timeoutMs) {
  const envProxyEnabled =
    process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy');
  const { url: proxyUrl, fromEnv } = resolveProxyInfo(url);

  // 仅当未配置代理，或代理来自环境变量且已开启 NODE_USE_ENV_PROXY 时直接走原生 fetch
  if (!proxyUrl || (fromEnv && envProxyEnabled) || !/^https?:$/i.test(proxyUrl.protocol)) {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    };
  }

  // 将 FormData / string 统一渲染为 Buffer 与精确 Content-Type 头
  let payloadBuffer;
  const finalHeaders = { ...headers };
  if (typeof body === 'string') {
    payloadBuffer = Buffer.from(body, 'utf8');
  } else {
    const helperReq = new Request(url, { method: 'POST', body });
    const ct = helperReq.headers.get('content-type');
    if (ct) finalHeaders['Content-Type'] = ct;
    payloadBuffer = Buffer.from(await helperReq.arrayBuffer());
  }
  finalHeaders['Content-Length'] = String(payloadBuffer.length);

  const target = new URL(url);
  const targetPort = Number(target.port) || 443;
  const proxyPort = Number(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80);

  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };

    const connectHeaders = { Host: `${target.hostname}:${targetPort}` };
    if (proxyUrl.username || proxyUrl.password) {
      const creds = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
      connectHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`;
    }

    const tunnelReq = http.request({
      host: proxyUrl.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      headers: connectHeaders,
      timeout: timeoutMs,
    });

    tunnelReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        done(rejectPromise, new Error(`代理 CONNECT 握手失败: HTTP ${res.statusCode}`));
        return;
      }

      const apiReq = https.request(
        {
          hostname: target.hostname,
          port: targetPort,
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          headers: finalHeaders,
          socket,
          agent: false,
          servername: target.hostname,
          timeout: timeoutMs,
        },
        (apiRes) => {
          const chunks = [];
          apiRes.on('data', (chunk) => chunks.push(chunk));
          apiRes.on('end', () => {
            const status = apiRes.statusCode || 0;
            const text = Buffer.concat(chunks).toString('utf8');
            done(resolvePromise, { ok: status >= 200 && status < 300, status, text });
          });
        },
      );

      apiReq.on('timeout', () => {
        apiReq.destroy(new Error('TypeSafe 请求超时'));
      });
      apiReq.on('error', (err) => done(rejectPromise, err));
      apiReq.write(payloadBuffer);
      apiReq.end();
    });

    tunnelReq.on('timeout', () => {
      tunnelReq.destroy(new Error('代理 CONNECT 超时'));
    });
    tunnelReq.on('error', (err) => done(rejectPromise, err));
    tunnelReq.end();
  });
}

/**
 * 调用 TypeSafe System One (Jev) 接口。
 * @param {object} params
 */
export async function callJev(params = {}) {
  const {
    preset,
    summary,
    state: rawState,
    questions: rawQuestions,
    images,
    model = DEFAULT_JEV_MODEL,
    task_id: taskId,
    allow_multiple: allowMultiple = false,
    timeout_sec: timeoutSec = 20,
    dry_run: dryRun = false,
  } = params;

  let state = rawState && typeof rawState === 'object' ? { ...rawState } : {};
  let questions = rawQuestions && typeof rawQuestions === 'object' ? { ...rawQuestions } : {};

  if (preset) {
    const built = buildPresetPayload(preset, summary, state);
    state = built.state;
    if (Object.keys(questions).length === 0) {
      questions = built.questions;
    } else {
      questions = { ...built.questions, ...questions };
    }
  } else if (typeof summary === 'string' && summary.trim() && !Object.prototype.hasOwnProperty.call(state, 'task_summary')) {
    state.task_summary = summary.trim();
  }

  if (Object.keys(questions).length === 0) {
    throw new Error('必须提供非空 questions 对象，或指定 preset (task_route / patch_gate)');
  }

  // 处理 PNG 图像资产与 assets 映射
  const loadedImages = [];
  const assets = {};
  if (images && typeof images === 'object') {
    for (const [fieldKey, imgPath] of Object.entries(images)) {
      if (typeof imgPath !== 'string' || !imgPath.trim()) continue;
      const loaded = validateAndLoadPng(imgPath);
      const refId = randomUUID();
      const partName = String(fieldKey).replace(/[^a-zA-Z0-9_-]/g, '_') || `img_${loadedImages.length}`;
      state[fieldKey] = refId;
      assets[refId] = { type: 'image', part: partName };
      loadedImages.push({
        fieldKey,
        partName,
        refId,
        ...loaded,
      });
    }
  }

  const payload = {
    model: typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_JEV_MODEL,
    state,
    ...(Object.keys(assets).length > 0 ? { assets } : {}),
    questions,
  };

  // 用于哈希与预算去重：若有动态 UUID 图像引用，按文件 SHA-256 归一化避免每次 dry_run 哈希变动
  const hashBasis = {
    model: payload.model,
    state: {
      ...state,
      ...Object.fromEntries(
        loadedImages.map((img) => [img.fieldKey, `png_sha256:${sha256Hex(img.buffer)}`]),
      ),
    },
    questions,
  };
  const canonicalPayloadStr = canonicalJson(payload);
  if (Buffer.byteLength(canonicalPayloadStr, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error('请求 JSON 超过 32 MiB 限制');
  }
  const requestSha256 = sha256Hex(canonicalJson(hashBasis));

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      endpoint: JEV_ENDPOINT,
      headers: { ...IMAGE_DANGER_HEADER },
      multipart: loadedImages.length > 0,
      images_meta: loadedImages.map((img) => ({
        field: img.fieldKey,
        part: img.partName,
        path: img.resolvedPath,
        width: img.width,
        height: img.height,
        bytes: img.bytes,
      })),
      request_sha256: requestSha256,
      payload,
    };
  }

  // 任务级预算校验与缓存复用
  const cleanTaskId = typeof taskId === 'string' && taskId.trim() ? taskId.trim() : null;
  let cachePath = null;
  let attemptPath = null;

  if (cleanTaskId) {
    mkdirSync(CACHE_ROOT, { recursive: true });
    const taskHash = sha256Hex(cleanTaskId);
    const cacheKey = allowMultiple ? sha256Hex(`${cleanTaskId}:${requestSha256}`) : taskHash;
    cachePath = join(CACHE_ROOT, `${cacheKey}.json`);
    attemptPath = join(CACHE_ROOT, `${cacheKey}.attempt`);

    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      const cachedHash = cached.cache_request_sha256 || cached.request_sha256;
      if (cachedHash !== requestSha256) {
        return {
          ok: false,
          cached: false,
          error: 'task_budget_already_used_for_different_request',
          message:
            '同一 task_id 默认仅允许发送 1 次 POST 请求；若确需发送新问题，请传入新阶段 task_id 或显式设置 allow_multiple: true。',
          task_id: cleanTaskId,
          cached_request_sha256: cachedHash,
          request_sha256: requestSha256,
        };
      }
      return {
        ...cached,
        cached: true,
      };
    }

    // 原子创建 .attempt 锁文件防并发重复计费，失败亦不自动重试
    try {
      const fd = openSync(attemptPath, 'wx');
      closeSync(fd);
    } catch {
      return {
        ok: false,
        cached: false,
        error: 'task_already_attempted_or_in_progress',
        automatic_retry: false,
        task_id: cleanTaskId,
        request_sha256: requestSha256,
      };
    }
  }

  const { key: apiKey, source: keySource } = resolveApiKeyInternal();
  if (!apiKey) {
    return {
      ok: false,
      cached: false,
      error: 'missing_typesafe_api_key',
      message: '未检测到 TYPESAFE_API_KEY（Windows 用户环境变量或当前进程环境均为空）。',
      request_sha256: requestSha256,
    };
  }

  const timeoutMs = Math.min(Math.max(Number(timeoutSec) || 20, 3), 60) * 1000;
  const startedAt = Date.now();
  let result;

  try {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      ...IMAGE_DANGER_HEADER,
    };

    let fetchBody;
    if (loadedImages.length > 0) {
      const form = new FormData();
      // TypeSafe multipart 规范要求第一个 part 必须为名为 request 的 JSON
      form.append('request', new Blob([canonicalPayloadStr], { type: 'application/json' }));
      for (const img of loadedImages) {
        form.append(img.partName, new Blob([img.buffer], { type: 'image/png' }), img.filename);
      }
      fetchBody = form;
    } else {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      fetchBody = canonicalPayloadStr;
    }

    const response = await postJsonOrForm(JEV_ENDPOINT, headers, fetchBody, timeoutMs);

    const elapsedMs = Date.now() - startedAt;
    const rawText = response.text;

    if (!response.ok) {
      result = {
        ok: false,
        cached: false,
        key_source: keySource,
        http_status: response.status,
        error: `typesafe_http_${response.status}`,
        message: `TypeSafe API 返回 HTTP ${response.status}（具体错误细节已脱敏隐藏）`,
        automatic_retry: false,
        elapsed_ms: elapsedMs,
        request_sha256: requestSha256,
        cache_request_sha256: requestSha256,
        recorded_at_utc: new Date().toISOString(),
      };
    } else {
      const parsed = JSON.parse(rawText);
      if (!parsed || typeof parsed !== 'object' || !parsed.answers) {
        throw new Error('TypeSafe 响应体缺少 answers 字段');
      }
      result = {
        ok: true,
        cached: false,
        key_source: keySource,
        model: parsed.model || payload.model,
        answers: parsed.answers,
        interpreted_gates: interpretJevAnswers(parsed.answers, questions),
        usage: parsed.usage || null,
        elapsed_ms: elapsedMs,
        request_sha256: requestSha256,
        cache_request_sha256: requestSha256,
        recorded_at_utc: new Date().toISOString(),
      };
    }
  } catch (err) {
    result = {
      ok: false,
      cached: false,
      key_source: keySource,
      http_status: null,
      error: err?.name || 'RequestError',
      message: String(err?.message || err).slice(0, 300),
      automatic_retry: false,
      elapsed_ms: Date.now() - startedAt,
      request_sha256: requestSha256,
      cache_request_sha256: requestSha256,
      recorded_at_utc: new Date().toISOString(),
    };
  }

  if (cachePath) {
    try {
      writeFileSync(cachePath, JSON.stringify(result), 'utf8');
    } catch {
      // 忽略缓存目录写失败
    }
  }

  return result;
}
