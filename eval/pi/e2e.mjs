#!/usr/bin/env node
// H-1、H-2 验收：真实模型在 pi 里使用 pi-lsp。
//   H-1：模型写入一个有类型错误的 Go 文件，收到诊断后改对，会话里先出现报错诊断、后出现「已消失」，最终代码能通过 go vet。
//   H-2：与用户已安装的扩展（pi-coding-standards、pi-subagents 等）一起加载时，两边的提示都在；子代理的运行方式（独立 pi 进程）里诊断送给它自己（D12）。
// 用法：node eval/pi/e2e.mjs [h1|h2|subagent]

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../../extensions/pi-lsp/index.ts", import.meta.url));
const BROKEN = 'package main\n\nimport "fmt"\n\n// Add 返回两数之和。\nfunc Add(a, b int) int {\n\treturn a + b\n}\n\nfunc main() {\n\tvar total int = Add(1, 2) + "3"\n\tfmt.Println(total)\n}\n';
const PROMPT = `Use the write tool to create main.go with exactly the following content. After writing it, fix every problem the tools report, using the edit tool, until there are no problems left. Then reply DONE.\n\n${BROKEN}`;

function project() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-lsp-e2e-")));
	writeFileSync(join(dir, "go.mod"), "module example.com/e2e\n\ngo 1.22\n");
	return dir;
}

function runPi(cwd, args, timeoutMs = 600_000) {
	const r = spawnSync("pi", args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function sessionEntries(dir) {
	const f = readdirSync(dir).find((x) => x.endsWith(".jsonl"));
	return f ? readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

const lspMessages = (entries) => entries.filter((e) => e.customType === "lsp-diagnostics").map((e) => String(e.content));

function goVet(cwd) {
	try {
		execFileSync("go", ["vet", "./..."], { cwd, stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const results = [];
const record = (name, pass, detail) => {
	results.push(pass);
	process.stdout.write(`${pass ? "PASS" : "FAIL"} ${name} — ${detail}\n`);
};

const which = process.argv[2] ?? "all";

if (which === "all" || which === "h1") {
	const cwd = project();
	const sess = mkdtempSync(join(tmpdir(), "pi-lsp-e2e-sess-"));
	runPi(cwd, ["-p", "-ne", "-e", EXT, "--session-dir", sess, PROMPT]);
	const msgs = lspMessages(sessionEntries(sess));
	const sawError = msgs.some((m) => m.includes("✘") && m.includes("main.go"));
	const sawResolved = msgs.some((m) => m.includes("main.go: all previously reported issues are resolved"));
	const vet = goVet(cwd);
	record("H-1 端到端", sawError && sawResolved && vet, `诊断消息 ${msgs.length} 条；出现报错：${sawError}；出现「已消失」：${sawResolved}；go vet 通过：${vet}`);
}

if (which === "all" || which === "h2") {
	const cwd = project();
	const sess = mkdtempSync(join(tmpdir(), "pi-lsp-e2e-sess-"));
	// 不加 -ne：加载用户已安装的全部扩展（其中有 pi-coding-standards 与 pi-subagents），再加上 pi-lsp。
	runPi(cwd, ["-p", "-e", EXT, "--session-dir", sess, PROMPT]);
	const entries = sessionEntries(sess);
	const msgs = lspMessages(entries);
	const standards = entries.some((e) => JSON.stringify(e).includes("write-check") || e.customType?.startsWith("coding-standards"));
	const sawError = msgs.some((m) => m.includes("✘"));
	record("H-2 共存", sawError && standards && goVet(cwd), `LSP 诊断消息 ${msgs.length} 条（含报错：${sawError}）；pi-coding-standards 的提示出现：${standards}`);
}

if (which === "all" || which === "subagent") {
	const cwd = project();
	// 子代理的运行方式：独立 pi 进程、json 模式、不保存会话。诊断应送给这个进程自己的对话（D12）。
	const r = runPi(cwd, ["--mode", "json", "-p", "-ne", "-e", EXT, "--no-session", PROMPT]);
	const delivered = r.stdout.includes("lsp-diagnostics") && r.stdout.includes("new-diagnostics");
	record("H-2 子代理就地收到诊断", delivered && goVet(cwd), `子代理进程的事件流里出现诊断消息：${delivered}`);
}

const failed = results.filter((x) => !x).length;
process.stdout.write(`\n${results.length - failed}/${results.length} 通过\n`);
process.exit(failed ? 1 : 0);
