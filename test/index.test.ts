// pi 接线里不经过语言服务器的部分：诊断消息的界面渲染、状态栏。

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piLsp, { statusBarText } from "../extensions/pi-lsp/index.ts";

type Render = (message: { content: string; details?: unknown }, opts: { expanded: boolean; outputPad: number }, theme: unknown) => { render(width: number): string[] };

/** 用只记录注册调用的假 pi 装载扩展，取出诊断消息的渲染函数。 */
function renderer(): Render {
	let found: Render | undefined;
	const noop = () => {};
	const pi = { on: noop, registerCommand: noop, registerTool: noop, sendMessage: noop, registerMessageRenderer: (_type: string, r: Render) => (found = r) };
	piLsp(pi as unknown as ExtensionAPI);
	assert.ok(found, "扩展没有注册诊断消息的渲染");
	return found;
}

const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t };
const CONTENT = "<new-diagnostics>The following new diagnostic issues were detected:\n\nmain.go:\n  ✘ [Line 4:14] boom [E1] (compiler)\n</new-diagnostics>";

test("C-12 诊断消息折叠显示为 Found N new diagnostic issues in M files，展开后是完整内容", () => {
	const render = renderer();
	const msg = { content: CONTENT, details: { files: 2, issues: 3 } };
	const collapsed = render(msg, { expanded: false, outputPad: 0 }, theme).render(200).join("\n");
	assert.match(collapsed, /Found 3 new diagnostic issues in 2 files/);
	assert.doesNotMatch(collapsed, /boom/);
	const expanded = render(msg, { expanded: true, outputPad: 0 }, theme).render(200).join("\n");
	assert.match(expanded, /Found 3 new diagnostic issues in 2 files/);
	assert.match(expanded, /\[Line 4:14\] boom \[E1\] \(compiler\)/);
});

test("C-12 只有「已消失」时折叠文案说明已解决，单数不加 s", () => {
	const collapsed = renderer()({ content: "<new-diagnostics>…</new-diagnostics>", details: { files: 1, issues: 0 } }, { expanded: false, outputPad: 0 }, theme).render(200).join("\n");
	assert.match(collapsed, /Diagnostics resolved in 1 file\b/);
});

/** 只有 server.name 与 client.state 的假实例，够 statusBarText 用。 */
const manager = (...insts: [string, string][]) => ({ all: insts.map(([name, state]) => ({ server: { name }, client: { state } })) }) as unknown as Parameters<typeof statusBarText>[0]["manager"];

test("状态栏文本：空闲、各状态、同一服务器多个实例、安装中", () => {
	assert.equal(statusBarText({ manager: manager() }), "LSP idle");
	assert.equal(statusBarText({ manager: manager(["gopls", "stopped"], ["pyright", "stopping"]) }), "LSP idle", "已关闭与关闭中的不显示");
	assert.equal(statusBarText({ manager: manager(["gopls", "running"], ["pyright", "starting"], ["rust-analyzer", "error"]) }), "LSP gopls ✓ · pyright … · rust-analyzer ✗");
	assert.equal(statusBarText({ manager: manager(["gopls", "running"], ["gopls", "running"]) }), "LSP gopls ✓×2");
	assert.equal(statusBarText({ manager: manager(["gopls", "running"], ["gopls", "error"]) }), "LSP gopls ✗×2", "有一个出错就显示出错");
	assert.equal(statusBarText({ manager: manager(["gopls", "running"]), installing: "pyright" }), "LSP installing pyright…");
	assert.doesNotMatch(statusBarText({ manager: manager(["gopls", "running"]) }), /\x1b/, "不传 paint 时是纯文本");
});

test("状态栏颜色：运行中绿色、启动中黄色、出错红色，其余文字 dim，每一段都显式上色", () => {
	const paint = (c: string, t: string) => `<${c}>${t}</>`;
	assert.equal(statusBarText({ manager: manager(["gopls", "running"], ["pyright", "starting"], ["clangd", "error"]) }, paint), "<dim>LSP </><success>gopls ✓</><dim> · </><warning>pyright …</><dim> · </><error>clangd ✗</>");
	assert.equal(statusBarText({ manager: manager() }, paint), "<dim>LSP idle</>");
	assert.equal(statusBarText({ manager: manager(), installing: "pyright" }, paint), "<warning>LSP installing pyright…</>");
});

type Handler = (event: unknown, ctx: unknown) => unknown;

/** 装载扩展并返回事件处理函数；agent 目录指到临时目录，避免清理真实的进程记录。 */
function load(): Map<string, Handler> {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-lsp-index-"));
	const handlers = new Map<string, Handler>();
	const noop = () => {};
	const pi = { on: (name: string, h: Handler) => handlers.set(name, h), registerCommand: noop, registerTool: noop, sendMessage: noop, registerMessageRenderer: noop };
	piLsp(pi as unknown as ExtensionAPI);
	return handlers;
}

function ctx(hasUI: boolean, statuses: [string, string | undefined][]) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-lsp-index-cwd-"));
	return { cwd, hasUI, isProjectTrusted: () => false, ui: { notify: () => {}, setStatus: (k: string, t: string | undefined) => statuses.push([k, t]) } };
}

test("状态栏接线：交互模式会话开始显示 LSP idle，会话结束清掉；非交互模式不写", async () => {
	// 本机至少有 /usr/bin/clangd 或其他服务器，lsp 工具会注册；没有任何服务器的机器上这条前提不成立。
	const h = load();
	const shown: [string, string | undefined][] = [];
	await h.get("session_start")!({}, ctx(true, shown));
	assert.deepEqual(shown, [["zz-pi-lsp", "LSP idle"]], "假 ctx 没有主题时写纯文本");
	await h.get("session_shutdown")!({}, {});
	assert.deepEqual(shown.at(-1), ["zz-pi-lsp", undefined]);

	const quiet: [string, string | undefined][] = [];
	const h2 = load();
	await h2.get("session_start")!({}, ctx(false, quiet));
	await h2.get("session_shutdown")!({}, {});
	assert.equal(quiet.length, 0);
});
