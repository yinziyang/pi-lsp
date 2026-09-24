// 实例管理与生命周期（验收 B-1、B-5、C-4、C-10、C-11、E-5、E-8）。

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { LspSettings, ServerConfig } from "../extensions/pi-lsp/config.ts";
import { DiagnosticsHub } from "../extensions/pi-lsp/diagnostics.ts";
import { ServerManager } from "../extensions/pi-lsp/manager.ts";
import { PidRegistry, isAlive } from "../extensions/pi-lsp/process.ts";
import { Router } from "../extensions/pi-lsp/routing.ts";
import { allDead, fakeServer, readLog, tempDir, waitUntil, writeFile } from "./fixtures.ts";

function setup(servers: ServerConfig[], over: Partial<LspSettings> = {}, sweepIntervalMs?: number) {
	const cwd = tempDir();
	const settings: LspSettings = { servers, idleTimeoutMs: 60_000, autoInstall: false, diagnostics: true, ...over };
	const router = new Router(servers, { cwd, toolDirs: [], env: process.env });
	const hub = new DiagnosticsHub(cwd, 50);
	const registry = new PidRegistry(join(cwd, "pids"));
	const manager = new ServerManager({ router, settings, hub, registry, sweepIntervalMs });
	return { cwd, manager, hub, registry };
}

function lookupOk(m: ServerManager, file: string) {
	const r = m.lookup(file);
	assert.equal(r.kind, "ok");
	return (r as { inst: import("../extensions/pi-lsp/manager.ts").Instance }).inst;
}

test("B-1 懒启动：lookup 不启动进程，第一次编辑时才启动", async () => {
	const log = join(tempDir(), "log");
	const { cwd, manager } = setup([fakeServer("fake", { log })]);
	const file = writeFile(cwd, "a.fake", "hello");
	const inst = lookupOk(manager, file);
	assert.equal(inst.client.pid, undefined);
	assert.equal(readLog(log).length, 0, "还没有任何服务器进程");
	await manager.syncEdited(file);
	assert.equal(inst.client.state, "running");
	assert.ok(await waitUntil(() => readLog(log).some((e) => e.method === "textDocument/didOpen")));
	await manager.shutdownAll();
});

test("B-5 运行中崩溃后下次用到会重启，成功启动一次计数清零", async () => {
	const { cwd, manager } = setup([fakeServer("fake", { crashAfterMs: 30 })]);
	const file = writeFile(cwd, "a.fake", "x");
	const inst = lookupOk(manager, file);
	for (let i = 1; i <= 5; i++) {
		await manager.ensureRunning(inst);
		assert.equal(inst.failures, 0, "启动成功后计数清零");
		assert.ok(await waitUntil(() => inst.client.state === "error"));
		assert.equal(inst.failures, 1);
	}
	await manager.shutdownAll();
});

test("B-5 连续启动失败 4 次后放弃，报超过最大重启次数", async () => {
	const { cwd, manager } = setup([fakeServer("fake", { exitOnInit: 7 })]);
	const file = writeFile(cwd, "a.fake", "x");
	const inst = lookupOk(manager, file);
	for (let i = 1; i <= 4; i++) {
		await assert.rejects(manager.ensureRunning(inst), /exited with code 7|crashed during startup/);
		assert.equal(inst.failures, i);
	}
	await assert.rejects(manager.ensureRunning(inst), /LSP server 'fake' exceeded max crash recovery attempts \(3\); last crash:/);
	await manager.shutdownAll();
});

test("B-5 restartOnCrash: false 时崩溃后不再启动", async () => {
	const { cwd, manager } = setup([fakeServer("fake", { crashAfterMs: 30 }, { restartOnCrash: false })]);
	const file = writeFile(cwd, "a.fake", "x");
	const inst = lookupOk(manager, file);
	await manager.ensureRunning(inst);
	assert.ok(await waitUntil(() => inst.client.state === "error"));
	await assert.rejects(manager.ensureRunning(inst), /exited with code 3/);
	await manager.shutdownAll();
});

test("C-4 拉取诊断：支持拉取的服务器编辑后被拉取，结果进入诊断中心", async () => {
	const log = join(tempDir(), "log");
	const { cwd, manager, hub } = setup([fakeServer("fake", { log, diagnostics: "pull" })]);
	const file = writeFile(cwd, "a.fake", "line ERROR here");
	hub.markEdited(file);
	await manager.syncEdited(file);
	await hub.waitFor(file, 2000);
	assert.match(hub.take()?.text ?? "", /error on line 1/);
	assert.ok(readLog(log).some((e) => e.method === "textDocument/diagnostic"));
	await manager.shutdownAll();
});

test("C-4 收到 workspace/diagnostic/refresh 后重新拉取已打开的文件", async () => {
	const log = join(tempDir(), "log");
	const { cwd, manager } = setup([fakeServer("fake", { log, diagnostics: "pull", serverRequests: [] })]);
	const file = writeFile(cwd, "a.fake", "ok");
	const inst = lookupOk(manager, file);
	await manager.syncEdited(file);
	await waitUntil(() => readLog(log).filter((e) => e.method === "textDocument/diagnostic").length === 1);
	// 模拟服务器发来 refresh：直接走客户端回调
	(inst.client as unknown as { opts: { onDiagnosticsRefresh: () => void } }).opts.onDiagnosticsRefresh();
	assert.ok(await waitUntil(() => readLog(log).filter((e) => e.method === "textDocument/diagnostic").length === 2));
	await manager.shutdownAll();
});

