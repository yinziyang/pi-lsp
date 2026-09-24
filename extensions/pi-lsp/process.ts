// 语言服务器子进程的启动、强制终止与遗留清理。
//
// 不变量：pi-lsp 起的每个服务器进程都必须有确定的结束路径，不留死进程占资源。
//   - 子进程放进单独的进程组（detached），终止时对整组发信号，连同它起的子进程一起收掉。
//   - 实测所有内置服务器在 stdin 管道断开后 1 秒内退出，所以 pi 被强杀时服务器会跟着退出。
//   - 每个服务器进程登记一条记录（pi 进程号、服务器进程号、命令）；下次会话开始时，记录里 pi 已死而服务器还活着的，按命令核对后清理。
// 有序的 shutdown / exit 由 client.ts 负责，这里只负责信号层面的兜底。

import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 在单独的进程组里启动服务器，三个标准流都走管道。 */
export function spawnServer(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
	return spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
}

/** 进程是否存活；没有权限查看（EPERM）也视为存活，宁可少清理也不误杀。 */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** 对整个进程组发信号；组已不存在时静默返回。 */
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pgid, signal);
	} catch {
		// 进程组已经全部退出。
	}
}

/**
 * 列出 pid 的全部子孙进程。
 * 子孙可能自己换了进程组（例如 gopls 的 telemetry 进程），只杀进程组收不到它们，所以要按父子关系另外找。
 * 查询失败时返回空列表，调用方仍会对进程组发信号。
 */
export function descendantsOf(pid: number): number[] {
	let out: string;
	try {
		out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 2000 });
	} catch {
		return [];
	}
	const children = new Map<number, number[]>();
	for (const line of out.split("\n")) {
		const [p, pp] = line.trim().split(/\s+/).map(Number);
		if (!p || !pp) continue;
		const list = children.get(pp);
		if (list) list.push(p);
		else children.set(pp, [p]);
	}
	const result: number[] = [];
	const stack = [pid];
	while (stack.length) {
		for (const c of children.get(stack.pop() as number) ?? []) {
			result.push(c);
			stack.push(c);
		}
	}
	return result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 按信号强制终止服务器及其子孙：先对进程组与子孙发 SIGTERM，最多等 termMs；仍未退出再发 SIGKILL。
 * 子孙列表在发信号之前取，父进程一退出，子孙会被过继给 init，就再也按父子关系找不到了。
 */
export async function forceTerminate(child: ChildProcessWithoutNullStreams, termMs: number): Promise<void> {
	const pid = child.pid;
	if (pid === undefined) return;
	const descendants = descendantsOf(pid);
	const exited = () => child.exitCode !== null || child.signalCode !== null;
	signalGroup(pid, "SIGTERM");
	for (const d of descendants) signalGroup(d, "SIGTERM");
	const deadline = Date.now() + termMs;
	while (Date.now() < deadline && (!exited() || descendants.some(isAlive))) await sleep(50);
	if (!exited()) signalGroup(pid, "SIGKILL");
	for (const d of descendants) if (isAlive(d)) signalGroup(d, "SIGKILL");
	for (const d of descendants) {
		try {
			process.kill(d, "SIGKILL");
		} catch {
			// 已退出。
		}
	}
}

interface PidRecord {
	piPid: number;
	pid: number;
	command: string;
}

/** 服务器进程记录，存放在 dir 下，一个进程一个文件。 */
export class PidRegistry {
	private readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	private file(pid: number): string {
		return join(this.dir, `${process.pid}-${pid}.json`);
	}

	/**
	 * 登记刚启动的服务器进程。命令名当场用 ps 读取，而不是用配置里的命令：pyright 这类 node 脚本在 ps 里显示为 node。
	 * libuv 在 exec 成功后才返回 spawn，所以此时读到的已经是服务器自己的程序名。
	 */
	add(pid: number): void {
		try {
			mkdirSync(this.dir, { recursive: true });
			const rec: PidRecord = { piPid: process.pid, pid, command: commandOf(pid) };
			writeFileSync(this.file(pid), JSON.stringify(rec));
		} catch {
			// 记录只用于遗留清理的兜底，写失败不影响服务器本身。
		}
	}

	remove(pid: number): void {
		rmSync(this.file(pid), { force: true });
	}

	/**
	 * 清理上一个 pi 遗留的服务器：记录里 pi 已死、服务器进程还活着、且进程的命令与记录一致时，终止它的进程组与子孙。
	 * 命令不一致说明进程号已被系统复用给了别的程序，只删记录不杀进程。返回清理掉的进程数。
	 */
	sweep(): number {
		let names: string[];
		try {
			names = readdirSync(this.dir);
		} catch {
			return 0;
		}
		let killed = 0;
		for (const name of names) {
			const path = join(this.dir, name);
			let rec: PidRecord;
			try {
				rec = JSON.parse(readFileSync(path, "utf8")) as PidRecord;
			} catch {
				rmSync(path, { force: true });
				continue;
			}
			if (rec.piPid === process.pid || isAlive(rec.piPid)) continue;
			if (isAlive(rec.pid) && commandOf(rec.pid) === rec.command) {
				const descendants = descendantsOf(rec.pid);
				signalGroup(rec.pid, "SIGKILL");
				for (const d of descendants) signalGroup(d, "SIGKILL");
				killed++;
			}
			rmSync(path, { force: true });
		}
		return killed;
	}
}

/** 进程的可执行文件名（不含参数）；查不到返回空串。 */
export function commandOf(pid: number): string {
	try {
		const cmd = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
		return cmd.split("/").pop() ?? "";
	} catch {
		return "";
	}
}
