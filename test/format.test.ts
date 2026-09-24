// 9 个操作的输出文本（验收 B-9）。期望值按 Claude Code 2.1.281 的格式化代码逐字手写，不由被测函数推出。

import assert from "node:assert/strict";
import { test } from "node:test";
import { formatResult } from "../extensions/pi-lsp/format.ts";
import { displayPath } from "../extensions/pi-lsp/uri.ts";

const cwd = "/w/proj";
const loc = (path: string, line: number, ch: number) => ({ uri: `file://${path}`, range: { start: { line, character: ch }, end: { line, character: ch + 1 } } });

test("路径规则：相对路径更短且不以 ../../ 开头时用相对路径", () => {
	assert.equal(displayPath("file:///w/proj/src/a.go", cwd), "src/a.go");
	assert.equal(displayPath("file:///w/other/a.go", cwd), "/w/other/a.go", "一样长时用绝对路径");
	assert.equal(displayPath("file:///home/me/other/a.go", "/home/me/proj"), "../other/a.go");
	assert.equal(displayPath("file:///home/me/other/a.go", "/home/me/proj/sub"), "/home/me/other/a.go", "以 ../../ 开头时用绝对路径");
	assert.equal(displayPath("file:///usr/include/stdio.h", cwd), "/usr/include/stdio.h");
	assert.equal(displayPath("file:///w/proj/with%20space.ts", cwd), "with space.ts");
	assert.equal(displayPath(undefined, cwd), "<unknown location>");
});

test("goToDefinition：单个、多个、LocationLink、空结果", () => {
	assert.equal(formatResult("goToDefinition", loc("/w/proj/a.go", 9, 4), cwd), "Defined in a.go:10:5");
	assert.equal(formatResult("goToDefinition", [loc("/w/proj/a.go", 0, 0), loc("/w/proj/b.go", 2, 3)], cwd), "Found 2 definitions:\n  a.go:1:1\n  b.go:3:4");
	const link = { targetUri: "file:///w/proj/c.go", targetRange: { start: { line: 5, character: 0 }, end: { line: 9, character: 1 } }, targetSelectionRange: { start: { line: 6, character: 5 }, end: { line: 6, character: 8 } } };
	assert.equal(formatResult("goToDefinition", [link], cwd), "Defined in c.go:7:6");
	const empty = "No definition found. This may occur if the cursor is not on a symbol, or if the definition is in an external library not indexed by the LSP server.";
	assert.equal(formatResult("goToDefinition", null, cwd), empty);
	assert.equal(formatResult("goToDefinition", [], cwd), empty);
	assert.equal(formatResult("goToImplementation", [loc("/w/proj/impl.go", 1, 1)], cwd), "Defined in impl.go:2:2");
});

test("findReferences：一条、多条按文件分组、空结果", () => {
	assert.equal(formatResult("findReferences", [loc("/w/proj/a.go", 0, 0)], cwd), "Found 1 reference:\n  a.go:1:1");
	assert.equal(
		formatResult("findReferences", [loc("/w/proj/a.go", 0, 0), loc("/w/proj/b.go", 4, 2), loc("/w/proj/a.go", 7, 1)], cwd),
		"Found 3 references across 2 files:\n\na.go:\n  Line 1:1\n  Line 8:2\n\nb.go:\n  Line 5:3",
	);
	assert.equal(formatResult("findReferences", [], cwd), "No references found. This may occur if the symbol has no usages, or if the LSP server has not fully indexed the workspace.");
});

test("hover：MarkupContent、MarkedString 数组、无 range、空结果", () => {
	assert.equal(formatResult("hover", { contents: { kind: "markdown", value: "```go\nfunc F()\n```" }, range: { start: { line: 2, character: 5 }, end: { line: 2, character: 6 } } }, cwd), "Hover info at 3:6:\n\n```go\nfunc F()\n```");
	assert.equal(formatResult("hover", { contents: ["a", { language: "ts", value: "b" }] }, cwd), "a\n\nb");
	assert.equal(formatResult("hover", { contents: "plain" }, cwd), "plain");
	assert.equal(formatResult("hover", null, cwd), "No hover information available. This may occur if the cursor is not on a symbol, or if the LSP server has not fully indexed the file.");
});

