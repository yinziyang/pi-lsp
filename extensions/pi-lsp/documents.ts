// 一个服务器实例的已打开文档：版本号、最多 50 个的淘汰、编辑后同步、bash 之后比对磁盘。
//
// 与 Claude Code 对齐：didOpen 版本从 1 开始；编辑后发全量 didChange（版本加 1）再发 didSave；超过 50 个按最久未用发 didClose。
// 有意偏离 D6：bash 执行完后，对已打开的文件比对磁盘内容，变了就同步，删了就关闭；Claude Code 不做这一步，用 Bash 改的文件服务器不知道。

import { readFile, stat } from "node:fs/promises";
import { fileUri } from "./uri.ts";

export const MAX_OPEN_DOCUMENTS = 50;
/** 与 Claude Code 相同：超过 10MB 的文件不交给服务器。 */
export const MAX_FILE_BYTES = 10_000_000;

interface OpenDoc {
	version: number;
	text: string;
	mtimeMs: number;
	size: number;
}

/** 文档同步需要的最小客户端能力，便于在测试里替换。 */
export interface DocumentChannel {
	notify(method: string, params: unknown): void;
}

export class DocumentSet {
	private readonly docs = new Map<string, OpenDoc>();
	private readonly languageIdOf: (path: string) => string;

	constructor(languageIdOf: (path: string) => string) {
		this.languageIdOf = languageIdOf;
	}

	isOpen(path: string): boolean {
		return this.docs.has(path);
	}

	get size(): number {
		return this.docs.size;
	}

	/** 已打开文件的当前版本号；未打开返回 undefined。 */
	versionOf(path: string): number | undefined {
		return this.docs.get(path)?.version;
	}

	/** 已打开文件的路径，按最近使用排序（最久未用在前）。 */
	paths(): string[] {
		return [...this.docs.keys()];
	}

	/** 服务器重启后，旧的打开记录作废，下次访问重新 didOpen。 */
	clear(): void {
		this.docs.clear();
	}

	private touch(path: string, doc: OpenDoc): void {
		this.docs.delete(path);
		this.docs.set(path, doc);
	}

	private evict(channel: DocumentChannel): void {
		while (this.docs.size > MAX_OPEN_DOCUMENTS) {
			const oldest = this.docs.keys().next().value as string;
			this.docs.delete(oldest);
			channel.notify("textDocument/didClose", { textDocument: { uri: fileUri(oldest) } });
		}
	}

	/** 打开文件（未打开时）并返回是否新打开。 */
	open(channel: DocumentChannel, path: string, text: string, mtimeMs: number, size: number): boolean {
		const doc = this.docs.get(path);
		if (doc) {
			this.touch(path, doc);
			return false;
		}
		this.touch(path, { version: 1, text, mtimeMs, size });
		channel.notify("textDocument/didOpen", { textDocument: { uri: fileUri(path), languageId: this.languageIdOf(path), version: 1, text } });
		this.evict(channel);
		return true;
	}

	/** 编辑后同步：未打开时 didOpen，已打开时全量 didChange；随后 didSave。返回同步后的版本号。 */
	change(channel: DocumentChannel, path: string, text: string, mtimeMs: number, size: number): number {
		const doc = this.docs.get(path);
		if (!doc) {
			this.open(channel, path, text, mtimeMs, size);
		} else {
			const next = { version: doc.version + 1, text, mtimeMs, size };
			this.touch(path, next);
			channel.notify("textDocument/didChange", { textDocument: { uri: fileUri(path), version: next.version }, contentChanges: [{ text }] });
		}
		channel.notify("textDocument/didSave", { textDocument: { uri: fileUri(path) } });
		return this.docs.get(path)?.version ?? 1;
	}

	/**
	 * D6：比对已打开文件的磁盘状态。
	 * mtime 或大小变了才读内容，内容确实变了才发 didChange 与 didSave；文件不存在了就发 didClose。
	 * 返回内容变化或被关闭的文件路径。
	 */
	async reconcile(channel: DocumentChannel): Promise<string[]> {
		const changed: string[] = [];
		for (const [path, doc] of [...this.docs]) {
			let st: import("node:fs").Stats;
			try {
				st = await stat(path);
			} catch {
				this.docs.delete(path);
				channel.notify("textDocument/didClose", { textDocument: { uri: fileUri(path) } });
				changed.push(path);
				continue;
			}
			if (st.mtimeMs === doc.mtimeMs && st.size === doc.size) continue;
			if (st.size > MAX_FILE_BYTES) continue;
			let text: string;
			try {
				text = await readFile(path, "utf8");
			} catch {
				continue;
			}
			if (text === doc.text) {
				doc.mtimeMs = st.mtimeMs;
				doc.size = st.size;
				continue;
			}
			this.change(channel, path, text, st.mtimeMs, st.size);
			changed.push(path);
		}
		return changed;
	}
}
