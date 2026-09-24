#!/usr/bin/env node
// 导航类问题上模型会不会用 lsp 工具：在用户真实的扩展环境里，比较不同版本的 pi-lsp。
// 做法：建一个临时 agent 目录，除 pi-lsp 包外全部链接到 ~/.pi/agent（其余扩展照常加载），pi-lsp 包换成要比较的目录。
// 每一轮在本仓库的一份新克隆里问同一个问题，统计 lsp 调用与 grep / rg 调用，并核对 pi 正常退出、有助手产出。
// 用法：node eval/pi/nav.mjs <轮数> <名字>=<pi-lsp 目录> [<名字>=<目录> ...] [--model <provider>/<id>] [--question refs|chain]

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const HOME_AGENT = join(homedir(), ".pi", "agent");
const PKG_PARENT = join("git", "github.com", "yinziyang");
const QUESTIONS = {
	// 按名字找调用处：文本搜索一步就能答，用来看模型在「grep 也行」的问题上会不会用 lsp。
	refs: "DiagnosticsHub 的 markEdited 都在哪些地方被调用？如果给它加一个参数，要改哪些地方？",
	// 追调用链：文本搜索要一层层反复搜，调用关系查询更合适。
	chain: "ServerManager.syncEdited 的上游调用链是什么？谁调用了它，调用它的函数又被谁调用，一直追到 pi 的事件入口。只看生产代码，不看测试。",
};

const argv = process.argv.slice(2);
const modelAt = argv.indexOf("--model");
const model = modelAt >= 0 ? argv.splice(modelAt, 2)[1] : undefined;
const questionAt = argv.indexOf("--question");
const QUESTION = QUESTIONS[questionAt >= 0 ? argv.splice(questionAt, 2)[1] : "refs"];
if (!QUESTION) throw new Error(`--question 只能是 ${Object.keys(QUESTIONS).join(" 或 ")}`);
const rounds = Number(argv.shift() ?? 3);
const variants = argv.map((a) => {
	const [name, dir] = a.split("=");
	return { name, dir: realpathSync(dir) };
});
if (variants.length === 0) throw new Error("至少给一个 <名字>=<pi-lsp 目录>");

/** 临时 agent 目录：顶层条目都链接回用户目录，只有 pi-lsp 包指向 pkgDir。 */
function agentDir(pkgDir) {
	const dir = mkdtempSync(join(tmpdir(), "pi-lsp-nav-agent-"));
	for (const name of readdirSync(HOME_AGENT)) {
		if (name === "git" || name === "sessions") continue;
		symlinkSync(join(HOME_AGENT, name), join(dir, name));
	}
	const gitHome = join(HOME_AGENT, "git");
	for (const host of readdirSync(gitHome)) {
		if (host !== "github.com") {
			mkdirSync(join(dir, "git"), { recursive: true });
			symlinkSync(join(gitHome, host), join(dir, "git", host));
		}
	}
	mkdirSync(join(dir, PKG_PARENT), { recursive: true });
	for (const pkg of readdirSync(join(HOME_AGENT, PKG_PARENT))) {
		symlinkSync(pkg === "pi-lsp" ? pkgDir : join(HOME_AGENT, PKG_PARENT, pkg), join(dir, PKG_PARENT, pkg));
	}
	return dir;
}

/** 本仓库的一份新克隆，node_modules 链接回来，模型即使改了文件也不影响仓库。 */
function project() {
	const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "pi-lsp-nav-proj-"))), "pi-lsp");
	execFileSync("git", ["clone", "-q", "--local", REPO, dir]);
	symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
	return dir;
}

function toolCalls(sessDir) {
	const f = readdirSync(sessDir).find((x) => x.endsWith(".jsonl"));
	const entries = f ? readFileSync(join(sessDir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	const calls = entries.flatMap((e) => (e.type === "message" && e.message?.role === "assistant" && Array.isArray(e.message.content) ? e.message.content.filter((c) => c.type === "toolCall") : []));
	const hasAnswer = entries.some((e) => e.type === "message" && e.message?.role === "assistant" && e.message.content?.some?.((c) => c.type === "text" && c.text.trim()));
	return { calls, hasAnswer, lspInTools: entries.some((e) => e.message?.toolsAdded?.some((t) => t.name === "lsp")) };
}

const rows = [];
for (const v of variants) {
	const agent = agentDir(v.dir);
	for (let r = 0; r < rounds; r++) {
		const sess = mkdtempSync(join(tmpdir(), "pi-lsp-nav-sess-"));
		const args = ["-p", "--session-dir", sess, ...(model ? ["--model", model] : []), QUESTION];
		const t0 = Date.now();
		const p = spawnSync("pi", args, { cwd: project(), env: { ...process.env, PI_CODING_AGENT_DIR: agent }, encoding: "utf8", timeout: 600_000 });
		const { calls, hasAnswer, lspInTools } = toolCalls(sess);
		const lsp = calls.filter((c) => c.name === "lsp").length;
		const grep = calls.filter((c) => c.name === "bash" && /\b(grep|rg)\b/.test(String(c.arguments?.command ?? ""))).length;
		const valid = p.status === 0 && hasAnswer && lspInTools;
		rows.push({ variant: v.name, valid, lsp, grep });
		process.stdout.write(`${v.name} #${r + 1}: ${valid ? "" : "作废 "}lsp=${lsp} grep=${grep} 工具总数=${calls.length} ${Math.round((Date.now() - t0) / 1000)}s\n`);
	}
}

process.stdout.write("\n| 版本 | 用了 lsp 的轮数 | 平均 lsp 调用 | 平均 grep/rg 调用 |\n|---|---|---|---|\n");
for (const v of variants) {
	const rs = rows.filter((x) => x.variant === v.name && x.valid);
	const avg = (k) => (rs.length ? (rs.reduce((s, x) => s + x[k], 0) / rs.length).toFixed(1) : "-");
	process.stdout.write(`| ${v.name} | ${rs.filter((x) => x.lsp > 0).length}/${rs.length} | ${avg("lsp")} | ${avg("grep")} |\n`);
}
process.stdout.write(`\n作废 ${rows.filter((x) => !x.valid).length} 次（pi 非正常退出、没有产出，或工具列表里没有 lsp）\n`);
