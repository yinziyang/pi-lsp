// 单个语言服务器进程的协议客户端：启动、initialize、请求、通知、应答服务器的反向请求、有上限的关闭。
//
// 状态机：stopped → starting → running → stopping → stopped；任何阶段进程意外退出或协议违规都进入 error。
// 与 Claude Code 对齐的部分：initialize 的能力声明、workspace/configuration 的取值规则、ContentModified 的退避重试、报错文本。
// 有意偏离的部分（计划文档 4.3）：
//   - D2：initialize 与每个请求都有超时，关闭流程每一步都有上限；Claude Code 这几处都是无限等待。
//   - D3：声明并支持拉取诊断，收到 workspace/diagnostic/refresh 时通知上层重新拉取。
//   - D4：应答 client/registerCapability、window/workDoneProgress/create 等反向请求，而不是回 MethodNotFound。

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { basename } from "node:path";
import { CancellationTokenSource, createMessageConnection, type MessageConnection, ResponseError } from "vscode-jsonrpc/node";
import { StreamMessageWriter } from "vscode-jsonrpc/node";
import type { InitializeParams, PublishDiagnosticsParams, ServerCapabilities } from "vscode-languageserver-protocol";
import { forceTerminate, type PidRegistry, spawnServer } from "./process.ts";
import { GuardedMessageReader } from "./reader.ts";
import { fileUri } from "./uri.ts";

export type ClientState = "stopped" | "starting" | "running" | "stopping" | "error";

export interface ClientOptions {
	/** 服务器名，用于报错文本，例如 gopls。 */
	name: string;
	command: string;
	args: string[];
	/** 子进程工作目录，同时是 initialize 里唯一的 workspace folder。 */
	root: string;
	env: NodeJS.ProcessEnv;
	initializationOptions: unknown;
	/** 为 undefined 时不声明 workspace.configuration，也不推送 didChangeConfiguration，与 Claude Code 相同。 */
	settings: unknown;
	/** initialize 的超时，毫秒。 */
	startupTimeout: number;
	/** 单个请求的超时，毫秒。 */
	requestTimeout: number;
	/** 关闭流程第一步 shutdown 请求的等待上限，毫秒。 */
	shutdownTimeout: number;
	/** 是否声明支持拉取诊断（D3）。 */
	pullDiagnostics: boolean;
	registry?: PidRegistry;
	onDiagnostics: (params: PublishDiagnosticsParams) => void;
	/** 服务器要求客户端重新拉取诊断。 */
	onDiagnosticsRefresh: () => void;
	/** 进程意外退出或协议违规；正常关闭不会触发。 */
	onCrash: (error: Error) => void;
}

/** 关闭流程第二步：发 exit 后等进程退出的上限。 */
const EXIT_WAIT_MS = 2000;
/** 关闭流程第三步：SIGTERM 后等进程退出的上限，之后 SIGKILL。 */
const TERM_WAIT_MS = 2000;
/** 与 Claude Code 相同：ContentModified 最多重试 3 次，间隔 500ms、1s、2s。 */
const CONTENT_MODIFIED = -32801;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
/** 启动失败时附在报错里的 stderr 尾部长度。 */
const STDERR_TAIL = 2000;

const VERSION = "0.1.0";

/** workspace/configuration 的取值：按点号路径逐级取，取不到返回 null。与 Claude Code 的实现逐行一致。 */
export function configurationValue(settings: unknown, section: string | undefined): unknown {
	if (settings == null) return null;
	if (section === undefined || section === "") return settings;
	let cur: unknown = settings;
	for (const key of section.split(".")) {
		if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, key)) return null;
		cur = (cur as Record<string, unknown>)[key];
	}
	return cur ?? null;
}

/** initialize 请求参数。能力声明与 Claude Code 相同，pull 为 true 时另加拉取诊断（D3）。 */
export function initializeParams(root: string, initializationOptions: unknown, hasSettings: boolean, pull = true): InitializeParams {
	const uri = fileUri(root);
	const params = {
		processId: process.pid,
		clientInfo: { name: "pi-lsp", version: VERSION },
		initializationOptions: initializationOptions ?? {},
		workspaceFolders: [{ uri, name: basename(root) }],
		rootPath: root,
		rootUri: uri,
		capabilities: {
			workspace: { configuration: hasSettings, workspaceFolders: false, diagnostics: { refreshSupport: true } },
			textDocument: {
				synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: true },
				publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] }, versionSupport: false, codeDescriptionSupport: true, dataSupport: false },
				hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
				definition: { dynamicRegistration: false, linkSupport: true },
				references: { dynamicRegistration: false },
				documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
				callHierarchy: { dynamicRegistration: false },
				diagnostic: { dynamicRegistration: true, relatedDocumentSupport: false },
			},
			general: { positionEncodings: ["utf-16"] },
		},
	} as InitializeParams & { capabilities: { workspace: Record<string, unknown>; textDocument: Record<string, unknown> } };
	if (!pull) {
		delete params.capabilities.workspace.diagnostics;
		delete params.capabilities.textDocument.diagnostic;
	}
	return params;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 带超时地等待 promise；超时抛出 message。 */
