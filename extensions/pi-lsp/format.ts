// 把 LSP 请求的返回值格式化成给模型看的文本。
// 每个函数与 Claude Code 2.1.281 里对应的格式化函数逐字一致：输出文本、空结果的提示语、单复数、分组与缩进都不能改。
// 与 Claude Code 对照的验收用例在 test/format.test.ts 与 eval/parity。

import type {
	CallHierarchyIncomingCall,
	CallHierarchyItem,
	CallHierarchyOutgoingCall,
	DocumentSymbol,
	Hover,
	Location,
	LocationLink,
	MarkedString,
	MarkupContent,
	SymbolInformation,
	WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import { displayPath } from "./uri.ts";

/** 模型可用的 9 个操作，与 Claude Code 的 LSP 工具相同。 */
export const OPERATIONS = [
	"goToDefinition",
	"findReferences",
	"hover",
	"documentSymbol",
	"workspaceSymbol",
	"goToImplementation",
	"prepareCallHierarchy",
	"incomingCalls",
	"outgoingCalls",
] as const;
export type Operation = (typeof OPERATIONS)[number];

const NO_DEFINITION = "No definition found. This may occur if the cursor is not on a symbol, or if the definition is in an external library not indexed by the LSP server.";
const NO_REFERENCES = "No references found. This may occur if the symbol has no usages, or if the LSP server has not fully indexed the workspace.";
const NO_HOVER = "No hover information available. This may occur if the cursor is not on a symbol, or if the LSP server has not fully indexed the file.";
const NO_DOCUMENT_SYMBOLS = "No symbols found in document. This may occur if the file is empty, not supported by the LSP server, or if the server has not fully indexed the file.";
const NO_WORKSPACE_SYMBOLS = "No symbols found in workspace. This may occur if the workspace is empty, or if the LSP server has not finished indexing the project.";
export const NO_CALL_HIERARCHY_ITEM = "No call hierarchy item found at this position";

type AnyLocation = Location | LocationLink;
type WorkspaceSymbolLike = SymbolInformation | WorkspaceSymbol;

function plural(count: number, word: string): string {
	return count === 1 ? word : `${word}s`;
}

/** LocationLink 统一成 Location：优先用 targetSelectionRange，没有再用 targetRange。 */
export function toLocation(loc: AnyLocation): Location {
	return "targetUri" in loc ? { uri: loc.targetUri, range: loc.targetSelectionRange || loc.targetRange } : loc;
}

function locationText(loc: Location, cwd: string): string {
	return `${displayPath(loc.uri, cwd)}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
}

/** 按显示路径分组，保持首次出现的顺序。 */
function groupByFile<T>(items: T[], uriOf: (item: T) => string, cwd: string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const key = displayPath(uriOf(item), cwd);
		const list = groups.get(key);
		if (list) list.push(item);
		else groups.set(key, [item]);
	}
	return groups;
}

const SYMBOL_KINDS: Record<number, string> = {
	1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class", 6: "Method", 7: "Property", 8: "Field", 9: "Constructor",
	10: "Enum", 11: "Interface", 12: "Function", 13: "Variable", 14: "Constant", 15: "String", 16: "Number", 17: "Boolean",
	18: "Array", 19: "Object", 20: "Key", 21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event", 25: "Operator", 26: "TypeParameter",
};

export function symbolKindName(kind: number): string {
	return SYMBOL_KINDS[kind] || "Unknown";
}

/** goToDefinition 与 goToImplementation 共用。 */
export function formatDefinition(result: AnyLocation | AnyLocation[] | null | undefined, cwd: string): string {
	if (!result) return NO_DEFINITION;
	if (Array.isArray(result)) {
		const locs = result.map((l) => (l && "targetUri" in l ? toLocation(l) : l)).filter((l): l is Location => Boolean(l && l.uri));
		if (locs.length === 0) return NO_DEFINITION;
		if (locs.length === 1) return `Defined in ${locationText(locs[0], cwd)}`;
		return `Found ${locs.length} definitions:\n${locs.map((l) => `  ${locationText(l, cwd)}`).join("\n")}`;
	}
	return `Defined in ${locationText(toLocation(result), cwd)}`;
}

export function formatReferences(result: Location[] | null | undefined, cwd: string): string {
	if (!result || result.length === 0) return NO_REFERENCES;
	const refs = result.filter((r) => r && r.uri);
	if (refs.length === 0) return NO_REFERENCES;
	if (refs.length === 1) return `Found 1 reference:\n  ${locationText(refs[0], cwd)}`;
	const groups = groupByFile(refs, (r) => r.uri, cwd);
	const lines = [`Found ${refs.length} references across ${groups.size} files:`];
	for (const [file, items] of groups) {
		lines.push(`\n${file}:`);
		for (const r of items) lines.push(`  Line ${r.range.start.line + 1}:${r.range.start.character + 1}`);
	}
	return lines.join("\n");
}

function hoverContents(contents: MarkupContent | MarkedString | MarkedString[]): string {
	if (Array.isArray(contents)) return contents.map((c) => (typeof c === "string" ? c : c.value)).join("\n\n");
	if (typeof contents === "string") return contents;
	return contents.value;
}

export function formatHover(result: Hover | null | undefined, _cwd: string): string {
	if (!result) return NO_HOVER;
	const text = hoverContents(result.contents);
	if (result.range) return `Hover info at ${result.range.start.line + 1}:${result.range.start.character + 1}:\n\n${text}`;
	return text;
}

function documentSymbolLines(sym: DocumentSymbol, depth: number): string[] {
	let line = `${"  ".repeat(depth)}${sym.name} (${symbolKindName(sym.kind)})`;
	if (sym.detail) line += ` ${sym.detail}`;
	line += ` - Line ${sym.range.start.line + 1}`;
	const out = [line];
	for (const child of sym.children ?? []) out.push(...documentSymbolLines(child, depth + 1));
	return out;
}

export function formatDocumentSymbols(result: DocumentSymbol[] | SymbolInformation[] | null | undefined, cwd: string): string {
	if (!result || result.length === 0) return NO_DOCUMENT_SYMBOLS;
	// 服务器返回扁平的 SymbolInformation 时，按工作区符号的格式输出，与 Claude Code 相同。
	if (result[0] && "location" in result[0]) return formatWorkspaceSymbols(result as SymbolInformation[], cwd);
	const lines = ["Document symbols:"];
	for (const sym of result as DocumentSymbol[]) lines.push(...documentSymbolLines(sym, 0));
	return lines.join("\n");
}

export function formatWorkspaceSymbols(result: WorkspaceSymbolLike[] | null | undefined, cwd: string): string {
	if (!result || result.length === 0) return NO_WORKSPACE_SYMBOLS;
	const syms = result.filter((s) => s && s.location && s.location.uri);
	if (syms.length === 0) return NO_WORKSPACE_SYMBOLS;
	const lines = [`Found ${syms.length} ${plural(syms.length, "symbol")} in workspace:`];
	for (const [file, items] of groupByFile(syms, (s) => s.location.uri, cwd)) {
		lines.push(`\n${file}:`);
		for (const s of items) {
			// WorkspaceSymbol 的 location 可能只有 uri 没有 range；Claude Code 直接读 range，这里缺 range 时按第 1 行处理，避免崩溃。
			const start = "range" in s.location ? s.location.range.start.line + 1 : 1;
			let line = `  ${s.name} (${symbolKindName(s.kind)}) - Line ${start}`;
			if (s.containerName) line += ` in ${s.containerName}`;
			lines.push(line);
		}
	}
	return lines.join("\n");
}

function callHierarchyItemText(item: CallHierarchyItem, cwd: string): string {
	if (!item.uri) return `${item.name} (${symbolKindName(item.kind)}) - <unknown location>`;
	let text = `${item.name} (${symbolKindName(item.kind)}) - ${displayPath(item.uri, cwd)}:${item.range.start.line + 1}`;
	if (item.detail) text += ` [${item.detail}]`;
	return text;
}

export function formatPrepareCallHierarchy(result: CallHierarchyItem[] | null | undefined, cwd: string): string {
	if (!result || result.length === 0) return NO_CALL_HIERARCHY_ITEM;
	if (result.length === 1) return `Call hierarchy item: ${callHierarchyItemText(result[0], cwd)}`;
	return [`Found ${result.length} call hierarchy items:`, ...result.map((i) => `  ${callHierarchyItemText(i, cwd)}`)].join("\n");
}

function rangesText(ranges: { start: { line: number; character: number } }[]): string {
	return ranges.map((r) => `${r.start.line + 1}:${r.start.character + 1}`).join(", ");
}

export function formatIncomingCalls(result: CallHierarchyIncomingCall[] | null | undefined, cwd: string): string {
	if (!result || result.length === 0) return "No incoming calls found (nothing calls this function)";
	const lines = [`Found ${result.length} incoming ${plural(result.length, "call")}:`];
	for (const [file, calls] of groupByFile(result.filter((c) => c.from), (c) => c.from.uri, cwd)) {
		lines.push(`\n${file}:`);
		for (const c of calls) {
			let line = `  ${c.from.name} (${symbolKindName(c.from.kind)}) - Line ${c.from.range.start.line + 1}`;
			if (c.fromRanges && c.fromRanges.length > 0) line += ` [calls at: ${rangesText(c.fromRanges)}]`;
			lines.push(line);
		}
	}
	return lines.join("\n");
}

export function formatOutgoingCalls(result: CallHierarchyOutgoingCall[] | null | undefined, cwd: string): string {
	if (!result || result.length === 0) return "No outgoing calls found (this function calls nothing)";
	const lines = [`Found ${result.length} outgoing ${plural(result.length, "call")}:`];
	for (const [file, calls] of groupByFile(result.filter((c) => c.to), (c) => c.to.uri, cwd)) {
		lines.push(`\n${file}:`);
		for (const c of calls) {
			let line = `  ${c.to.name} (${symbolKindName(c.to.kind)}) - Line ${c.to.range.start.line + 1}`;
			if (c.fromRanges && c.fromRanges.length > 0) line += ` [called from: ${rangesText(c.fromRanges)}]`;
			lines.push(line);
		}
	}
	return lines.join("\n");
}

/** 按操作分派到对应的格式化函数。incoming / outgoing 传入的是第二步 callHierarchy 请求的结果。 */
export function formatResult(op: Operation, result: unknown, cwd: string): string {
	switch (op) {
		case "goToDefinition":
		case "goToImplementation":
			return formatDefinition(result as AnyLocation | AnyLocation[] | null, cwd);
		case "findReferences":
			return formatReferences(result as Location[] | null, cwd);
		case "hover":
			return formatHover(result as Hover | null, cwd);
		case "documentSymbol":
			return formatDocumentSymbols(result as DocumentSymbol[] | SymbolInformation[] | null, cwd);
		case "workspaceSymbol":
			return formatWorkspaceSymbols(result as WorkspaceSymbolLike[] | null, cwd);
		case "prepareCallHierarchy":
			return formatPrepareCallHierarchy(result as CallHierarchyItem[] | null, cwd);
		case "incomingCalls":
			return formatIncomingCalls(result as CallHierarchyIncomingCall[] | null, cwd);
		case "outgoingCalls":
			return formatOutgoingCalls(result as CallHierarchyOutgoingCall[] | null, cwd);
	}
}
