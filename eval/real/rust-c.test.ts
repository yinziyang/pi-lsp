// Rust（rust-analyzer）、C 与 C++（clangd）真实服务器验收：D-1 到 D-6、D-8、D-10。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { diagnosticsUntil, pos, project, session } from "./harness.ts";

const LIB_RS = `pub trait Shape {
    fn area(&self) -> f64;
}

pub struct Sq {
    pub s: f64,
}

impl Shape for Sq {
    fn area(&self) -> f64 {
        self.s * self.s
    }
}

pub fn total(xs: &[&dyn Shape]) -> f64 {
    xs.iter().map(|x| x.area()).sum()
}

pub fn run() -> f64 {
    total(&[&Sq { s: 2.0 }])
}
`;

test("Rust：拉取诊断不等 cargo check（D-10）、已消失、导航、trait 实现、调用关系", { timeout: 180_000 }, async () => {
	const root = project({ "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n', "src/lib.rs": LIB_RS });
	const s = session(root);
	try {
		const lib = join(root, "src/lib.rs");
		// 先让服务器完成加载，再计时编辑后的诊断。
		await s.until({ operation: "documentSymbol", filePath: lib, line: 1, character: 1 }, (t) => t.includes("Shape"), 120_000);
		const t0 = Date.now();
		const diag = await s.edit("src/lib.rs", LIB_RS.replace("self.s * self.s", 'let bad: i32 = "x";\n        self.s * self.s'), 3000);
		const all = diag || (await diagnosticsUntil(s, (t) => /mismatched types|expected `i32`/.test(t), 30_000));
		assert.match(all, /src\/lib\.rs:\n  ✘ \[Line 11:\d+\] /, `诊断：${all}`);
		assert.match(all, /expected `i32`|mismatched types|expected i32/);
		assert.ok(Date.now() - t0 < 10_000, "拉取诊断不必等 cargo check 跑完");
		const fixed = await s.edit("src/lib.rs", LIB_RS, 3000);
		const resolved = fixed.includes("resolved") ? fixed : await diagnosticsUntil(s, (t) => t.includes("resolved"), 60_000);
		assert.match(resolved, /src\/lib\.rs: all previously reported issues are resolved/, resolved);
		const def = await s.lsp({ operation: "goToDefinition", filePath: lib, ...pos(lib, "total(&[", 1, 0) });
		assert.equal(def, `Defined in src/lib.rs:${pos(lib, "pub fn total").line}:8`);
		const refs = await s.lsp({ operation: "findReferences", filePath: lib, ...pos(lib, "pub fn total", 1, 7) });
		assert.match(refs, /^Found 2 references across 1 files:/, refs);
		const hover = await s.lsp({ operation: "hover", filePath: lib, ...pos(lib, "pub fn total", 1, 7) });
		assert.match(hover, /pub fn total\(xs: &\[&dyn Shape\]\) -> f64/, hover);
		const impl = await s.lsp({ operation: "goToImplementation", filePath: lib, ...pos(lib, "pub trait Shape", 1, 10) });
		assert.match(impl, /src\/lib\.rs:9:/, impl);
		const inc = await s.lsp({ operation: "incomingCalls", filePath: lib, ...pos(lib, "pub fn total", 1, 7) });
		assert.match(inc, /^Found 1 incoming call:\n\nsrc\/lib\.rs:\n  run \(Function\) - Line 19/, inc);
		const ws = await s.until({ operation: "workspaceSymbol", filePath: lib, line: 1, character: 1, query: "total" }, (t) => t.includes("total ("));
		assert.match(ws, /total \(Function\)/, ws);
	} finally {
		await s.close();
	}
});

test("Rust D-8：不在同一个 workspace 的两个 crate 各起一个实例", { timeout: 180_000 }, async () => {
	const crate = (name: string) => ({ [`${name}/Cargo.toml`]: `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n`, [`${name}/src/lib.rs`]: `pub fn ${name}_fn() -> u8 { 1 }\n` });
	const root = project({ ...crate("alpha"), ...crate("beta"), ".git/HEAD": "" });
	const s = session(root);
	try {
		for (const c of ["alpha", "beta"]) {
			const f = join(root, c, "src/lib.rs");
			const out = await s.until({ operation: "documentSymbol", filePath: f, line: 1, character: 1 }, (t) => t.includes(`${c}_fn`), 120_000);
			assert.match(out, new RegExp(`${c}_fn \\(Function\\)`));
		}
		assert.deepEqual(s.manager.all.map((i) => i.root).sort(), [join(root, "alpha"), join(root, "beta")]);
	} finally {
		await s.close();
	}
});

const UTIL_H = "#ifndef UTIL_H\n#define UTIL_H\nint add(int a, int b);\n#endif\n";
const UTIL_C = '#include "util.h"\n\nint add(int a, int b) { return a + b; }\n';
const MAIN_C = '#include "util.h"\n\nint twice(int x) { return add(x, x); }\n\nint main(void) { return twice(2); }\n';

test("C：诊断、已消失、跨文件定义、引用、悬停、调用关系", { timeout: 120_000 }, async () => {
	const root = project({ "compile_flags.txt": "-std=c11\n", "util.h": UTIL_H, "util.c": UTIL_C, "main.c": MAIN_C });
	const s = session(root);
	try {
		const main = join(root, "main.c");
		const diag = await s.edit("main.c", MAIN_C.replace("return twice(2);", "return undefined_var;"));
		assert.match(diag, /main\.c:\n  ✘ \[Line 5:\d+\] Use of undeclared identifier 'undefined_var'/, diag);
		assert.match(await s.edit("main.c", MAIN_C), /main\.c: all previously reported issues are resolved/);
		const def = await s.lsp({ operation: "goToDefinition", filePath: main, ...pos(main, "add(x", 1, 0) });
		assert.match(def, /util\.(h:3|c:3):5/, def);
		const hover = await s.lsp({ operation: "hover", filePath: main, ...pos(main, "add(x", 1, 0) });
		assert.match(hover, /int add\(int a, int b\)/, hover);
		const inc = await s.lsp({ operation: "incomingCalls", filePath: main, ...pos(main, "twice(int", 1, 0) });
		assert.match(inc, /main \(Function\) - Line 5/, inc);
		// Apple clangd 17 不支持 callHierarchy/outgoingCalls，服务器回 method not found；按 Claude Code 的做法原样作为结果返回。
		const out = await s.lsp({ operation: "outgoingCalls", filePath: main, ...pos(main, "twice(int", 1, 0) });
		assert.match(out, /add \(Function\)|^Error performing outgoingCalls: LSP request 'callHierarchy\/outgoingCalls' failed for server 'clangd': method not found$/, out);
	} finally {
		await s.close();
	}
});

const SHAPE_HPP = "#pragma once\nclass Shape {\npublic:\n  virtual ~Shape() = default;\n  virtual double area() const = 0;\n};\n";
const SQ_H = '#pragma once\n#include "shape.hpp"\nclass Sq : public Shape {\npublic:\n  explicit Sq(double s) : s_(s) {}\n  double area() const override { return s_ * s_; }\nprivate:\n  double s_;\n};\n';
const MAIN_CPP = '#include "sq.h"\n#include <vector>\n\ndouble total(const std::vector<const Shape*>& xs) {\n  double sum = 0;\n  for (auto* x : xs) sum += x->area();\n  return sum;\n}\n\nint main() {\n  Sq s(2);\n  return static_cast<int>(total({&s}));\n}\n';

test("C++ D-6：.h 里的类按 C++ 解析不报假错误；虚函数找到实现；诊断与已消失", { timeout: 120_000 }, async () => {
	const root = project({ "shape.hpp": SHAPE_HPP, "sq.h": SQ_H, "main.cpp": MAIN_CPP, "compile_commands.json": "" });
	const { writeFileSync } = await import("node:fs");
	writeFileSync(join(root, "compile_commands.json"), JSON.stringify([{ directory: root, file: "main.cpp", command: "clang++ -std=c++17 -c main.cpp" }]));
	const s = session(root);
	try {
		assert.equal(s.router.languageIdFor(s.router.serverFor(join(root, "sq.h"))!, join(root, "sq.h"), root), "cpp");
		const header = await s.edit("sq.h", SQ_H);
		assert.doesNotMatch(header, /✘/, `.h 按 C++ 解析时不应报错：${header}`);
		const main = join(root, "main.cpp");
		const diag = await s.edit("main.cpp", MAIN_CPP.replace("sum += x->area();", "sum += x->nosuch();"));
		assert.match(diag, /main\.cpp:\n  ✘ \[Line 6:\d+\] No member named 'nosuch'/, diag);
		assert.match(await s.edit("main.cpp", MAIN_CPP), /main\.cpp: all previously reported issues are resolved/);
		const shape = join(root, "shape.hpp");
		await s.lsp({ operation: "documentSymbol", filePath: join(root, "sq.h"), line: 1, character: 1 });
		const impl = await s.until({ operation: "goToImplementation", filePath: shape, ...pos(shape, "area() const", 1, 0) }, (t) => t.includes("sq.h"), 30_000);
		assert.match(impl, /sq\.h:6:\d+/, impl);
		const def = await s.lsp({ operation: "goToDefinition", filePath: main, ...pos(main, "total({", 1, 0) });
		assert.equal(def, "Defined in main.cpp:4:8");
	} finally {
		await s.close();
	}
});
