// pi-lsp：为 pi 提供与 Claude Code 对齐的 LSP 能力。
//
// 本文件只做接线，把 pi 的事件接到各模块上：
//   - session_start：读设置、清理上一个 pi 遗留的服务器进程、建立路由与实例管理器、有可用服务器时注册 lsp 工具。
//   - tool_result：edit / write 成功后同步文件并短暂等待诊断（D5），bash 之后比对已打开文件（D6），随后把待送诊断用 steer 投递。
//   - agent_end：本轮结束后才到的诊断用 nextTurn 投递，在用户下次发消息时送达。
//   - session_shutdown：关闭本会话的全部服务器，每个都有上限。
// 生命周期的完整说明见 manager.ts 与 process.ts；设计依据见计划文档 docs/pi-lsp-plan.md。

import { execFile } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { loadSettings, type LspSettings } from "./config.ts";
import { DiagnosticsHub } from "./diagnostics.ts";
import { type Exec, installHint, installPlan, INSTALLABLE, type PlanContext, runInstall, serverForTarget, toolDirs } from "./install.ts";
import { ServerManager } from "./manager.ts";
import { PidRegistry } from "./process.ts";
import { resolveCommand, Router } from "./routing.ts";
import { createLspTool, type ToolRuntime } from "./tool.ts";

const MESSAGE_TYPE = "lsp-diagnostics";
/** D5：edit / write 之后等诊断的上限，毫秒，包含首次编辑时拉起服务器的时间；安静窗口见 diagnostics.ts 的 QUIET_MS。 */
const EDIT_WAIT_MS = 3000;

interface Runtime extends ToolRuntime {
	settings: LspSettings;
	router: Router;
	hub: DiagnosticsHub;
	planCtx: PlanContext;
	ctx: ExtensionContext;
	/** 本会话已经提示过「未安装」的服务器，每个只提示一次。 */
	warnedMissing: Set<string>;
}

/** 生产环境的命令执行：execFile，带超时与中止；不经过 shell。 */
const exec: Exec = (command, args, options) =>
	new Promise((res) => {
		execFile(command, args, { cwd: options.cwd, env: options.env, timeout: options.timeout, signal: options.signal, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
			// 非零退出时 err.code 是退出码；启动失败（ENOENT 等）时是字符串，统一记为 1。
			const raw = (err as { code?: unknown } | null)?.code;
			const code = err ? (typeof raw === "number" ? raw : 1) : 0;
			res({ code, stdout: String(stdout ?? ""), stderr: `${stderr ?? ""}${err && !stderr ? err.message : ""}` });
		});
	});

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
	return new Promise((res) => {
		const t = setTimeout(() => res(undefined), ms);
		p.then(
			(v) => { clearTimeout(t); res(v); },
			() => { clearTimeout(t); res(undefined); },
		);
	});
}

function plural(n: number, word: string): string {
	return `${n} ${n === 1 ? word : `${word}s`}`;
}

