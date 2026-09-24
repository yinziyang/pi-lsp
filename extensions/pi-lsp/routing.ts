// 文件到服务器的路由：用哪个服务器、项目根在哪、languageId 是什么、用什么命令启动。
//
// 与 Claude Code 对齐：扩展名转小写匹配，一个扩展名一个服务器，先注册的生效，冲突只记录。
// 有意偏离（计划文档 4.3、4.5）：
//   - D7：按标记文件为每个文件找项目根，而不是一律用启动目录。
//   - D8：.h 按项目判断当 C 还是 C++。
//   - D9：探测 Python 虚拟环境，通过 settings 下发给 pyright。
//   - TS：按项目实际装的 TypeScript 版本选服务器，TS 7 用 tsc --lsp，7 以下用 typescript-language-server。

import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { ServerConfig } from "./config.ts";

export interface Launch {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	settings: unknown;
	initializationOptions: unknown;
	/** 给 /lsp 看的说明，例如 "tsc --lsp (TypeScript 7.0.2)"。 */
	label: string;
}

export interface ExtensionConflict {
	ext: string;
	winner: string;
	loser: string;
}

/** 从 dir 向上逐级找，返回第一个满足 test 的目录。 */
function findUp(dir: string, test: (d: string) => boolean): string | undefined {
	let cur = resolve(dir);
	for (;;) {
		if (test(cur)) return cur;
		const up = dirname(cur);
		if (up === cur) return undefined;
		cur = up;
	}
}

const hasAny = (names: string[]) => (d: string) => names.some((n) => existsSync(join(d, n)));

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** 在额外目录与 PATH 里找可执行文件；找不到返回 undefined。 */
export function resolveCommand(command: string, extraDirs: string[], pathEnv: string | undefined): string | undefined {
	if (isAbsolute(command)) return isExecutable(command) ? command : undefined;
	for (const dir of [...extraDirs, ...(pathEnv ?? "").split(delimiter).filter(Boolean)]) {
		const full = join(dir, command);
		if (isExecutable(full)) return full;
	}
	return undefined;
}

/** 含可执行文件的 TypeScript 包：返回主版本号与包目录。 */
function typescriptPackageOf(dir: string): { major: number; version: string; dir: string } | undefined {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
		if (pkg.name !== "typescript" || !pkg.version) return undefined;
		return { major: Number(pkg.version.split(".")[0]), version: pkg.version, dir };
	} catch {
		return undefined;
	}
}

/** 从 dir 向上找最近的 node_modules/typescript。 */
function projectTypescript(dir: string): { major: number; version: string; dir: string } | undefined {
	const found = findUp(dir, (d) => typescriptPackageOf(join(d, "node_modules", "typescript")) !== undefined);
	return found ? typescriptPackageOf(join(found, "node_modules", "typescript")) : undefined;
}

/** 可执行文件所属的 TypeScript 包（沿真实路径向上找 package.json）。 */
function typescriptOfExecutable(exe: string): { major: number; version: string; dir: string } | undefined {
	let real: string;
	try {
		real = realpathSync(exe);
	} catch {
		return undefined;
	}
	const found = findUp(dirname(real), (d) => typescriptPackageOf(d) !== undefined);
	return found ? typescriptPackageOf(found) : undefined;
}

const CPP_SOURCE = new Set([".cpp", ".cc", ".cxx", ".c++", ".hpp", ".hxx", ".hh"]);
const SKIP_DIRS = new Set(["node_modules", "build", "target", "vendor", "dist", "out", "third_party"]);
/** 扫描 C++ 源文件的上限：只需判断「有没有」，大仓库没必要全扫。 */
const SCAN_LIMIT = 5000;

function hasCppSources(root: string): boolean {
	let seen = 0;
	const stack: [string, number][] = [[root, 0]];
	while (stack.length && seen < SCAN_LIMIT) {
		const [dir, depth] = stack.pop() as [string, number];
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (++seen > SCAN_LIMIT) break;
			if (e.isDirectory()) {
				if (depth < 6 && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) stack.push([join(dir, e.name), depth + 1]);
			} else if (CPP_SOURCE.has(extname(e.name).toLowerCase())) return true;
		}
	}
	return false;
}

interface CompileEntry {
	file: string;
	directory?: string;
	command?: string;
	arguments?: string[];
}

/** 编译数据库里这条命令是不是按 C++ 编译。 */
function entryIsCpp(e: CompileEntry): boolean {
	const cmd = e.arguments ? e.arguments.join(" ") : (e.command ?? "");
	return /(^|[\s/])(clang\+\+|g\+\+|c\+\+)(\s|$)|-x\s*c\+\+|-std=(c|gnu)\+\+/.test(cmd) || CPP_SOURCE.has(extname(e.file).toLowerCase());
}

