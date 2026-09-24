// 服务器实例管理：每个「服务器 + 项目根」一个实例，懒启动、崩溃计数、空闲回收、会话结束时全部关闭。
//
// 生命周期不变量（计划文档 4.4）：每个实例都会在以下时机之一被关闭，不留死进程。
//   - shutdownAll()：会话结束时调用，所有实例并行关闭，每个实例的关闭都有上限。
//   - 空闲回收：没有请求、也没有文件同步超过 idleTimeoutMs，就关闭它，下次用到再懒启动（D1）。
//   - 崩溃：进程已退出，client 里已清理进程组与记录。
// 崩溃与启动失败的计数语义与 Claude Code 相同：连续失败超过 maxRestarts 就放弃，成功启动一次清零；restartOnCrash 为 false 时崩溃后不再启动。

import { readFile, stat } from "node:fs/promises";
import type { LspSettings, ServerConfig } from "./config.ts";
import { LspClient } from "./client.ts";
import type { DiagnosticsHub } from "./diagnostics.ts";
import { DocumentSet, MAX_FILE_BYTES } from "./documents.ts";
import type { PidRegistry } from "./process.ts";
import type { Launch, Router } from "./routing.ts";
import { fileUri, uriToPath } from "./uri.ts";

export interface Instance {
	key: string;
	server: ServerConfig;
	root: string;
	launch: Launch;
	client: LspClient;
	docs: DocumentSet;
	/** 连续崩溃或启动失败的次数，成功启动后清零。 */
	failures: number;
	/** 已经发生过崩溃（用于 restartOnCrash: false）。 */
	crashed: boolean;
	lastActive: number;
	inflight: number;
	starting: Promise<void> | undefined;
}

export type Lookup =
	| { kind: "none" }
	| { kind: "missing"; server: ServerConfig; command: string }
	| { kind: "ok"; inst: Instance };

export interface ManagerOptions {
	router: Router;
	settings: LspSettings;
	hub: DiagnosticsHub;
	registry?: PidRegistry;
	/** 空闲检查的间隔，毫秒；测试里调小。 */
	sweepIntervalMs?: number;
	log?: (message: string) => void;
}

export class ServerManager {
	private readonly opts: ManagerOptions;
	private readonly instances = new Map<string, Instance>();
	private readonly sweepTimer: NodeJS.Timeout;
	private closed = false;

	constructor(opts: ManagerOptions) {
		this.opts = opts;
		const interval = opts.sweepIntervalMs ?? Math.min(60_000, Math.max(1000, Math.floor(opts.settings.idleTimeoutMs / 4)));
		this.sweepTimer = setInterval(() => void this.sweepIdle(), interval);
		this.sweepTimer.unref();
	}

	get all(): Instance[] {
		return [...this.instances.values()];
	}

	/** 找到文件对应的实例（必要时创建，但不启动）。 */
	lookup(file: string): Lookup {
		const { router } = this.opts;
		const server = router.serverFor(file);
		if (!server) return { kind: "none" };
		const root = router.rootFor(server, file);
		const key = `${server.name}\u0000${root}`;
		const existing = this.instances.get(key);
		if (existing) return { kind: "ok", inst: existing };
		const launch = router.launchFor(server, file, root);
		if ("missing" in launch) return { kind: "missing", server, command: launch.missing };
		const inst: Instance = {
			key,
			server,
			root,
			launch,
			docs: new DocumentSet((p) => router.languageIdFor(server, p, root)),
			failures: 0,
			crashed: false,
			lastActive: Date.now(),
			inflight: 0,
			starting: undefined,
			client: undefined as unknown as LspClient,
		};
		inst.client = new LspClient({
			name: server.name,
			command: launch.command,
			args: launch.args,
			root,
			env: launch.env,
			initializationOptions: launch.initializationOptions,
			settings: launch.settings,
			startupTimeout: server.startupTimeout,
			requestTimeout: server.requestTimeout,
			shutdownTimeout: server.shutdownTimeout,
			registry: this.opts.registry,
			onDiagnostics: (p) => {
				if (!this.diagnosticsOn(server)) return;
				// C-10：带版本号且早于当前文档版本的是过期诊断，丢弃，与 Claude Code 相同。
				const current = inst.docs.versionOf(uriToPath(p.uri));
				if (p.version !== undefined && p.version !== null && current !== undefined && p.version < current) return;
				this.opts.hub.receive(p.uri, `${key}\u0000push`, p.diagnostics);
			},
			onDiagnosticsRefresh: () => void this.pullOpen(inst),
			onCrash: (err) => {
				inst.failures++;
				inst.crashed = true;
				inst.docs.clear();
				this.opts.log?.(`[pi-lsp] ${err.message}`);
			},
		});
		this.instances.set(key, inst);
		return { kind: "ok", inst };
	}

	private diagnosticsOn(server: ServerConfig): boolean {
		return this.opts.settings.diagnostics && server.diagnostics;
	}

