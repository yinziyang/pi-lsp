// lsp 工具与安装计划（验收 B-9 的完整链路、B-10、B-11，G-2、G-3 的判定逻辑）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { LspSettings, ServerConfig } from "../extensions/pi-lsp/config.ts";
import { DiagnosticsHub } from "../extensions/pi-lsp/diagnostics.ts";
import { installHint, installPlan, runInstall, type Exec } from "../extensions/pi-lsp/install.ts";
import { ServerManager } from "../extensions/pi-lsp/manager.ts";
import { Router } from "../extensions/pi-lsp/routing.ts";
import { TOOL_DESCRIPTION, createLspTool, runLsp, type ToolRuntime } from "../extensions/pi-lsp/tool.ts";
import { fakeServer, readLog, tempDir, writeFile } from "./fixtures.ts";

function runtime(servers: ServerConfig[], cwd = tempDir(), onMissing?: ToolRuntime["onMissing"]): ToolRuntime & { manager: ServerManager } {
	const settings: LspSettings = { servers, idleTimeoutMs: 60_000, autoInstall: false, diagnostics: true };
	const router = new Router(servers, { cwd, toolDirs: [], env: process.env });
	const manager = new ServerManager({ router, settings, hub: new DiagnosticsHub(cwd) });
	return { manager, cwd, onMissing: onMissing ?? (async () => ({ installed: false, note: "" })) };
}

const range = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 3 } });

test("B-9 链路：参数 1 基转 0 基，结果按 Claude Code 格式输出", async () => {
	const cwd = tempDir();
	const log = join(tempDir(), "log");
	const file = writeFile(cwd, "a.fake", "x");
	const rt = runtime([fakeServer("fake", { log, responses: { "textDocument/definition": { uri: `file://${join(cwd, "b.fake")}`, range: range(4) } } })], cwd);
	const out = await runLsp(rt, { operation: "goToDefinition", filePath: "a.fake", line: 3, character: 7 });
	assert.equal(out, "Defined in b.fake:5:1");
	const req = readLog(log).find((e) => e.method === "textDocument/definition")?.params as { position: unknown; textDocument: { uri: string } };
	assert.deepEqual(req.position, { line: 2, character: 6 });
	assert.equal(req.textDocument.uri, `file://${file}`);
	assert.ok(readLog(log).some((e) => e.method === "textDocument/didOpen"), "查询前先打开文件");
	await rt.manager.shutdownAll();
});

test("B-9 findReferences 带 includeDeclaration；workspaceSymbol 传 query", async () => {
	const cwd = tempDir();
	const log = join(tempDir(), "log");
	writeFile(cwd, "a.fake", "x");
	const rt = runtime([fakeServer("fake", { log })], cwd);
	await runLsp(rt, { operation: "findReferences", filePath: "a.fake", line: 1, character: 1 });
	await runLsp(rt, { operation: "workspaceSymbol", filePath: "a.fake", line: 1, character: 1, query: "Foo" });
	const ev = readLog(log);
	assert.deepEqual((ev.find((e) => e.method === "textDocument/references")?.params as { context: unknown }).context, { includeDeclaration: true });
	assert.deepEqual(ev.find((e) => e.method === "workspace/symbol")?.params, { query: "Foo" });
	await rt.manager.shutdownAll();
});

