// 服务器配置：内置表、字段校验、与 pi 设置合并。
//
// 配置格式沿用 Claude Code 插件 .lsp.json 的字段，可以直接照抄 Claude Code 的插件配置；另外增加四个字段：
//   - requestTimeout：单个请求的超时（D2）。
//   - rootMarkers：找项目根用的标记文件（D7），内置服务器的规则在 routing.ts。
//   - pullDiagnostics：是否向服务器声明支持拉取诊断（D3）。
//   - enabled：设为 false 可以关掉某个内置服务器。
// 设置来源：pi 的 settings.json 与受信项目的 .pi/settings.json 里的 lsp 键，后者覆盖前者。

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface ServerConfig {
	name: string;
	command: string;
	args: string[];
	/** 扩展名（含点、小写）到 languageId。 */
	extensionToLanguage: Record<string, string>;
	env: Record<string, string>;
	initializationOptions: unknown;
	settings: unknown;
	workspaceFolder: string | undefined;
	/** initialize 超时，毫秒，默认 30 秒（D2）。 */
	startupTimeout: number;
	/** 关闭时 shutdown 请求的等待上限，毫秒，默认 3 秒。 */
	shutdownTimeout: number;
	/** 单个请求的超时，毫秒，默认 60 秒（D2）。 */
	requestTimeout: number;
	restartOnCrash: boolean;
	/** 连续崩溃或启动失败超过这个次数后放弃，默认 3，语义与 Claude Code 相同。 */
	maxRestarts: number;
	/** 是否接收并送达这个服务器的诊断，默认 true。 */
	diagnostics: boolean;
	/**
	 * 是否在 initialize 里声明支持拉取诊断（D3），默认 true。
	 * 有的服务器看到客户端支持拉取就不再推送，拉取实现又有问题，这时关掉，回到与 Claude Code 相同的纯推送。
	 */
	pullDiagnostics: boolean;
	rootMarkers: string[] | undefined;
	/** 内置服务器且用户没有改过 command：启动命令由 routing.ts 按项目决定（例如 TS 的服务器选择）。 */
	builtin: boolean;
}

export interface LspSettings {
	servers: ServerConfig[];
	/** 空闲回收时间，毫秒，默认 10 分钟（D1）。 */
	idleTimeoutMs: number;
	/** 非交互模式下是否自动安装缺失的服务器，默认 false。 */
	autoInstall: boolean;
	/** 整体开关：false 时不送编辑后诊断，只保留 lsp 工具。 */
	diagnostics: boolean;
}

export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

type Raw = Record<string, unknown>;

/**
 * 内置服务器表，顺序即注册顺序（同一扩展名先注册的生效）。
 * clangd、gopls、rust-analyzer、pyright 与 Claude Code 官方市场的配置逐字一致；TS 的命令是占位，实际命令由 routing.ts 选择；CSS、HTML 是 Claude Code 没有的补充。
 */