	/** 确保实例在运行；按 Claude Code 的规则决定是否允许重启。 */
	async ensureRunning(inst: Instance): Promise<void> {
		if (this.closed) throw new Error("LSP server manager is shut down");
		if (inst.client.state === "running") return;
		if (inst.starting) return inst.starting;
		const { server } = inst;
		if (inst.crashed && !server.restartOnCrash) throw inst.client.lastError ?? new Error(`LSP server '${server.name}' crashed (restartOnCrash is false)`);
		if (inst.failures > server.maxRestarts) {
			const last = inst.client.lastError;
			throw new Error(`LSP server '${server.name}' exceeded max crash recovery attempts (${server.maxRestarts})${last ? `; last crash: ${last.message}` : ""}`);
		}
		inst.docs.clear();
		inst.starting = inst.client
			.start()
			.then(() => {
				inst.failures = 0;
				inst.crashed = false;
			})
			.catch((e: unknown) => {
				inst.failures++;
				throw e;
			})
			.finally(() => {
				inst.starting = undefined;
				inst.lastActive = Date.now();
			});
		return inst.starting;
	}

	/** 发请求，记录活跃时间与在途数，空闲回收不会关掉正在处理请求的实例。 */
	async request<T>(inst: Instance, method: string, params: unknown, signal?: AbortSignal): Promise<T> {
		inst.inflight++;
		inst.lastActive = Date.now();
		try {
			return await inst.client.request<T>(method, params, signal);
		} finally {
			inst.inflight--;
			inst.lastActive = Date.now();
		}
	}

	/** 查询前确保文件已打开；超过 10MB 返回 Claude Code 同款的提示文本。 */
	async openForQuery(inst: Instance, path: string): Promise<string | undefined> {
		if (inst.docs.isOpen(path)) return undefined;
		const st = await stat(path);
		if (st.size > MAX_FILE_BYTES) return `File too large for LSP analysis (${Math.ceil(st.size / 1e6)}MB exceeds 10MB limit)`;
		const text = await readFile(path, "utf8");
		inst.docs.open(inst.client, path, text, st.mtimeMs, st.size);
		inst.lastActive = Date.now();
		return undefined;
	}

	/**
	 * 编辑后同步：必要时启动服务器，发 didChange / didSave，服务器支持拉取诊断时再拉一次（D3）。
	 * 返回同步到的实例；文件没有对应服务器或服务器没装时返回 undefined。
	 */
	async syncEdited(path: string): Promise<Instance | undefined> {
		const found = this.lookup(path);
		if (found.kind !== "ok") return undefined;
		const inst = found.inst;
		const st = await stat(path);
		if (st.size > MAX_FILE_BYTES) return undefined;
		const text = await readFile(path, "utf8");
		await this.ensureRunning(inst);
		inst.docs.change(inst.client, path, text, st.mtimeMs, st.size);
		inst.lastActive = Date.now();
		void this.pull(inst, path);
		return inst;
	}

	/** D3：拉取一个文件的诊断。服务器不支持或请求失败时静默跳过。 */
	async pull(inst: Instance, path: string): Promise<void> {
		if (!this.diagnosticsOn(inst.server) || !inst.client.supportsPullDiagnostics || inst.client.state !== "running") return;
		try {
			const uri = fileUri(path);
			const r = await this.request<{ kind?: string; items?: import("vscode-languageserver-protocol").Diagnostic[] }>(inst, "textDocument/diagnostic", { textDocument: { uri } });
			if (r && r.kind === "full" && Array.isArray(r.items)) this.opts.hub.receive(uri, `${inst.key}\u0000pull`, r.items);
		} catch {
			// 拉取失败不影响推送诊断与导航。
		}
	}

	private async pullOpen(inst: Instance): Promise<void> {
		for (const path of inst.docs.paths()) await this.pull(inst, path);
	}

	/** D6：bash 之后，对所有运行中的实例比对已打开文件的磁盘状态。返回有变化的文件。 */
	async reconcileAll(): Promise<string[]> {
		const changed: string[] = [];
		for (const inst of this.instances.values()) {
			if (inst.client.state !== "running") continue;
			const paths = await inst.docs.reconcile(inst.client);
			if (paths.length) inst.lastActive = Date.now();
			for (const p of paths) {
				changed.push(p);
				if (inst.docs.isOpen(p)) void this.pull(inst, p);
			}
		}
		return changed;
	}

	/** D1：关闭空闲超时的实例。 */
	async sweepIdle(now = Date.now()): Promise<void> {
		const idle = this.opts.settings.idleTimeoutMs;
		const stops: Promise<void>[] = [];
		for (const inst of this.instances.values()) {
			if (inst.client.state !== "running" || inst.inflight > 0 || inst.starting) continue;
			if (now - inst.lastActive < idle) continue;
			this.opts.log?.(`[pi-lsp] stopping idle LSP server '${inst.server.name}' (${inst.root})`);
			inst.docs.clear();
			stops.push(inst.client.stop());
		}
		await Promise.all(stops);
	}

	/** 重启一个实例（/lsp restart）：清零失败计数后按懒启动重新拉起。 */
	async restart(inst: Instance): Promise<void> {
		await inst.client.stop();
		inst.failures = 0;
		inst.crashed = false;
		await this.ensureRunning(inst);
	}

	/** 会话结束：并行关闭所有实例，幂等。 */
	async shutdownAll(): Promise<void> {
		this.closed = true;
		clearInterval(this.sweepTimer);
		await Promise.all([...this.instances.values()].map((i) => i.client.stop().catch(() => {})));
		this.instances.clear();
	}
}
