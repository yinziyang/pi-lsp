#!/usr/bin/env node
// E 组验收：在真实的 pi 进程里验证语言服务器的生命周期，不留死进程。
//
// 每个场景：以 RPC 模式启动只加载 pi-lsp 的 pi，让模型用 write 写一个 Go 文件把 gopls 拉起来，
// 记下 pi 名下的服务器进程（含 gopls 的 telemetry 子进程），执行场景动作，再检查这些进程在上限内全部退出。
// 会调用真实模型，每个场景一次很短的对话。
//
// 用法：node eval/pi/lifecycle.mjs [场景名...]，不带参数跑全部。

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../../extensions/pi-lsp/index.ts", import.meta.url));
const SERVER_RE = /gopls/;
const WRITE_PROMPT = "Use the write tool to create main.go with exactly this content and do nothing else:\npackage main\n\nfunc main() {}\n";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function processTable() {
	const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
	return out.split("\n").filter(Boolean).map((l) => {
		const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
		return { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] };
	});
}

/** pi 名下所有子孙里的语言服务器进程。 */
function serversUnder(pid) {
	const table = processTable();
	const kids = new Map();
	for (const p of table) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)).push(p);
	const out = [];
	const stack = [pid];
	while (stack.length) for (const c of kids.get(stack.pop()) ?? []) { out.push(c); stack.push(c.pid); }
	return out.filter((p) => SERVER_RE.test(p.command));
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

async function waitFor(pred, ms) {
	const end = Date.now() + ms;
	while (Date.now() < end) { if (pred()) return true; await sleep(100); }
	return pred();
}

function project() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-lsp-life-")));
	writeFileSync(join(dir, "go.mod"), "module example.com/life\n\ngo 1.22\n");
	return dir;
}

function startPi(cwd, sessionDir, extra = []) {
	mkdirSync(sessionDir, { recursive: true });
	const pi = spawn("pi", ["--mode", "rpc", "-ne", "-e", EXT, "--session-dir", sessionDir, ...extra], { cwd, stdio: ["pipe", "pipe", "pipe"] });
	pi.stdout.on("data", () => {});
	pi.stderr.on("data", () => {});
	pi.send = (o) => pi.stdin.write(JSON.stringify(o) + "\n");
	return pi;
}

/** 让模型写一个 Go 文件，等 gopls 在 pi 名下出现，返回服务器进程列表。 */
async function bringUpGopls(pi) {
	pi.send({ id: "w", type: "prompt", message: WRITE_PROMPT });
	const ok = await waitFor(() => serversUnder(pi.pid).length > 0, 120_000);
	if (!ok) throw new Error("gopls did not start under pi within 120s");
	await sleep(1500);
	return serversUnder(pi.pid);
}

const report = [];
function record(name, pass, detail) {
	report.push({ name, pass, detail });
	process.stdout.write(`${pass ? "PASS" : "FAIL"} ${name} — ${detail}\n`);
}