export default function piLsp(pi: ExtensionAPI) {
	let rt: Runtime | undefined;
	let toolRegistered = false;
	// 进程退出时的最后一道兜底：同步地对仍在运行的服务器进程组发 SIGTERM。正常路径是 session_shutdown。
	const liveManagers = new Set<ServerManager>();
	process.once("exit", () => {
		for (const m of liveManagers) {
			for (const inst of m.all) {
				const pid = inst.client.pid;
				if (pid === undefined) continue;
				try {
					process.kill(-pid, "SIGTERM");
				} catch {
					// 已退出。
				}
			}
		}
	});

	const flush = (deliverAs: "steer" | "nextTurn") => {
		const out = rt?.hub.take();
		if (!out) return;
		pi.sendMessage({ customType: MESSAGE_TYPE, content: out.text, display: true, details: { files: out.fileCount, issues: out.issueCount } }, { deliverAs });
	};

	/** 服务器没装时的处理：交互模式先确认再装；非交互模式开了 autoInstall 才装，否则只返回说明。 */
	const onMissing = async (r: Runtime, serverName: string, signal?: AbortSignal): Promise<{ installed: boolean; note: string }> => {
		const lang = INSTALLABLE.find((l) => serverForTarget(l) === serverName) ?? serverName;
		const plan = installPlan(lang, r.planCtx);
		if ("error" in plan) return { installed: false, note: installHint(serverName, r.planCtx) };
		const consent = r.ctx.hasUI ? await r.ctx.ui.confirm("Install language server?", `pi-lsp needs ${plan.label}. Install it into ${r.planCtx.lspDir}?`) : r.settings.autoInstall;
		if (!consent) return { installed: false, note: installHint(serverName, r.planCtx) };
		const result = await runInstall(plan, exec, process.env, signal);
		if (!result.ok) return { installed: false, note: `Installing ${plan.label} failed:\n${result.output.slice(-1500)}` };
		return { installed: true, note: "" };
	};

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
		const d = message.details as { files?: number; issues?: number } | undefined;
		const summary = d?.issues ? `Found ${plural(d.issues, "new diagnostic issue")} in ${plural(d.files ?? 0, "file")}` : `Diagnostics resolved in ${plural(d?.files ?? 0, "file")}`;
		const body = expanded ? `${summary}\n\n${String(message.content)}` : `${summary} ${theme.fg("dim", "(expand to view)")}`;
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(body, 0, 0));
		return box;
	});

	pi.on("session_start", (_event, ctx) => {
		const agentDir = getAgentDir();
		const lspDir = join(agentDir, "lsp");
		const { settings, warnings } = loadSettings({ agentDir, cwd: ctx.cwd, trusted: ctx.isProjectTrusted() });
		const dirs = toolDirs(lspDir);
		const registry = new PidRegistry(join(lspDir, "pids"));
		const swept = registry.sweep();
		const router = new Router(settings.servers, { cwd: ctx.cwd, toolDirs: dirs, env: process.env });
		const hub = new DiagnosticsHub(ctx.cwd);
		const manager = new ServerManager({ router, settings, hub, registry });
		liveManagers.add(manager);
		const planCtx: PlanContext = { lspDir, platform: process.platform, resolve: (c) => resolveCommand(c, dirs, [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter)) };
		const runtime: Runtime = {
			settings,
			router,
			hub,
			manager,
			planCtx,
			ctx,
			cwd: ctx.cwd,
			warnedMissing: new Set(),
			onMissing: (serverName, _command, signal) => onMissing(runtime, serverName, signal),
		};
		rt = runtime;
		// G-5：一个可用服务器都没有时不注册工具；安装之后在下次会话开始时注册。
		if (!toolRegistered && settings.servers.some((s) => router.available(s))) {
			pi.registerTool(createLspTool(() => rt));
			toolRegistered = true;
		}
		if (ctx.hasUI) {
			for (const w of warnings) ctx.ui.notify(`[pi-lsp] ${w}`, "warning");
			for (const c of router.conflicts) ctx.ui.notify(`[pi-lsp] ${c.ext} is handled by '${c.winner}'; '${c.loser}' will not be used for it`, "warning");
			if (swept > 0) ctx.ui.notify(`[pi-lsp] cleaned up ${plural(swept, "leftover language server process")}`, "info");
		}
	});

	pi.on("session_shutdown", async () => {
		const r = rt;
		rt = undefined;
		if (!r) return;
		r.hub.dispose();
		await r.manager.shutdownAll();
		liveManagers.delete(r.manager);
	});

	pi.on("tool_result", async (event, ctx) => {
		const r = rt;
		if (!r || event.isError) return;
		if (event.toolName === "edit" || event.toolName === "write") {
			const rawPath = (event.input as { path?: unknown }).path;
			if (typeof rawPath === "string") {
				const path = resolve(ctx.cwd, rawPath);
				const found = r.manager.lookup(path);
				if (found.kind === "missing" && ctx.hasUI && !r.warnedMissing.has(found.server.name)) {
					r.warnedMissing.add(found.server.name);
					ctx.ui.notify(`[pi-lsp] ${installHint(found.server.name, r.planCtx)}`, "info");
				}
				if (found.kind === "ok") {
					const deadline = Date.now() + EDIT_WAIT_MS;
					r.hub.markEdited(path);
					const synced = await withTimeout(r.manager.syncEdited(path), EDIT_WAIT_MS);
					const left = deadline - Date.now();
					if (synced && r.settings.diagnostics && synced.server.diagnostics && left > 0) await r.hub.waitFor(path, left, ctx.signal);
				}
			}
		} else if (event.toolName === "bash") {
			await withTimeout(r.manager.reconcileAll(), EDIT_WAIT_MS);
		}
		flush("steer");
	});

	pi.on("agent_end", () => flush("nextTurn"));

	pi.registerCommand("lsp", {
		description: "Language servers: /lsp (status), /lsp install <language>, /lsp restart [server]",
		getArgumentCompletions: (prefix) => {
			const words = ["install", "restart", ...INSTALLABLE.map((l) => `install ${l}`)];
			return words.filter((w) => w.startsWith(prefix)).map((w) => ({ value: w, label: w }));
		},
		handler: async (args, ctx) => {
			const r = rt;
			if (!r) return ctx.ui.notify("[pi-lsp] not initialized", "warning");
			const [sub, target] = args.trim().split(/\s+/);
			if (sub === "install") {
				if (!target) return ctx.ui.notify(`Usage: /lsp install <${INSTALLABLE.join("|")}>`, "warning");
				const plan = installPlan(target, r.planCtx);
				if ("error" in plan) return ctx.ui.notify(plan.error, "warning");
				ctx.ui.notify(`[pi-lsp] installing ${plan.label}…`, "info");
				const res = await runInstall(plan, exec, process.env);
				return ctx.ui.notify(res.ok ? `[pi-lsp] installed ${plan.label}` : `[pi-lsp] install failed:\n${res.output.slice(-1500)}`, res.ok ? "info" : "error");
			}
			if (sub === "restart") {
				const targets = r.manager.all.filter((i) => !target || i.server.name === target);
				if (targets.length === 0) return ctx.ui.notify(`[pi-lsp] no running instance${target ? ` of '${target}'` : ""}`, "warning");
				for (const inst of targets) {
					try {
						await r.manager.restart(inst);
					} catch (e) {
						ctx.ui.notify(`[pi-lsp] restart of '${inst.server.name}' failed: ${(e as Error).message}`, "error");
					}
				}
				return ctx.ui.notify(`[pi-lsp] restarted ${plural(targets.length, "instance")}`, "info");
			}
			ctx.ui.notify(statusText(r), "info");
		},
	});
}

/** /lsp 的状态文本：每个实例的状态、进程号、项目根、最近错误，以及未安装的服务器与扩展名冲突。 */
export function statusText(r: Pick<Runtime, "manager" | "router" | "settings">): string {
	const lines = ["pi-lsp servers:"];
	for (const s of r.settings.servers) {
		const insts = r.manager.all.filter((i) => i.server.name === s.name);
		if (insts.length === 0) {
			lines.push(`  ${s.name}: ${r.router.available(s) ? "not started" : "not installed"}`);
			continue;
		}
		for (const i of insts) {
			const err = i.client.lastError ? ` — last error: ${i.client.lastError.message.split("\n")[0]}` : "";
			lines.push(`  ${s.name}: ${i.client.state}${i.client.pid ? ` (pid ${i.client.pid})` : ""} root=${i.root} [${i.launch.label}]${err}`);
		}
	}
	for (const c of r.router.conflicts) lines.push(`  conflict: ${c.ext} → '${c.winner}' (ignored '${c.loser}')`);
	return lines.join("\n");
}
