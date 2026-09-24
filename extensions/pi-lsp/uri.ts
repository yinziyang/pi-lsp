// 文件路径与 LSP URI 的互转，以及给模型看的路径写法。
// 显示规则逐字照抄 Claude Code 的 formatUri：相对路径更短、且不以 ../../ 开头时用相对路径，否则用绝对路径，分隔符统一为 /。

import { relative } from "node:path";
import { pathToFileURL } from "node:url";

/** 本地路径转 file:// URI。 */
export function fileUri(path: string): string {
	return pathToFileURL(path).href;
}

/**
 * LSP 返回的 URI 转本地路径。
 * 与 Claude Code 相同：去掉 file:// 前缀与 Windows 盘符前多出的斜杠，再做 URI 解码；解码失败时用未解码的路径。
 */
export function uriToPath(uri: string): string {
	let path = uri.replace(/^file:\/\//, "");
	if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
	try {
		path = decodeURIComponent(path);
	} catch {
		// 畸形的百分号编码按原样显示，与 Claude Code 的降级行为一致。
	}
	return path;
}

/** 给模型看的路径；uri 缺失时返回 Claude Code 同款的占位文本。 */
export function displayPath(uri: string | undefined, cwd: string | undefined): string {
	if (!uri) return "<unknown location>";
	const path = uriToPath(uri);
	if (cwd) {
		const rel = relative(cwd, path).replaceAll("\\", "/");
		if (rel.length < path.length && !rel.startsWith("../../")) return rel;
	}
	return path.replaceAll("\\", "/");
}
