#!/usr/bin/env node
// G-2、G-6 验收：真实 pi 里的安装确认与 /lsp 命令。
//   G-2：交互模式（RPC，ctx.hasUI 为真）下安装前先弹确认，拒绝则不装、只返回安装说明，同意则装好并继续完成请求；非交互模式（-p）未开 autoInstall 时不装，开了之后自动装。
//   G-6：/lsp 列出实例的状态、进程号与项目根；/lsp restart 之后换成新进程且旧进程已退出。
//   状态栏：会话开始写 LSP idle，安装期间写 installing，服务器就绪后写 pyright ✓（比较前去掉颜色控制符）。
// 用空的临时 agent 目录（只链接登录信息与模型配置）和只含系统目录的 PATH，让 pyright 处于「没装」状态；安装是真实的 npm 安装（联网，调用模型）。
// 用法：node eval/pi/ui.mjs

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../../extensions/pi-lsp/index.ts", import.meta.url));
const PI_CLI = realpathSync(spawnSync("which", ["pi"], { encoding: "utf8" }).stdout.trim());
// 只留系统目录：clangd（/usr/bin）可用，所以 lsp 工具会注册；pyright、gopls 等都找不到。
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const HOVER = "Call the lsp tool exactly once with operation hover, filePath main.py, line 1, character 1. Then reply with the tool output verbatim and stop. Do not use any other tool.";

function agentDir() {
	const dir = mkdtempSync(join(tmpdir(), "pi-lsp-ui-agent-"));
	const home = join(homedir(), ".pi", "agent");
	for (const f of ["auth.json", "models.json", "models-store.json"]) if (existsSync(join(home, f))) symlinkSync(join(home, f), join(dir, f));
	// 只沿用模型选择；去掉 packages，免得 pi 在新目录里重新拉取用户装的扩展包。
	const { packages: _packages, ...settings } = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2));
	return dir;
}

function project() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-lsp-ui-proj-")));
	writeFileSync(join(dir, "pyproject.toml"), "[project]\nname='ui'\n");
	writeFileSync(join(dir, "main.py"), "x: int = 1\n");
	return dir;
}

const installed = (agent) => existsSync(join(agent, "lsp", "node", "node_modules", ".bin", "pyright-langserver"));
const env = (agent) => ({ ...process.env, PATH: SYSTEM_PATH, PI_CODING_AGENT_DIR: agent });

/** RPC 模式的 pi 子进程：收集全部事件，按 confirmAnswer 自动应答确认框。 */
class Rpc {
	constructor(cwd, agent, confirmAnswer) {
		this.events = [];
		this.waiters = [];
		this.proc = spawn(process.execPath, [PI_CLI, "--mode", "rpc", "-ne", "-e", EXT, "--no-session"], { cwd, env: env(agent), stdio: ["pipe", "pipe", "pipe"] });
		this.exited = new Promise((r) => this.proc.once("exit", r));
		createInterface({ input: this.proc.stdout }).on("line", (line) => {
			let ev;
			try {
				ev = JSON.parse(line);
			} catch {
				return;
			}
			this.events.push(ev);
			if (ev.type === "extension_ui_request" && ev.method === "confirm") this.send({ type: "extension_ui_response", id: ev.id, confirmed: confirmAnswer });
			for (const w of [...this.waiters]) if (w.pred(ev)) w.resolve(ev);
		});
	}
	send(obj) {
		this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
	}
	/** 等到满足 pred 的下一个事件；超时返回 undefined。 */
	next(pred, ms) {
		return new Promise((resolve) => {
			const w = { pred, resolve: (ev) => { clearTimeout(t); this.waiters.splice(this.waiters.indexOf(w), 1); resolve(ev); } };
			const t = setTimeout(() => w.resolve(undefined), ms);
			this.waiters.push(w);
		});
	}
	async prompt(message, ms = 300_000) {
		const done = this.next((e) => e.type === "agent_end", ms);
		this.send({ type: "prompt", id: `p${this.events.length}`, message });
		return done;
	}
	async command(message) {
		const note = this.next((e) => e.type === "extension_ui_request" && e.method === "notify" && String(e.message).includes("pi-lsp"), 60_000);
		this.send({ type: "prompt", id: `c${this.events.length}`, message });
		return (await note)?.message ?? "";
	}
	async close() {
		this.proc.stdin.end();
		const t = setTimeout(() => this.proc.kill("SIGKILL"), 10_000);
		await this.exited;
		clearTimeout(t);
	}
	text() {
		return this.events.map((e) => JSON.stringify(e)).join("\n");
	}
}

