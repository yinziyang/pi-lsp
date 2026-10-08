#!/usr/bin/env node
// 导航类问题上模型会不会用 lsp 工具：在用户真实的扩展环境里，比较不同版本的 pi-lsp。
// 做法：建一个临时 agent 目录，除 pi-lsp 包外全部链接到 ~/.pi/agent（其余扩展照常加载），pi-lsp 包换成要比较的目录。
// 每一轮在一份新的工程里问同一个问题，统计 lsp 调用与 grep / rg 调用，并核对 pi 正常退出、有助手产出、答案含预期内容。
// 工程是本仓库的克隆（refs、chain），或 fixtures/godep 下的 Go 工程（dbdef、dep、unit）：它依赖的模块只在模块缓存里，不在工作区。
// 用法：node eval/pi/nav.mjs <轮数> <名字>=<pi-lsp 目录> [<名字>=<目录> ...] [--model <provider>/<id>] [--question refs|chain|dbdef|dep|unit]

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const HOME_AGENT = join(homedir(), ".pi", "agent");
const PKG_PARENT = join("git", "github.com", "yinziyang");
const GODEP = join(REPO, "eval", "pi", "fixtures", "godep");
const QUESTIONS = {
	// 按名字找调用处：文本搜索一步就能答，用来看模型在「grep 也行」的问题上会不会用 lsp。
	refs: { prompt: "DiagnosticsHub 的 markEdited 都在哪些地方被调用？如果给它加一个参数，要改哪些地方？", project: "self" },
	// 追调用链：文本搜索要一层层反复搜，调用关系查询更合适。
	chain: { prompt: "ServerManager.syncEdited 的上游调用链是什么？谁调用了它，调用它的函数又被谁调用，一直追到 pi 的事件入口。只看生产代码，不看测试。", project: "self" },
	// 复现真实会话的原话：问题模糊，工程里有 SQL、文档、仓储层等干扰，表定义只在模块缓存里的依赖中。
	dbdef: { prompt: "当前项目的数据库定义在哪里的？", project: "godep", expect: /tables\.go/ },
	// 找依赖模块里的定义：问题不给符号名，定义只在模块缓存里，工作区内 grep 找不到；在用到它的地方 goToDefinition 一步就到。
	dep: { prompt: "这个服务读写的订单表是在哪里定义的？订单金额字段叫什么、单位是什么？", project: "godep", expect: /厘/ },
	// 看依赖里字段的文档：字段名就在工作区，说明只在模块缓存里，hover 一步就到。
	unit: { prompt: "cmd/server/main.go 里传给 shopdb.Open 的 IdleTimeout: 30，单位是什么？", project: "godep", expect: /分钟/ },
};

const argv = process.argv.slice(2);
const modelAt = argv.indexOf("--model");
const model = modelAt >= 0 ? argv.splice(modelAt, 2)[1] : undefined;
const questionAt = argv.indexOf("--question");
const QUESTION = QUESTIONS[questionAt >= 0 ? argv.splice(questionAt, 2)[1] : "refs"];
if (!QUESTION) throw new Error(`--question 只能是 ${Object.keys(QUESTIONS).join("、")} 之一`);
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
function selfProject() {
	const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "pi-lsp-nav-proj-"))), "pi-lsp");
	execFileSync("git", ["clone", "-q", "--local", REPO, dir]);
	symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
	return dir;
}

/**
 * 把 fixtures/godep/shopdb 发布成本地 GOPROXY 上的 example.com/shopdb v1.0.0，下载进一个临时模块缓存。
 * 返回之后运行 pi 用的环境变量：gopls 与模型执行的 go 命令都只看这个缓存，且不联网。
 */
function godepEnv() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-lsp-nav-godep-")));
	const v = join(root, "proxy", "example.com", "shopdb", "@v");
	const src = join(root, "zip", "example.com", "shopdb@v1.0.0");
	mkdirSync(v, { recursive: true });
	cpSync(join(GODEP, "shopdb"), src, { recursive: true });
	// 模块 zip 不能含目录条目，-D 只打文件。
	execFileSync("zip", ["-qrD", join(v, "v1.0.0.zip"), "example.com"], { cwd: join(root, "zip") });
	copyFileSync(join(GODEP, "shopdb", "go.mod"), join(v, "v1.0.0.mod"));
	writeFileSync(join(v, "list"), "v1.0.0\n");
	writeFileSync(join(v, "v1.0.0.info"), JSON.stringify({ Version: "v1.0.0", Time: "2026-01-01T00:00:00Z" }));
	const env = { GOMODCACHE: join(root, "modcache"), GOSUMDB: "off", GOFLAGS: "-mod=mod" };
	execFileSync("go", ["mod", "download", "example.com/shopdb"], { cwd: join(GODEP, "shopapp"), env: { ...process.env, ...env, GOPROXY: `file://${join(root, "proxy")}` } });
	return { ...env, GOPROXY: "off" };
}

