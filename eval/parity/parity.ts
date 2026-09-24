// F 组验收：与 Claude Code 的 LSP 工具逐字节对比（F-1 工具输出，F-2 诊断消息）。
//
// 做法：同一个样例项目，Claude Code 在无界面模式下按原样参数调用它的 LSP 工具（每个查询调两次，取第二次，避开建索引阶段），从 stream-json 输出里取工具结果。
// pi-lsp 对同样参数执行，结果不一致时重试到一致或超时，仍不一致即判失败并打印两边原文。
// 诊断：Claude Code 用 Write 写入一个有错的文件，从它的会话记录里取 <new-diagnostics>；pi-lsp 对同一内容给出诊断。
// 比较前把我们有意的改动还原成 Claude Code 的写法：V1 相对路径（样例文件放在项目根，basename 与相对路径相同）、V2 去掉 Hint 行、V3 不涉及。
// 会调用真实模型：每种语言一次 Claude Code 会话。用法：node eval/parity/parity.ts [语言...]

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pos, project, session } from "../real/harness.ts";

interface Query {
	operation: string;
	filePath: string;
	line: number;
	character: number;
	query?: string;
}

interface Case {
	name: string;
	files: Record<string, string>;
	setup?: (root: string) => void;
	/** 查询列表，文件路径相对项目根。 */
	queries: (root: string) => Query[];
	/** 诊断对比：写入的文件与内容。 */
	broken: { file: string; text: string };
}

const q = (root: string, file: string, operation: string, needle: string, n = 1, offset = 0, query?: string): Query => ({ operation, filePath: file, ...pos(join(root, file), needle, n, offset), ...(query ? { query } : {}) });

const GO_SHAPES = "package main\n\n// Shape 有面积。\ntype Shape interface {\n\tArea() float64\n}\n\ntype Sq struct{ S float64 }\n\nfunc (s Sq) Area() float64 { return s.S * s.S }\n\nfunc total(xs []Shape) float64 {\n\tsum := 0.0\n\tfor _, x := range xs {\n\t\tsum += x.Area()\n\t}\n\treturn sum\n}\n";
const GO_MAIN = "package main\n\nimport \"fmt\"\n\nfunc run() float64 { return total([]Shape{Sq{S: 2}}) }\n\nfunc main() { fmt.Println(run()) }\n";
const RS = "pub trait Shape {\n    fn area(&self) -> f64;\n}\n\npub struct Sq {\n    pub s: f64,\n}\n\nimpl Shape for Sq {\n    fn area(&self) -> f64 {\n        self.s * self.s\n    }\n}\n\npub fn total(xs: &[&dyn Shape]) -> f64 {\n    xs.iter().map(|x| x.area()).sum()\n}\n\npub fn run() -> f64 {\n    total(&[&Sq { s: 2.0 }])\n}\n";
const C_MAIN = '#include "util.h"\n\nint twice(int x) { return add(x, x); }\n\nint main(void) { return twice(2); }\n';
const CPP_MAIN = '#include <vector>\n\nclass Shape {\npublic:\n  virtual ~Shape() = default;\n  virtual double area() const = 0;\n};\n\nclass Sq : public Shape {\npublic:\n  explicit Sq(double s) : s_(s) {}\n  double area() const override { return s_ * s_; }\nprivate:\n  double s_;\n};\n\ndouble total(const std::vector<const Shape*>& xs) {\n  double sum = 0;\n  for (auto* x : xs) sum += x->area();\n  return sum;\n}\n\nint main() {\n  Sq s(2);\n  return static_cast<int>(total({&s}));\n}\n';
const TS_SHAPE = "export interface Shape {\n  area(): number;\n}\n\nexport class Sq implements Shape {\n  constructor(private s: number) {}\n  area(): number {\n    return this.s * this.s;\n  }\n}\n\nexport function total(xs: Shape[]): number {\n  return xs.reduce((n, x) => n + x.area(), 0);\n}\n";
const TS_MAIN = 'import { Sq, total } from "./shape";\n\nexport function run(): number {\n  return total([new Sq(2)]);\n}\n';
const PY_SHAPES = "from typing import Protocol\n\n\nclass Shape(Protocol):\n    def area(self) -> float: ...\n\n\nclass Sq:\n    def __init__(self, s: float) -> None:\n        self.s = s\n\n    def area(self) -> float:\n        return self.s * self.s\n\n\ndef total(xs: list[Shape]) -> float:\n    return sum(x.area() for x in xs)\n";
const PY_MAIN = "from shapes import Sq, total\n\n\ndef run() -> float:\n    return total([Sq(2)])\n";
const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", checkJs: true, allowJs: true, noEmit: true } });
const REPO_TS = fileURLToPath(new URL("../../node_modules/typescript", import.meta.url));
const linkTs = (root: string) => {
	mkdirSync(join(root, "node_modules"), { recursive: true });
	symlinkSync(REPO_TS, join(root, "node_modules/typescript"));
};

