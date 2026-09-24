// 缺失语言服务器的安装（计划文档 4.7）。
//
// 规则：
//   - npm 类服务器装到 <lspDir>/node（npm install --prefix），不改动 npm 全局目录。
//   - gopls 用 go install，GOBIN 指向 <lspDir>/bin；rust-analyzer 用 rustup component add。
//   - clangd 不由本扩展安装：macOS 用 Xcode 命令行工具自带的，Linux 用系统包管理器，只给出说明。
//   - 不执行 curl | sh 一类的脚本安装；npm 用它自己配置的源。
// 命令执行通过 Exec 注入：生产环境用 index.ts 里基于 execFile 的实现，单元测试里换成记录调用的假实现，不真的安装。

import { delimiter, dirname, join } from "node:path";

export interface Exec {
	(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout: number; signal?: AbortSignal }): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export interface InstallStep {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

export interface InstallPlan {
	/** 服务器名，例如 gopls。 */
	server: string;
	label: string;
	steps: InstallStep[];
}

/** 每一步安装的超时，毫秒。 */
export const INSTALL_STEP_TIMEOUT_MS = 10 * 60_000;

/** 语言名与服务器名的对应，/lsp install 两种写法都接受。 */
const ALIASES: Record<string, string> = {
	typescript: "typescript", ts: "typescript", javascript: "typescript", js: "typescript", react: "typescript", tsx: "typescript", jsx: "typescript",
	python: "pyright", py: "pyright", pyright: "pyright",
	css: "css", scss: "css", less: "css",
	html: "html",
	go: "gopls", golang: "gopls", gopls: "gopls",
	rust: "rust-analyzer", rs: "rust-analyzer", "rust-analyzer": "rust-analyzer",
	c: "clangd", cpp: "clangd", "c++": "clangd", clangd: "clangd",
};

export const INSTALLABLE = ["typescript", "python", "css", "html", "go", "rust", "c"] as const;

/** 本扩展的安装目录：npm 包的 .bin 与 go install 的 GOBIN，查找服务器命令时排在 PATH 之前。 */
export function toolDirs(lspDir: string): string[] {
	return [join(lspDir, "node", "node_modules", ".bin"), join(lspDir, "bin")];
}

export function serverForTarget(target: string): string | undefined {
	return ALIASES[target.toLowerCase()];
}

export interface PlanContext {
	lspDir: string;
	platform: NodeJS.Platform;
	/** 找命令，找不到返回 undefined。 */
	resolve: (command: string) => string | undefined;
}

/** 生成安装步骤；不能安装时返回 error，内容是给用户看的说明。 */
export function installPlan(target: string, ctx: PlanContext): InstallPlan | { error: string } {
	const server = serverForTarget(target);
	if (!server) return { error: `Unknown language '${target}'. Supported: ${INSTALLABLE.join(", ")}.` };
	const npm = (packages: string[], label: string): InstallPlan | { error: string } => {
		const bin = ctx.resolve("npm");
		if (!bin) return { error: `Installing ${label} needs npm, which was not found on PATH.` };
		return { server, label, steps: [{ command: bin, args: ["install", "--prefix", join(ctx.lspDir, "node"), "--no-audit", "--no-fund", ...packages] }] };
	};
	switch (server) {
		case "typescript":
			return npm(["typescript@latest", "typescript-language-server@latest"], "TypeScript (tsc --lsp) and typescript-language-server");
		case "pyright":
			return npm(["pyright@latest"], "pyright");
		case "css":
		case "html":
			return npm(["vscode-langservers-extracted@latest"], "vscode-langservers-extracted (HTML and CSS language servers)");
		case "gopls": {
			const go = ctx.resolve("go");
			if (!go) return { error: "Installing gopls needs the Go toolchain, which was not found on PATH. Install Go from https://go.dev/dl/ and retry." };
			return { server, label: "gopls", steps: [{ command: go, args: ["install", "golang.org/x/tools/gopls@latest"], env: { GOBIN: join(ctx.lspDir, "bin") } }] };
		}
		case "rust-analyzer": {
			const rustup = ctx.resolve("rustup");
			if (!rustup) return { error: "Installing rust-analyzer needs rustup, which was not found on PATH. Install Rust from https://rustup.rs and retry." };
			return { server, label: "rust-analyzer", steps: [{ command: rustup, args: ["component", "add", "rust-analyzer"] }] };
		}
		default:
			return {
				error: ctx.platform === "darwin"
					? "clangd ships with the Xcode command line tools; run `xcode-select --install` to install them."
					: "Install clangd with your system package manager, for example `sudo apt install clangd` or `sudo dnf install clang-tools-extra`.",
			};
	}
}

/** 一句话说明怎么装，附在工具结果或提示里。 */
export function installHint(serverName: string, ctx: PlanContext): string {
	const lang = Object.entries(ALIASES).find(([, s]) => s === serverName)?.[0] ?? serverName;
	const plan = installPlan(lang, ctx);
	if ("error" in plan) return `The ${serverName} language server is not installed. ${plan.error}`;
	return `The ${serverName} language server is not installed. Run /lsp install ${lang} to install ${plan.label}.`;
}

/** 依次执行安装步骤，任何一步失败即停止并返回原因。 */
export async function runInstall(plan: InstallPlan, exec: Exec, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
	let output = "";
	// npm 是 #!/usr/bin/env node 的脚本，PATH 上没有 node 时直接失败（从图形界面启动 pi、node 由 nvm 管理时就是这样）；把 pi 所用的 node 放到最前。
	const path = [dirname(process.execPath), env.PATH ?? ""].filter(Boolean).join(delimiter);
	for (const step of plan.steps) {
		const r = await exec(step.command, step.args, { env: { ...env, PATH: path, ...step.env }, timeout: INSTALL_STEP_TIMEOUT_MS, signal });
		output += `$ ${[step.command, ...step.args].join(" ")}\n${r.stdout}${r.stderr}`;
		if (r.code !== 0) return { ok: false, output: `${output}\n(exit ${r.code})` };
	}
	return { ok: true, output };
}
