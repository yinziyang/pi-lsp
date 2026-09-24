// 诊断的接收、去重、限量与渲染（计划文档 4.6）。
//
// 数据流：服务器推送或拉取得到的诊断 → receive() 按文件与通道记下当前结果 → 与「已送达」比较得出新增项放进待送队列 → take() 取出渲染成 <new-diagnostics>。
// 与 Claude Code 对齐：只保留 message / severity / range / source / code；按这五项去重，只报新增；编辑过的文件清掉已送达记录后重新全量上报；
// 每个文件 10 条、总共 30 条，按严重级别排序；已送达记录最多保留 500 个文件；正文超过 4000 字符截断。
// 有意偏离：V1 写相对路径而不是 basename；V2 不送 Hint；V3 编辑后问题全部消失时报一行「已消失」；D5 编辑后等诊断，安静 150ms 就收。
//
// 通道：同一个文件可能同时有推送与拉取两路结果（rust-analyzer 的 cargo check 走推送，自身分析走拉取），分开记。
// 编辑后各路旧结果标为过期，只有重新上报过的一路才参与新增判断；所有上报过的路都重新报了空，才算「已消失」。实测不这样做时，修好之后会把编辑前 cargo check 的旧错误再送一次。

import type { Diagnostic as LspDiagnostic } from "vscode-languageserver-protocol";
import { displayPath, fileUri, uriToPath } from "./uri.ts";

export type Severity = "Error" | "Warning" | "Info" | "Hint";

export interface Diag {
	message: string;
	severity: Severity;
	line: number;
	character: number;
	source?: string;
	code?: string;
}

export const MAX_PER_FILE = 10;
export const MAX_TOTAL = 30;
export const MAX_TRACKED_FILES = 500;
export const MAX_CHARS = 4000;
const SEVERITY_ORDER: Record<Severity, number> = { Error: 0, Warning: 1, Info: 2, Hint: 3 };
const SYMBOL: Record<Severity, string> = { Error: "✘", Warning: "⚠", Info: "ℹ", Hint: "★" };

/** LSP 的数字级别转名称；缺省按 Error，与 Claude Code 相同。 */
function severityName(n: number | undefined): Severity {
	return n === 2 ? "Warning" : n === 3 ? "Info" : n === 4 ? "Hint" : "Error";
}

export function toDiag(d: LspDiagnostic): Diag {
	return {
		// LSP 3.18 起 message 也可以是 MarkupContent，取其中的文本。
		message: typeof d.message === "string" ? d.message : d.message.value,
		severity: severityName(d.severity),
		line: d.range.start.line,
		character: d.range.start.character,
		source: d.source,
		code: d.code === undefined || d.code === null ? undefined : String(d.code),
	};
}

const keyOf = (d: Diag) => JSON.stringify([d.message, d.severity, d.line, d.character, d.source, d.code]);

export interface RenderedDiagnostics {
	text: string;
	fileCount: number;
	issueCount: number;
}

interface ChannelResult {
	diags: Diag[];
	/** 编辑后重新上报过。编辑前的结果是旧版本的，不参与新增判断。 */
	fresh: boolean;
}

interface FileState {
	/** 每个通道的最新结果。 */
	channels: Map<string, ChannelResult>;
	/** 编辑后，这个文件之前送达过诊断（用于 V3）。 */
	hadDelivered: boolean;
	/** 编辑后是否已经收到过一次结果（用于 V3 与 D5 的等待）。 */
	reportedSinceEdit: boolean;
	/** 编辑后等待过期通道的定时器。 */
	staleTimer?: NodeJS.Timeout;
}

/**
 * 编辑后某一路超过这个时间还没重新上报，就不再等它，按空结果处理。
 * 简化：固定 8 秒。实测 rust-analyzer 在连续编辑时，cargo check 那一路可能一直不重新推送，不设上限的话「已消失」永远出不来。
 * 代价是 cargo check 比 8 秒更慢且仍有错误时，会先报「已消失」、随后再报错误；出现这种误报时，改为按服务器分别配置，或以 $/progress 的结束为准。
 */