const CASES: Case[] = [
	{
		name: "go",
		files: { "go.mod": "module example.com/p\n\ngo 1.22\n", "shapes.go": GO_SHAPES, "main.go": GO_MAIN },
		queries: (r) => [
			q(r, "main.go", "goToDefinition", "total(", 1, 1),
			q(r, "shapes.go", "findReferences", "func total", 1, 5),
			q(r, "shapes.go", "hover", "func total", 1, 5),
			q(r, "shapes.go", "documentSymbol", "package"),
			q(r, "main.go", "workspaceSymbol", "package", 1, 0, "total"),
			q(r, "shapes.go", "goToImplementation", "Shape interface", 1, 1),
			q(r, "shapes.go", "prepareCallHierarchy", "func total", 1, 5),
			q(r, "shapes.go", "incomingCalls", "func total", 1, 5),
			q(r, "main.go", "outgoingCalls", "func run", 1, 5),
		],
		broken: { file: "main.go", text: GO_MAIN.replace("func main()", 'func bad() int { return "x" }\n\nfunc main()') },
	},
	{
		name: "rust",
		files: { "Cargo.toml": '[package]\nname = "p"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\npath = "lib.rs"\n', "lib.rs": RS },
		queries: (r) => [
			q(r, "lib.rs", "goToDefinition", "total(&[", 1, 0),
			q(r, "lib.rs", "findReferences", "pub fn total", 1, 7),
			q(r, "lib.rs", "hover", "pub fn total", 1, 7),
			q(r, "lib.rs", "documentSymbol", "pub trait"),
			q(r, "lib.rs", "goToImplementation", "pub trait Shape", 1, 10),
			q(r, "lib.rs", "incomingCalls", "pub fn total", 1, 7),
			q(r, "lib.rs", "outgoingCalls", "pub fn run", 1, 7),
		],
		broken: { file: "lib.rs", text: RS.replace("self.s * self.s", 'let bad: i32 = "x";\n        self.s * self.s') },
	},
	{
		name: "c",
		files: { "compile_flags.txt": "-std=c11\n", "util.h": "#ifndef UTIL_H\n#define UTIL_H\nint add(int a, int b);\n#endif\n", "util.c": '#include "util.h"\n\nint add(int a, int b) { return a + b; }\n', "main.c": C_MAIN },
		queries: (r) => [
			q(r, "main.c", "goToDefinition", "add(x", 1, 0),
			q(r, "main.c", "findReferences", "twice(int", 1, 0),
			q(r, "main.c", "hover", "add(x", 1, 0),
			q(r, "main.c", "documentSymbol", "#include"),
			q(r, "main.c", "incomingCalls", "twice(int", 1, 0),
		],
		broken: { file: "main.c", text: C_MAIN.replace("return twice(2);", "return undefined_var;") },
	},
	{
		name: "cpp",
		files: { "compile_flags.txt": "-std=c++17\n", "main.cpp": CPP_MAIN },
		queries: (r) => [
			q(r, "main.cpp", "goToDefinition", "total({", 1, 0),
			q(r, "main.cpp", "findReferences", "double total", 1, 7),
			q(r, "main.cpp", "hover", "double total", 1, 7),
			q(r, "main.cpp", "documentSymbol", "#include"),
			q(r, "main.cpp", "goToImplementation", "area() const = 0", 1, 0),
		],
		broken: { file: "main.cpp", text: CPP_MAIN.replace("sum += x->area();", "sum += x->nosuch();") },
	},
	{
		name: "ts",
		files: { "tsconfig.json": TSCONFIG, "shape.ts": TS_SHAPE, "main.ts": TS_MAIN },
		setup: linkTs,
		queries: (r) => [
			q(r, "main.ts", "goToDefinition", "total([", 1, 0),
			q(r, "shape.ts", "findReferences", "function total", 1, 9),
			q(r, "shape.ts", "hover", "function total", 1, 9),
			q(r, "shape.ts", "documentSymbol", "export"),
			q(r, "main.ts", "workspaceSymbol", "import", 1, 0, "total"),
			q(r, "shape.ts", "goToImplementation", "interface Shape", 1, 10),
			q(r, "shape.ts", "incomingCalls", "function total", 1, 9),
		],
		broken: { file: "main.ts", text: TS_MAIN.replace("return total", 'const n: number = "x";\n  void n;\n  return total') },
	},
	{
		name: "jsx",
		files: { "tsconfig.json": TSCONFIG, "app.jsx": '// @ts-check\nimport { Button } from "./button.jsx";\n\nexport function App() {\n  return <Button label="hi" />;\n}\n', "button.jsx": "/** @param {{ label: string }} props */\nexport function Button(props) {\n  return <button>{props.label}</button>;\n}\n" },
		setup: linkTs,
		queries: (r) => [q(r, "app.jsx", "goToDefinition", "<Button", 1, 1), q(r, "button.jsx", "hover", "function Button", 1, 9), q(r, "app.jsx", "documentSymbol", "//")],
		broken: { file: "app.jsx", text: '// @ts-check\nimport { Button } from "./button.jsx";\n\nexport function App() {\n  return <Button label={42} />;\n}\n' },
	},
	{
		name: "python",
		files: { "pyproject.toml": "[project]\nname='p'\n", "shapes.py": PY_SHAPES, "main.py": PY_MAIN },
		queries: (r) => [
			q(r, "main.py", "goToDefinition", "total([", 1, 0),
			q(r, "shapes.py", "findReferences", "def total", 1, 4),
			q(r, "shapes.py", "hover", "def total", 1, 4),
			q(r, "shapes.py", "documentSymbol", "from"),
			q(r, "main.py", "workspaceSymbol", "from", 1, 0, "total"),
			q(r, "shapes.py", "incomingCalls", "def total", 1, 4),
		],
		broken: { file: "main.py", text: PY_MAIN.replace("return total([Sq(2)])", 'x: int = "s"\n    return total([Sq(2)])') },
	},
];

