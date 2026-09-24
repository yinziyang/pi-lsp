#!/usr/bin/env node
// H-3 对照评测：装与不装 pi-lsp，在容易写出类型错误的小任务上比较最终代码能否通过编译 / 类型检查。
// 每个场景的任务都引用一个签名「不按直觉」的已有函数，照直觉写会出类型错误。
// 汇总前逐个核对每次运行：pi 正常退出、没有超时、有产出，否则该次记为作废而不是失败。
// 用法：node eval/pi/compare.mjs [轮数，默认 3]

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../../extensions/pi-lsp/index.ts", import.meta.url));
const REPO_TS = fileURLToPath(new URL("../../node_modules/typescript", import.meta.url));
const ROUNDS = Number(process.argv[2] ?? 3);

const SCENARIOS = [
	{
		name: "go",
		files: {
			"go.mod": "module example.com/cmp\n\ngo 1.22\n",
			"calc/calc.go": "package calc\n\n// Sum 返回所有值之和，单位是分。\nfunc Sum(values []int64) int64 {\n\tvar s int64\n\tfor _, v := range values {\n\t\ts += v\n\t}\n\treturn s\n}\n",
		},
		task: "Create main.go (package main) that builds a slice with the integers 1 to 10, passes it to calc.Sum from example.com/cmp/calc, and prints the result with fmt.Println. Keep it short. Do not run any shell commands.",
		check: (dir) => run("go", ["vet", "./..."], dir),
	},
	{
		name: "ts",
		files: {
			"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true } }),
			"user.ts": "export interface User {\n  id: number;\n  name: string;\n  /** 创建时间，毫秒时间戳 */\n  createdAt: number;\n  roles: ReadonlyArray<\"admin\" | \"member\">;\n}\n\nexport function describe(u: User): string {\n  return `${u.name} (${u.roles.join(\",\")})`;\n}\n",
		},
		setup: (dir) => { mkdirSync(join(dir, "node_modules"), { recursive: true }); symlinkSync(REPO_TS, join(dir, "node_modules/typescript")); },
		task: "Create main.ts that constructs a User named Ada with id 1 who is an admin, and logs describe(user) from ./user. Keep it short. Do not run any shell commands.",
		check: (dir) => run(process.execPath, [join(REPO_TS, "bin", "tsc"), "--noEmit", "-p", dir], dir),
	},
	{
		name: "python",
		files: {
			"pyproject.toml": "[project]\nname='cmp'\n",
			"inventory.py": "from dataclasses import dataclass\n\n\n@dataclass(frozen=True)\nclass Item:\n    sku: str\n    qty: int\n\n\ndef load() -> dict[str, Item]:\n    \"\"\"按 sku 索引的库存。\"\"\"\n    return {\"a\": Item(\"a\", 3), \"b\": Item(\"b\", 5)}\n",
		},
		task: "Create report.py that calls inventory.load() and prints the total quantity across all items, with a function total_qty() -> int that does the summing. Keep it short. Do not run any shell commands.",
		check: (dir) => run("pyright", ["-p", dir], dir),
	},
];

function run(cmd, args, cwd) {
	try {
		execFileSync(cmd, args, { cwd, stdio: "pipe", timeout: 120_000 });
		return true;
	} catch {
		return false;
	}
}

function project(s) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `pi-lsp-cmp-${s.name}-`)));
	for (const [rel, text] of Object.entries(s.files)) {
		mkdirSync(dirname(join(dir, rel)), { recursive: true });
		writeFileSync(join(dir, rel), text);
	}
	s.setup?.(dir);
	return dir;
}

const rows = [];
for (const s of SCENARIOS) {
	for (const variant of ["with", "without"]) {
		for (let r = 0; r < ROUNDS; r++) {
			const dir = project(s);
			const sess = mkdtempSync(join(tmpdir(), "pi-lsp-cmp-sess-"));
			const args = ["-p", "-ne", "--session-dir", sess, ...(variant === "with" ? ["-e", EXT] : []), s.task];
			const t0 = Date.now();
			const p = spawnSync("pi", args, { cwd: dir, encoding: "utf8", timeout: 600_000 });
			const secs = Math.round((Date.now() - t0) / 1000);
			const f = readdirSync(sess).find((x) => x.endsWith(".jsonl"));
			const entries = f ? readFileSync(join(sess, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
			const valid = p.status === 0 && entries.some((e) => e.type === "message" && e.message?.role === "assistant");
			const diags = entries.filter((e) => e.customType === "lsp-diagnostics").length;
			const pass = valid && s.check(dir);
			rows.push({ scenario: s.name, variant, valid, pass, diags, secs });
			process.stdout.write(`${s.name} ${variant} #${r + 1}: ${valid ? (pass ? "PASS" : "FAIL") : "作废"} diag=${diags} ${secs}s\n`);
		}
	}
}

process.stdout.write("\n| 场景 | 装 pi-lsp | 不装 |\n|---|---|---|\n");
for (const s of SCENARIOS) {
	const cell = (v) => {
		const rs = rows.filter((x) => x.scenario === s.name && x.variant === v && x.valid);
		return `${rs.filter((x) => x.pass).length}/${rs.length} 通过`;
	};
	process.stdout.write(`| ${s.name} | ${cell("with")} | ${cell("without")} |\n`);
}
const invalid = rows.filter((x) => !x.valid).length;
process.stdout.write(`\n作废 ${invalid} 次（pi 非正常退出或没有产出）\n`);
