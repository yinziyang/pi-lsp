// 路由与配置（验收 B-12、D-6 到 D-9 的判定逻辑、G-4、G-5）。

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadSettings, parseServerConfig } from "../extensions/pi-lsp/config.ts";
import { Router, headerLanguage, pythonInterpreter, resolveCommand } from "../extensions/pi-lsp/routing.ts";
import { fakeServer, tempDir } from "./fixtures.ts";

function tree(files: Record<string, string>): string {
	const root = tempDir();
	for (const [rel, text] of Object.entries(files)) {
		const p = join(root, rel);
		mkdirSync(join(p, ".."), { recursive: true });
		writeFileSync(p, text);
	}
	return root;
}

function builtinRouter(cwd: string, toolDirs: string[] = [], env: NodeJS.ProcessEnv = process.env) {
	const { settings } = loadSettings({ agentDir: tempDir(), cwd, trusted: false });
	return { router: new Router(settings.servers, { cwd, toolDirs, env }), settings };
}

const server = (router: Router, name: string) => router.allServers.find((s) => s.name === name) as NonNullable<ReturnType<Router["serverFor"]>>;

test("扩展名转小写匹配，未知扩展名没有服务器", () => {
	const { router } = builtinRouter(tempDir());
	assert.equal(router.serverFor("/x/A.GO")?.name, "gopls");
	assert.equal(router.serverFor("/x/a.tsx")?.name, "typescript");
	assert.equal(router.serverFor("/x/a.scss")?.name, "css");
	assert.equal(router.serverFor("/x/a.unknown"), undefined);
});

test("B-12 两个服务器声明同一扩展名时先注册的生效，冲突被记录", () => {
	const a = fakeServer("first", {});
	const b = fakeServer("second", {});
	const router = new Router([a, b], { cwd: tempDir(), toolDirs: [], env: process.env });
	assert.equal(router.serverFor("/x/a.fake")?.name, "first");
	assert.deepEqual(router.conflicts.map((c) => [c.ext, c.winner, c.loser]), [[".fake", "first", "second"], [".fk2", "first", "second"]]);
});

test("D-8 项目根：Go 找 go.work 优先于 go.mod；两个模块各自为根", () => {
	const root = tree({ "m1/go.mod": "module a", "m1/a.go": "", "m2/go.mod": "module b", "m2/b.go": "", "w/go.work": "go 1.22", "w/m3/go.mod": "", "w/m3/c.go": "" });
	const { router } = builtinRouter(root);
	const gopls = server(router, "gopls");
	assert.equal(router.rootFor(gopls, join(root, "m1/a.go")), join(root, "m1"));
	assert.equal(router.rootFor(gopls, join(root, "m2/b.go")), join(root, "m2"));
	assert.equal(router.rootFor(gopls, join(root, "w/m3/c.go")), join(root, "w"));
});

test("D-8 项目根：Rust 两个独立 crate 各自为根，workspace 下的 crate 以 workspace 为根", () => {
	const root = tree({ "a/Cargo.toml": "[package]", "a/src/lib.rs": "", "b/Cargo.toml": "[package]", "b/src/lib.rs": "", "ws/Cargo.toml": "[workspace]\nmembers=['c']", "ws/c/Cargo.toml": "[package]", "ws/c/src/lib.rs": "" });
	const { router } = builtinRouter(root);
	const ra = server(router, "rust-analyzer");
	assert.equal(router.rootFor(ra, join(root, "a/src/lib.rs")), join(root, "a"));
	assert.equal(router.rootFor(ra, join(root, "b/src/lib.rs")), join(root, "b"));
	assert.equal(router.rootFor(ra, join(root, "ws/c/src/lib.rs")), join(root, "ws"));
});

test("项目根：C/C++、Python、TS 的标记文件，找不到时退回启动目录", () => {
	const root = tree({ "cpp/compile_commands.json": "[]", "cpp/src/a.cpp": "", "py/pyproject.toml": "", "py/pkg/m.py": "", ".git/HEAD": "", "web/src/a.ts": "", "loose/x.c": "" });
	const cwd = join(root, "loose");
	const { router } = builtinRouter(cwd);
	assert.equal(router.rootFor(server(router, "clangd"), join(root, "cpp/src/a.cpp")), join(root, "cpp"));
	assert.equal(router.rootFor(server(router, "pyright"), join(root, "py/pkg/m.py")), join(root, "py"));
	assert.equal(router.rootFor(server(router, "typescript"), join(root, "web/src/a.ts")), root, "TS 用 git 仓库根");
	assert.equal(router.rootFor(server(router, "clangd"), join(root, "loose/x.c")), cwd);
});

