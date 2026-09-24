// 协议客户端：能力声明、超时、取消、重试、协议保护、反向请求、有上限的关闭（验收 B-2 到 B-4、B-6 到 B-8、E-9）。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { LspClient, configurationValue } from "../extensions/pi-lsp/client.ts";
import { FAKE_SERVER, type Script, allDead, readLog, tempDir, waitUntil } from "./fixtures.ts";

function client(script: Script, over: Partial<ConstructorParameters<typeof LspClient>[0]> = {}) {
	const crashes: Error[] = [];
	const diags: unknown[] = [];
	let refreshes = 0;
	const c = new LspClient({
		name: "fake",
		command: process.execPath,
		args: [FAKE_SERVER],
		root: tempDir(),
		env: { ...process.env, FAKE_LSP: JSON.stringify(script) },
		initializationOptions: undefined,
		settings: undefined,
		startupTimeout: 3000,
		requestTimeout: 1000,
		shutdownTimeout: 500,
		pullDiagnostics: true,
		onDiagnostics: (p) => diags.push(p),
		onDiagnosticsRefresh: () => { refreshes++; },
		onCrash: (e) => crashes.push(e),
		...over,
	});
	return { c, crashes, diags, refreshes: () => refreshes };
}

test("B-2 initialize 的能力声明与 Claude Code 一致，另加拉取诊断（D3）与进度（D13）", async () => {
	const log = join(tempDir(), "log");
	const { c } = client({ log });
	await c.start();
	const init = readLog(log).find((e) => e.method === "initialize")?.params as { capabilities: Record<string, any>; processId: number; initializationOptions: unknown };
	const cap = init.capabilities;
	assert.equal(init.processId, process.pid);
	assert.deepEqual(init.initializationOptions, {});
	assert.deepEqual(cap.general, { positionEncodings: ["utf-16"] });
	assert.equal(cap.workspace.configuration, false, "没有 settings 时不声明 configuration");
	assert.equal(cap.workspace.workspaceFolders, false);
	assert.deepEqual(cap.textDocument.synchronization, { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: true });
	assert.equal(cap.textDocument.definition.linkSupport, true);
	assert.equal(cap.textDocument.documentSymbol.hierarchicalDocumentSymbolSupport, true);
	assert.deepEqual(cap.textDocument.publishDiagnostics.tagSupport, { valueSet: [1, 2] });
	assert.ok(cap.textDocument.diagnostic, "D3：声明拉取诊断");
	assert.deepEqual(cap.window, { workDoneProgress: true }, "D13：声明进度，服务器才会发启动阶段的进度");
	await c.stop();
});

test("pullDiagnostics: false 时不声明拉取诊断，只多出 D13 的进度声明", async () => {
	const log = join(tempDir(), "log");
	const { c } = client({ log, diagnostics: "pull" }, { pullDiagnostics: false });
	await c.start();
	const cap = (readLog(log).find((e) => e.method === "initialize")?.params as { capabilities: Record<string, any> }).capabilities;
	assert.equal(cap.textDocument.diagnostic, undefined);
	assert.equal(cap.workspace.diagnostics, undefined);
	assert.equal(c.supportsPullDiagnostics, false, "服务器声明了也不拉取");
	await c.stop();
});

test("B-2 配了 settings 时声明 configuration、推送 didChangeConfiguration，并按点号路径应答 workspace/configuration", async () => {
	const log = join(tempDir(), "log");
	const settings = { python: { pythonPath: "/v/bin/python", analysis: { typeCheckingMode: "strict" } } };
	const { c } = client({ log, serverRequests: [{ method: "workspace/configuration", params: { items: [{ section: "python" }, { section: "python.analysis.typeCheckingMode" }, { section: "missing.key" }, {}] } }] }, { settings });
	await c.start();
	assert.ok(await waitUntil(() => readLog(log).some((e) => e.ev === "response")));
	const ev = readLog(log);
	const init = ev.find((e) => e.method === "initialize")?.params as { capabilities: { workspace: { configuration: boolean } } };
	assert.equal(init.capabilities.workspace.configuration, true);
	assert.deepEqual(ev.find((e) => e.method === "workspace/didChangeConfiguration")?.settings, settings);
	assert.deepEqual(ev.find((e) => e.ev === "response")?.result, [settings.python, "strict", null, settings]);
	await c.stop();
});