const scenarios = {
	/** E-1：正常退出（关闭 stdin），全过程不超过 7 秒，残留为 0。 */
	async quit() {
		const pi = startPi(project(), mkdtempSync(join(tmpdir(), "pi-lsp-sess-")));
		const servers = await bringUpGopls(pi);
		const t0 = Date.now();
		pi.stdin.end();
		const dead = await waitFor(() => servers.every((s) => !alive(s.pid)), 10_000);
		const took = Date.now() - t0;
		await waitFor(() => pi.exitCode !== null, 10_000);
		record("E-1 正常退出", dead && took <= 7000, `${servers.length} 个服务器进程，${took}ms 内全部退出${dead ? "" : "（有残留）"}`);
	},
	/** E-3：kill -9 强杀 pi，5 秒内服务器全部退出（靠管道断开）。 */
	async sigkill() {
		const pi = startPi(project(), mkdtempSync(join(tmpdir(), "pi-lsp-sess-")));
		const servers = await bringUpGopls(pi);
		const t0 = Date.now();
		process.kill(pi.pid, "SIGKILL");
		const dead = await waitFor(() => servers.every((s) => !alive(s.pid)), 5000);
		record("E-3 kill -9", dead, `${servers.length} 个服务器进程，${dead ? `${Date.now() - t0}ms 内全部退出` : "5 秒后仍有残留"}`);
	},
	/** E-4：SIGTERM 终止 pi，残留为 0。 */
	async sigterm() {
		const pi = startPi(project(), mkdtempSync(join(tmpdir(), "pi-lsp-sess-")));
		const servers = await bringUpGopls(pi);
		const t0 = Date.now();
		process.kill(pi.pid, "SIGTERM");
		const dead = await waitFor(() => servers.every((s) => !alive(s.pid)), 8000);
		record("E-4 SIGTERM", dead, `${servers.length} 个服务器进程，${dead ? `${Date.now() - t0}ms 内全部退出` : "8 秒后仍有残留"}`);
	},
	/** E-4：请求进行中 pi 被强杀（lsp 工具调用途中）。 */
	async crashMidRequest() {
		const pi = startPi(project(), mkdtempSync(join(tmpdir(), "pi-lsp-sess-")));
		const servers = await bringUpGopls(pi);
		pi.send({ id: "q", type: "prompt", message: "Call the lsp tool with operation workspaceSymbol, filePath main.go, line 1, character 1, query main. Then call it again with operation documentSymbol on main.go." });
		await sleep(3000);
		process.kill(pi.pid, "SIGKILL");
		const dead = await waitFor(() => servers.every((s) => !alive(s.pid)), 5000);
		record("E-4 请求中崩溃", dead, `${servers.length} 个服务器进程，${dead ? "全部退出" : "5 秒后仍有残留"}`);
	},
	/** E-2：新建会话后旧会话的服务器被清掉，新会话按需重新启动。 */
	async newSession() {
		const cwd = project();
		const pi = startPi(cwd, mkdtempSync(join(tmpdir(), "pi-lsp-sess-")));
		const servers = await bringUpGopls(pi);
		pi.send({ id: "n", type: "new_session" });
		const dead = await waitFor(() => servers.every((s) => !alive(s.pid)), 8000);
		const restarted = dead ? (await bringUpGopls(pi)).every((s) => !servers.some((o) => o.pid === s.pid)) : false;
		pi.stdin.end();
		await waitFor(() => pi.exitCode !== null, 10_000);
		const left = serversUnder(pi.pid).length;
		record("E-2 新建会话", dead && restarted && left === 0, `旧服务器${dead ? "已清掉" : "有残留"}，新会话${restarted ? "重新启动了新的实例" : "没有重新启动"}`);
	},
	/** E-2：切换到另一个会话（resume）后旧会话的服务器被清掉。 */
	async resume() {
		const cwd = project();
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-lsp-sess-"));
		const first = startPi(cwd, sessionDir);
		await bringUpGopls(first);
		first.stdin.end();
		await waitFor(() => first.exitCode !== null, 10_000);
		const oldSession = join(sessionDir, readdirSync(sessionDir).find((f) => f.endsWith(".jsonl")));
		const pi = startPi(cwd, mkdtempSync(join(tmpdir(), "pi-lsp-sess-")));
		const servers = await bringUpGopls(pi);
		pi.send({ id: "s", type: "switch_session", sessionPath: oldSession });
		const dead = await waitFor(() => servers.every((s) => !alive(s.pid)), 8000);
		pi.stdin.end();
		await waitFor(() => pi.exitCode !== null, 10_000);
		record("E-2 切换会话", dead, `切换后旧会话的 ${servers.length} 个服务器进程${dead ? "已清掉" : "有残留"}`);
	},
	/** E-7：两个 pi 同时用同一个项目，互不影响，分别退出后残留都为 0。 */
	async twoSessions() {
		const cwd = project();
		const a = startPi(cwd, mkdtempSync(join(tmpdir(), "pi-lsp-sess-")));
		const b = startPi(cwd, mkdtempSync(join(tmpdir(), "pi-lsp-sess-")));
		const [sa, sb] = await Promise.all([bringUpGopls(a), bringUpGopls(b)]);
		const disjoint = sa.every((x) => !sb.some((y) => y.pid === x.pid));
		process.kill(a.pid, "SIGKILL");
		const aDead = await waitFor(() => sa.every((s) => !alive(s.pid)), 5000);
		const bAlive = sb.every((s) => alive(s.pid));
		b.stdin.end();
		const bDead = await waitFor(() => sb.every((s) => !alive(s.pid)), 10_000);
		record("E-7 两个会话", disjoint && aDead && bAlive && bDead, `各自一套服务器：${disjoint}；杀掉 A 后 A 的服务器退出：${aDead}，B 的仍在：${bAlive}；B 退出后清掉：${bDead}`);
	},
	/** E-6：后台子代理在独立的 pi 进程里运行（pi --mode json -p），它结束后自己的服务器被清掉。 */
	async subagentProcess() {
		const cwd = project();
		const child = spawn("pi", ["--mode", "json", "-p", "-ne", "-e", EXT, "--no-session", WRITE_PROMPT], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.on("data", () => {});
		child.stderr.on("data", () => {});
		let seen = [];
		await waitFor(() => { const s = serversUnder(child.pid); if (s.length) seen = s; return child.exitCode !== null; }, 180_000);
		const dead = await waitFor(() => seen.every((s) => !alive(s.pid)), 8000);
		record("E-6 子代理进程", seen.length > 0 && dead, `子代理进程起过 ${seen.length} 个服务器进程，结束后${dead ? "全部退出" : "有残留"}`);
	},
};

const wanted = process.argv.slice(2);
for (const [name, run] of Object.entries(scenarios)) {
	if (wanted.length && !wanted.includes(name)) continue;
	try {
		await run();
	} catch (e) {
		record(name, false, `场景出错：${e.message}`);
	}
}
const failed = report.filter((r) => !r.pass).length;
process.stdout.write(`\n${report.length - failed}/${report.length} 通过\n`);
process.exit(failed ? 1 : 0);