/**
 * 判断 .h 当 C 还是 C++（D8）。
 * 先看编译数据库里有没有这个头文件或同目录源文件的条目，按它的编译命令判断。
 * 没有编译数据库或找不到条目时，看项目根下有没有 C++ 源文件。
 */
export function headerLanguage(file: string, root: string): "c" | "cpp" {
	for (const db of [join(root, "compile_commands.json"), join(root, "build", "compile_commands.json")]) {
		if (!existsSync(db)) continue;
		let entries: CompileEntry[];
		try {
			entries = JSON.parse(readFileSync(db, "utf8")) as CompileEntry[];
		} catch {
			continue;
		}
		const abs = (e: CompileEntry) => resolve(e.directory ?? root, e.file);
		const exact = entries.find((e) => abs(e) === file);
		const sameDir = exact ?? entries.find((e) => dirname(abs(e)) === dirname(file));
		if (sameDir) return entryIsCpp(sameDir) ? "cpp" : "c";
		if (entries.length) return entries.some(entryIsCpp) ? "cpp" : "c";
	}
	return hasCppSources(root) ? "cpp" : "c";
}

/** Python 虚拟环境里的解释器（D9）：VIRTUAL_ENV、项目根下的 .venv / venv、CONDA_PREFIX，找到第一个即停。 */
export function pythonInterpreter(root: string, env: NodeJS.ProcessEnv): string | undefined {
	const candidates = [env.VIRTUAL_ENV, join(root, ".venv"), join(root, "venv"), env.CONDA_PREFIX].filter((x): x is string => Boolean(x));
	for (const dir of candidates) {
		const py = join(dir, "bin", "python");
		if (existsSync(py)) return py;
	}
	return undefined;
}

/** 内置服务器的项目根标记（计划文档 4.5）。null 表示用 git 仓库根。 */
const ROOT_RULES: Record<string, ((file: string) => string | undefined) | null> = {
	clangd: (f) => findUp(dirname(f), hasAny(["compile_commands.json", "compile_flags.txt", ".clangd"])),
	gopls: (f) => findUp(dirname(f), hasAny(["go.work"])) ?? findUp(dirname(f), hasAny(["go.mod"])),
	"rust-analyzer": (f) => {
		const crate = findUp(dirname(f), hasAny(["Cargo.toml"]));
		if (!crate) return undefined;
		const ws = findUp(dirname(crate), (d) => {
			try {
				return /^\s*\[workspace\]/m.test(readFileSync(join(d, "Cargo.toml"), "utf8"));
			} catch {
				return false;
			}
		});
		return ws ?? crate;
	},
	pyright: (f) => findUp(dirname(f), hasAny(["pyproject.toml", "pyrightconfig.json", "setup.cfg", "setup.py", "requirements.txt"])),
	typescript: null,
	css: null,
	html: null,
};

function deepMerge(a: unknown, b: unknown): unknown {
	if (typeof a !== "object" || a === null || typeof b !== "object" || b === null || Array.isArray(a) || Array.isArray(b)) return b;
	const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
	for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
	return out;
}

export interface RouterOptions {
	cwd: string;
	/** 本扩展安装服务器的目录，查找命令时排在 PATH 之前。 */
	toolDirs: string[];
	env: NodeJS.ProcessEnv;
}

export class Router {
	private readonly servers: ServerConfig[];
	private readonly opts: RouterOptions;
	private readonly owners = new Map<string, ServerConfig>();
	private readonly headerCache = new Map<string, "c" | "cpp">();
	readonly conflicts: ExtensionConflict[] = [];

	constructor(servers: ServerConfig[], opts: RouterOptions) {
		this.servers = servers;
		this.opts = opts;
		for (const s of servers) {
			for (const ext of Object.keys(s.extensionToLanguage)) {
				const owner = this.owners.get(ext);
				if (owner) this.conflicts.push({ ext, winner: owner.name, loser: s.name });
				else this.owners.set(ext, s);
			}
		}
	}

	get allServers(): ServerConfig[] {
		return this.servers;
	}

	/** 按扩展名找服务器；与 Claude Code 相同，扩展名转小写后匹配。 */
	serverFor(file: string): ServerConfig | undefined {
		return this.owners.get(extname(file).toLowerCase());
	}

