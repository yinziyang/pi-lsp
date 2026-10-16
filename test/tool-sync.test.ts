// 在扩展事件边界验证自动同步，使用真实文件和协议服务器观察结果，不替换内部 manager。

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createWriteTool, type ExtensionAPI, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import piLsp from "../extensions/pi-lsp/index.ts";
import { FAKE_SERVER, readLog, tempDir, waitUntil } from "./fixtures.ts";
import { MAX_FILE_BYTES } from "../extensions/pi-lsp/documents.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** 每个测试隔离设置和协议日志，结束时关闭服务器并恢复环境。 */
async function setup(t: TestContext) {
	const dir = tempDir("pi-lsp-tool-sync-");
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir);
	const log = join(dir, "server.jsonl");
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ lsp: { servers: {
		clangd: { enabled: false }, gopls: { enabled: false }, "rust-analyzer": { enabled: false },
		typescript: { enabled: false }, pyright: { enabled: false }, css: { enabled: false }, html: { enabled: false },
		fake: { command: process.execPath, args: [FAKE_SERVER], extensionToLanguage: { ".ts": "typescript" }, env: { FAKE_LSP: JSON.stringify({ log, diagnostics: "push" }) }, shutdownTimeout: 1000 },
	} } }));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const handlers = new Map<string, Handler>();
	const messages: { content: unknown }[] = [];
	const beforeExit = new Set(process.listeners("exit"));
	const noop = () => {};
	piLsp({ on: (name: string, h: Handler) => handlers.set(name, h), registerCommand: noop, registerTool: noop, registerMessageRenderer: noop, sendMessage: (m: { content: unknown }) => messages.push(m) } as unknown as ExtensionAPI);
	const exitListeners = process.listeners("exit").filter((h) => !beforeExit.has(h));
	const ctx = { cwd: dir, hasUI: false, isProjectTrusted: () => false, signal: new AbortController().signal };
	t.after(async () => {
		try {
			await handlers.get("session_shutdown")?.({}, ctx);
		} finally {
			for (const listener of exitListeners) process.removeListener("exit", listener);
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	});
	await handlers.get("session_start")!({}, ctx);
	return { dir, log, messages, handlers, ctx };
}

/** 按宿主的累计结果契约执行写后处理器，保留先前处理器的错误和内容。 */
async function toolResult(h: Awaited<ReturnType<typeof setup>>, event: ToolResultEvent, standardsFirst: boolean) {
	const standards: Handler = (raw) => {
		const current = raw as ToolResultEvent;
		return { isError: true, content: [...current.content, { type: "text", text: "规范检查失败：必须返修。" }] };
	};
	const lsp = h.handlers.get("tool_result")!;
	let current = event;
	for (const handler of standardsFirst ? [standards, lsp] : [lsp, standards]) {
		const patch = await handler(current, h.ctx) as Partial<ToolResultEvent> | undefined;
		if (patch) current = { ...current, ...patch };
	}
	return current;
}

/** 生成与宿主工具结果结构一致的成功事件，写后错误由链式处理器追加。 */
function event(id: string, input: { path: string; content?: string }, toolName: "write" | "edit" = "write"): ToolResultEvent {
	return { type: "tool_result", toolCallId: id, toolName, input, content: [{ type: "text", text: "写入成功。" }], details: undefined, isError: false };
}

/** 通过写前事件捕获磁盘状态，不把工具参数当作执行成功的证明。 */
async function before(h: Awaited<ReturnType<typeof setup>>, e: ToolResultEvent) {
	await h.handlers.get("tool_call")?.({ ...e, type: "tool_call" }, h.ctx);
}

test("成功落盘被写后检查标错后仍同步，且保留规范错误", async (t) => {
	const h = await setup(t);
	const input = { path: "probe.ts", content: "const value = 'ERROR';\n" };
	const e = event("first", input);
	await before(h, e);
	writeFileSync(join(h.dir, input.path), input.content);
	const result = await toolResult(h, e, true);
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /规范检查失败/);
	assert.equal(readFileSync(join(h.dir, input.path), "utf8"), input.content);
	assert.ok(await waitUntil(() => readLog(h.log).some((e) => e.method === "textDocument/didOpen")), "落盘成功后不能因后续检查失败漏掉 didOpen");
	assert.match(JSON.stringify(h.messages), /error on line 1/);
});

test("LSP 先执行也保留规范错误，后续等长 edit 不因元数据相同而漏同步", async (t) => {
	const h = await setup(t);
	const path = join(h.dir, "probe.ts");
	const first = event("first", { path });
	await before(h, first);
	writeFileSync(path, "ERROR one\n");
	const result = await toolResult(h, first, false);
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /规范检查失败/);
	const st = statSync(path);
	const second = event("second", { path }, "edit");
	await before(h, second);
	writeFileSync(path, "ERROR two\n");
	utimesSync(path, st.atime, st.mtime);
	await toolResult(h, second, true);
	assert.ok(await waitUntil(() => readLog(h.log).some((e) => e.method === "textDocument/didChange")));
	assert.equal(readLog(h.log).filter((e) => e.method === "textDocument/didOpen").length, 1);
});

for (const scenario of ["未变化", "真实失败", "缺失", "删除", "目录", "超限", "不可读", "缺少写前快照", "门禁阻断后清理"] as const) {
	test(`${scenario}不启动语言服务器`, async (t) => {
		const h = await setup(t);
		const path = join(h.dir, "probe.ts");
		const e = event("attempt", { path });
		if (scenario !== "缺失") writeFileSync(path, "ERROR old\n");
		if (scenario === "不可读") {
			if (process.getuid?.() === 0) return t.skip("root 无法可靠构造读权限失败");
			chmodSync(path, 0);
		}
		if (scenario !== "缺少写前快照") await before(h, e);
		if (scenario === "真实失败") {
			if (process.getuid?.() === 0) return t.skip("root 无法可靠构造写权限失败");
			chmodSync(path, 0o400);
			await assert.rejects(createWriteTool(h.dir).execute(e.toolCallId, { path, content: "ERROR new\n" }, h.ctx.signal), /EACCES|permission/i);
			assert.equal(readFileSync(path, "utf8"), "ERROR old\n");
		}
		if (scenario === "删除" || scenario === "目录") unlinkSync(path);
		if (scenario === "目录") mkdirSync(path);
		if (scenario === "超限") truncateSync(path, MAX_FILE_BYTES + 1);
		if (scenario === "未变化") writeFileSync(path, "ERROR old\n");
		if (scenario === "真实失败" || scenario === "缺失") e.isError = true;
		if (scenario === "门禁阻断后清理") await h.handlers.get("agent_end")!({}, h.ctx);
		if (scenario === "门禁阻断后清理" || scenario === "缺少写前快照") writeFileSync(path, "ERROR new\n");
		await toolResult(h, e, true);
		assert.deepEqual(readLog(h.log), []);
		assert.deepEqual(h.messages, []);
	});
}

test("同轮并行文件的快照按调用标识隔离，结果乱序也能各自同步", async (t) => {
	const h = await setup(t);
	const a = event("a", { path: join(h.dir, "a.ts") });
	const b = event("b", { path: join(h.dir, "b.ts") });
	await Promise.all([before(h, a), before(h, b)]);
	writeFileSync(a.input.path as string, "ERROR a\n");
	writeFileSync(b.input.path as string, "ERROR b\n");
	await toolResult(h, b, true);
	await toolResult(h, a, true);
	assert.ok(await waitUntil(() => readLog(h.log).filter((e) => e.method === "textDocument/didOpen").length === 2));
});