test("configurationValue 的取值规则", () => {
	assert.equal(configurationValue(undefined, "a"), null);
	assert.deepEqual(configurationValue({ a: 1 }, ""), { a: 1 });
	assert.equal(configurationValue({ a: { b: 2 } }, "a.b"), 2);
	assert.equal(configurationValue({ a: { b: 2 } }, "a.c"), null);
	assert.equal(configurationValue({ a: 5 }, "a.b"), null);
});

test("B-3 initialize 永不回复时在启动超时内失败，报错为 Claude Code 格式，进程被收掉", async () => {
	const { c } = client({ neverInit: true }, { startupTimeout: 400 });
	const t0 = Date.now();
	await assert.rejects(c.start(), /LSP server 'fake' timed out after 400ms during initialization/);
	assert.ok(Date.now() - t0 < 400 + 5000, "关闭流程有上限");
	assert.equal(c.state, "error");
	assert.equal(c.pid, undefined);
});

test("启动命令不存在时报错，状态为 error", async () => {
	const { c } = client({}, { command: "/definitely/not/here" });
	await assert.rejects(c.start(), /ENOENT/);
	assert.equal(c.state, "error");
});

test("B-4 请求永不回复时在请求超时内返回错误，并发出 $/cancelRequest", async () => {
	const log = join(tempDir(), "log");
	const { c } = client({ log, neverRespond: ["textDocument/hover"] }, { requestTimeout: 300 });
	await c.start();
	await assert.rejects(c.request("textDocument/hover", {}), /LSP request 'textDocument\/hover' failed for server 'fake': request timed out after 300ms/);
	assert.ok(await waitUntil(() => readLog(log).some((e) => e.method === "$/cancelRequest")));
	await c.stop();
});

test("B-4 用户中止时立即返回并发出 $/cancelRequest", async () => {
	const log = join(tempDir(), "log");
	const { c } = client({ log, neverRespond: ["textDocument/hover"] }, { requestTimeout: 10_000 });
	await c.start();
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 100);
	const t0 = Date.now();
	await assert.rejects(c.request("textDocument/hover", {}, ac.signal), /failed for server 'fake'/);
	assert.ok(Date.now() - t0 < 2000);
	assert.ok(await waitUntil(() => readLog(log).some((e) => e.method === "$/cancelRequest")));
	await c.stop();
});

test("B-7 ContentModified 按 500ms、1s、2s 重试，第 4 次仍失败返回错误", async () => {
	const { c } = client({ contentModified: { "a/b": 2, "x/y": 9 } }, { requestTimeout: 3000 });
	await c.start();
	const t0 = Date.now();
	assert.equal(await c.request("a/b", {}), null);
	const took = Date.now() - t0;
	assert.ok(took >= 1400 && took < 2500, `两次重试约 1.5 秒，实际 ${took}ms`);
	const t1 = Date.now();
	await assert.rejects(c.request("x/y", {}), /content modified/);
	assert.ok(Date.now() - t1 >= 3400, "三次重试共约 3.5 秒");
	await c.stop();
});

