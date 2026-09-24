// TypeScript / JavaScript / JSX、Python、CSS、HTML 真实服务器验收：D-1 到 D-5、D-7、D-9。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { diagnosticsUntil, pos, project, session } from "./harness.ts";

const SHAPE_TS = `export interface Shape {
  area(): number;
}

export class Sq implements Shape {
  constructor(private s: number) {}
  area(): number {
    return this.s * this.s;
  }
}

export function total(xs: Shape[]): number {
  return xs.reduce((n, x) => n + x.area(), 0);
}
`;
const MAIN_TS = `import { Sq, total } from "./shape";

export function run(): number {
  return total([new Sq(2)]);
}
`;
const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", checkJs: true, allowJs: true, noEmit: true } });

async function tsSuite(label: string, extraFiles: Record<string, string>, expectLabel: RegExp) {
	const root = project({ "tsconfig.json": TSCONFIG, "src/shape.ts": SHAPE_TS, "src/main.ts": MAIN_TS, ".git/HEAD": "", ...extraFiles });
	return { root, label, expectLabel };
}

async function runTs(root: string, expectLabel: RegExp) {
	const s = session(root);
	try {
		const shape = join(root, "src/shape.ts");
		const main = join(root, "src/main.ts");
		const diag = await s.edit("src/main.ts", MAIN_TS.replace("return total", 'const n: number = "x";\n  void n;\n  return total'));
		const all = diag.includes("✘") ? diag : await diagnosticsUntil(s, (t) => t.includes("not assignable"), 20_000);
		assert.match(all, /src\/main\.ts:\n  ✘ \[Line 4:\d+\] Type 'string' is not assignable to type 'number'/, all);
		const fixed = await s.edit("src/main.ts", MAIN_TS);
		const resolved = fixed.includes("resolved") ? fixed : await diagnosticsUntil(s, (t) => t.includes("resolved"), 15_000);
		assert.match(resolved, /src\/main\.ts: all previously reported issues are resolved/, resolved);
		assert.match(s.manager.all.find((i) => i.server.name === "typescript")?.launch.label ?? "", expectLabel);
		const def = await s.lsp({ operation: "goToDefinition", filePath: main, ...pos(main, "total([", 1, 0) });
		assert.equal(def, `Defined in src/shape.ts:${pos(shape, "function total").line}:17`);
		const refs = await s.lsp({ operation: "findReferences", filePath: shape, ...pos(shape, "function total", 1, 9) });
		assert.match(refs, /^Found 3 references across 2 files:/, refs);
		const hover = await s.lsp({ operation: "hover", filePath: shape, ...pos(shape, "function total", 1, 9) });
		assert.match(hover, /function total\(xs: Shape\[\]\): number/, hover);
		const syms = await s.lsp({ operation: "documentSymbol", filePath: shape, line: 1, character: 1 });
		assert.match(syms, /Shape \(Interface\)/, syms);
		assert.match(syms, /Sq \(Class\)/);
		const ws = await s.until({ operation: "workspaceSymbol", filePath: main, line: 1, character: 1, query: "total" }, (t) => t.includes("total ("), 20_000);
		assert.match(ws, /total \(Function\)/, ws);
		const impl = await s.lsp({ operation: "goToImplementation", filePath: shape, ...pos(shape, "interface Shape", 1, 10) });
		assert.match(impl, /src\/shape\.ts:5:/, impl);
		const inc = await s.lsp({ operation: "incomingCalls", filePath: shape, ...pos(shape, "function total", 1, 9) });
		assert.match(inc, /run \(Function\) - Line 3/, inc);
	} finally {
		await s.close();
	}
}

