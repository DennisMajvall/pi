/**
 * Tests for the walking-skeleton ProcessService (NodeProcessService):
 * spawn/exec/shell semantics, streaming, timeout/abort, error mapping,
 * kill/getProcess, and not-implemented methods.
 */

import { afterEach, describe, expect, it } from "vitest";
import { NotFoundError, PlatformError } from "../src/error/index.ts";
import { NodeProcessService } from "../src/kernel/process-service.ts";
import type { ProcessHandle } from "../src/service/index.ts";

const services: NodeProcessService[] = [];

function createService(): NodeProcessService {
	const service = new NodeProcessService();
	services.push(service);
	return service;
}

afterEach(() => {
	services.length = 0;
});

/** Collect a handle's stdout/stderr into strings while awaiting exit. */
async function collect(handle: ProcessHandle): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	let stdout = "";
	let stderr = "";
	const pump = async (stream: ReadableStream<Uint8Array> | null, collectText: (text: string) => void) => {
		if (!stream) return;
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				collectText(decoder.decode(value, { stream: true }));
			}
		} catch {
			// Stream destroyed by exit handling.
		}
	};
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
	return { stdout, stderr, exitCode };
}

describe("NodeProcessService: spawn", () => {
	it("spawns a process and streams stdout/stderr through Web Streams", async () => {
		const service = createService();
		const handle = service.spawn(
			process.execPath,
			["-e", "console.log('out'); console.error('err'); process.exit(0)"],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		const result = await collect(handle);
		expect(result.stdout).toContain("out");
		expect(result.stderr).toContain("err");
		expect(result.exitCode).toBe(0);
	});

	it("exposes process info via getProcess and resolves exited with the exit code", async () => {
		const service = createService();
		const handle = service.spawn(process.execPath, ["-e", "process.exit(7)"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const info = service.getProcess(handle.pid);
		expect(info?.command).toBe(process.execPath);
		expect(info?.pid).toBe(handle.pid);
		expect(await handle.exited).toBe(7);
	});

	it("rejects exited on spawn errors (missing binary)", async () => {
		const service = createService();
		const handle = service.spawn("/nonexistent-binary-xyz", [], { stdio: ["ignore", "pipe", "pipe"] });
		await expect(handle.exited).rejects.toThrow(/ENOENT/);
	});

	it("supports stdin pipes", async () => {
		const service = createService();
		const handle = service.spawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		const writer = handle.stdin?.getWriter();
		await writer?.write("echo-stdin");
		await writer?.close();
		const result = await collect(handle);
		expect(result.stdout).toContain("echo-stdin");
		expect(result.exitCode).toBe(0);
	});

	it("kills the process when the abort signal fires", async () => {
		const service = createService();
		const controller = new AbortController();
		const handle = service.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
			stdio: ["ignore", "pipe", "pipe"],
			signal: controller.signal,
		});
		const exited = handle.exited;
		setTimeout(() => controller.abort(), 100);
		const exitCode = await exited;
		expect(exitCode).toBe(-1);
	});

	it("supports the detached option", async () => {
		const service = createService();
		const handle = service.spawn(process.execPath, ["-e", "process.exit(0)"], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		expect(await handle.exited).toBe(0);
	});

	it("resolves exited for a process whose descendant holds stdio open", async () => {
		const service = createService();
		// The child spawns a detached grandchild with inherited stdio and exits
		// immediately; the shell/process must not hang the caller.
		const script =
			"const {spawn}=require('node:child_process');" +
			"const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit',detached:true});" +
			"c.unref();" +
			"console.log('child-exiting');" +
			"process.exit(0);";
		const handle = service.spawn(process.execPath, ["-e", script], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		const result = await collect(handle);
		expect(result.stdout).toContain("child-exiting");
		expect(result.exitCode).toBe(0);
	});
});

describe("NodeProcessService: exec", () => {
	it("collects stdout/stderr and the exit code", async () => {
		const service = createService();
		const result = await service.exec(process.execPath, [
			"-e",
			"console.log('out'); console.error('err'); process.exit(3)",
		]);
		expect(result.stdout).toContain("out");
		expect(result.stderr).toContain("err");
		expect(result.exitCode).toBe(3);
		expect(result.timedOut).toBe(false);
		expect(result.killed).toBe(false);
	});

	it("rejects on spawn errors", async () => {
		const service = createService();
		await expect(service.exec("/nonexistent-binary-xyz", [])).rejects.toThrow(/ENOENT/);
	});

	it("reports timedOut when the timeout elapses", async () => {
		const service = createService();
		const started = Date.now();
		const result = await service.exec(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { timeout: 150 });
		expect(result.timedOut).toBe(true);
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it("reports killed when the signal aborts", async () => {
		const service = createService();
		const controller = new AbortController();
		const promise = service.exec(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 100);
		const result = await promise;
		expect(result.killed).toBe(true);
		expect(result.exitCode).toBe(-1);
	});
});

describe("NodeProcessService: shell", () => {
	it("runs a command through a shell and collects output", async () => {
		const service = createService();
		const result = await service.shell("echo shell-out");
		expect(result.stdout).toContain("shell-out");
		expect(result.exitCode).toBe(0);
	});

	it("propagates the shell exit code and stderr", async () => {
		const service = createService();
		const result = await service.shell("echo boom >&2 && exit 9");
		expect(result.stderr).toContain("boom");
		expect(result.exitCode).toBe(9);
	});

	it("honors the explicit shell option", async () => {
		const service = createService();
		const result = await service.shell("echo via-shell-option", { shell: "/bin/sh" });
		expect(result.stdout).toContain("via-shell-option");
		expect(result.exitCode).toBe(0);
	});
});

describe("NodeProcessService: kill and getProcess", () => {
	it("kills a tracked process", async () => {
		const service = createService();
		const handle = service.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		await service.kill(handle.pid);
		expect(await handle.exited).toBe(-1);
	});

	it("throws NotFoundError for untracked pids", async () => {
		const service = createService();
		await expect(service.kill(999_999_999)).rejects.toBeInstanceOf(NotFoundError);
	});

	it("returns undefined for unknown processes", async () => {
		const service = createService();
		expect(service.getProcess(999_999_999)).toBeUndefined();
	});
});

describe("NodeProcessService: not-implemented methods", () => {
	it("throws for spawnPty", () => {
		const service = createService();
		expect(() => service.spawnPty("cmd", [], {})).toThrow(PlatformError);
		expect(() => service.spawnPty("cmd", [], {})).toThrow(/not implemented/);
	});
});
