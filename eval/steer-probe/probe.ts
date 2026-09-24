// 阶段 1 的一次性探针：验证 pi 的 steer / nextTurn 投递是否满足 pi-lsp 送诊断的前提。
// 记录到 PROBE_LOG 指向的 JSONL：工具执行起止时间、tool_result 处理器里的等待、每次请求模型时标记出现的次数。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

const LOG = process.env.PROBE_LOG ?? "/tmp/pi-steer-probe.jsonl";
const WAIT_MS = Number(process.env.PROBE_WAIT_MS ?? "0");
const log = (o: Record<string, unknown>) => appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + "\n");
const count = (s: string, token: string) => s.split(token).length - 1;

export default function probe(pi: ExtensionAPI) {
	pi.on("tool_execution_start", (e) => log({ ev: "start", tool: e.toolName }));
	pi.on("tool_execution_end", (e) => log({ ev: "end", tool: e.toolName }));
	pi.on("tool_result", async (e) => {
		if (e.toolName !== "write" || e.isError) return;
		log({ ev: "tool_result_begin", tool: e.toolName });
		if (WAIT_MS) await new Promise((r) => setTimeout(r, WAIT_MS));
		pi.sendMessage({ customType: "lsp-probe", content: "<new-diagnostics>PROBE-STEER-TOKEN</new-diagnostics>", display: true }, { deliverAs: "steer" });
		log({ ev: "tool_result_end", tool: e.toolName });
	});
	pi.on("agent_end", () => {
		if (process.env.PROBE_NEXTTURN !== "1") return;
		pi.sendMessage({ customType: "lsp-probe", content: "PROBE-NEXTTURN-TOKEN", display: true }, { deliverAs: "nextTurn" });
		log({ ev: "nextturn_queued" });
	});
	pi.on("before_provider_request", (e) => {
		const s = JSON.stringify(e.payload);
		log({ ev: "request", steer: count(s, "PROBE-STEER-TOKEN"), next: count(s, "PROBE-NEXTTURN-TOKEN") });
	});
}