test("B-9 incomingCalls 先 prepare 再用第一项查询；prepare 为空时返回提示", async () => {
	const cwd = tempDir();
	const log = join(tempDir(), "log");
	writeFile(cwd, "a.fake", "x");
	const item = { name: "f", kind: 12, uri: `file://${join(cwd, "a.fake")}`, range: range(0), selectionRange: range(0) };
	const caller = { name: "main", kind: 12, uri: `file://${join(cwd, "m.fake")}`, range: range(9), selectionRange: range(9) };
	const rt = runtime([fakeServer("fake", { log, responses: { "textDocument/prepareCallHierarchy": [item, { ...item, name: "g" }], "callHierarchy/incomingCalls": [{ from: caller, fromRanges: [range(10)] }] } })], cwd);
	assert.equal(await runLsp(rt, { operation: "incomingCalls", filePath: "a.fake", line: 1, character: 1 }), "Found 1 incoming call:\n\nm.fake:\n  main (Function) - Line 10 [calls at: 11:1]");
	assert.deepEqual((readLog(log).find((e) => e.method === "callHierarchy/incomingCalls")?.params as { item: { name: string } }).item.name, "f");
	await rt.manager.shutdownAll();
	const empty = runtime([fakeServer("fake", {})], cwd);
	assert.equal(await runLsp(empty, { operation: "outgoingCalls", filePath: "a.fake", line: 1, character: 1 }), "No call hierarchy item found at this position");
	await empty.manager.shutdownAll();
});

test("B-9 定义与引用的结果过滤掉被 gitignore 的路径", async () => {
	const cwd = tempDir();
	execFileSync("git", ["init", "-q"], { cwd });
	writeFileSync(join(cwd, ".gitignore"), "gen/\n");
	mkdirSync(join(cwd, "gen"));
	writeFile(cwd, "a.fake", "x");
	const refs = [{ uri: `file://${join(cwd, "a.fake")}`, range: range(0) }, { uri: `file://${join(cwd, "gen", "z.fake")}`, range: range(1) }];
	const rt = runtime([fakeServer("fake", { responses: { "textDocument/references": refs } })], cwd);
	assert.equal(await runLsp(rt, { operation: "findReferences", filePath: "a.fake", line: 1, character: 1 }), "Found 1 reference:\n  a.fake:1:1");
	await rt.manager.shutdownAll();
});

test("B-10 报错文本：参数不合法、文件不存在、不是普通文件时抛错；没有服务器时返回 Claude Code 同款文本", async () => {
	const cwd = tempDir();
	mkdirSync(join(cwd, "dir.fake"));
	writeFile(cwd, "a.txt", "x");
	const rt = runtime([fakeServer("fake", {})], cwd);
	await assert.rejects(runLsp(rt, { operation: "hover", filePath: "missing.fake", line: 1, character: 1 }), /^Error: File does not exist: missing\.fake$/);
	await assert.rejects(runLsp(rt, { operation: "hover", filePath: "dir.fake", line: 1, character: 1 }), /^Error: Path is not a file: dir\.fake$/);
	await assert.rejects(runLsp(rt, { operation: "hover", filePath: "a.txt", line: 0, character: 1 }), /Invalid input: line must be a positive integer/);
	assert.equal(await runLsp(rt, { operation: "hover", filePath: "a.txt", line: 1, character: 1 }), "No LSP server available for file type: .txt");
	await rt.manager.shutdownAll();
});

test("B-10 服务器报错时作为普通结果返回 Error performing …", async () => {
	const cwd = tempDir();
	writeFile(cwd, "a.fake", "x");
	const rt = runtime([fakeServer("fake", { neverRespond: ["textDocument/hover"] }, { requestTimeout: 300 })], cwd);
	assert.equal(await runLsp(rt, { operation: "hover", filePath: "a.fake", line: 1, character: 1 }), "Error performing hover: LSP request 'textDocument/hover' failed for server 'fake': request timed out after 300ms");
	await rt.manager.shutdownAll();
});

test("B-10 超过 10MB 的文件不交给服务器", async () => {
	const cwd = tempDir();
	writeFile(cwd, "big.fake", "x".repeat(10_000_001));
	const rt = runtime([fakeServer("fake", {})], cwd);
	assert.equal(await runLsp(rt, { operation: "documentSymbol", filePath: "big.fake", line: 1, character: 1 }), "File too large for LSP analysis (11MB exceeds 10MB limit)");
	await rt.manager.shutdownAll();
});