	/** 项目根：配置了 workspaceFolder 就用它，其次按标记文件找，都找不到用启动目录。 */
	rootFor(server: ServerConfig, file: string): string {
		if (server.workspaceFolder) return resolve(this.opts.cwd, server.workspaceFolder);
		const rule = server.rootMarkers ? (f: string) => findUp(dirname(f), hasAny(server.rootMarkers as string[])) : ROOT_RULES[server.builtin || server.name in ROOT_RULES ? server.name : ""];
		if (rule === null) return findUp(dirname(file), hasAny([".git"])) ?? this.opts.cwd;
		return (rule && rule(file)) ?? this.opts.cwd;
	}

	/** languageId：内置 clangd 的 .h 按项目判断，其余查 extensionToLanguage，查不到用 plaintext。 */
	languageIdFor(server: ServerConfig, file: string, root: string): string {
		const ext = extname(file).toLowerCase();
		if (server.builtin && server.name === "clangd" && ext === ".h") {
			let lang = this.headerCache.get(root);
			if (!lang) {
				lang = headerLanguage(file, root);
				this.headerCache.set(root, lang);
			}
			return lang;
		}
		return server.extensionToLanguage[ext] ?? "plaintext";
	}

	private resolve(command: string): string | undefined {
		return resolveCommand(command, this.opts.toolDirs, this.opts.env.PATH);
	}

	private baseEnv(server: ServerConfig): NodeJS.ProcessEnv {
		// 本扩展的安装目录排在 PATH 最前，node 脚本型服务器（pyright、TS 等）靠 PATH 上的 node 运行，pi 所用的 node 也放进去。
		const nodeDir = dirname(process.execPath);
		const path = [...this.opts.toolDirs, nodeDir, this.opts.env.PATH ?? ""].filter(Boolean).join(delimiter);
		return { ...this.opts.env, ...server.env, PATH: path };
	}

	/** TypeScript 的启动方式（计划文档 4.5）。file 用来找项目自带的 TypeScript。 */
	private typescriptLaunch(server: ServerConfig, file: string): Omit<Launch, "env"> | { missing: string } {
		const tsls = this.resolve("typescript-language-server");
		const viaTsls = (ts: { version: string; dir: string }) =>
			tsls
				? {
						command: tsls,
						args: ["--stdio"],
						settings: server.settings,
						initializationOptions: deepMerge({ tsserver: { path: join(ts.dir, "lib", "tsserver.js") } }, server.initializationOptions),
						label: `typescript-language-server (TypeScript ${ts.version})`,
					}
				: { missing: "typescript-language-server" };
		const project = projectTypescript(dirname(file));
		if (project && project.major < 7) return viaTsls(project);
		if (project) {
			const tsc = join(project.dir, "bin", "tsc");
			return { command: process.execPath, args: [tsc, "--lsp", "--stdio"], settings: server.settings, initializationOptions: server.initializationOptions, label: `tsc --lsp (TypeScript ${project.version}, project)` };
		}
		const tsc = this.resolve("tsc");
		const global = tsc ? typescriptOfExecutable(tsc) : undefined;
		if (tsc && global && global.major >= 7) return { command: tsc, args: ["--lsp", "--stdio"], settings: server.settings, initializationOptions: server.initializationOptions, label: `tsc --lsp (TypeScript ${global.version})` };
		if (global) return viaTsls(global);
		return { missing: "typescript" };
	}

	/**
	 * 启动方式。命令找不到时返回 missing，调用方据此提示安装（D10、D11）。
	 * 内置 pyright 探测到虚拟环境时，把 python.pythonPath 合并进 settings（D9）。
	 */
	launchFor(server: ServerConfig, file: string, root: string): Launch | { missing: string } {
		const env = this.baseEnv(server);
		if (server.builtin && server.name === "typescript") {
			const ts = this.typescriptLaunch(server, file);
			return "missing" in ts ? ts : { ...ts, env };
		}
		const command = this.resolve(server.command);
		if (!command) return { missing: server.command };
		let settings = server.settings;
		if (server.builtin && server.name === "pyright") {
			const py = pythonInterpreter(root, this.opts.env);
			if (py) settings = deepMerge(settings ?? {}, { python: { pythonPath: py } });
		}
		return { command, args: server.args, env, settings, initializationOptions: server.initializationOptions, label: [server.command, ...server.args].join(" ") };
	}

	/** 服务器的命令是否能找到。TS 只要 tsc（7 及以上）或 typescript-language-server 之一在就算可用。 */
	available(server: ServerConfig): boolean {
		if (server.builtin && server.name === "typescript") {
			const tsc = this.resolve("tsc");
			const global = tsc ? typescriptOfExecutable(tsc) : undefined;
			return Boolean((global && global.major >= 7) || this.resolve("typescript-language-server"));
		}
		return Boolean(this.resolve(server.command));
	}
}