test("D-6 .h 判定：编译数据库里按 C++ 编译时当 C++；项目根有 C++ 源文件时当 C++；否则当 C", () => {
	const db = tree({ "compile_commands.json": JSON.stringify([{ directory: ".", file: "src/a.cc", command: "clang++ -c src/a.cc" }]), "src/a.h": "" });
	assert.equal(headerLanguage(join(db, "src/a.h"), db), "cpp");
	const cdb = tree({ "compile_commands.json": JSON.stringify([{ directory: ".", file: "src/a.c", arguments: ["cc", "-c", "src/a.c"] }]), "src/a.h": "" });
	assert.equal(headerLanguage(join(cdb, "src/a.h"), cdb), "c");
	const cpp = tree({ "lib/x.cpp": "", "include/x.h": "" });
	assert.equal(headerLanguage(join(cpp, "include/x.h"), cpp), "cpp");
	const c = tree({ "x.c": "", "x.h": "" });
	assert.equal(headerLanguage(join(c, "x.h"), c), "c");
	const { router } = builtinRouter(cpp);
	assert.equal(router.languageIdFor(server(router, "clangd"), join(cpp, "include/x.h"), cpp), "cpp");
	assert.equal(router.languageIdFor(server(router, "clangd"), join(cpp, "lib/x.cpp"), cpp), "cpp");
});

test("D-7 Python 虚拟环境：VIRTUAL_ENV 优先，其次项目根的 .venv，并下发为 python.pythonPath", () => {
	const root = tree({ ".venv/bin/python": "", "pyproject.toml": "", "a.py": "" });
	const other = tree({ "bin/python": "" });
	assert.equal(pythonInterpreter(root, {}), join(root, ".venv/bin/python"));
	assert.equal(pythonInterpreter(root, { VIRTUAL_ENV: other }), join(other, "bin/python"));
	assert.equal(pythonInterpreter(tempDir(), {}), undefined);
	const bin = tempDir();
	const fake = join(bin, "pyright-langserver");
	writeFileSync(fake, "#!/bin/sh\n");
	chmodSync(fake, 0o755);
	const { router } = builtinRouter(root, [bin], {});
	const launch = router.launchFor(server(router, "pyright"), join(root, "a.py"), root);
	assert.ok(!("missing" in launch));
	assert.deepEqual((launch as { settings: unknown }).settings, { python: { pythonPath: join(root, ".venv/bin/python") } });
});

function fakeTypescript(dir: string, version: string) {
	mkdirSync(join(dir, "node_modules/typescript/bin"), { recursive: true });
	mkdirSync(join(dir, "node_modules/typescript/lib"), { recursive: true });
	writeFileSync(join(dir, "node_modules/typescript/package.json"), JSON.stringify({ name: "typescript", version }));
	writeFileSync(join(dir, "node_modules/typescript/bin/tsc"), "");
}

test("D-9 TS 服务器选择：项目自带 TS 5 用 typescript-language-server 并指向项目的 tsserver；自带 TS 7 用项目的 tsc --lsp", () => {
	const bin = tempDir();
	const tsls = join(bin, "typescript-language-server");
	writeFileSync(tsls, "#!/bin/sh\n");
	chmodSync(tsls, 0o755);
	const ts5 = tree({ "a.ts": "", ".git/HEAD": "" });
	fakeTypescript(ts5, "5.9.3");
	const { router } = builtinRouter(ts5, [bin], {});
	const l5 = router.launchFor(server(router, "typescript"), join(ts5, "a.ts"), ts5) as { command: string; initializationOptions: { tsserver: { path: string } }; label: string };
	assert.equal(l5.command, tsls);
	assert.equal(l5.initializationOptions.tsserver.path, join(ts5, "node_modules/typescript/lib/tsserver.js"));
	assert.match(l5.label, /TypeScript 5\.9\.3/);
	const ts7 = tree({ "a.ts": "" });
	fakeTypescript(ts7, "7.0.2");
	const l7 = router.launchFor(server(router, "typescript"), join(ts7, "a.ts"), ts7) as { command: string; args: string[] };
	assert.equal(l7.command, process.execPath);
	assert.deepEqual(l7.args, [join(ts7, "node_modules/typescript/bin/tsc"), "--lsp", "--stdio"]);
});

test("D-9 项目没有自带 TS 时，用 PATH 上的 TS 7；只有 TS 5 时退回 typescript-language-server；都没有时报缺失", () => {
	const noTs = tree({ "a.ts": "" });
	const globalTs = (version: string) => {
		const pkg = tempDir();
		mkdirSync(join(pkg, "bin"));
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "typescript", version }));
		writeFileSync(join(pkg, "bin", "tsc"), "#!/bin/sh\n");
		chmodSync(join(pkg, "bin", "tsc"), 0o755);
		return pkg;
	};
	const g7 = globalTs("7.0.2");
	const r7 = builtinRouter(noTs, [], { PATH: join(g7, "bin") });
	const l7 = r7.router.launchFor(server(r7.router, "typescript"), join(noTs, "a.ts"), noTs) as { command: string; args: string[] };
	assert.equal(l7.command, join(g7, "bin", "tsc"));
	assert.deepEqual(l7.args, ["--lsp", "--stdio"]);
	const g5 = globalTs("5.9.3");
	const tslsDir = tempDir();
	writeFileSync(join(tslsDir, "typescript-language-server"), "#!/bin/sh\n");
	chmodSync(join(tslsDir, "typescript-language-server"), 0o755);
	const r5 = builtinRouter(noTs, [tslsDir], { PATH: join(g5, "bin") });
	const l5 = r5.router.launchFor(server(r5.router, "typescript"), join(noTs, "a.ts"), noTs) as { command: string; initializationOptions: { tsserver: { path: string } } };
	assert.equal(l5.command, join(tslsDir, "typescript-language-server"));
	assert.equal(l5.initializationOptions.tsserver.path, join(realpathSync(g5), "lib", "tsserver.js"), "按可执行文件的真实路径找到 TS 包");
	const empty = builtinRouter(noTs, [], { PATH: tempDir() });
	assert.deepEqual(empty.router.launchFor(server(empty.router, "typescript"), join(noTs, "a.ts"), noTs), { missing: "typescript" });
	assert.equal(empty.router.available(server(empty.router, "typescript")), false);
});

