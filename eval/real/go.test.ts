// Go（gopls）真实服务器验收：D-1 到 D-5、D-8。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pos, project, session } from "./harness.ts";

const SHAPES = `package shapes

// Shape 有面积。
type Shape interface {
	Area() float64
}

// Sq 是正方形。
type Sq struct{ S float64 }

func (s Sq) Area() float64 { return s.S * s.S }

// Total 求面积之和。
func Total(xs []Shape) float64 {
	sum := 0.0
	for _, x := range xs {
		sum += x.Area()
	}
	return sum
}
`;

const MAIN = `package main

import (
	"fmt"

	"example.com/demo/shapes"
)

func run() float64 {
	return shapes.Total([]shapes.Shape{shapes.Sq{S: 2}})
}

func main() {
	fmt.Println(run())
}
`;

test("Go：诊断、已消失、导航、实现、调用关系", { timeout: 120_000 }, async () => {
	const root = project({ "go.mod": "module example.com/demo\n\ngo 1.22\n", "shapes/shapes.go": SHAPES, "main.go": MAIN });
	const s = session(root);
	try {
		const main = join(root, "main.go");
		const shapes = join(root, "shapes/shapes.go");
		// D-1：制造一个类型错误。
		const broken = MAIN.replace("return shapes.Total", 'var bad int = "x"\n\t_ = bad\n\treturn shapes.Total');
		const diag = await s.edit("main.go", broken);
		assert.match(diag, /<new-diagnostics>/);
		assert.match(diag, /main\.go:\n  ✘ \[Line 10:\d+\] .*cannot use "x"/, `诊断：${diag}`);
		// D-2：改回去之后报「已消失」。
		const fixed = await s.edit("main.go", MAIN);
		assert.match(fixed, /main\.go: all previously reported issues are resolved/, `诊断：${fixed}`);
		// D-3：跨文件跳转定义、引用、悬停、符号。
		const def = await s.lsp({ operation: "goToDefinition", filePath: main, ...pos(main, "Total", 1, 1) });
		assert.equal(def, `Defined in shapes/shapes.go:${pos(shapes, "Total(xs").line}:6`);
		const refs = await s.lsp({ operation: "findReferences", filePath: shapes, ...pos(shapes, "Total(xs", 1, 1) });
		assert.match(refs, /^Found 2 references across 2 files:/, refs);
		const hover = await s.lsp({ operation: "hover", filePath: shapes, ...pos(shapes, "Total(xs", 1, 1) });
		assert.match(hover, /func Total\(xs \[\]Shape\) float64/, hover);
		const syms = await s.lsp({ operation: "documentSymbol", filePath: shapes, line: 1, character: 1 });
		assert.match(syms, /^Document symbols:\nShape \(Interface\)/, syms);
		assert.match(syms, /Total \(Function\)/);
		const ws = await s.until({ operation: "workspaceSymbol", filePath: main, line: 1, character: 1, query: "Total" }, (t) => t.includes("Total"));
		assert.match(ws, /Total \(Function\)/, ws);
		// D-4：interface 的实现。
		const impl = await s.lsp({ operation: "goToImplementation", filePath: shapes, ...pos(shapes, "Shape interface", 1, 1) });
		assert.match(impl, /shapes\/shapes\.go:\d+:6/, impl);
		// D-5：调用关系。
		const inc = await s.lsp({ operation: "incomingCalls", filePath: shapes, ...pos(shapes, "Total(xs", 1, 1) });
		assert.match(inc, /^Found 1 incoming call:\n\nmain\.go:\n  run \(Function\) - Line 9 \[calls at: 10:\d+\]$/, inc);
		const out = await s.lsp({ operation: "outgoingCalls", filePath: main, ...pos(main, "run() float64", 1, 1) });
		assert.match(out, /Total \(Function\)/, out);
	} finally {
		await s.close();
	}
});

test("Go D-8：同一仓库里两个模块（没有 go.work）各起一个实例，不报假的找不到导入", { timeout: 120_000 }, async () => {
	const root = project({
		"a/go.mod": "module example.com/a\n\ngo 1.22\n",
		"a/lib/lib.go": "package lib\n\nfunc A() int { return 1 }\n",
		"a/main.go": 'package main\n\nimport "example.com/a/lib"\n\nfunc main() { _ = lib.A() }\n',
		"b/go.mod": "module example.com/b\n\ngo 1.22\n",
		"b/lib/lib.go": "package lib\n\nfunc B() int { return 2 }\n",
		"b/main.go": 'package main\n\nimport "example.com/b/lib"\n\nfunc main() { _ = lib.B() }\n',
		".git/HEAD": "",
	});
	const s = session(root);
	try {
		const da = await s.edit("a/main.go", 'package main\n\nimport "example.com/a/lib"\n\nfunc main() { _ = lib.A() }\n');
		const db = await s.edit("b/main.go", 'package main\n\nimport "example.com/b/lib"\n\nfunc main() { _ = lib.B() }\n');
		assert.doesNotMatch(da + db, /could not import|not in std|no required module/, `不应有假的导入错误：${da}${db}`);
		const roots = s.manager.all.filter((i) => i.server.name === "gopls").map((i) => i.root).sort();
		assert.deepEqual(roots, [join(root, "a"), join(root, "b")]);
		const def = await s.lsp({ operation: "goToDefinition", filePath: join(root, "b/main.go"), ...pos(join(root, "b/main.go"), "B()", 1, 0) });
		assert.equal(def, "Defined in b/lib/lib.go:3:6");
	} finally {
		await s.close();
	}
});
