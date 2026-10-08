// lsp 工具：与 Claude Code 的 LSP 工具相同的 9 个操作、参数与输出文本。
//
// 与 Claude Code 对齐：
//   - 参数 operation / filePath / line（1 基）/ character（1 基）/ query，行列减 1 后作为 UTF-16 位置发给服务器。
//   - 参数不合法、文件不存在、不是普通文件时报错（工具调用失败）；其余错误都作为普通结果返回，文本为 "Error performing <op>: …"。
//   - references 带 includeDeclaration: true；incoming / outgoing 先 prepareCallHierarchy 再用第一项查询。
//   - 定义、引用、实现、工作区符号的结果用 git check-ignore 过滤掉被忽略的路径。
// 有意偏离 V4：工具说明末尾加一句使用引导。
// 有意偏离 D13：服务器启动后的第一次查询先等它就绪（见 client.ts 的 Readiness），Claude Code 不等，冷启动时会拿到不完整的结果。
// 有意偏离 V5：按位置的操作落空或出错时，在结果后附上该行原文与行内各标识符的列号（见 positionHint）。

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatResult, NO_CALL_HIERARCHY_ITEM, OPERATIONS, type Operation } from "./format.ts";
import type { Instance, ServerManager } from "./manager.ts";
import { fileUri, uriToPath } from "./uri.ts";

/** 与 Claude Code LSP 工具的说明逐字一致，最后一段是 V4 的使用引导。 */
export const TOOL_DESCRIPTION = `Interact with Language Server Protocol (LSP) servers to get code intelligence features.

Supported operations:
- goToDefinition: Find where a symbol is defined
- findReferences: Find all references to a symbol
- hover: Get hover information (documentation, type info) for a symbol
- documentSymbol: Get all symbols (functions, classes, variables) in a document
- workspaceSymbol: Search for symbols matching a query across the entire workspace
- goToImplementation: Find implementations of an interface or abstract method
- prepareCallHierarchy: Get call hierarchy item at a position (functions/methods)
- incomingCalls: Find all functions/methods that call the function at a position
- outgoingCalls: Find all functions/methods called by the function at a position

All operations require:
- filePath: The file to operate on
- line: The line number (1-based, as shown in editors)
- character: The character offset (1-based, as shown in editors)

The workspaceSymbol operation also takes:
- query: The symbol name or partial name to search for. Always provide it — most language servers return no results for an empty query.

Note: LSP servers must be configured for the file type. If no server is available, an error will be returned.

Prefer this tool over grep when looking up where a symbol is defined, its references, its implementations, or its callers.`;

const Parameters = Type.Object({
	operation: Type.Unsafe<Operation>({ type: "string", enum: [...OPERATIONS], description: "The LSP operation to perform" }),
	filePath: Type.String({ description: "The absolute or relative path to the file" }),
	line: Type.Integer({ exclusiveMinimum: 0, description: "The line number (1-based, as shown in editors)" }),
	character: Type.Integer({ exclusiveMinimum: 0, description: "The character offset (1-based, as shown in editors)" }),
	query: Type.Optional(Type.String({ description: "The symbol name or partial name to search for (workspaceSymbol only). Most language servers return no results for an empty query, so always provide it when using workspaceSymbol." })),
});

export interface LspParams {
	operation: Operation;
	filePath: string;
	line: number;
	character: number;
	query?: string;
}

/** 工具执行时需要的运行时，由 index.ts 在会话开始时提供。 */
export interface ToolRuntime {
	manager: ServerManager;
	cwd: string;
	/** 服务器命令找不到时调用：可能提示或执行安装，返回附在结果后面的说明；安装成功时返回 installed。 */
	onMissing(serverName: string, command: string, signal: AbortSignal | undefined): Promise<{ installed: boolean; note: string }>;
}

/** 操作到 LSP 请求的映射，与 Claude Code 相同。 */
export function requestFor(p: LspParams, absPath: string): { method: string; params: unknown } {
	const textDocument = { uri: fileUri(absPath) };
	const position = { line: p.line - 1, character: p.character - 1 };
	switch (p.operation) {
		case "goToDefinition":
			return { method: "textDocument/definition", params: { textDocument, position } };
		case "findReferences":
			return { method: "textDocument/references", params: { textDocument, position, context: { includeDeclaration: true } } };
		case "hover":
			return { method: "textDocument/hover", params: { textDocument, position } };
		case "documentSymbol":
			return { method: "textDocument/documentSymbol", params: { textDocument } };
		case "workspaceSymbol":
			return { method: "workspace/symbol", params: { query: p.query ?? "" } };
		case "goToImplementation":
			return { method: "textDocument/implementation", params: { textDocument, position } };
		case "prepareCallHierarchy":
		case "incomingCalls":
		case "outgoingCalls":
			return { method: "textDocument/prepareCallHierarchy", params: { textDocument, position } };
	}
}

