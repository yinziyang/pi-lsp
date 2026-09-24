// 诊断中心与文档同步（验收 C-1、C-2、C-5 到 C-10）。

import assert from "node:assert/strict";
import { test } from "node:test";
import { DiagnosticsHub, MAX_CHARS } from "../extensions/pi-lsp/diagnostics.ts";
import { DocumentSet, MAX_OPEN_DOCUMENTS } from "../extensions/pi-lsp/documents.ts";
import { tempDir, writeFile } from "./fixtures.ts";

const cwd = "/w/p";
const uri = (name: string) => `file:///w/p/${name}`;
const d = (line: number, message: string, severity: 1 | 2 | 3 | 4 = 1, extra: Record<string, unknown> = {}) => ({ range: { start: { line, character: 2 }, end: { line, character: 3 } }, message, severity, ...extra });
const HEAD = "<new-diagnostics>The following new diagnostic issues were detected:\n\n";

test("C-7 渲染：Claude Code 的格式，路径为相对路径（V1），code 与 source 按原样附加", () => {
	const hub = new DiagnosticsHub(cwd);
	hub.receive(uri("src/a.go"), "push", [d(4, "undefined: x", 1, { code: "UndeclaredName", source: "compiler" }), d(9, "unused", 2)]);
	const out = hub.take();
	assert.equal(out?.text, `${HEAD}src/a.go:\n  ✘ [Line 5:3] undefined: x [UndeclaredName] (compiler)\n  ⚠ [Line 10:3] unused</new-diagnostics>`);
	assert.equal(out?.issueCount, 2);
	assert.equal(hub.take(), undefined, "取出后清空");
});

test("C-5 去重：同一条只送一次；编辑过的文件重新全量上报", () => {
	const hub = new DiagnosticsHub(cwd);
	hub.receive(uri("a.go"), "push", [d(1, "e1")]);
	assert.ok(hub.take());
	hub.receive(uri("a.go"), "push", [d(1, "e1")]);
	assert.equal(hub.take(), undefined, "已送达的不再送");
	hub.receive(uri("a.go"), "push", [d(1, "e1"), d(2, "e2")]);
	assert.match(hub.take()?.text ?? "", /e2/);
	hub.markEdited("/w/p/a.go");
	hub.receive(uri("a.go"), "push", [d(1, "e1"), d(2, "e2")]);
	const again = hub.take()?.text ?? "";
	assert.match(again, /e1/);
	assert.match(again, /e2/);
});

test("C-6 限量与排序：每个文件 10 条、总共 30 条，按 Error、Warning、Info 排序，Hint 不出现（V2）", () => {
	const hub = new DiagnosticsHub(cwd);
	const many = Array.from({ length: 14 }, (_, i) => d(i, `m${i}`, ((i % 4) + 1) as 1 | 2 | 3 | 4));
	for (const f of ["a", "b", "c", "d"]) hub.receive(uri(`${f}.ts`), "push", many);
	const text = hub.take()?.text ?? "";
	const lines = text.split("\n").filter((l) => l.startsWith("  "));
	assert.equal(lines.length, 30);
	assert.ok(!text.includes("★"), "Hint 不送");
	const first = text.split("\n\n")[1].split("\n").slice(1);
	const order = first.map((l) => l.trim()[0]);
	assert.deepEqual([...order].sort((x, y) => "✘⚠ℹ".indexOf(x) - "✘⚠ℹ".indexOf(y)), order, "文件内按严重级别排序");
	assert.equal(first.length, 10);
	const rest = hub.take()?.text ?? "";
	assert.ok(rest.length > 0, "被截掉的之后还会再报");
});

test("C-7 超过 4000 字符截断", () => {
	const hub = new DiagnosticsHub(cwd);
	hub.receive(uri("a.ts"), "push", Array.from({ length: 10 }, (_, i) => d(i, `${"x".repeat(600)}${i}`)));
	const text = hub.take()?.text ?? "";
	const body = text.slice(HEAD.length, -"</new-diagnostics>".length);
	assert.equal(body.length, MAX_CHARS);
	assert.ok(body.endsWith("…[truncated]"));
});

test("C-8 之前报过诊断的文件编辑后变为零，送出一次「已消失」；从没报过的不送", () => {
	const hub = new DiagnosticsHub(cwd);
	hub.receive(uri("a.go"), "push", [d(1, "boom")]);
	assert.ok(hub.take());
	hub.markEdited("/w/p/a.go");
	hub.receive(uri("a.go"), "push", []);
	assert.equal(hub.take()?.text, `${HEAD}a.go: all previously reported issues are resolved</new-diagnostics>`);
	hub.receive(uri("a.go"), "push", []);
	assert.equal(hub.take(), undefined, "只报一次");
	hub.receive(uri("clean.go"), "push", []);
	assert.equal(hub.take(), undefined, "从没报过诊断的文件不送");
});

test("C-8 推送与拉取两路：编辑前的旧结果不再送；每一路都重新报了空才算已消失", () => {
	const hub = new DiagnosticsHub(cwd);
	hub.receive(uri("lib.rs"), "pull", [d(0, "type error")]);
	hub.receive(uri("lib.rs"), "push", [d(3, "cargo check error")]);
	assert.ok(hub.take());
	hub.markEdited("/w/p/lib.rs");
	hub.receive(uri("lib.rs"), "pull", []);
	assert.equal(hub.take(), undefined, "推送那一路还没重新上报：旧的 cargo check 错误不再送，也不下「已消失」的结论");
	hub.receive(uri("lib.rs"), "push", []);
	assert.match(hub.take()?.text ?? "", /lib\.rs: all previously reported issues are resolved/);
	hub.markEdited("/w/p/lib.rs");
	hub.receive(uri("lib.rs"), "pull", []);
	hub.receive(uri("lib.rs"), "push", [d(5, "borrow error")]);
	assert.match(hub.take()?.text ?? "", /borrow error/, "重新上报的错误照常送出");
});