/** 让 Claude Code 依次调用 LSP 工具（每个查询两次），再写入有错的文件，返回每个查询第二次的结果与会话 id。 */
function runClaude(root: string, queries: Query[], broken: Case["broken"]): Promise<{ results: Map<string, string>; sessionId: string }> {
	const list = [...queries, ...queries].map((x) => JSON.stringify(x)).join("\n");
	const prompt = [
		"This is an automated tool test. Do not explain, do not read files, do not use any tool other than the ones named here.",
		"1. Use ToolSearch with query 'select:LSP' to load the LSP tool.",
		"2. Call the LSP tool once for each of the following JSON argument objects, exactly as given, in order:",
		list,
		`3. Use the Write tool to write this exact content to ${broken.file}:`,
		"```",
		broken.text,
		"```",
		"4. Run the Bash command `sleep 5`, then run the Bash command `true`.",
		"5. Reply with DONE.",
	].join("\n");
	return new Promise((resolve, reject) => {
		const child = spawn("claude", ["-p", prompt, "--output-format", "stream-json", "--verbose", "--model", "sonnet", "--allowedTools", "ToolSearch,LSP,Write,Bash"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
		let buf = "";
		child.stdout.on("data", (d) => (buf += d));
		child.stderr.on("data", () => {});
		const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
		child.on("exit", () => {
			clearTimeout(timer);
			const calls = new Map<string, string>();
			const results = new Map<string, string>();
			let sessionId = "";
			for (const line of buf.split("\n")) {
				if (!line.trim()) continue;
				let o: any;
				try { o = JSON.parse(line); } catch { continue; }
				if (o.session_id) sessionId = o.session_id;
				for (const b of o.message?.content ?? []) {
					if (b.type === "tool_use" && b.name === "LSP") calls.set(b.id, JSON.stringify({ operation: b.input.operation, filePath: b.input.filePath, line: b.input.line, character: b.input.character, ...(b.input.query ? { query: b.input.query } : {}) }));
					if (b.type === "tool_result" && calls.has(b.tool_use_id)) {
						const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("");
						results.set(calls.get(b.tool_use_id) as string, text);
					}
				}
			}
			if (!sessionId) reject(new Error(`claude produced no session:\n${buf.slice(-2000)}`));
			else resolve({ results, sessionId });
		});
	});
}

/** 从 Claude Code 的会话记录里取出诊断消息正文。 */
function claudeDiagnostics(root: string, sessionId: string): string[] {
	const dir = join(homedir(), ".claude", "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
	const file = join(dir, `${sessionId}.jsonl`);
	if (!existsSync(file)) return [];
	const out: string[] = [];
	for (const m of readFileSync(file, "utf8").matchAll(/<new-diagnostics>[\s\S]*?<\/new-diagnostics>/g)) out.push(m[0]);
	return [...new Set(out.map((s) => JSON.parse(`"${s.replace(/"/g, '\\"')}"`.replace(/\\\\"/g, '\\"')) as string).map((s) => s.replace(/\\n/g, "\n")))];
}

/**
 * 同一文件内的诊断按条排序后的形式。
 * 我们同时接收推送与拉取两路（D3），同为一个级别时按到达先后排列；Claude Code 只收推送，按服务器给的顺序。两边条目完全相同、只有同级别先后不同时，按这个形式比较。
 */
function orderInsensitive(text: string): string {
	return text
		.split("\n\n")
		.map((block) => {
			const [head, ...rest] = block.split(/\n(?=  [✘⚠ℹ★•] \[Line)/);
			return [head, ...rest.sort()].join("\n");
		})
		.join("\n\n");
}

/** 把 Claude Code 的诊断还原成可与我们比较的形式：去掉 Hint（V2）。 */
function normalizeClaude(text: string): string {
	return text.split("\n").filter((l) => !l.startsWith("  ★")).join("\n");
}

const wanted = process.argv.slice(2);
let failures = 0;
for (const c of CASES) {
	if (wanted.length && !wanted.includes(c.name)) continue;
	const root = project(c.files);
	c.setup?.(root);
	const queries = c.queries(root);
	process.stdout.write(`\n== ${c.name}（${root}）\n`);
	let claude: Awaited<ReturnType<typeof runClaude>>;
	try {
		claude = await runClaude(root, queries, c.broken);
	} catch (e) {
		failures++;
		process.stdout.write(`FAIL claude 会话出错：${(e as Error).message}\n`);
		continue;
	}
	// Claude Code 在第 3 步把有错的内容写进了样例文件；我们的查询要针对同一份原始内容，先恢复。
	for (const [rel, text] of Object.entries(c.files)) writeFileSync(join(root, rel), text);
	const s = session(root);
	try {
		for (const qq of queries) {
			const key = JSON.stringify(qq);
			const theirs = claude.results.get(key);
			if (theirs === undefined) {
				failures++;
				process.stdout.write(`FAIL ${qq.operation} ${qq.filePath}:${qq.line}:${qq.character} — Claude Code 没有返回这个查询的结果\n`);
				continue;
			}
			const abs = { ...qq, filePath: join(root, qq.filePath) };
			let ours = await s.lsp(abs as any);
			const end = Date.now() + 30_000;
			while (ours !== theirs && Date.now() < end) {
				await new Promise((r) => setTimeout(r, 1000));
				ours = await s.lsp(abs as any);
			}
			// Claude Code 用相对路径调用时，工具内部按 cwd 解析，结果文本相同；这里统一用绝对路径调用。
			if (ours === theirs) process.stdout.write(`PASS ${qq.operation} ${qq.filePath}:${qq.line}:${qq.character}\n`);
			else {
				failures++;
				process.stdout.write(`FAIL ${qq.operation} ${qq.filePath}:${qq.line}:${qq.character}\n--- Claude Code\n${theirs}\n--- pi-lsp\n${ours}\n---\n`);
			}
		}
		const theirDiags = claudeDiagnostics(root, claude.sessionId).map(normalizeClaude);
		const ours = await s.edit(c.broken.file, c.broken.text, 3000);
		let oursAll = ours;
		const end = Date.now() + 15_000;
		while (Date.now() < end && !theirDiags.includes(oursAll)) {
			await new Promise((r) => setTimeout(r, 1000));
			const more = s.hub.take()?.text;
			if (more) oursAll = more;
		}
		if (theirDiags.length === 0) process.stdout.write(`INFO 诊断：Claude Code 的会话里没有出现 <new-diagnostics>（它不等服务器推送，可能晚于会话结束）；pi-lsp：\n${ours}\n`);
		else if (theirDiags.includes(oursAll) || theirDiags.includes(ours)) process.stdout.write(`PASS 诊断消息逐字一致\n`);
		else if (theirDiags.map(orderInsensitive).includes(orderInsensitive(oursAll))) process.stdout.write(`PASS 诊断消息的条目逐字一致，只有同级别诊断的先后不同（D3：推送与拉取两路合并）\n`);
		else {
			failures++;
			process.stdout.write(`FAIL 诊断消息不一致\n--- Claude Code\n${theirDiags.join("\n")}\n--- pi-lsp\n${oursAll}\n---\n`);
		}
	} finally {
		await s.close();
	}
}
process.stdout.write(`\n${failures === 0 ? "全部一致" : `${failures} 处不一致`}\n`);
process.exit(failures ? 1 : 0);
