// G-1 真实安装验收：在空的安装目录里真的安装各语言服务器，装完能启动，npm 全局目录不受影响。
// 会联网下载，耗时数分钟；单独用 npm run test:install 运行。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { LspClient } from "../../extensions/pi-lsp/client.ts";
import { loadSettings } from "../../extensions/pi-lsp/config.ts";
import { type Exec, installPlan, runInstall, toolDirs } from "../../extensions/pi-lsp/install.ts";
import { resolveCommand, Router } from "../../extensions/pi-lsp/routing.ts";

const exec: Exec = (command, args, options) =>
	new Promise((res) => {
		import("node:child_process").then(({ execFile }) =>
			execFile(command, args, { env: options.env, timeout: options.timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
				const raw = (err as { code?: unknown } | null)?.code;
				res({ code: err ? (typeof raw === "number" ? raw : 1) : 0, stdout: String(stdout), stderr: `${stderr}${err && !stderr ? err.message : ""}` });
			}),
		);
	});

/** 只含系统目录与 go、rustup 所在目录的 PATH：里面没有任何语言服务器。 */
function barePath(): string {
	const dirs = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
	for (const tool of ["go", "rustup"]) {
		const found = resolveCommand(tool, [], process.env.PATH);
		if (found) dirs.push(dirname(found));
	}
	return dirs.join(delimiter);
}

function npmGlobalList(): string {
	return execFileSync("npm", ["ls", "-g", "--depth=0"], { encoding: "utf8" });
}

test("G-1 在空的安装目录里真实安装 TS、pyright、HTML/CSS、gopls、rust-analyzer，装完能启动，npm 全局不变", { timeout: 1_800_000 }, async () => {
	const lspDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-lsp-install-")));
	const dirs = toolDirs(lspDir);
	const PATH = barePath();
	const env = { ...process.env, PATH };
	const planCtx = { lspDir, platform: process.platform, resolve: (c: string) => resolveCommand(c, dirs, [dirname(process.execPath), PATH].join(delimiter)) };
	const globalBefore = npmGlobalList();
	const { settings } = loadSettings({ agentDir: mkdtempSync(join(tmpdir(), "pi-lsp-agent-")), cwd: lspDir, trusted: false });
	const router = new Router(settings.servers, { cwd: lspDir, toolDirs: dirs, env });
	const server = (name: string) => settings.servers.find((s) => s.name === name)!;

	for (const name of ["typescript", "pyright", "css", "html", "gopls"]) assert.equal(router.available(server(name)), false, `${name} 装之前不可用`);

	for (const lang of ["typescript", "python", "css", "go", "rust"]) {
		const plan = installPlan(lang, planCtx);
		assert.ok(!("error" in plan), `${lang}: ${"error" in plan ? plan.error : ""}`);
		const r = await runInstall(plan as Exclude<typeof plan, { error: string }>, exec, env);
		assert.ok(r.ok, `${lang} 安装失败：${r.output.slice(-2000)}`);
	}

	for (const name of ["typescript", "pyright", "css", "html", "gopls", "rust-analyzer"]) {
		assert.ok(router.available(server(name)), `${name} 装完可用`);
		const file = { typescript: "a.ts", pyright: "a.py", css: "a.css", html: "a.html", gopls: "a.go", "rust-analyzer": "a.rs" }[name] as string;
		const launch = router.launchFor(server(name), join(lspDir, file), lspDir);
		assert.ok(!("missing" in launch), `${name} 找得到启动命令`);
		if (name !== "rust-analyzer") assert.ok((launch as { command: string }).command.startsWith(lspDir) || (launch as { args: string[] }).args.some((a) => a.startsWith(lspDir)), `${name} 用的是安装目录里的命令：${JSON.stringify(launch)}`);
		const l = launch as Exclude<typeof launch, { missing: string }>;
		const client = new LspClient({
			name,
			command: l.command,
			args: l.args,
			root: lspDir,
			env: l.env,
			initializationOptions: l.initializationOptions,
			settings: l.settings,
			startupTimeout: 60_000,
			requestTimeout: 10_000,
			shutdownTimeout: 3000,
			pullDiagnostics: server(name).pullDiagnostics,
			onDiagnostics: () => {},
			onDiagnosticsRefresh: () => {},
			onCrash: () => {},
		});
		await client.start();
		assert.equal(client.state, "running", `${name} 启动成功`);
		await client.stop();
	}

	assert.equal(npmGlobalList(), globalBefore, "npm 全局包列表前后不变");
});
