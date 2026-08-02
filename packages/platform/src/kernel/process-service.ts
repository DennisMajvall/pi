/**
 * Walking-skeleton ProcessService.
 *
 * A thin wrapper over node:child_process for the methods the bash pilot needs
 * (spawn with streamed stdio, kill, exit wait) plus the string-collecting
 * conveniences (exec / shell) the next extractions (Workspaces runs git, etc.)
 * will use. Everything else throws "not implemented", mirroring
 * NodeFileSystemService.
 *
 * Kill semantics: killing a spawned process kills its process tree (POSIX
 * process-group SIGKILL, Windows taskkill /F /T) — a shell's descendants are
 * its command, and killing only the shell would orphan running commands. This
 * matches the behavior of the legacy createLocalBashOperations.
 *
 * ProcessHandle.exited resolves on process close, or after exit once the stdio
 * pipes end, or after a short idle grace (re-armed on output) so detached
 * descendants holding pipes cannot hang the caller and tail output is not
 * lost. A signal-killed process has no exit code; exited resolves -1.
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { NotFoundError, PlatformError } from "../error/index.ts";
import type {
	ExecOptions,
	ExecResult,
	ProcessHandle,
	ProcessInfo,
	ProcessService,
	PtyHandle,
	PtyOptions,
	ShellOptions,
	SpawnOptions,
} from "../service/index.ts";

/** Idle grace after process exit before resolving, mirroring waitForChildProcess. */
const EXIT_STDIO_GRACE_MS = 100;

function notImplemented(method: string): never {
	throw new PlatformError(`ProcessService.${method} is not implemented in the walking skeleton`, {
		code: "NOT_IMPLEMENTED",
	});
}

/**
 * Wait for a child process to terminate without hanging on inherited stdio
 * handles. Port of the coding-agent waitForChildProcess semantics: resolve on
 * close, or after exit when the pipes end, or after an idle grace re-armed on
 * every chunk (so an actively writing descendant keeps us reading, while a
 * quiet inherited handle still releases us). Spawn errors reject.
 */
function waitForProcessExit(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(exitCode);
			}
		};

		const armIdleTimer = () => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
		};

		const onData = () => {
			// Output is still arriving after exit; defer finalizing so we don't
			// destroy the stream mid-write and truncate the tail.
			if (exited && !settled) armIdleTimer();
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const onExit = (code: number | null) => {
			exited = true;
			exitCode = code;
			maybeFinalizeAfterExit();
			if (!settled) {
				armIdleTimer();
			}
		};

		const onClose = (code: number | null) => {
			finalize(code);
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

/** Kill a process and its whole tree (cross-platform). */
function killProcessTree(pid: number, signal = "SIGKILL"): void {
	if (process.platform === "win32") {
		try {
			nodeSpawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
		} catch {
			// Ignore errors if taskkill fails
		}
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Process already dead
		}
	}
}

class NodeProcessHandle implements ProcessHandle {
	readonly pid: number;
	readonly stdin: WritableStream | null;
	readonly stdout: ReadableStream | null;
	readonly stderr: ReadableStream | null;
	readonly exited: Promise<number>;

	constructor(child: ChildProcess, exited: Promise<number>) {
		this.pid = child.pid ?? 0;
		this.stdin = child.stdin ? Writable.toWeb(child.stdin) : null;
		this.stdout = child.stdout ? Readable.toWeb(child.stdout) : null;
		this.stderr = child.stderr ? Readable.toWeb(child.stderr) : null;
		this.exited = exited;
	}

	async kill(signal?: string): Promise<void> {
		if (this.pid > 0) {
			killProcessTree(this.pid, signal);
		}
	}
}

export class NodeProcessService implements ProcessService {
	private readonly processes = new Map<number, ProcessInfo>();

	spawn(command: string, args: string[], options: SpawnOptions = {}): ProcessHandle {
		const child = nodeSpawn(command, args, {
			cwd: options.cwd,
			env: options.env as NodeJS.ProcessEnv,
			stdio: options.stdio,
			detached: options.detached,
			windowsHide: true,
		});
		const pid = child.pid ?? 0;
		if (pid > 0) {
			this.processes.set(pid, {
				pid,
				ppid: process.pid,
				command,
				args,
				cwd: options.cwd ?? process.cwd(),
				startTime: Date.now(),
			});
		}

		if (options.signal?.aborted) {
			killProcessTree(pid);
		} else if (options.signal) {
			options.signal.addEventListener(
				"abort",
				() => {
					killProcessTree(pid);
				},
				{ once: true },
			);
		}

		const exited = waitForProcessExit(child).then((code) => code ?? -1);
		return new NodeProcessHandle(child, exited);
	}

	async exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
		const handle = this.spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			signal: options.signal,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer =
			options.timeout !== undefined
				? setTimeout(() => {
						timedOut = true;
						void handle.kill();
					}, options.timeout)
				: undefined;
		try {
			const pump = (stream: ReadableStream | null, collect: (text: string) => void) => pumpStream(stream, collect);
			const pumps = Promise.all([
				pump(handle.stdout, (t) => {
					stdout += t;
				}),
				pump(handle.stderr, (t) => {
					stderr += t;
				}),
			]);
			const exitCode = await handle.exited;
			await pumps;
			return {
				stdout,
				stderr,
				exitCode,
				timedOut,
				killed: options.signal?.aborted ?? false,
			};
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async shell(command: string, options: ShellOptions = {}): Promise<ExecResult> {
		const shell = options.shell ?? defaultShell();
		const args = process.platform === "win32" ? ["/c", command] : ["-c", command];
		return this.exec(shell, args, {
			cwd: options.cwd,
			env: options.env,
			timeout: options.timeout,
		});
	}

	async kill(pid: number, signal?: string): Promise<void> {
		if (!this.processes.has(pid)) {
			throw new NotFoundError(`Process not spawned by this service: ${pid}`, {
				resourceType: "process",
				resourceId: String(pid),
			});
		}
		killProcessTree(pid, signal);
	}

	getProcess(pid: number): ProcessInfo | undefined {
		return this.processes.get(pid);
	}

	spawnPty(_command: string, _args: string[], _options: PtyOptions): PtyHandle {
		notImplemented("spawnPty");
	}
}

/** POSIX default shell. Windows cmd.exe is the fallback. */
function defaultShell(): string {
	if (process.platform === "win32") {
		return process.env.COMSPEC ?? "cmd.exe";
	}
	return process.env.SHELL ?? "/bin/sh";
}

/** Read a Web Stream to completion, collecting text; tolerates destruction by exit handling. */
async function pumpStream(stream: ReadableStream | null, collect: (text: string) => void): Promise<void> {
	if (!stream) return;
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			collect(decoder.decode(value, { stream: true }));
		}
		collect(decoder.decode());
	} catch {
		// Stream destroyed by exit handling; collected output is returned as-is.
	}
}