export const STALE_CHANNEL_MS = 8000;

/** D5 的安静窗口，毫秒，取值依据见构造函数的说明。 */
export const QUIET_MS = 150;

type Waiter = { path: string; resolve: () => void; quiet?: NodeJS.Timeout };

export class DiagnosticsHub {
	private readonly cwd: string;
	private readonly files = new Map<string, FileState>();
	/** 已送达的诊断键，按文件记，插入顺序即最近使用顺序。 */
	private readonly delivered = new Map<string, Set<string>>();
	/** 待送的新增诊断，按文件。 */
	private readonly pending = new Map<string, Diag[]>();
	/** 待送的「已消失」文件。 */
	private readonly resolved = new Set<string>();
	private readonly waiters = new Set<Waiter>();
	private readonly quietMs: number;
	private readonly staleMs: number;

	/**
	 * quietMs：D5 的安静窗口，收到一路结果后再这么久没有新结果就结束等待，默认 150ms。
	 * 实测 300ms 时 pyright 编辑后的等待中位数是 570ms，超过计划定的 500ms 上限；150ms 时是 421ms，真实服务器验收没有因此漏报。
	 */
	constructor(cwd: string, quietMs = QUIET_MS, staleMs = STALE_CHANNEL_MS) {
		this.cwd = cwd;
		this.quietMs = quietMs;
		this.staleMs = staleMs;
	}

	private state(path: string): FileState {
		let s = this.files.get(path);
		if (!s) {
			s = { channels: new Map(), hadDelivered: false, reportedSinceEdit: false };
			this.files.set(path, s);
		}
		return s;
	}

	/** 文件被编辑：清掉它的已送达记录与待送项，重新全量上报，与 Claude Code 相同。 */
	markEdited(path: string): void {
		const s = this.state(path);
		const had = this.delivered.get(path);
		s.hadDelivered = s.hadDelivered || Boolean(had && had.size > 0);
		s.reportedSinceEdit = false;
		for (const ch of s.channels.values()) ch.fresh = false;
		this.delivered.delete(path);
		this.pending.delete(path);
		this.resolved.delete(path);
		if (s.staleTimer) clearTimeout(s.staleTimer);
		if (s.channels.size > 0) {
			s.staleTimer = setTimeout(() => this.expireStale(path), this.staleMs);
			s.staleTimer.unref();
		}
	}

	/** 过期通道不再等待：按空结果处理后重新计算。 */
	private expireStale(path: string): void {
		const s = this.files.get(path);
		if (!s) return;
		for (const ch of s.channels.values()) {
			if (!ch.fresh) {
				ch.diags = [];
				ch.fresh = true;
			}
		}
		this.recompute(path, s);
	}

	/**
	 * 收到一路诊断结果。uri 为服务器给的文件 URI，channel 区分推送与拉取。
	 * provisional 表示这是可能还没分析完的临时结果（见 manager.ts 的拉取），它照常记录，但不结束编辑后的等待。
	 */
	receive(uri: string, channel: string, diagnostics: LspDiagnostic[], provisional = false): void {
		const path = uriToPath(uri);
		const s = this.state(path);
		// V2：不送 Hint。
		const diags = diagnostics.map(toDiag).filter((d) => d.severity !== "Hint");
		s.channels.set(channel, { diags, fresh: true });
		this.recompute(path, s);
		if (provisional) return;
		s.reportedSinceEdit = true;
		this.poke(path);
	}

	private recompute(path: string, s: FileState): void {
		const all: Diag[] = [];
		const seen = new Set<string>();
		for (const ch of s.channels.values()) {
			if (!ch.fresh) continue;
			for (const d of ch.diags) {
				const k = keyOf(d);
				if (!seen.has(k)) {
					seen.add(k);
					all.push(d);
				}
			}
		}
		if (all.length === 0) {
			this.pending.delete(path);
			// V3：编辑前送达过诊断，编辑后每一路都重新报了空，报一次「已消失」；还有没重新上报的通道就先不下结论。
			if (s.hadDelivered && [...s.channels.values()].every((c) => c.fresh)) this.resolved.add(path);
			return;
		}
		this.resolved.delete(path);
		const done = this.delivered.get(path);
		const fresh = all.filter((d) => !done || !done.has(keyOf(d)));
		if (fresh.length) this.pending.set(path, fresh);
		else this.pending.delete(path);
	}