/** fixtures/godep/shopapp 的一份新拷贝，初始化成 git 仓库，与真实工程一致。 */
function godepProject() {
	const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "pi-lsp-nav-proj-"))), "shopapp");
	cpSync(join(GODEP, "shopapp"), dir, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: dir });
	return dir;
}

function toolCalls(sessDir) {
	const f = readdirSync(sessDir).find((x) => x.endsWith(".jsonl"));
	const entries = f ? readFileSync(join(sessDir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	const calls = entries.flatMap((e) => (e.type === "message" && e.message?.role === "assistant" && Array.isArray(e.message.content) ? e.message.content.filter((c) => c.type === "toolCall") : []));
	const hasAnswer = entries.some((e) => e.type === "message" && e.message?.role === "assistant" && e.message.content?.some?.((c) => c.type === "text" && c.text.trim()));
	const answer = entries.filter((e) => e.type === "message" && e.message?.role === "assistant" && Array.isArray(e.message.content)).flatMap((e) => e.message.content.filter((c) => c.type === "text").map((c) => c.text)).join("\n");
	return { calls, hasAnswer, answer, lspInTools: entries.some((e) => e.message?.toolsAdded?.some((t) => t.name === "lsp")) };
}

const extraEnv = QUESTION.project === "godep" ? godepEnv() : {};
const project = QUESTION.project === "godep" ? godepProject : selfProject;
const rows = [];
for (const v of variants) {
	const agent = agentDir(v.dir);
	for (let r = 0; r < rounds; r++) {
		const sess = mkdtempSync(join(tmpdir(), "pi-lsp-nav-sess-"));
		const args = ["-p", "--session-dir", sess, ...(model ? ["--model", model] : []), QUESTION.prompt];
		const t0 = Date.now();
		const p = spawnSync("pi", args, { cwd: project(), env: { ...process.env, ...extraEnv, PI_CODING_AGENT_DIR: agent }, encoding: "utf8", timeout: 600_000 });
		const { calls, hasAnswer, answer, lspInTools } = toolCalls(sess);
		// codemode 工具在一段脚本里调用其他工具，脚本里的 tools.lsp(...) 与 grep / rg 也要算上。
		const code = (c) => (c.name === "codemode" ? String(c.arguments?.code ?? "") : "");
		const lsp = calls.filter((c) => c.name === "lsp").length + calls.reduce((n, c) => n + (code(c).match(/tools\.lsp\(/g)?.length ?? 0), 0);
		const grep = calls.filter((c) => (c.name === "bash" && /\b(grep|rg)\b/.test(String(c.arguments?.command ?? ""))) || /\b(grep|rg)\b/.test(code(c))).length;
		const valid = p.status === 0 && hasAnswer && lspInTools;
		const right = !QUESTION.expect || QUESTION.expect.test(answer);
		const secs = Math.round((Date.now() - t0) / 1000);
		rows.push({ variant: v.name, valid, lsp, grep, right, tools: calls.length, secs });
		process.stdout.write(`${v.name} #${r + 1}: ${valid ? "" : "作废 "}lsp=${lsp} grep=${grep} 工具总数=${calls.length} ${right ? "" : "答错 "}${secs}s 会话=${sess}\n`);
	}
}

process.stdout.write("\n| 版本 | 用了 lsp 的轮数 | 平均 lsp 调用 | 平均 grep/rg 调用 | 平均工具调用 | 平均耗时 | 答对 |\n|---|---|---|---|---|---|---|\n");
for (const v of variants) {
	const rs = rows.filter((x) => x.variant === v.name && x.valid);
	const avg = (k) => (rs.length ? (rs.reduce((s, x) => s + x[k], 0) / rs.length).toFixed(1) : "-");
	process.stdout.write(`| ${v.name} | ${rs.filter((x) => x.lsp > 0).length}/${rs.length} | ${avg("lsp")} | ${avg("grep")} | ${avg("tools")} | ${avg("secs")}s | ${rs.filter((x) => x.right).length}/${rs.length} |\n`);
}
process.stdout.write(`\n作废 ${rows.filter((x) => !x.valid).length} 次（pi 非正常退出、没有产出，或工具列表里没有 lsp）\n`);