function alive(pid) {
	try {
		process.kill(pid, 0);
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

// G-2 交互模式：先拒绝，再同意。
const agentA = agentDir();
{
	const rpc = new Rpc(project(), agentA, false);
	await rpc.prompt(HOVER);
	const asked = rpc.events.some((e) => e.type === "extension_ui_request" && e.method === "confirm" && e.title === "Install language server?");
	const hint = rpc.text().includes("Run /lsp install python");
	await rpc.close();
	record("G-2 交互模式拒绝安装", asked && hint && !installed(agentA), `弹出确认：${asked}；工具结果带安装说明：${hint}；未安装：${!installed(agentA)}`);
}

let rpcB;
{
	rpcB = new Rpc(project(), agentA, true);
	await rpcB.prompt(HOVER, 600_000);
	const asked = rpcB.events.some((e) => e.type === "extension_ui_request" && e.method === "confirm");
	const hovered = rpcB.events.some((e) => e.type === "tool_execution_end" && JSON.stringify(e.result ?? "").includes("Hover info at 1:1"));
	record("G-2 交互模式同意安装", asked && installed(agentA) && hovered, `弹出确认：${asked}；已安装到临时 agent 目录：${installed(agentA)}；装好后同一次调用拿到 hover：${hovered}`);
	const statuses = rpcB.events.filter((e) => e.type === "extension_ui_request" && e.method === "setStatus" && e.statusKey === "zz-pi-lsp").map((e) => String(e.statusText ?? "").replace(/\x1b\[[0-9;]*m/g, ""));
	const sawInstalling = statuses.some((t) => /^LSP installing /.test(t));
	const sawRunning = statuses.some((t) => /pyright ✓/.test(t));
	record("状态栏跟随实例状态", statuses[0] === "LSP idle" && sawInstalling && sawRunning, `依次写入：${JSON.stringify(statuses)}`);
}

// G-6：/lsp 与 /lsp restart。
{
	const pidOf = (s) => Number(/pyright: running \(pid (\d+)\)/.exec(s)?.[1] ?? 0);
	const before = await rpcB.command("/lsp");
	const pid1 = pidOf(before);
	const restarted = await rpcB.command("/lsp restart pyright");
	const after = await rpcB.command("/lsp");
	const pid2 = pidOf(after);
	const rooted = before.includes("root=");
	await new Promise((r) => setTimeout(r, 500));
	const oldGone = pid1 > 0 && !alive(pid1);
	await rpcB.close();
	record("G-6 /lsp 状态与重启", pid1 > 0 && rooted && restarted.includes("restarted 1 instance") && pid2 > 0 && pid2 !== pid1 && oldGone && !alive(pid2), `重启前 pid ${pid1}，重启后 pid ${pid2}；状态含项目根：${rooted}；重启提示：${JSON.stringify(restarted)}；旧进程已退出：${oldGone}；关闭 pi 后新进程已退出：${!alive(pid2)}`);
	process.stdout.write(`# /lsp 输出：\n${before}\n`);
}

// G-2 非交互模式：未开 autoInstall 不装，开了自动装。
const agentC = agentDir();
{
	const run = () => spawnSync(process.execPath, [PI_CLI, "--mode", "json", "-p", "-ne", "-e", EXT, "--no-session", HOVER], { cwd: project(), env: env(agentC), encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 }).stdout ?? "";
	const off = run();
	const hint = off.includes("Run /lsp install python");
	record("G-2 非交互模式默认不装", hint && !installed(agentC), `工具结果带安装说明：${hint}；未安装：${!installed(agentC)}`);

	const settings = JSON.parse(readFileSync(join(agentC, "settings.json"), "utf8"));
	writeFileSync(join(agentC, "settings.json"), JSON.stringify({ ...settings, lsp: { autoInstall: true } }, null, 2));
	const on = run();
	const hovered = on.includes("Hover info at 1:1");
	record("G-2 非交互模式开 autoInstall 后自动装", installed(agentC) && hovered, `已安装：${installed(agentC)}；拿到 hover：${hovered}`);
}

const failed = results.filter((x) => !x).length;
process.stdout.write(`\n${results.length - failed}/${results.length} 通过\n`);
process.exit(failed ? 1 : 0);