async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
	} finally {
		clearTimeout(timer);
	}
}

export class LspClient {
	private readonly opts: ClientOptions;
	private child: ChildProcessWithoutNullStreams | undefined;
	private conn: MessageConnection | undefined;
	private stopping: Promise<void> | undefined;
	private stderrTail = "";
	state: ClientState = "stopped";
	capabilities: ServerCapabilities = {};
	lastError: Error | undefined;
	/** 服务器通过 client/registerCapability 动态注册的方法名。 */
	readonly registrations = new Set<string>();
	/** 服务器发过 workspace/diagnostic/refresh：它用刷新通知表示分析完成，编辑后立即拉取到的空结果可能还没分析完。 */
	usesDiagnosticRefresh = false;

	constructor(opts: ClientOptions) {
		this.opts = opts;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get name(): string {
		return this.opts.name;
	}

	/** 是否对这个服务器拉取诊断：我们声明了拉取，且服务器在初始化时声明或之后动态注册了。 */
	get supportsPullDiagnostics(): boolean {
		if (!this.opts.pullDiagnostics) return false;
		return Boolean(this.capabilities.diagnosticProvider) || this.registrations.has("textDocument/diagnostic");
	}

	/** 启动进程并完成 initialize 握手。失败时进程已被终止，状态为 error，抛出原因。 */
	async start(): Promise<void> {
		const o = this.opts;
		this.state = "starting";
		this.lastError = undefined;
		this.stderrTail = "";
		this.registrations.clear();
		const child = spawnServer(o.command, o.args, o.root, o.env);
		this.child = child;
		const spawned = new Promise<void>((resolve, reject) => {
			child.once("spawn", () => resolve());
			child.once("error", (e) => reject(e));
		});
		child.stderr.on("data", (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString("utf8")).slice(-STDERR_TAIL); });
		child.on("exit", (code, signal) => this.onExit(code, signal));
		// 写管道在进程退出后会报 EPIPE，这里吞掉，退出本身由 exit 事件处理。
		child.stdin.on("error", () => {});
		try {
			await spawned;
		} catch (e) {
			this.state = "error";
			this.lastError = e as Error;
			throw e;
		}
		if (child.pid !== undefined) o.registry?.add(child.pid);

		const reader = new GuardedMessageReader(child.stdout);
		const conn = createMessageConnection(reader, new StreamMessageWriter(child.stdin));
		this.conn = conn;
		this.installHandlers(conn);
		conn.onError(([err]) => this.fail(err instanceof Error ? err : new Error(String(err))));
		conn.listen();

		try {
			const init = conn.sendRequest("initialize", initializeParams(o.root, o.initializationOptions, o.settings !== undefined, o.pullDiagnostics));
			const result = (await withTimeout(init, o.startupTimeout, `LSP server '${o.name}' timed out after ${o.startupTimeout}ms during initialization`)) as { capabilities?: ServerCapabilities };
			if (this.state !== "starting") throw this.lastError ?? new Error("LSP server crashed during startup");
			this.capabilities = result?.capabilities ?? {};
			await conn.sendNotification("initialized", {});
			if (o.settings !== undefined) await conn.sendNotification("workspace/didChangeConfiguration", { settings: o.settings });
			this.state = "running";
		} catch (e) {
			// 初始化期间进程退出时，onExit 已记下退出码与 stderr，比「连接已释放」更能说明原因，优先用它。
			const err = (this.state as ClientState) === "error" && this.lastError ? this.lastError : (e as Error);
			const tail = this.stderrTail.trim();
			this.lastError = tail && !err.message.includes(tail) ? new Error(`${err.message}\n${tail}`) : err;
			await this.stop();
			this.state = "error";
			throw this.lastError;
		}
	}

	private installHandlers(conn: MessageConnection): void {
		const o = this.opts;
		conn.onNotification("textDocument/publishDiagnostics", (p: PublishDiagnosticsParams) => o.onDiagnostics(p));
		conn.onRequest("workspace/configuration", (p: { items: { section?: string }[] }) => p.items.map((i) => configurationValue(o.settings, i.section)));
		conn.onRequest("client/registerCapability", (p: { registrations?: { method: string }[] }) => {
			for (const r of p.registrations ?? []) this.registrations.add(r.method);
			return null;
		});
		conn.onRequest("client/unregisterCapability", (p: { unregisterations?: { method: string }[] }) => {
			for (const r of p.unregisterations ?? []) this.registrations.delete(r.method);
			return null;
		});
		conn.onRequest("window/workDoneProgress/create", () => null);
		conn.onRequest("window/showMessageRequest", () => null);
		conn.onRequest("workspace/workspaceFolders", () => [{ uri: fileUri(o.root), name: basename(o.root) }]);
		conn.onRequest("workspace/diagnostic/refresh", () => {
			this.usesDiagnosticRefresh = true;
			o.onDiagnosticsRefresh();
			return null;
		});
		// 其余 */refresh（语义高亮、inlay hint 等）我们没有要刷新的界面，应答即可。
		conn.onRequest((method: string) => {
			if (method.endsWith("/refresh")) return null;
			return new ResponseError(-32601, `Unhandled method ${method}`);
		});
		conn.onNotification(() => {});
	}