	/** 有无待送内容。 */
	get hasPending(): boolean {
		return this.pending.size > 0 || this.resolved.size > 0;
	}

	/**
	 * 取出待送诊断并渲染；没有时返回 undefined。
	 * 每个文件按严重级别排序后取前 10 条，总数不超过 30 条；被截掉的不算已送达，之后还会再报。
	 */
	take(): RenderedDiagnostics | undefined {
		if (!this.hasPending) return undefined;
		const sections: string[] = [];
		let total = 0;
		let files = 0;
		for (const [path, list] of this.pending) {
			if (total >= MAX_TOTAL) break;
			const chosen = [...list].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]).slice(0, Math.min(MAX_PER_FILE, MAX_TOTAL - total));
			total += chosen.length;
			files++;
			this.markDelivered(path, chosen);
			const lines = chosen.map((d) => `  ${SYMBOL[d.severity]} [Line ${d.line + 1}:${d.character + 1}] ${d.message}${d.code ? ` [${d.code}]` : ""}${d.source ? ` (${d.source})` : ""}`);
			sections.push(`${displayPath(fileUri(path), this.cwd)}:\n${lines.join("\n")}`);
			this.pending.delete(path);
		}
		for (const path of this.resolved) {
			sections.push(`${displayPath(fileUri(path), this.cwd)}: all previously reported issues are resolved`);
			const s = this.files.get(path);
			if (s) s.hadDelivered = false;
			files++;
		}
		this.resolved.clear();
		if (sections.length === 0) return undefined;
		let body = sections.join("\n\n");
		if (body.length > MAX_CHARS) body = `${body.slice(0, MAX_CHARS - 12)}…[truncated]`;
		return { text: `<new-diagnostics>The following new diagnostic issues were detected:\n\n${body}</new-diagnostics>`, fileCount: files, issueCount: total };
	}

	private markDelivered(path: string, diags: Diag[]): void {
		let set = this.delivered.get(path);
		if (set) this.delivered.delete(path);
		else set = new Set();
		for (const d of diags) set.add(keyOf(d));
		this.delivered.set(path, set);
		const s = this.files.get(path);
		if (s) s.hadDelivered = true;
		while (this.delivered.size > MAX_TRACKED_FILES) {
			const oldest = this.delivered.keys().next().value as string;
			this.delivered.delete(oldest);
		}
	}

	/**
	 * D5：等这个文件编辑后的诊断。收到第一路结果后再安静 quietMs 没有新结果就返回；一直没有结果时最多等 maxMs。
	 * signal 中止时立即返回。
	 */
	waitFor(path: string, maxMs: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			const w: Waiter = { path, resolve: () => {} };
			const finish = () => {
				clearTimeout(timer);
				if (w.quiet) clearTimeout(w.quiet);
				this.waiters.delete(w);
				signal?.removeEventListener("abort", finish);
				resolve();
			};
			w.resolve = finish;
			const timer = setTimeout(finish, maxMs);
			signal?.addEventListener("abort", finish, { once: true });
			this.waiters.add(w);
			if (this.state(path).reportedSinceEdit) this.poke(path);
		});
	}

	private poke(path: string): void {
		for (const w of this.waiters) {
			if (w.path !== path) continue;
			if (w.quiet) clearTimeout(w.quiet);
			w.quiet = setTimeout(w.resolve, this.quietMs);
		}
	}

	/** 会话结束：放掉所有等待与定时器。 */
	dispose(): void {
		for (const w of [...this.waiters]) w.resolve();
		for (const s of this.files.values()) if (s.staleTimer) clearTimeout(s.staleTimer);
	}
}