/** git check-ignore 批量判断，与 Claude Code 相同：每批 50 个路径，每批最多 5 秒；git 不可用时不过滤。 */
async function ignoredPaths(paths: string[], cwd: string): Promise<Set<string>> {
	const ignored = new Set<string>();
	for (let i = 0; i < paths.length; i += 50) {
		const batch = paths.slice(i, i + 50);
		const stdout = await new Promise<string>((res) => {
			execFile("git", ["check-ignore", ...batch], { cwd, timeout: 5000 }, (_err, out) => res(typeof out === "string" ? out : ""));
		});
		for (const line of stdout.split("\n")) if (line.trim()) ignored.add(line.trim());
	}
	return ignored;
}

type WithUri = { uri?: string; targetUri?: string; location?: { uri?: string } };

async function filterIgnored(op: Operation, result: unknown, cwd: string): Promise<unknown> {
	if (!Array.isArray(result) || !["findReferences", "goToDefinition", "goToImplementation", "workspaceSymbol"].includes(op)) return result;
	const uriOf = (x: WithUri): string | undefined => (op === "workspaceSymbol" ? x?.location?.uri : x && ("targetUri" in x ? x.targetUri : x.uri));
	const uris = [...new Set((result as WithUri[]).map(uriOf).filter((u): u is string => Boolean(u)))];
	if (uris.length === 0) return result;
	const ignored = await ignoredPaths(uris.map(uriToPath), cwd);
	if (ignored.size === 0) return result;
	return (result as WithUri[]).filter((x) => {
		const u = uriOf(x);
		return !u || !ignored.has(uriToPath(u));
	});
}

function validate(p: LspParams): void {
	const problems: string[] = [];
	if (!OPERATIONS.includes(p.operation)) problems.push(`operation must be one of ${OPERATIONS.join(", ")}`);
	if (typeof p.filePath !== "string" || !p.filePath) problems.push("filePath must be a non-empty string");
	if (!Number.isInteger(p.line) || p.line <= 0) problems.push("line must be a positive integer");
	if (!Number.isInteger(p.character) || p.character <= 0) problems.push("character must be a positive integer");
	if (problems.length) throw new Error(`Invalid input: ${problems.join("; ")}`);
}

function withHint(text: string, hint: string): string {
	return hint ? `${text}\n\n${hint}` : text;
}

/** 依赖 line / character 的操作，位置打偏时结果为空或出错。 */
const POSITIONAL: ReadonlySet<Operation> = new Set(OPERATIONS.filter((op) => op !== "documentSymbol" && op !== "workspaceSymbol"));

const isCallsQuery = (op: Operation): boolean => op === "incomingCalls" || op === "outgoingCalls";

/** 结果为空：没有命中任何符号。 */
function isEmpty(result: unknown): boolean {
	return result == null || (Array.isArray(result) && result.length === 0);
}

const IDENTIFIER = /[\p{L}\p{Nl}_$][\p{L}\p{N}_$]*/gu;
const MAX_LINE_TEXT = 200;
const MAX_IDENTIFIERS = 30;

/**
 * V5：位置类操作落空或出错时附在结果后面的提示，给出该行原文与行内每个标识符的 1 基列号。
 * 模型是估出 character 的，常常打在空白、标点或行尾之后；只回一句「没找到」时它连错两三次就改用 grep。
 * 只给信息、不替模型换位置：同一行常有多个标识符（如 pkg.Table.Get），自动挑一个可能跳错地方，且结果与请求的位置对不上。
 * 列号按 UTF-16 计，与参数的 character 一致。读不到文件时返回空串，不影响原结果。
 */
export async function positionHint(absPath: string, line: number): Promise<string> {
	let text: string;
	try {
		text = await readFile(absPath, "utf8");
	} catch {
		return "";
	}
	const lines = text.split(/\r?\n/);
	if (line > lines.length) return `Line ${line} is past the end of the file, which has ${lines.length} lines.`;
	const src = lines[line - 1];
	const ids = [...src.matchAll(IDENTIFIER)].slice(0, MAX_IDENTIFIERS).map((m) => `${m[0]} ${m.index + 1}`);
	const shown = src.trim().length > MAX_LINE_TEXT ? `${src.trim().slice(0, MAX_LINE_TEXT)}…` : src.trim();
	if (ids.length === 0) return `Line ${line} has no identifiers: ${shown}`;
	return `Line ${line}: ${shown}\nIdentifiers on this line (name character): ${ids.join(", ")}\nIf the position was off, retry with the character of the identifier you meant.`;
}

