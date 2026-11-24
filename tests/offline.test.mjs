import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(TESTS_DIR, '..');
const MCP_SERVER_PATH = join(PLUGIN_ROOT, 'server', 'mcp-server.mjs');
const JEV_CLIENT_URL = pathToFileURL(join(PLUGIN_ROOT, 'server', 'jev-client.mjs')).href;

const { interpretJevAnswers } = await import(JEV_CLIENT_URL);

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
  const tempDir = mkdtempSync(join(tmpdir(), 'gemini-codex-jev-offline-'));
  const validPng = join(tempDir, 'valid-300.png');
  const smallPng = join(tempDir, 'small-100.png');
  writeFileSync(validPng, createSolidPng(300, 300));
  writeFileSync(smallPng, createSolidPng(100, 100));

  try {
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

    await runModeChecks('line', validPng, smallPng);
    console.log('[PASS] line-delimited JSON framing checks');
    await runModeChecks('lsp', validPng, smallPng);
    console.log('[PASS] LSP Content-Length framing checks');
    console.log('ALL OFFLINE CHECKS PASSED (0 network calls, 0 API spend)');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
