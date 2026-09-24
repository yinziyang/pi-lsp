// LSP 服务器行为探针：不依赖任何库，按 Claude Code 的 initialize 能力声明拉起服务器，记录它的能力、反向请求、诊断到达时间与退出条件。
// 用法：node probe.mjs <模式 normal|eof|parent> <root> <file> <languageId> <command> [args...]
// 每一步都有超时上界，探针自身最多运行 PROBE_MAX_MS 毫秒。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [mode, root, file, languageId, cmd, ...args] = process.argv.slice(2);
const PROBE_MAX_MS = 90_000;
const t0 = Date.now();
const out = { mode, cmd, serverRequests: [], diagnostics: null, firstDiagMs: null, exit: null };
const log = () => { process.stdout.write(JSON.stringify(out) + '\n'); };
setTimeout(() => { out.note = 'probe timeout'; log(); process.exit(0); }, PROBE_MAX_MS).unref();

// parent 模式：先起一个替身父进程，把它的 pid 作为 processId 交给服务器。
const fakeParent = mode === 'parent' ? spawn('sleep', ['600'], { stdio: 'ignore' }) : null;
const child = spawn(cmd, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', () => {});
child.on('exit', (code, sig) => { out.exit = { code, sig, atMs: Date.now() - t0 }; if (mode !== 'normal') { log(); process.exit(0); } });
child.on('error', (e) => { out.note = `spawn error ${e.message}`; log(); process.exit(0); });

let buf = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();
function send(msg) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }));
  child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}
function request(method, params, timeoutMs = 60_000) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timeout`)); }, timeoutMs).unref();
  });
}
child.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const m = /Content-Length: (\d+)/i.exec(buf.slice(0, sep).toString());
    if (!m) { out.note = 'bad header'; return; }
    const len = Number(m[1]);
    if (buf.length < sep + 4 + len) return;
    const msg = JSON.parse(buf.slice(sep + 4, sep + 4 + len).toString());
    buf = buf.slice(sep + 4 + len);
    onMessage(msg);
  }
});

const uri = pathToFileURL(file).href;
function onMessage(msg) {
  if (msg.id !== undefined && msg.method === undefined) { const r = pending.get(msg.id); if (r) { pending.delete(msg.id); r(msg); } return; }
  if (msg.id !== undefined && msg.method) {
    // 服务器发来的反向请求：记录方法名；workspace/configuration 按条目数回 null，其余回空结果。
    out.serverRequests.push(msg.method);
    const result = msg.method === 'workspace/configuration' ? (msg.params.items || []).map(() => null) : null;
    send({ id: msg.id, result });
    return;
  }
  if (msg.method === 'textDocument/publishDiagnostics' && msg.params.uri === uri && msg.params.diagnostics.length && out.firstDiagMs === null) {
    out.firstDiagMs = Date.now() - t0;
    out.diagnostics = msg.params.diagnostics.slice(0, 3).map((x) => `${x.severity}:${x.message.slice(0, 80)}`);
  }
}

const initRes = await request('initialize', {
  processId: fakeParent ? fakeParent.pid : process.pid,
  clientInfo: { name: 'probe' },
  rootUri: pathToFileURL(root).href,
  rootPath: root,
  workspaceFolders: [{ uri: pathToFileURL(root).href, name: 'root' }],
  capabilities: {
    workspace: { configuration: false, workspaceFolders: false },
    textDocument: {
      synchronization: { didSave: true, willSave: false },
      publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] }, codeDescriptionSupport: true },
      hover: { contentFormat: ['markdown', 'plaintext'] },
      definition: { linkSupport: true },
      documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      callHierarchy: {},
    },
    general: { positionEncodings: ['utf-16'] },
  },
}).catch((e) => ({ error: e.message }));
if (initRes.error) { out.note = `initialize failed: ${JSON.stringify(initRes.error).slice(0, 200)}`; log(); child.kill('SIGKILL'); process.exit(0); }
const caps = initRes.result.capabilities || {};
out.initMs = Date.now() - t0;
out.pullDiagnostics = Boolean(caps.diagnosticProvider);
out.positionEncoding = caps.positionEncoding || 'utf-16(默认)';
out.sync = typeof caps.textDocumentSync === 'object' ? caps.textDocumentSync.change : caps.textDocumentSync;
out.callHierarchy = Boolean(caps.callHierarchyProvider);
out.implementation = Boolean(caps.implementationProvider);
send({ method: 'initialized', params: {} });
send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId, version: 1, text: readFileSync(file, 'utf8') } } });
send({ method: 'textDocument/didSave', params: { textDocument: { uri } } });

if (mode === 'normal') {
  // 最多等 45 秒诊断，再按 shutdown → exit 收尾。
  const deadline = Date.now() + 45_000;
  while (out.firstDiagMs === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  if (out.firstDiagMs === null && out.pullDiagnostics) {
    const r = await request('textDocument/diagnostic', { textDocument: { uri } }, 20_000).catch((e) => ({ error: e.message }));
    const items = r.result && r.result.items;
    out.pulled = items ? items.slice(0, 3).map((x) => `${x.severity}:${x.message.slice(0, 80)}`) : r.error || r;
  }
  await new Promise((r) => setTimeout(r, 1500));
  const s0 = Date.now();
  await request('shutdown', null, 10_000).catch(() => {});
  send({ method: 'exit' });
  const d = Date.now() + 10_000;
  while (!out.exit && Date.now() < d) await new Promise((r) => setTimeout(r, 100));
  out.shutdownMs = Date.now() - s0;
  if (!out.exit) { out.note = 'did not exit after shutdown/exit'; child.kill('SIGKILL'); }
  log();
  process.exit(0);
}

// 等服务器进入稳定状态后，制造退出条件，再看 20 秒内它会不会自己退出。
await new Promise((r) => setTimeout(r, 3000));
const k0 = Date.now();
if (mode === 'eof') child.stdin.end();
if (mode === 'parent') fakeParent.kill('SIGKILL');
setTimeout(() => { out.exit = out.exit || { survived: true, waitedMs: Date.now() - k0 }; log(); child.kill('SIGKILL'); process.exit(0); }, 20_000).unref();