test("B-8 反向请求 registerCapability、workDoneProgress/create、未知的 refresh 都被正确应答", async () => {
	const log = join(tempDir(), "log");
	const { c } = client({
		log,
		serverRequests: [
			{ method: "client/registerCapability", params: { registrations: [{ id: "1", method: "textDocument/diagnostic" }] } },
			{ method: "window/workDoneProgress/create", params: { token: "t" } },
			{ method: "workspace/semanticTokens/refresh" },
			{ method: "totally/unknown" },
		],
	});
	await c.start();
	assert.ok(await waitUntil(() => readLog(log).filter((e) => e.ev === "response").length === 4));
	const responses = readLog(log).filter((e) => e.ev === "response");
	assert.equal(responses.filter((r) => r.error === undefined).length, 3);
	assert.ok(responses.some((r) => r.error), "未知方法回 MethodNotFound");
	assert.ok(c.supportsPullDiagnostics, "动态注册的拉取诊断被记录");
	await c.stop();
});

test("收到 workspace/diagnostic/refresh 时通知上层重新拉取", async () => {
	const { c, refreshes } = client({ serverRequests: [{ method: "workspace/diagnostic/refresh" }] });
	await c.start();
	assert.ok(await waitUntil(() => refreshes() === 1));
	await c.stop();
});

test("B-6 stdout 混入非协议输出时按崩溃处理并终止进程", async () => {
	const { c, crashes } = client({ garbage: true });
	await c.start();
	const pid = c.pid as number;
	assert.ok(await waitUntil(() => crashes.length === 1));
	assert.match(crashes[0].message, /non-protocol output/);
	assert.ok(await waitUntil(() => allDead([pid]), 5000));
	assert.equal(c.state, "error");
});

test("B-6 消息头超过 64KB 时按崩溃处理", async () => {
	const { c, crashes } = client({ hugeHeader: true });
	await c.start();
	assert.ok(await waitUntil(() => crashes.length === 1));
	assert.match(crashes[0].message, /header exceeds/);
	await c.stop();
});

test("B-6 正文超过 32MB 时按崩溃处理，不等正文读完", async () => {
	const { c, crashes } = client({ hugeBody: true });
	await c.start();
	assert.ok(await waitUntil(() => crashes.length === 1));
	assert.match(crashes[0].message, /body of \d+ bytes exceeds/);
	await c.stop();
});

test("进程意外退出时报告崩溃，文本包含退出码", async () => {
	const { c, crashes } = client({ crashAfterMs: 100 });
	await c.start();
	assert.ok(await waitUntil(() => crashes.length === 1));
	assert.match(crashes[0].message, /LSP server 'fake' exited with code 3/);
	await assert.rejects(c.request("a", {}), /Cannot send request to LSP server 'fake': server is error, last error:/);
});

test("E-9 服务器忽略 shutdown、exit 与 SIGTERM 时，仍在上限内被强杀，连同换了进程组的子进程", async () => {
	const log = join(tempDir(), "log");
	const { c } = client({ log, ignoreShutdown: true, ignoreExit: true, ignoreTerm: true, ignoreEof: true, spawnChild: true }, { shutdownTimeout: 3000 });
	await c.start();
	const pid = c.pid as number;
	assert.ok(await waitUntil(() => readLog(log).some((e) => e.ev === "child")));
	const child = (readLog(log).find((e) => e.ev === "child") as unknown as { pid: number }).pid;
	const t0 = Date.now();
	await c.stop();
	const took = Date.now() - t0;
	assert.ok(took <= 7500, `关闭总时长 ${took}ms 超过 7 秒上限`);
	assert.ok(await waitUntil(() => allDead([pid, child]), 2000), "服务器与子进程都已退出");
	assert.equal(c.state, "stopped");
});

test("正常关闭按 shutdown → exit 的顺序，幂等", async () => {
	const log = join(tempDir(), "log");
	const { c } = client({ log });
	await c.start();
	const pid = c.pid as number;
	await Promise.all([c.stop(), c.stop()]);
	await c.stop();
	const methods = readLog(log).map((e) => e.method).filter(Boolean);
	assert.ok(methods.indexOf("shutdown") < methods.indexOf("exit"));
	assert.ok(allDead([pid]));
});
