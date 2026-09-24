// 从服务器 stdout 读 LSP 消息，带与 Claude Code 相同的协议保护。
//
// 为什么不用 vscode-jsonrpc 自带的 StreamMessageReader：它不限制消息头与正文大小，也不区分「非协议输出」。
// 服务器往 stdout 打日志、或输出失控时，要尽早判为协议违规并按崩溃处理，否则会一直缓冲直到内存耗尽。
// 三条上限与 Claude Code 相同：消息头 64KiB、正文 32MiB、帧起始处出现非 Content-Length 头的内容即违规。

import type { Readable } from "node:stream";
import { AbstractMessageReader, type DataCallback, type Disposable, type Message } from "vscode-jsonrpc";

export const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** 协议违规：读取器已停止，调用方应当按崩溃处理并终止服务器进程。 */
export class ProtocolViolation extends Error {}

export class GuardedMessageReader extends AbstractMessageReader {
	private readonly stream: Readable;
	private buffer: Buffer = Buffer.alloc(0);
	private expected = -1;
	private callback: DataCallback | undefined;
	private stopped = false;

	constructor(stream: Readable) {
		super();
		this.stream = stream;
	}

	listen(callback: DataCallback): Disposable {
		this.callback = callback;
		const onData = (chunk: Buffer) => this.onData(chunk);
		const onError = (err: Error) => this.fireError(err);
		const onClose = () => this.fireClose();
		this.stream.on("data", onData);
		this.stream.on("error", onError);
		this.stream.on("close", onClose);
		return {
			dispose: () => {
				this.stream.off("data", onData);
				this.stream.off("error", onError);
				this.stream.off("close", onClose);
			},
		};
	}

	private violate(reason: string): void {
		this.stopped = true;
		this.buffer = Buffer.alloc(0);
		this.fireError(new ProtocolViolation(reason));
	}

	private onData(chunk: Buffer): void {
		if (this.stopped) return;
		this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
		for (;;) {
			if (this.expected < 0) {
				const end = this.buffer.indexOf("\r\n\r\n");
				if (end < 0) {
					if (this.buffer.length > MAX_HEADER_BYTES) return this.violate(`LSP header exceeds ${MAX_HEADER_BYTES} bytes`);
					// 帧起始处必须是消息头；等到够长再判断，避免把被拆开的 "Content-Length" 误判。
					if (this.buffer.length >= 16 && !/^content-(length|type)/i.test(this.buffer.subarray(0, 16).toString("ascii"))) {
						return this.violate(`non-protocol output on stdout: ${JSON.stringify(this.buffer.subarray(0, 60).toString("utf8"))}`);
					}
					return;
				}
				if (end > MAX_HEADER_BYTES) return this.violate(`LSP header exceeds ${MAX_HEADER_BYTES} bytes`);
				const header = this.buffer.subarray(0, end).toString("ascii");
				const m = /^content-length:\s*(\d+)\s*$/im.exec(header);
				if (!m || !/^content-(length|type)/i.test(header)) return this.violate(`missing or invalid Content-Length header: ${JSON.stringify(header.slice(0, 80))}`);
				const length = Number(m[1]);
				if (length > MAX_BODY_BYTES) return this.violate(`LSP message body of ${length} bytes exceeds ${MAX_BODY_BYTES} bytes`);
				this.expected = length;
				this.buffer = this.buffer.subarray(end + 4);
			}
			if (this.buffer.length < this.expected) return;
			const body = this.buffer.subarray(0, this.expected).toString("utf8");
			this.buffer = this.buffer.subarray(this.expected);
			this.expected = -1;
			let message: Message;
			try {
				message = JSON.parse(body) as Message;
			} catch {
				return this.violate("LSP message body is not valid JSON");
			}
			this.callback?.(message);
		}
	}
}