test("documentSymbol：分层缩进、detail、扁平 SymbolInformation、空结果", () => {
	const sym = (name: string, kind: number, line: number, children?: unknown[], detail?: string) => ({ name, kind, detail, range: { start: { line, character: 0 }, end: { line, character: 1 } }, selectionRange: { start: { line, character: 0 }, end: { line, character: 1 } }, children });
	assert.equal(
		formatResult("documentSymbol", [sym("Server", 23, 3, [sym("Start", 6, 5, undefined, "func()"), sym("port", 8, 4)]), sym("main", 12, 20)], cwd),
		"Document symbols:\nServer (Struct) - Line 4\n  Start (Method) func() - Line 6\n  port (Field) - Line 5\nmain (Function) - Line 21",
	);
	const info = [{ name: "f", kind: 12, location: loc("/w/proj/a.py", 1, 0) }];
	assert.equal(formatResult("documentSymbol", info, cwd), "Found 1 symbol in workspace:\n\na.py:\n  f (Function) - Line 2");
	assert.equal(formatResult("documentSymbol", [], cwd), "No symbols found in document. This may occur if the file is empty, not supported by the LSP server, or if the server has not fully indexed the file.");
});

test("workspaceSymbol：单复数、containerName、未知 kind、空结果", () => {
	const syms = [
		{ name: "Parse", kind: 12, location: loc("/w/proj/p.go", 9, 0), containerName: "parser" },
		{ name: "X", kind: 99, location: loc("/w/proj/q.go", 0, 0) },
	];
	assert.equal(formatResult("workspaceSymbol", syms, cwd), "Found 2 symbols in workspace:\n\np.go:\n  Parse (Function) - Line 10 in parser\n\nq.go:\n  X (Unknown) - Line 1");
	assert.equal(formatResult("workspaceSymbol", [], cwd), "No symbols found in workspace. This may occur if the workspace is empty, or if the LSP server has not finished indexing the project.");
});

test("prepareCallHierarchy、incomingCalls、outgoingCalls", () => {
	const item = (name: string, path: string, line: number, detail?: string) => ({ name, kind: 12, uri: `file://${path}`, detail, range: { start: { line, character: 0 }, end: { line, character: 1 } }, selectionRange: { start: { line, character: 0 }, end: { line, character: 1 } } });
	assert.equal(formatResult("prepareCallHierarchy", [item("run", "/w/proj/m.go", 4, "main")], cwd), "Call hierarchy item: run (Function) - m.go:5 [main]");
	assert.equal(formatResult("prepareCallHierarchy", [item("a", "/w/proj/m.go", 0), item("b", "/w/proj/n.go", 1)], cwd), "Found 2 call hierarchy items:\n  a (Function) - m.go:1\n  b (Function) - n.go:2");
	assert.equal(formatResult("prepareCallHierarchy", [], cwd), "No call hierarchy item found at this position");
	const r = (line: number, ch: number) => ({ start: { line, character: ch }, end: { line, character: ch + 1 } });
	assert.equal(
		formatResult("incomingCalls", [{ from: item("main", "/w/proj/m.go", 2), fromRanges: [r(3, 4), r(5, 1)] }], cwd),
		"Found 1 incoming call:\n\nm.go:\n  main (Function) - Line 3 [calls at: 4:5, 6:2]",
	);
	assert.equal(
		formatResult("outgoingCalls", [{ to: item("helper", "/w/proj/h.go", 7), fromRanges: [r(1, 1)] }, { to: item("log", "/w/proj/h.go", 9), fromRanges: [] }], cwd),
		"Found 2 outgoing calls:\n\nh.go:\n  helper (Function) - Line 8 [called from: 2:2]\n  log (Function) - Line 10",
	);
	assert.equal(formatResult("incomingCalls", [], cwd), "No incoming calls found (nothing calls this function)");
	assert.equal(formatResult("outgoingCalls", null, cwd), "No outgoing calls found (this function calls nothing)");
});
