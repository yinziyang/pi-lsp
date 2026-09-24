// 真实语言服务器验收的公共夹具：生成样例项目、按文本计算位置、驱动 pi-lsp 的管理器与工具。
// 使用本机 PATH 上的服务器；缺少的服务器对应的用例会跳过并说明原因。

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readiness } from "../../extensions/pi-lsp/client.ts";
import { loadSettings, type LspSettings } from "../../extensions/pi-lsp/config.ts";
import { DiagnosticsHub } from "../../extensions/pi-lsp/diagnostics.ts";
import { ServerManager } from "../../extensions/pi-lsp/manager.ts";
import { Router } from "../../extensions/pi-lsp/routing.ts";
import { type LspParams, runLsp } from "../../extensions/pi-lsp/tool.ts";

/** 在临时目录里写出一组文件，返回项目根（真实路径，避免 macOS 的 /var 与 /private/var 不一致）。 */
export function project(files: Record<string, string>): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-lsp-real-")));
	for (const [rel, text] of Object.entries(files)) {
		const p = join(root, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, text);
	}
	return root;
}

/** 文本在文件里第 n 次出现的位置，1 基，偏移 offset 个字符。 */
export function pos(file: string, needle: string, n = 1, offset = 0): { line: number; character: number } {
	const text = readFileSync(file, "utf8");
	let idx = -1;
	for (let i = 0; i < n; i++) {
		idx = text.indexOf(needle, idx + 1);
		if (idx < 0) throw new Error(`'${needle}' #${n} not found in ${file}`);
	}
	const before = text.slice(0, idx + offset);
	const line = before.split("\n").length;
	const character = before.length - before.lastIndexOf("\n");
	return { line, character };
}

export interface Session {
	root: string;
	manager: ServerManager;
	hub: DiagnosticsHub;
	router: Router;
	settings: LspSettings;
	lsp(p: Omit<LspParams, "filePath"> & { filePath: string }): Promise<string>;
	/** 模拟 pi 的一次 edit / write：写文件、同步、等诊断，返回渲染后的诊断文本（没有则为空串）。 */
	edit(rel: string, text: string, waitMs?: number): Promise<string>;
	/** 反复调用直到结果满足 pred 或超时，用于等服务器建索引。 */
	until(p: Omit<LspParams, "filePath"> & { filePath: string }, pred: (s: string) => boolean, timeoutMs?: number): Promise<string>;
	close(): Promise<void>;
}

/** readiness 不传时用默认的就绪等待（D13）；传 { minMs: 0, quietMs: 0, maxMs: 0 } 可关掉，用来对照冷启动的问题。 */
export function session(root: string, cwd = root, readiness?: Readiness): Session {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-lsp-agent-"));
	const { settings } = loadSettings({ agentDir, cwd, trusted: false });
	// npm run 会把本仓库的 node_modules/.bin 放到 PATH 最前，里面的 tsc 是开发依赖的 TS 5，会改变 TS 服务器的选择；去掉它，模拟用户的环境。
	const PATH = (process.env.PATH ?? "").split(":").filter((d) => !d.includes("node_modules/.bin")).join(":");
	const router = new Router(settings.servers, { cwd, toolDirs: [], env: { ...process.env, PATH } });
	const hub = new DiagnosticsHub(cwd);
	if (process.env.PI_LSP_DEBUG) {
		const orig = hub.receive.bind(hub);
		const t0 = Date.now();
		hub.receive = (uri, ch, d, provisional) => {
			process.stderr.write(`[diag ${((Date.now() - t0) / 1000).toFixed(1)}s] ${ch.split("\u0000").pop()} ${uri.split("/").pop()} n=${d.length}${provisional ? " provisional" : ""} ${d.map((x) => String(x.message).slice(0, 30)).join(" | ")}\n`);
			orig(uri, ch, d, provisional);
		};
	}
	const manager = new ServerManager({ router, settings, hub, readiness });
	const rt = { manager, cwd, onMissing: async () => ({ installed: false, note: "" }) };
	const s: Session = {
		root,
		manager,
		hub,
		router,
		settings,
		lsp: (p) => runLsp(rt, p),
		async edit(rel, text, waitMs = 3000) {
			// 与 index.ts 相同：同步与等待共用一个截止时间。
			const path = join(root, rel);
			writeFileSync(path, text);
			const deadline = Date.now() + waitMs;
			hub.markEdited(path);
			const inst = await manager.syncEdited(path);
			const left = deadline - Date.now();
			if (inst && left > 0) await hub.waitFor(path, left);
			return hub.take()?.text ?? "";
		},
		async until(p, pred, timeoutMs = 60_000) {
			const end = Date.now() + timeoutMs;
			let last = "";
			while (Date.now() < end) {
				last = await runLsp(rt, p);
				if (pred(last)) return last;
				await new Promise((r) => setTimeout(r, 500));
			}
			return last;
		},
		close: () => manager.shutdownAll(),
	};
	return s;
}

/** 等某个文件的诊断里出现 pred 满足的内容；用于服务器分析较慢时。 */
export async function diagnosticsUntil(s: Session, pred: (text: string) => boolean, timeoutMs = 60_000): Promise<string> {
	const end = Date.now() + timeoutMs;
	let all = "";
	while (Date.now() < end) {
		const t = s.hub.take()?.text;
		if (t) all += `${t}\n`;
		if (pred(all)) return all;
		await new Promise((r) => setTimeout(r, 200));
	}
	return all;
}