const BUILTIN: Record<string, Raw> = {
	clangd: {
		command: "clangd",
		args: ["--background-index"],
		extensionToLanguage: { ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hxx": "cpp", ".hh": "cpp" },
	},
	gopls: { command: "gopls", extensionToLanguage: { ".go": "go" } },
	"rust-analyzer": { command: "rust-analyzer", extensionToLanguage: { ".rs": "rust" } },
	typescript: {
		command: "tsc",
		args: ["--lsp", "--stdio"],
		extensionToLanguage: {
			".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact",
			".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact",
		},
	},
	// pyright 1.1.414 在客户端声明拉取诊断后改走拉取，实测编辑后的第二次拉取不返回，所以不向它声明拉取，保持与 Claude Code 相同的推送。
	pyright: { command: "pyright-langserver", args: ["--stdio"], extensionToLanguage: { ".py": "python", ".pyi": "python" }, pullDiagnostics: false },
	css: { command: "vscode-css-language-server", args: ["--stdio"], extensionToLanguage: { ".css": "css", ".scss": "scss", ".less": "less" } },
	html: { command: "vscode-html-language-server", args: ["--stdio"], extensionToLanguage: { ".html": "html", ".htm": "html" } },
};

export const BUILTIN_SERVER_NAMES = Object.keys(BUILTIN);

function isRecordOf(v: unknown, pred: (x: unknown) => boolean): v is Record<string, string> {
	return typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every(pred);
}

function positiveInt(v: unknown): v is number {
	return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * 校验并补齐一个服务器配置。校验规则与 Claude Code 的 schema 相同：command 必填且非绝对路径时不能含空格，extensionToLanguage 至少一项。
 * 不合法时返回 error，调用方跳过这个服务器，它也不会占用扩展名。
 */
export function parseServerConfig(name: string, raw: Raw, builtin: boolean): { config?: ServerConfig; error?: string } {
	const err = (m: string) => ({ error: `LSP server '${name}': ${m}` });
	const { command, args = [], extensionToLanguage, env = {}, initializationOptions, settings, workspaceFolder } = raw;
	if (typeof command !== "string" || command.length === 0) return err("command must be a non-empty string");
	if (!isAbsolute(command) && command.includes(" ")) return err("command must not contain spaces unless it is an absolute path; put arguments in args");
	if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return err("args must be an array of strings");
	if (!isRecordOf(extensionToLanguage, (x) => typeof x === "string") || Object.keys(extensionToLanguage).length === 0) return err("extensionToLanguage must map at least one extension to a language id");
	if (!isRecordOf(env, (x) => typeof x === "string")) return err("env must map names to strings");
	if (workspaceFolder !== undefined && typeof workspaceFolder !== "string") return err("workspaceFolder must be a string");
	for (const k of ["startupTimeout", "shutdownTimeout", "requestTimeout"] as const) {
		if (raw[k] !== undefined && !positiveInt(raw[k])) return err(`${k} must be a positive integer (milliseconds)`);
	}
	if (raw.maxRestarts !== undefined && !(Number.isInteger(raw.maxRestarts) && (raw.maxRestarts as number) >= 0)) return err("maxRestarts must be a non-negative integer");
	if (raw.rootMarkers !== undefined && !(Array.isArray(raw.rootMarkers) && raw.rootMarkers.every((m) => typeof m === "string"))) return err("rootMarkers must be an array of strings");
	const ext: Record<string, string> = {};
	for (const [k, v] of Object.entries(extensionToLanguage)) ext[k.toLowerCase()] = v;
	return {
		config: {
			name,
			command,
			args: args as string[],
			extensionToLanguage: ext,
			env: env as Record<string, string>,
			initializationOptions: initializationOptions ?? {},
			settings,
			workspaceFolder: workspaceFolder as string | undefined,
			startupTimeout: (raw.startupTimeout as number) ?? DEFAULT_STARTUP_TIMEOUT_MS,
			shutdownTimeout: (raw.shutdownTimeout as number) ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
			requestTimeout: (raw.requestTimeout as number) ?? DEFAULT_REQUEST_TIMEOUT_MS,
			restartOnCrash: raw.restartOnCrash !== false,
			maxRestarts: (raw.maxRestarts as number) ?? 3,
			diagnostics: raw.diagnostics !== false,
			pullDiagnostics: raw.pullDiagnostics !== false,
			rootMarkers: raw.rootMarkers as string[] | undefined,
			builtin,
		},
	};
}

function readLspKey(path: string): Raw | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const json = JSON.parse(readFileSync(path, "utf8")) as Raw;
		const lsp = json.lsp;
		return typeof lsp === "object" && lsp !== null ? (lsp as Raw) : undefined;
	} catch {
		return undefined;
	}
}

export interface SettingsSources {
	/** pi 的用户级配置目录，例如 ~/.pi/agent。 */
	agentDir: string;
	cwd: string;
	/** 项目是否受信；不受信时不读项目的 .pi/settings.json。 */
	trusted: boolean;
}

/**
 * 读出并合并 lsp 设置。
 * servers 里与内置同名的条目按字段覆盖内置配置；覆盖了 command 的不再算内置，启动命令原样使用。
 * enabled: false 的服务器被移除。不合法的条目跳过并返回告警。
 */
export function loadSettings(src: SettingsSources): { settings: LspSettings; warnings: string[] } {
	const warnings: string[] = [];
	const layers = [readLspKey(join(src.agentDir, "settings.json"))];
	if (src.trusted) layers.push(readLspKey(join(src.cwd, ".pi", "settings.json")));
	const merged: Raw = {};
	const serverRaw: Record<string, Raw> = {};
	for (const layer of layers) {
		if (!layer) continue;
		for (const [k, v] of Object.entries(layer)) {
			if (k === "servers" && typeof v === "object" && v !== null) {
				for (const [name, s] of Object.entries(v as Raw)) {
					if (typeof s === "object" && s !== null) serverRaw[name] = { ...serverRaw[name], ...(s as Raw) };
					else warnings.push(`LSP server '${name}': configuration must be an object`);
				}
			} else merged[k] = v;
		}
	}
	const servers: ServerConfig[] = [];
	const names = [...BUILTIN_SERVER_NAMES, ...Object.keys(serverRaw).filter((n) => !(n in BUILTIN))];
	for (const name of names) {
		const user = serverRaw[name] ?? {};
		if (user.enabled === false) continue;
		const builtin = name in BUILTIN && user.command === undefined;
		const { config, error } = parseServerConfig(name, { ...BUILTIN[name], ...user }, builtin);
		if (config) servers.push(config);
		else if (error) warnings.push(error);
	}
	const idleMinutes = merged.idleTimeoutMinutes;
	return {
		settings: {
			servers,
			idleTimeoutMs: typeof idleMinutes === "number" && idleMinutes > 0 ? idleMinutes * 60_000 : DEFAULT_IDLE_TIMEOUT_MS,
			autoInstall: merged.autoInstall === true,
			diagnostics: merged.diagnostics !== false,
		},
		warnings,
	};
}
