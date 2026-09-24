// 测试夹具：指向假服务器的配置、轮询等待、事件日志、进程存活检查。

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseServerConfig, type ServerConfig } from "../extensions/pi-lsp/config.ts";
import { isAlive } from "../extensions/pi-lsp/process.ts";

export const FAKE_SERVER = fileURLToPath(new URL("./fake-server.mjs", import.meta.url));

export function tempDir(prefix = "pi-lsp-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** 假服务器剧本；log 默认写到临时目录。 */
export interface Script {
	log?: string;
	[k: string]: unknown;
}

/** 生成一个指向假服务器的服务器配置。 */
export function fakeServer(name: string, script: Script, extra: Record<string, unknown> = {}): ServerConfig {
	const { config, error } = parseServerConfig(
		name,
		{
			command: process.execPath,
			args: [FAKE_SERVER],
			extensionToLanguage: { ".fake": "fake", ".fk2": "fake" },
			env: { FAKE_LSP: JSON.stringify(script) },
			startupTimeout: 5000,
			requestTimeout: 3000,
			shutdownTimeout: 1000,
			...extra,
		},
		false,
	);
	if (!config) throw new Error(error);
	return config;
}

export interface LogEvent {
	t: number;
	pid: number;
	ev: string;
	method?: string;
	params?: unknown;
	uri?: string;
	version?: number;
	languageId?: string;
	settings?: unknown;
	result?: unknown;
	error?: unknown;
}

export function readLog(path: string): LogEvent[] {
	try {
		return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogEvent);
	} catch {
		return [];
	}
}

export async function waitUntil(pred: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<boolean> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, stepMs));
	}
	return pred();
}

export function writeFile(dir: string, name: string, text: string): string {
	const p = join(dir, name);
	writeFileSync(p, text);
	return p;
}

/** 这些进程是否全部已退出。 */
export function allDead(pids: number[]): boolean {
	return pids.every((p) => !isAlive(p));
}
