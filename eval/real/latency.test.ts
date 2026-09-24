// H-4：推送快的服务器（clangd、gopls、pyright），edit 之后增加的等待中位数不超过 0.5 秒，任何一次不超过 3 秒。
// 等待从同步文件开始算到诊断等待结束，出错与修好交替各编辑 10 次；服务器已预热，不含首次启动。

import assert from "node:assert/strict";
import { test } from "node:test";
import { project, session } from "./harness.ts";

const CASES: { name: string; files: Record<string, string>; file: string; good: string; bad: string }[] = [
	{ name: "gopls", files: { "go.mod": "module example.com/l\n\ngo 1.22\n", "main.go": "package main\n\nfunc main() {}\n" }, file: "main.go", good: "package main\n\nfunc main() {}\n", bad: 'package main\n\nfunc main() { var x int = "s"; _ = x }\n' },
	{ name: "clangd", files: { "compile_flags.txt": "-std=c11\n", "main.c": "int main(void) { return 0; }\n" }, file: "main.c", good: "int main(void) { return 0; }\n", bad: "int main(void) { return nope; }\n" },
	{ name: "pyright", files: { "pyproject.toml": "[project]\nname='l'\n", "main.py": "x: int = 1\n" }, file: "main.py", good: "x: int = 1\n", bad: 'x: int = "s"\n' },
];

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

for (const c of CASES) {
	test(`H-4 ${c.name}：编辑后增加的等待中位数 ≤ 500ms，最大 ≤ 3000ms`, { timeout: 120_000 }, async () => {
		const root = project(c.files);
		const s = session(root);
		try {
			await s.edit(c.file, c.good);
			await s.edit(c.file, c.bad);
			const times: number[] = [];
			for (let i = 0; i < 10; i++) {
				const t0 = Date.now();
				// 上一次写入的是 bad，从 good 开始交替，保证每次内容都真的变了。
				await s.edit(c.file, i % 2 ? c.bad : c.good);
				times.push(Date.now() - t0);
			}
			const m = median(times);
			process.stdout.write(`# ${c.name} 等待（ms）：${times.join(", ")}；中位数 ${m}\n`);
			assert.ok(m <= 500, `${c.name} 中位数 ${m}ms 超过 500ms`);
			assert.ok(Math.max(...times) <= 3000, `${c.name} 最大 ${Math.max(...times)}ms 超过 3000ms`);
		} finally {
			await s.close();
		}
	});
}