	/** 协议违规或连接错误：终止进程并按崩溃处理。 */
	private fail(err: Error): void {
		if (this.state === "stopping" || this.state === "stopped" || this.state === "error") return;
		this.lastError = err;
		const wasRunning = this.state === "running";
		this.state = "error";
		if (this.child) void forceTerminate(this.child, TERM_WAIT_MS);
		if (wasRunning) this.opts.onCrash(err);
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.child?.pid !== undefined) this.opts.registry?.remove(this.child.pid);
		this.conn?.dispose();
		if (this.state === "stopping" || this.state === "stopped") return;
		const why = signal ? `killed by signal ${signal}` : `exited with code ${code}`;
		const tail = this.stderrTail.trim();
		const err = new Error(`LSP server '${this.opts.name}' ${why}${tail ? `\n${tail}` : ""}`);
		const wasRunning = this.state === "running";
		if (this.state !== "error") this.lastError = err;
		this.state = "error";
		if (wasRunning) this.opts.onCrash(this.lastError ?? err);
	}

	private notReady(kind: "request" | "notification"): Error {
		const last = this.lastError ? `, last error: ${this.lastError.message}` : "";
		return new Error(`Cannot send ${kind} to LSP server '${this.opts.name}': server is ${this.state}${kind === "request" ? last : ""}`);
	}

	/**
	 * 发请求。遇到 ContentModified 按 500ms、1s、2s 重试；每次尝试都受 requestTimeout 约束，超时或 signal 中止时发 $/cancelRequest。
	 * 失败时抛出与 Claude Code 同款的报错文本。
	 */
	async request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
		if (this.state !== "running" || !this.conn) throw this.notReady("request");
		const conn = this.conn;
		let last: (Error & { code?: number }) | undefined;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			const source = new CancellationTokenSource();
			// 取消令牌只负责发 $/cancelRequest；服务器不理睬时 sendRequest 的 promise 不会结束，所以中止要自己结束等待。
			let rejectAbort: (e: Error) => void = () => {};
			const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
			aborted.catch(() => {});
			const onAbort = () => {
				source.cancel();
				rejectAbort(new Error("request aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				if (signal?.aborted) throw new Error("request aborted");
				const p = conn.sendRequest(method, params, source.token) as Promise<T>;
				p.catch(() => {});
				return await withTimeout(Promise.race([p, aborted]), this.opts.requestTimeout, `request timed out after ${this.opts.requestTimeout}ms`);
			} catch (e) {
				last = e as Error & { code?: number };
				source.cancel();
				if (signal?.aborted) break;
				if (last.code === CONTENT_MODIFIED && attempt < MAX_RETRIES) {
					await sleep(RETRY_BASE_MS * 2 ** attempt);
					continue;
				}
				break;
			} finally {
				signal?.removeEventListener("abort", onAbort);
				source.dispose();
			}
		}
		throw Object.assign(new Error(`LSP request '${method}' failed for server '${this.opts.name}': ${last?.message ?? "unknown error"}`), { code: last?.code });
	}

	notify(method: string, params: unknown): void {
		if (this.state !== "running" || !this.conn) throw this.notReady("notification");
		void this.conn.sendNotification(method, params).catch(() => {});
	}

	/**
	 * 按计划文档 4.4 关闭，幂等，总时长不超过 shutdownTimeout + 4 秒。
	 * 步骤是 shutdown 请求（最多 shutdownTimeout）→ 无论成败都发 exit → 等进程退出（最多 2 秒）→ 对进程组 SIGTERM（最多 2 秒）→ SIGKILL。
	 */
	stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		if (this.state === "stopped" && !this.child) return Promise.resolve();
		this.stopping = this.doStop().finally(() => { this.stopping = undefined; });
		return this.stopping;
	}

	private async doStop(): Promise<void> {
		const child = this.child;
		const conn = this.conn;
		this.state = "stopping";
		if (child && child.exitCode === null && child.signalCode === null) {
			const exited = new Promise<void>((r) => child.once("exit", () => r()));
			if (conn) {
				try {
					await withTimeout(conn.sendRequest("shutdown"), this.opts.shutdownTimeout, "shutdown timed out");
				} catch {
					// shutdown 失败也要继续发 exit，与 Claude Code 相同。
				}
				try {
					await conn.sendNotification("exit");
				} catch {
					// 管道已断。
				}
			}
			const done = await Promise.race([exited.then(() => true), sleep(EXIT_WAIT_MS).then(() => false)]);
			if (!done) await forceTerminate(child, TERM_WAIT_MS);
		}
		conn?.dispose();
		if (child?.pid !== undefined) this.opts.registry?.remove(child.pid);
		this.child = undefined;
		this.conn = undefined;
		this.state = "stopped";
	}
}
