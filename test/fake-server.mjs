#!/usr/bin/env node
// 可编剧本的假语言服务器，供单元测试以真实子进程的方式驱动 pi-lsp。
// 剧本是 JSON，放在环境变量 FAKE_LSP；收到的每条消息与关键事件按行写到剧本里的 log 文件，测试据此断言。
//
// 剧本字段（都可选）：
//   log                 事件日志路径（JSONL）
//   initDelayMs         initialize 延迟回复
//   neverInit           永不回复 initialize
//   exitOnInit          收到 initialize 后以该退出码退出
//   capabilities        initialize 返回的 capabilities
//   serverRequests      initialized 之后向客户端发的请求 [{method, params}]，客户端的应答写进日志
//   diagnostics         "push" | "pull" | "both"：按文本生成诊断的方式；文本里含 ERROR / WARN / INFO / HINT 的行各产生一条
//   publishDelayMs      推送诊断前的延迟
//   publishVersion      推送诊断时附带的 version（用于过期诊断测试）
//   responses           {method: result} 请求的固定返回
//   neverRespond        [method] 永不回复
//   contentModified     {method: n} 前 n 次回 -32801
//   serverCancelled     {method: n} 前 n 次回 -32802
//   ignoreShutdown / ignoreExit / ignoreTerm / ignoreEof  忽略相应的关闭信号
//   crashAfterMs        initialized 之后多久以退出码 3 退出
//   garbage             initialized 之后往 stdout 写非协议文本
//   hugeHeader          initialized 之后发一个超长消息头
//   spawnChild          起一个换了进程组的 sleep 子进程，测试进程树清理

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const S = JSON.parse(process.env.FAKE_LSP || "{}");
const log = (o) => { if (S.log) appendFileSync(S.log, JSON.stringify({ t: Date.now(), pid: process.pid, ...o }) + "\n"); };
const docs = new Map();
const cmCount = {};
let nextId = 1000;

if (S.ignoreTerm) process.on("SIGTERM", () => log({ ev: "sigterm-ignored" }));

function send(msg) {
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }));
	process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
	process.stdout.write(body);
}

function diagsFor(text) {
	const out = [];
	text.split("\n").forEach((line, i) => {
		for (const [word, sev] of [["ERROR", 1], ["WARN", 2], ["INFO", 3], ["HINT", 4]]) {
			const c = line.indexOf(word);
			if (c >= 0) out.push({ range: { start: { line: i, character: c }, end: { line: i, character: c + word.length } }, severity: sev, message: `${word.toLowerCase()} on line ${i + 1}`, source: "fake", code: `F${sev}` });
		}
	});
	return out;
}

function publish(uri) {
	if (!S.diagnostics || S.diagnostics === "pull") return;
	const doc = docs.get(uri);
	const params = { uri, diagnostics: diagsFor(doc?.text ?? "") };
	if (S.publishVersion !== undefined) params.version = S.publishVersion;
	setTimeout(() => send({ method: "textDocument/publishDiagnostics", params }), S.publishDelayMs ?? 0);
}

function onRequest(msg) {
	const { id, method, params } = msg;
	log({ ev: "request", method, params });
	if (method === "initialize") {
		if (S.neverInit) return;
		if (S.exitOnInit !== undefined) process.exit(S.exitOnInit);
		const caps = { textDocumentSync: 1, definitionProvider: true, referencesProvider: true, hoverProvider: true, ...(S.capabilities || {}) };
		if (S.diagnostics === "pull" || S.diagnostics === "both") caps.diagnosticProvider = { interFileDependencies: false, workspaceDiagnostics: false };
		setTimeout(() => send({ id, result: { capabilities: caps } }), S.initDelayMs ?? 0);
		return;
	}
	if (method === "shutdown") {
		if (S.ignoreShutdown) return;
		send({ id, result: null });
		return;
	}
	if ((S.neverRespond || []).includes(method)) return;
	if (S.contentModified && S.contentModified[method] > (cmCount[method] ?? 0)) {
		cmCount[method] = (cmCount[method] ?? 0) + 1;
		send({ id, error: { code: -32801, message: "content modified" } });
		return;
	}
	if (S.serverCancelled && S.serverCancelled[method] > (cmCount[`sc:${method}`] ?? 0)) {
		cmCount[`sc:${method}`] = (cmCount[`sc:${method}`] ?? 0) + 1;
		send({ id, error: { code: -32802, message: "server cancelled", data: { retriggerRequest: true } } });
		return;
	}
	if (method === "textDocument/diagnostic") {
		const doc = docs.get(params.textDocument.uri);
		send({ id, result: { kind: "full", items: diagsFor(doc?.text ?? "") } });
		return;
	}
	const result = S.responses && method in S.responses ? S.responses[method] : null;
	send({ id, result });
}

function onNotification(msg) {
	const { method, params } = msg;
	log({ ev: "notify", method, uri: params?.textDocument?.uri, version: params?.textDocument?.version, languageId: params?.textDocument?.languageId, settings: params?.settings });
	if (method === "initialized") {
		for (const r of S.serverRequests || []) send({ id: nextId++, method: r.method, params: r.params ?? {} });
		if (S.crashAfterMs !== undefined) setTimeout(() => process.exit(3), S.crashAfterMs);
		if (S.garbage) setTimeout(() => process.stdout.write("this is not an LSP message\n".repeat(4)), 50);
		if (S.hugeHeader) setTimeout(() => process.stdout.write(`Content-Type: application/${"a".repeat(70 * 1024)}`), 50);
		if (S.spawnChild) {
			const c = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
			log({ ev: "child", pid: c.pid });
		}
	} else if (method === "textDocument/didOpen") {
		docs.set(params.textDocument.uri, { text: params.textDocument.text, version: params.textDocument.version });
		publish(params.textDocument.uri);
	} else if (method === "textDocument/didChange") {
		docs.set(params.textDocument.uri, { text: params.contentChanges[0].text, version: params.textDocument.version });
		publish(params.textDocument.uri);
	} else if (method === "textDocument/didClose") {
		docs.delete(params.textDocument.uri);
	} else if (method === "exit") {
		if (!S.ignoreExit) process.exit(0);
	}
}

let buf = Buffer.alloc(0);
process.stdin.on("data", (d) => {
	buf = Buffer.concat([buf, d]);
	for (;;) {
		const sep = buf.indexOf("\r\n\r\n");
		if (sep < 0) return;
		const m = /Content-Length: (\d+)/i.exec(buf.subarray(0, sep).toString());
		const len = Number(m[1]);
		if (buf.length < sep + 4 + len) return;
		const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString());
		buf = buf.subarray(sep + 4 + len);
		if (msg.id !== undefined && msg.method) onRequest(msg);
		else if (msg.method) onNotification(msg);
		else log({ ev: "response", id: msg.id, result: msg.result, error: msg.error });
	}
});
process.stdin.on("end", () => {
	log({ ev: "eof" });
	if (!S.ignoreEof) process.exit(0);
});
// 忽略 EOF 时保持进程存活。
setInterval(() => {}, 1 << 30);