test("服务器没装时：返回 Claude Code 同款文本并附上安装说明", async () => {
	const cwd = tempDir();
	writeFile(cwd, "a.fake", "x");
	const missing = { ...fakeServer("fake", {}), command: "/nonexistent/fake-lsp" };
	const rt = runtime([missing], cwd, async () => ({ installed: false, note: "Run /lsp install fake." }));
	assert.equal(await runLsp(rt, { operation: "hover", filePath: "a.fake", line: 1, character: 1 }), "No LSP server available for file type: .fake\n\nRun /lsp install fake.");
});

test("B-11 工具的参数定义与 Claude Code 一致，说明是原文加 V4 的一句", () => {
	const tool = createLspTool(() => undefined);
	assert.equal(tool.name, "lsp");
	const schema = tool.parameters as unknown as { properties: Record<string, { type?: string; enum?: string[]; exclusiveMinimum?: number }>; required: string[] };
	assert.deepEqual(Object.keys(schema.properties), ["operation", "filePath", "line", "character", "query"]);
	assert.deepEqual(schema.required.sort(), ["character", "filePath", "line", "operation"]);
	assert.deepEqual(schema.properties.operation.enum, ["goToDefinition", "findReferences", "hover", "documentSymbol", "workspaceSymbol", "goToImplementation", "prepareCallHierarchy", "incomingCalls", "outgoingCalls"]);
	assert.equal(schema.properties.operation.type, "string", "用 string enum，不用 anyOf");
	assert.equal(schema.properties.line.exclusiveMinimum, 0);
	assert.ok(TOOL_DESCRIPTION.startsWith("Interact with Language Server Protocol (LSP) servers to get code intelligence features."));
	assert.ok(TOOL_DESCRIPTION.includes("Note: LSP servers must be configured for the file type. If no server is available, an error will be returned."));
	assert.ok(TOOL_DESCRIPTION.endsWith("Prefer this tool over grep when looking up where a symbol is defined, its references, its implementations, or its callers."));
});

test("G-3 安装计划：npm 类装进本扩展目录；缺 go、缺 rustup 时说清楚缺什么；clangd 只给说明", () => {
	const ctx = (have: string[]) => ({ lspDir: "/L", platform: "darwin" as NodeJS.Platform, resolve: (c: string) => (have.includes(c) ? `/bin/${c}` : undefined) });
	const ts = installPlan("typescript", ctx(["npm"]));
	assert.ok(!("error" in ts));
	assert.deepEqual((ts as { steps: { args: string[] }[] }).steps[0].args.slice(0, 3), ["install", "--prefix", "/L/node"]);
	assert.equal((installPlan("go", ctx(["go"])) as { steps: { env: Record<string, string> }[] }).steps[0].env.GOBIN, "/L/bin");
	assert.match((installPlan("go", ctx([])) as { error: string }).error, /needs the Go toolchain/);
	assert.match((installPlan("rust", ctx([])) as { error: string }).error, /needs rustup/);
	assert.match((installPlan("cpp", ctx(["npm"])) as { error: string }).error, /xcode-select --install/);
	assert.match((installPlan("cobol", ctx([])) as { error: string }).error, /Unknown language/);
	assert.match(installHint("gopls", ctx(["go"])), /Run \/lsp install go/);
});

test("G-2 安装执行：按步骤执行，失败即停并带上输出", async () => {
	const calls: string[][] = [];
	const exec: Exec = async (cmd, args) => {
		calls.push([cmd, ...args]);
		return { code: calls.length === 1 ? 0 : 1, stdout: "out", stderr: "boom" };
	};
	const plan = { server: "x", label: "x", steps: [{ command: "a", args: ["1"] }, { command: "b", args: ["2"] }, { command: "c", args: [] }] };
	const r = await runInstall(plan, exec, {});
	assert.equal(r.ok, false);
	assert.equal(calls.length, 2, "第二步失败后不再执行第三步");
	assert.match(r.output, /boom/);
});