test("C-10 带版本号且早于当前版本的推送诊断被丢弃", async () => {
	const { cwd, manager, hub } = setup([fakeServer("fake", { diagnostics: "push", publishVersion: 1, publishDelayMs: 150 })]);
	const file = writeFile(cwd, "a.fake", "ERROR one");
	await manager.syncEdited(file);
	writeFile(cwd, "a.fake", "ERROR two");
	hub.markEdited(file);
	await manager.syncEdited(file);
	await new Promise((r) => setTimeout(r, 500));
	assert.equal(hub.take(), undefined, "版本 1 的诊断在文档已到版本 2 时被丢弃");
	await manager.shutdownAll();
});

test("C-11 diagnostics: false 的服务器不送诊断", async () => {
	const { cwd, manager, hub } = setup([fakeServer("fake", { diagnostics: "push" }, { diagnostics: false })]);
	const file = writeFile(cwd, "a.fake", "ERROR");
	await manager.syncEdited(file);
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(hub.take(), undefined);
	await manager.shutdownAll();
});

test("E-5 空闲超时的实例被回收、进程退出；之后再用能重新启动", async () => {
	const { cwd, manager } = setup([fakeServer("fake", {})], { idleTimeoutMs: 300 }, 100);
	const file = writeFile(cwd, "a.fake", "x");
	const inst = lookupOk(manager, file);
	await manager.syncEdited(file);
	const pid = inst.client.pid as number;
	assert.ok(await waitUntil(() => inst.client.state === "stopped", 3000), "空闲后被关闭");
	assert.ok(await waitUntil(() => allDead([pid]), 2000));
	await manager.syncEdited(file);
	assert.equal(inst.client.state, "running", "再次使用时懒启动");
	await manager.shutdownAll();
});

test("E-5 正在处理请求的实例不会被空闲回收", async () => {
	const { cwd, manager } = setup([fakeServer("fake", { neverRespond: ["slow/op"] }, { requestTimeout: 1500 })], { idleTimeoutMs: 200 }, 50);
	const file = writeFile(cwd, "a.fake", "x");
	const inst = lookupOk(manager, file);
	await manager.ensureRunning(inst);
	inst.lastActive = 0;
	const p = manager.request(inst, "slow/op", {}).catch(() => {});
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(inst.client.state, "running");
	await p;
	await manager.shutdownAll();
});

test("每个「服务器 + 项目根」一个实例", async () => {
	const { cwd, manager } = setup([fakeServer("fake", {}, { rootMarkers: ["root.marker"] })]);
	for (const sub of ["m1", "m2"]) {
		mkdirSync(join(cwd, sub));
		writeFileSync(join(cwd, sub, "root.marker"), "");
		writeFile(join(cwd, sub), "a.fake", "x");
	}
	const a = lookupOk(manager, join(cwd, "m1", "a.fake"));
	const b = lookupOk(manager, join(cwd, "m2", "a.fake"));
	assert.notEqual(a.key, b.key);
	assert.equal(a.root, join(cwd, "m1"));
	await manager.shutdownAll();
});

test("shutdownAll 关闭全部实例且幂等，之后不再启动", async () => {
	const { cwd, manager } = setup([fakeServer("fake", {})]);
	const f1 = writeFile(cwd, "a.fake", "x");
	const inst = lookupOk(manager, f1);
	await manager.syncEdited(f1);
	const pid = inst.client.pid as number;
	await manager.shutdownAll();
	await manager.shutdownAll();
	assert.ok(allDead([pid]));
	await assert.rejects(manager.ensureRunning(inst), /shut down/);
});

test("E-8 遗留进程记录：pi 已死、服务器还活着时被清理；pi 还活着或进程号已被复用时不动", async () => {
	const dir = tempDir();
	const registry = new PidRegistry(dir);
	const orphan = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
	const deadPi = spawn("true");
	await new Promise((r) => deadPi.once("exit", r));
	writeFileSync(join(dir, `${deadPi.pid}-${orphan.pid}.json`), JSON.stringify({ piPid: deadPi.pid, pid: orphan.pid, command: "sleep" }));
	const reused = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
	writeFileSync(join(dir, `${deadPi.pid}-${reused.pid}.json`), JSON.stringify({ piPid: deadPi.pid, pid: reused.pid, command: "gopls" }));
	const live = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
	writeFileSync(join(dir, `${process.pid}9-${live.pid}.json`), JSON.stringify({ piPid: process.pid, pid: live.pid, command: "sleep" }));
	assert.equal(registry.sweep(), 1);
	assert.ok(await waitUntil(() => !isAlive(orphan.pid as number), 2000), "遗留进程被清理");
	assert.ok(isAlive(reused.pid as number), "命令不一致说明进程号被复用，不杀");
	assert.ok(isAlive(live.pid as number), "pi 还活着的不动");
	process.kill(reused.pid as number, "SIGKILL");
	process.kill(live.pid as number, "SIGKILL");
});

test("启动后登记进程记录，关闭后删除", async () => {
	const { cwd, manager } = setup([fakeServer("fake", {})]);
	const f = writeFile(cwd, "a.fake", "x");
	await manager.syncEdited(f);
	const { readdirSync } = await import("node:fs");
	assert.equal(readdirSync(join(cwd, "pids")).length, 1);
	await manager.shutdownAll();
	assert.equal(readdirSync(join(cwd, "pids")).length, 0);
});