test("TS D-9：项目没有自带 TypeScript 时用 TS 7 的 tsc --lsp，通过拉取拿到诊断", { timeout: 120_000 }, async () => {
	const { root } = await tsSuite("ts7", {}, /tsc --lsp/);
	await runTs(root, /tsc --lsp \(TypeScript 7/);
});

test("TS D-9：项目自带 TypeScript 5 时用 typescript-language-server", { timeout: 120_000 }, async () => {
	const { root } = await tsSuite("ts5", {}, /typescript-language-server/);
	// 用本仓库 devDependencies 里的 TypeScript 5 充当项目自带的版本。
	const repoTs = fileURLToPath(new URL("../../node_modules/typescript", import.meta.url));
	mkdirSync(join(root, "node_modules"), { recursive: true });
	symlinkSync(repoTs, join(root, "node_modules/typescript"));
	await runTs(root, /typescript-language-server \(TypeScript 5/);
});

test("JSX：React 组件的诊断与跳转", { timeout: 120_000 }, async () => {
	const APP = `// @ts-check\nimport { Button } from "./button.jsx";\n\nexport function App() {\n  return <Button label="hi" />;\n}\n`;
	const BUTTON = `/** @param {{ label: string }} props */\nexport function Button(props) {\n  return <button>{props.label}</button>;\n}\n`;
	const root = project({ "tsconfig.json": TSCONFIG, "src/app.jsx": APP, "src/button.jsx": BUTTON, ".git/HEAD": "" });
	const s = session(root);
	try {
		const app = join(root, "src/app.jsx");
		assert.equal(s.router.serverFor(app)?.name, "typescript");
		const diag = await s.edit("src/app.jsx", APP.replace('label="hi"', "label={42}"));
		const all = diag.includes("✘") ? diag : await diagnosticsUntil(s, (t) => t.includes("not assignable"), 20_000);
		// 项目里没装 react，服务器先报一条找不到 react/jsx-runtime；这里只验证类型错误本身。
		assert.match(all, /src\/app\.jsx:\n(  .*\n)*  ✘ \[Line 5:\d+\] Type 'number' is not assignable to type 'string'/, all);
		const def = await s.lsp({ operation: "goToDefinition", filePath: app, ...pos(app, "<Button", 1, 1) });
		assert.match(def, /src\/button\.jsx:2:17/, def);
	} finally {
		await s.close();
	}
});

const SHAPES_PY = `from typing import Protocol


class Shape(Protocol):
    def area(self) -> float: ...


class Sq:
    def __init__(self, s: float) -> None:
        self.s = s

    def area(self) -> float:
        return self.s * self.s


def total(xs: list[Shape]) -> float:
    return sum(x.area() for x in xs)
`;
const MAIN_PY = `from pkg.shapes import Sq, total


def run() -> float:
    return total([Sq(2)])
`;

test("Python：诊断、已消失、导航、调用关系", { timeout: 120_000 }, async () => {
	const root = project({ "pyproject.toml": "[project]\nname='demo'\n", "pkg/__init__.py": "", "pkg/shapes.py": SHAPES_PY, "main.py": MAIN_PY });
	const s = session(root);
	try {
		const main = join(root, "main.py");
		const shapes = join(root, "pkg/shapes.py");
		const diag = await s.edit("main.py", MAIN_PY.replace("return total([Sq(2)])", 'x: int = "s"\n    return total([Sq(2)])'));
		assert.match(diag, /main\.py:\n  ✘ \[Line 5:\d+\] Type "Literal\['s'\]" is not assignable to declared type "int"/, diag);
		assert.match(await s.edit("main.py", MAIN_PY), /main\.py: all previously reported issues are resolved/);
		const def = await s.lsp({ operation: "goToDefinition", filePath: main, ...pos(main, "total([", 1, 0) });
		assert.equal(def, `Defined in pkg/shapes.py:${pos(shapes, "def total").line}:5`);
		const refs = await s.lsp({ operation: "findReferences", filePath: shapes, ...pos(shapes, "def total", 1, 4) });
		assert.match(refs, /^Found 3 references across 2 files:/, refs);
		const hover = await s.lsp({ operation: "hover", filePath: shapes, ...pos(shapes, "def total", 1, 4) });
		assert.match(hover, /def total\(xs: list\[Shape\]\) -> float/, hover);
		const inc = await s.lsp({ operation: "incomingCalls", filePath: shapes, ...pos(shapes, "def total", 1, 4) });
		assert.match(inc, /run \(Function\) - Line 4/, inc);
		const ws = await s.until({ operation: "workspaceSymbol", filePath: main, line: 1, character: 1, query: "total" }, (t) => t.includes("total ("), 20_000);
		assert.match(ws, /total \(Function\)/, ws);
	} finally {
		await s.close();
	}
});

test("Python D-7：装在 .venv 里的第三方包，import 不报「无法解析」", { timeout: 180_000 }, async () => {
	const root = project({ "pyproject.toml": "[project]\nname='demo'\n", "app.py": "import vendoredpkg\n\nprint(vendoredpkg.VALUE)\n" });
	execFileSync("python3", ["-m", "venv", join(root, ".venv")]);
	const site = execFileSync(join(root, ".venv/bin/python"), ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"], { encoding: "utf8" }).trim();
	mkdirSync(join(site, "vendoredpkg"), { recursive: true });
	writeFileSync(join(site, "vendoredpkg/__init__.py"), "VALUE: int = 1\n");
	const s = session(root);
	try {
		const diag = await s.edit("app.py", "import vendoredpkg\n\nprint(vendoredpkg.VALUE)\n");
		assert.doesNotMatch(diag, /could not be resolved/, `装在 .venv 里的包不应报无法解析：${diag}`);
		const bad = await s.edit("app.py", "import notinstalledpkg\n");
		assert.match(bad, /Import "notinstalledpkg" could not be resolved/, "对照：真没装的包照常报错");
	} finally {
		await s.close();
	}
});

test("CSS：诊断、已消失、悬停、符号", { timeout: 60_000 }, async () => {
	const CSS = ".card {\n  color: red;\n}\n\n.title {\n  font-weight: bold;\n}\n";
	const root = project({ "a.css": CSS, ".git/HEAD": "" });
	const s = session(root);
	try {
		const css = join(root, "a.css");
		const diag = await s.edit("a.css", CSS.replace("color: red", "colr: red"));
		assert.match(diag, /a\.css:\n  ⚠ \[Line 2:3\] Unknown property: 'colr'/, diag);
		assert.match(await s.edit("a.css", CSS), /a\.css: all previously reported issues are resolved/);
		const hover = await s.lsp({ operation: "hover", filePath: css, ...pos(css, "color", 1, 1) });
		assert.match(hover, /Hover info at 2:3/, hover);
		const syms = await s.lsp({ operation: "documentSymbol", filePath: css, line: 1, character: 1 });
		assert.match(syms, /\.card \(Class\)|\.card/, syms);
	} finally {
		await s.close();
	}
});

test("HTML：没有诊断也不出错，符号可用", { timeout: 60_000 }, async () => {
	const HTML = '<!doctype html>\n<html>\n<head><title>x</title></head>\n<body>\n  <div id="app" class="p-4">hi</div>\n</body>\n</html>\n';
	const root = project({ "index.html": HTML, ".git/HEAD": "" });
	const s = session(root);
	try {
		const html = join(root, "index.html");
		const diag = await s.edit("index.html", HTML);
		assert.doesNotMatch(diag, /✘/);
		const syms = await s.lsp({ operation: "documentSymbol", filePath: html, line: 1, character: 1 });
		// HTML 服务器返回扁平的 SymbolInformation，按 Claude Code 的规则用工作区符号的格式输出。
		assert.match(syms, /^Found \d+ symbols in workspace:\n\nindex\.html:\n/, syms);
		assert.match(syms, /div#app\.p-4 \(Field\) - Line 5 in body/, syms);
	} finally {
		await s.close();
	}
});