test("resolveCommand：先找本扩展的目录，再找 PATH；绝对路径要可执行", () => {
	const a = tempDir();
	const b = tempDir();
	for (const d of [a, b]) {
		writeFileSync(join(d, "tool"), "");
		chmodSync(join(d, "tool"), 0o755);
	}
	assert.equal(resolveCommand("tool", [a], b), join(a, "tool"));
	assert.equal(resolveCommand("tool", [], b), join(b, "tool"));
	assert.equal(resolveCommand("nope", [a], b), undefined);
	assert.equal(resolveCommand(join(a, "tool"), [], ""), join(a, "tool"));
});

test("配置校验：与 Claude Code 相同的必填与格式规则", () => {
	assert.match(parseServerConfig("x", { extensionToLanguage: { ".a": "a" } }, false).error ?? "", /command must be a non-empty string/);
	assert.match(parseServerConfig("x", { command: "my server", extensionToLanguage: { ".a": "a" } }, false).error ?? "", /must not contain spaces/);
	assert.match(parseServerConfig("x", { command: "srv", extensionToLanguage: {} }, false).error ?? "", /at least one extension/);
	assert.match(parseServerConfig("x", { command: "srv", extensionToLanguage: { ".a": "a" }, startupTimeout: -1 }, false).error ?? "", /startupTimeout must be a positive integer/);
	const ok = parseServerConfig("x", { command: "srv", extensionToLanguage: { ".A": "a" } }, false).config;
	assert.deepEqual(ok?.extensionToLanguage, { ".a": "a" }, "扩展名统一转小写");
	assert.equal(ok?.restartOnCrash, true);
	assert.equal(ok?.maxRestarts, 3);
	assert.equal(ok?.startupTimeout, 30_000);
	assert.equal(ok?.requestTimeout, 60_000);
});

test("G-4 设置合并：用户级覆盖内置，受信项目覆盖用户级；不受信项目的配置不读；enabled: false 移除内置", () => {
	const agentDir = tempDir();
	const cwd = tempDir();
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ lsp: { idleTimeoutMinutes: 5, servers: { gopls: { args: ["-remote=auto"] }, html: { enabled: false }, mine: { command: "mine-lsp", extensionToLanguage: { ".mine": "mine" } } } } }));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ lsp: { autoInstall: true, servers: { gopls: { args: ["-project"] } } } }));
	const untrusted = loadSettings({ agentDir, cwd, trusted: false }).settings;
	assert.equal(untrusted.idleTimeoutMs, 5 * 60_000);
	assert.equal(untrusted.autoInstall, false, "不受信项目的配置不读");
	assert.deepEqual(untrusted.servers.find((s) => s.name === "gopls")?.args, ["-remote=auto"]);
	assert.equal(untrusted.servers.find((s) => s.name === "gopls")?.builtin, true, "只改 args 仍算内置");
	assert.equal(untrusted.servers.some((s) => s.name === "html"), false);
	assert.equal(untrusted.servers.at(-1)?.name, "mine", "新增的排在内置之后");
	const trusted = loadSettings({ agentDir, cwd, trusted: true }).settings;
	assert.equal(trusted.autoInstall, true);
	assert.deepEqual(trusted.servers.find((s) => s.name === "gopls")?.args, ["-project"]);
});

test("G-4 不合法的服务器配置被跳过并告警，不占用扩展名", () => {
	const agentDir = tempDir();
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ lsp: { servers: { bad: { command: "", extensionToLanguage: { ".go": "go" } } } } }));
	const { settings, warnings } = loadSettings({ agentDir, cwd: tempDir(), trusted: false });
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /LSP server 'bad'/);
	assert.equal(new Router(settings.servers, { cwd: tempDir(), toolDirs: [], env: {} }).serverFor("/a.go")?.name, "gopls");
});

test("G-5 可用性：命令都找不到时没有可用服务器", () => {
	const { router, settings } = builtinRouter(tempDir(), [], { PATH: tempDir() });
	assert.equal(settings.servers.some((s) => router.available(s)), false);
});