test("C-8 编辑后某一路一直不重新上报时，超过上限按空处理，照样报「已消失」", async () => {
	const hub = new DiagnosticsHub(cwd, 300, 200);
	hub.receive(uri("lib.rs"), "push", [d(3, "cargo check error")]);
	hub.receive(uri("lib.rs"), "pull", []);
	assert.ok(hub.take());
	hub.markEdited("/w/p/lib.rs");
	hub.receive(uri("lib.rs"), "pull", []);
	assert.equal(hub.take(), undefined);
	await new Promise((r) => setTimeout(r, 300));
	assert.match(hub.take()?.text ?? "", /all previously reported issues are resolved/);
	hub.dispose();
});

test("C-9 临时的空结果不结束等待", async () => {
	const hub = new DiagnosticsHub(cwd, 100);
	hub.markEdited("/w/p/a.rs");
	const t0 = Date.now();
	setTimeout(() => hub.receive(uri("a.rs"), "pull", [], true), 20);
	setTimeout(() => hub.receive(uri("a.rs"), "pull", [d(0, "real")]), 400);
	await hub.waitFor("/w/p/a.rs", 3000);
	assert.ok(Date.now() - t0 >= 480, "临时结果之后继续等到真结果");
	assert.match(hub.take()?.text ?? "", /real/);
});

test("C-9 等待：收到后安静一段时间（这里设 300ms）就结束；一直没有结果时最多等上限", async () => {
	const hub = new DiagnosticsHub(cwd, 300);
	hub.markEdited("/w/p/a.go");
	const t0 = Date.now();
	setTimeout(() => hub.receive(uri("a.go"), "push", [d(0, "x")]), 100);
	await hub.waitFor("/w/p/a.go", 3000);
	const took = Date.now() - t0;
	assert.ok(took >= 380 && took < 800, `应在约 400ms 结束，实际 ${took}ms`);
	hub.markEdited("/w/p/b.go");
	const t1 = Date.now();
	await hub.waitFor("/w/p/b.go", 500);
	assert.ok(Date.now() - t1 >= 490 && Date.now() - t1 < 800, "没有结果时等满上限");
	const ac = new AbortController();
	const t2 = Date.now();
	setTimeout(() => ac.abort(), 50);
	await hub.waitFor("/w/p/c.go", 3000, ac.signal);
	assert.ok(Date.now() - t2 < 500, "中止时立即返回");
});

test("C-1 编辑后先全量 didChange 再 didSave，版本号加 1；未打开时 didOpen", () => {
	const sent: [string, any][] = [];
	const ch = { notify: (m: string, p: unknown) => void sent.push([m, p]) };
	const docs = new DocumentSet(() => "go");
	docs.change(ch, "/w/p/a.go", "v1", 1, 2);
	docs.change(ch, "/w/p/a.go", "v2", 2, 2);
	assert.deepEqual(sent.map(([m]) => m), ["textDocument/didOpen", "textDocument/didSave", "textDocument/didChange", "textDocument/didSave"]);
	assert.equal(sent[0][1].textDocument.version, 1);
	assert.equal(sent[0][1].textDocument.languageId, "go");
	assert.equal(sent[2][1].textDocument.version, 2);
	assert.deepEqual(sent[2][1].contentChanges, [{ text: "v2" }]);
});

test("C-2 打开第 51 个文件时最久未用的那个收到 didClose", () => {
	const sent: [string, any][] = [];
	const ch = { notify: (m: string, p: unknown) => void sent.push([m, p]) };
	const docs = new DocumentSet(() => "go");
	for (let i = 0; i < MAX_OPEN_DOCUMENTS; i++) docs.open(ch, `/w/p/f${i}.go`, "", 0, 0);
	docs.open(ch, "/w/p/f0.go", "", 0, 0);
	docs.open(ch, "/w/p/new.go", "", 0, 0);
	const closed = sent.filter(([m]) => m === "textDocument/didClose").map(([, p]) => p.textDocument.uri);
	assert.deepEqual(closed, ["file:///w/p/f1.go"], "f0 刚用过，关掉的是 f1");
	assert.equal(docs.size, MAX_OPEN_DOCUMENTS);
});

test("C-3 bash 之后：内容变了发 didChange，删了发 didClose，没动的不发", async () => {
	const dir = tempDir();
	const a = writeFile(dir, "a.go", "one");
	const b = writeFile(dir, "b.go", "two");
	const c = writeFile(dir, "c.go", "three");
	const sent: [string, any][] = [];
	const ch = { notify: (m: string, p: unknown) => void sent.push([m, p]) };
	const docs = new DocumentSet(() => "go");
	const { statSync, rmSync } = await import("node:fs");
	for (const p of [a, b, c]) docs.open(ch, p, (await import("node:fs")).readFileSync(p, "utf8"), statSync(p).mtimeMs, statSync(p).size);
	sent.length = 0;
	await new Promise((r) => setTimeout(r, 20));
	writeFile(dir, "a.go", "one changed");
	rmSync(b);
	const changed = await docs.reconcile(ch);
	assert.deepEqual(changed.sort(), [a, b].sort());
	assert.deepEqual(sent.map(([m]) => m).sort(), ["textDocument/didChange", "textDocument/didClose", "textDocument/didSave"].sort());
	assert.equal(docs.isOpen(b), false);
	assert.equal(docs.isOpen(c), true);
});