/** 执行一次 lsp 工具调用，返回给模型的文本。参数或文件问题直接抛错。 */
export async function runLsp(rt: ToolRuntime, p: LspParams, signal?: AbortSignal): Promise<string> {
	validate(p);
	const abs = resolve(rt.cwd, p.filePath);
	let st: import("node:fs").Stats;
	try {
		st = await stat(abs);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`File does not exist: ${p.filePath}`);
		throw new Error(`Cannot access file: ${p.filePath}. ${(e as Error).message}`);
	}
	if (!st.isFile()) throw new Error(`Path is not a file: ${p.filePath}`);

	let found = rt.manager.lookup(abs);
	if (found.kind === "none") return `No LSP server available for file type: ${extname(abs)}`;
	if (found.kind === "missing") {
		const { installed, note } = await rt.onMissing(found.server.name, found.command, signal);
		if (installed) found = rt.manager.lookup(abs);
		if (found.kind !== "ok") return `No LSP server available for file type: ${extname(abs)}${note ? `\n\n${note}` : ""}`;
	}
	const inst: Instance = found.inst;
	try {
		await rt.manager.ensureRunning(inst);
		const tooLarge = await rt.manager.openForQuery(inst, abs);
		if (tooLarge) return tooLarge;
		// D13：服务器刚启动时先等它加载完工程，否则引用、定义等会静默返回不完整的结果；只有启动后的第一次查询会等。
		await inst.client.whenReady(signal);
		const { method, params } = requestFor(p, abs);
		let result = await rt.manager.request<unknown>(inst, method, params, signal);
		if (p.operation === "incomingCalls" || p.operation === "outgoingCalls") {
			if (!Array.isArray(result) || result.length === 0) return withHint(NO_CALL_HIERARCHY_ITEM, await positionHint(abs, p.line));
			const next = p.operation === "incomingCalls" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls";
			result = await rt.manager.request<unknown>(inst, next, { item: result[0] }, signal);
		}
		result = await filterIgnored(p.operation, result, rt.cwd);
		const text = formatResult(p.operation, result, rt.cwd);
		// incoming / outgoing 走到这里时位置已经命中（prepareCallHierarchy 有结果），为空只说明没有调用关系。
		return POSITIONAL.has(p.operation) && !isCallsQuery(p.operation) && isEmpty(result) ? withHint(text, await positionHint(abs, p.line)) : text;
	} catch (e) {
		const text = `Error performing ${p.operation}: ${(e as Error).message}`;
		// 只有服务器回了错误（带 JSON-RPC 错误码）才可能是位置问题；超时、取消、启动失败与位置无关，不附提示。
		const fromServer = typeof (e as { code?: unknown }).code === "number";
		return POSITIONAL.has(p.operation) && fromServer ? withHint(text, await positionHint(abs, p.line)) : text;
	}
}

/**
 * 写进 pi 默认系统提示 Available tools 一节的工具简介。
 * pi 只列出填了 promptSnippet 的自定义工具；不填时模型只看到 bash 的「ls, grep, find」与规则「Use bash for file operations like ls, rg, find」，导航类问题几乎都去 grep。
 * 有意偏离 V4：Claude Code 的系统提示里没有这段。
 */
export const PROMPT_SNIPPET = "Code intelligence from language servers: definitions, references, hover, symbols, implementations, call hierarchy";

/**
 * 追加到系统提示 Guidelines 的使用引导（V4）：优先用 lsp，不可用时退回文本搜索，不写成绝对禁止。
 * 按任务而不按「已知符号名」来写：模型手里常常只有一个概念或一处用法，只写「查某符号的定义、引用」时它会认定 lsp 不适用而去 grep。
 *   - 第一条：凡是关于代码实体而非文本的问题都适用，并给出没有名字、没有位置时怎么起步。
 *   - 第二条：依赖在工作区外（模块缓存、node_modules 等），grep 搜不到，模型会去 find、go list 或翻缓存目录；在用法处跳定义一步就拿到文件路径。
 *   - 第三条：退回文本搜索的条件。
 */
export const PROMPT_GUIDELINES = [
	"Prefer the lsp tool for any question about code entities rather than text: where something is defined or implemented, who uses or calls it, what type or documentation it has, or what a file declares. You do not need the exact name or position up front: find any line that mentions it with grep -n or read, then run lsp on that line, or search a partial name with workspaceSymbol.",
	"For code in a dependency outside the workspace, such as the Go module cache, node_modules, or site-packages, run goToDefinition or hover on an import or a usage of it instead of locating the source with find, go list, pip show, or by browsing cache directories. goToDefinition returns the dependency's file path, which you can then read.",
	"Fall back to grep or rg when lsp reports no server for the file type, returns an error, or returns nothing useful, and use them for plain-text searches such as strings, comments, or config keys.",
];

export function createLspTool(getRuntime: () => ToolRuntime | undefined): ToolDefinition<typeof Parameters> {
	return {
		name: "lsp",
		label: "LSP",
		description: TOOL_DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: Parameters,
		executionMode: "parallel",
		async execute(_id, params, signal) {
			const rt = getRuntime();
			const text = rt ? await runLsp(rt, params as LspParams, signal) : "LSP server manager not initialized. This may indicate a startup issue.";
			return { content: [{ type: "text", text }], details: { operation: params.operation, filePath: params.filePath } };
		},
	};
}

