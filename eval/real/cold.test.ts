// D13：服务器用到才启动，所以每个会话的第一次查询都落在服务器刚启动、还在加载工程的时刻。
// 修复前实测：typescript-language-server 只返回当前文件里的引用，rust-analyzer 返回空，pyright 只返回 1 条，都不报错。
// 这里每个用例都是新起的服务器，第一次 findReferences 就必须拿到完整结果，不允许反复重试。
// COLD_NO_WAIT=1 时关掉就绪等待，用来对照修复前的行为（预期失败）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pos, project, session } from "./harness.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const readiness = process.env.COLD_NO_WAIT ? { minMs: 0, quietMs: 0, maxMs: 0 } : undefined;
const has = (cmd: string) => {
	try {
		execFileSync("which", [cmd], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

/** 本仓库的一份克隆：真实规模的 TS 工程，冷启动加载要一两秒。 */
function repoClone(): string {
	const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "pi-lsp-cold-"))), "pi-lsp");
	execFileSync("git", ["clone", "-q", "--local", REPO, dir]);
	symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
	return dir;
}

async function firstReferences(root: string, rel: string, at: { line: number; character: number }): Promise<string> {
	const s = session(root, root, readiness);
	try {
		return await s.lsp({ operation: "findReferences", filePath: rel, ...at });
	} finally {
		await s.close();
	}
}

test("D13 TypeScript：冷启动后第一次 findReferences 就拿到跨文件的全部引用", { timeout: 60_000 }, async () => {
	const root = repoClone();
	const rel = "extensions/pi-lsp/diagnostics.ts";
	const out = await firstReferences(root, rel, pos(join(root, rel), "markEdited(path"));
	const files = Number(/across (\d+) files/.exec(out)?.[1] ?? 1);
	assert.ok(files >= 3, `只拿到 ${files} 个文件里的引用：${out.split("\n")[0]}`);
});

test("D13 Python：冷启动后第一次 findReferences 就拿到全部引用", { timeout: 60_000, skip: !has("pyright-langserver") && "没有 pyright-langserver" }, async () => {
	const root = project({ "pyproject.toml": "[project]\nname='p'\n", "lib.py": "def add(a: int, b: int) -> int:\n    return a + b\n", "main.py": "from lib import add\n\nadd(1, 2)\nadd(3, 4)\n" });
	const out = await firstReferences(root, "lib.py", pos(join(root, "lib.py"), "add"));
	assert.match(out, /^Found 4 references across 2 files:/, out);
});

test("D13 Rust：冷启动后第一次 findReferences 就拿到全部引用", { timeout: 60_000, skip: !has("rust-analyzer") && "没有 rust-analyzer" }, async () => {
	const root = project({ "Cargo.toml": '[package]\nname = "p"\nversion = "0.1.0"\nedition = "2021"\n', "src/lib.rs": "pub fn add(a: i32, b: i32) -> i32 { a + b }\n", "src/main.rs": "fn main() { let _ = p::add(1, 2); let _ = p::add(3, 4); }\n" });
	const out = await firstReferences(root, "src/lib.rs", pos(join(root, "src/lib.rs"), "add"));
	assert.match(out, /^Found 3 references across 2 files:/, out);
});
