// pi 接线里不经过语言服务器的部分：诊断消息的界面渲染。

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piLsp from "../extensions/pi-lsp/index.ts";

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
