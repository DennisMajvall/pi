/**
 * Integration test for the Step 1.7 extraction: the real SessionService
 * (SessionManagerService) adapts the existing SessionManager behind the
 * platform contract, and the kernel injects it into capability contexts via
 * the KernelServiceProvider `session` option.
 *
 * Scope honored: the read surface (create / open / list, the handle's
 * getters / getEntries / getHeader, a no-op close) is implemented; the write
 * surface (append / updateInfo / fork / delete / export / import) throws
 * NOT_IMPLEMENTED.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformError } from "@earendil-works/pi-platform/error";
import { capabilityId, sessionId, workspaceId } from "@earendil-works/pi-platform/identifier";
import { createRuntime, type KernelRuntime } from "@earendil-works/pi-platform/kernel";
import {
	type Session,
	type SessionEntry,
	SessionEntryType,
	type SessionSummary,
} from "@earendil-works/pi-platform/service";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { readCapability } from "../src/platform/read-capability.ts";
import { SessionManagerService, SessionManagerSession } from "../src/platform/session-service.ts";

const READ_ID = capabilityId("tool.read");

let kernel: KernelRuntime | undefined;
const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-service-"));
	tempDirs.push(dir);
	return dir;
}

/** Write a v3 JSONL session file with deterministic timestamps for filtering tests. */
function writeSessionFile(filePath: string, cwd: string, lines: string[]): void {
	writeFileSync(
		filePath,
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "test-session",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd,
			}),
			...lines,
			"",
		].join("\n"),
	);
}

const SESSION_LINES = [
	'{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"one","timestamp":1}}',
	'{"type":"thinking_level_change","id":"t1","parentId":"m1","timestamp":"2026-01-01T00:00:02.000Z","thinkingLevel":"high"}',
	'{"type":"model_change","id":"mc1","parentId":"t1","timestamp":"2026-01-01T00:00:02.500Z","provider":"anthropic","modelId":"claude-opus-4"}',
	'{"type":"message","id":"m2","parentId":"mc1","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"assistant","content":"two","timestamp":2,"provider":"anthropic","model":"claude-opus-4"}}',
	'{"type":"label","id":"l1","parentId":"m2","timestamp":"2026-01-01T00:00:04.000Z","targetId":"m2","label":"checkpoint"}',
	'{"type":"custom","id":"c1","parentId":"l1","timestamp":"2026-01-01T00:00:05.000Z","customType":"ext.state","data":{"x":1}}',
	'{"type":"session_info","id":"s1","parentId":"c1","timestamp":"2026-01-01T00:00:06.000Z","name":"My Session"}',
];

/** Materialize a persisted session file (an assistant message flushes the file). */
function persistedSession(cwd: string, sessionDir: string): { manager: SessionManager; file: string } {
	const manager = SessionManager.create(cwd, sessionDir);
	manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "world" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	const file = manager.getSessionFile();
	if (!file) throw new Error("session file not created");
	return { manager, file };
}

afterEach(async () => {
	if (kernel) {
		await kernel.shutdown();
		kernel = undefined;
	}
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});

describe("SessionManagerService: create / open / list", () => {
	it("create returns a handle bound to a new session", async () => {
		const agentRoot = makeTempDir();
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentRoot;
		try {
			const workspace = makeTempDir();
			const service = new SessionManagerService(SessionManager.inMemory());
			const session = await service.create({
				cwd: workspace,
				workspaceId: workspaceId("ws-1"),
				parentSessionId: sessionId("parent-1"),
			});

			expect(session.workspaceId).toBe(workspaceId("ws-1"));
			expect(session.cwd).toBe(workspace);
			const header = session.getHeader();
			expect(session.id).toBe(header.id);
			expect(header.cwd).toBe(workspace);
			expect(header.version).toBe(3);
			expect(header.createdAt).toBeGreaterThan(0);
			expect(session.createdAt).toBe(header.createdAt);
			expect(session.updatedAt).toBe(header.createdAt);
			expect(await session.getEntries()).toEqual([]);
			await session.close();
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previousAgentDir;
			}
		}
	});

	it("open reads back a session file with translated entries and header", async () => {
		const dir = makeTempDir();
		const { file } = persistedSession(dir, makeTempDir());
		const service = new SessionManagerService(SessionManager.inMemory());
		const session = await service.open(file);

		expect(session.cwd).toBe(dir);
		expect(session.workspaceId).toBe(workspaceId(dir));

		const entries = await session.getEntries();
		expect(entries).toHaveLength(2);
		expect(entries[0]!.type).toBe(SessionEntryType.Message);
		expect(entries[0]!.parentId).toBeUndefined();
		expect((entries[0]!.data as { content: string }).content).toBe("hello");
		expect(entries[1]!.type).toBe(SessionEntryType.Message);
		expect(entries[1]!.parentId).toBe(entries[0]!.id);
		expect(typeof entries[0]!.timestamp).toBe("number");
		expect(entries[0]!.timestamp).toBeGreaterThan(0);

		const header = session.getHeader();
		expect(header.id).toBe(session.id);
		expect(header.cwd).toBe(dir);
		expect(header.version).toBe(3);
		expect(header.createdAt).toBe(session.createdAt);
	});

	it("list returns session summaries for a workspace (sorted by updatedAt desc)", async () => {
		const agentRoot = makeTempDir();
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentRoot;
		try {
			const workspace = makeTempDir();
			const sessionDir = join(
				agentRoot,
				"sessions",
				`--${workspace.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
			);
			persistedSession(workspace, sessionDir);
			persistedSession(workspace, sessionDir);

			const service = new SessionManagerService(SessionManager.inMemory());
			const summaries: SessionSummary[] = await service.list(workspaceId(workspace));

			expect(summaries).toHaveLength(2);
			for (const summary of summaries) {
				expect(summary.workspaceId).toBe(workspaceId(workspace));
				expect(summary.cwd).toBe(workspace);
				expect(summary.createdAt).toBeGreaterThan(0);
				expect(summary.updatedAt).toBeGreaterThan(0);
				expect(summary.path.startsWith(sessionDir)).toBe(true);
			}
			expect(summaries[0]!.updatedAt).toBeGreaterThanOrEqual(summaries[1]!.updatedAt);
			// The two sessions have distinct ids.
			expect(summaries[0]!.id).not.toBe(summaries[1]!.id);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previousAgentDir;
			}
		}
	});

	it("getBootSession is bound to the boot-time manager", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "boot", timestamp: 1 });
		const service = new SessionManagerService(manager);

		const session = service.getBootSession();
		expect(session).toBeInstanceOf(SessionManagerSession);
		expect(session.id).toBe(sessionId(manager.getSessionId()));
		const entries = await session.getEntries();
		expect(entries).toHaveLength(1);
		expect((entries[0]!.data as { content: string }).content).toBe("boot");
	});
});

describe("SessionManagerService: entry translation and filtering", () => {
	it("translates typed entries and omits manager custom/label entries", async () => {
		const dir = makeTempDir();
		const file = join(dir, "session.jsonl");
		writeSessionFile(file, dir, SESSION_LINES);
		const service = new SessionManagerService(SessionManager.inMemory());
		const session = await service.open(file);

		const entries = await session.getEntries();
		// label (l1) and custom (c1) have no contract types and are omitted.
		expect(entries.map((entry) => entry.id)).toEqual(["m1", "t1", "mc1", "m2", "s1"]);

		const thinking = entries.find((entry) => entry.type === SessionEntryType.ThinkingLevelChange);
		expect((thinking!.data as { thinkingLevel: string }).thinkingLevel).toBe("high");
		const model = entries.find((entry) => entry.type === SessionEntryType.ModelChange);
		expect((model!.data as { provider: string; modelId: string }).modelId).toBe("claude-opus-4");
		const info = entries.find((entry) => entry.type === SessionEntryType.SessionInfo);
		expect((info!.data as { name: string }).name).toBe("My Session");
	});

	it("filters entries by types, since/until, and limit", async () => {
		const dir = makeTempDir();
		const file = join(dir, "session.jsonl");
		writeSessionFile(file, dir, SESSION_LINES);
		const service = new SessionManagerService(SessionManager.inMemory());
		const session = await service.open(file);

		const messages = await session.getEntries({ types: [SessionEntryType.Message] });
		expect(messages.map((entry) => entry.id)).toEqual(["m1", "m2"]);

		const t1 = Date.parse("2026-01-01T00:00:02.000Z");
		const until = await session.getEntries({ until: t1 });
		expect(until.map((entry) => entry.id)).toEqual(["m1", "t1"]);

		const since = await session.getEntries({ since: Date.parse("2026-01-01T00:00:03.000Z") });
		expect(since.map((entry) => entry.id)).toEqual(["m2", "s1"]);

		const limited = await session.getEntries({ limit: 2 });
		expect(limited.map((entry) => entry.id)).toEqual(["m1", "t1"]);
	});

	it("walks a branch from an entry id", async () => {
		const dir = makeTempDir();
		const file = join(dir, "session.jsonl");
		writeSessionFile(file, dir, SESSION_LINES);
		const service = new SessionManagerService(SessionManager.inMemory());
		const session = await service.open(file);

		const branch = await session.getEntries({ branch: "t1" });
		expect(branch.map((entry) => entry.id)).toEqual(["m1", "t1"]);
	});

	it("getHeader reports model and thinking level from the session context", async () => {
		const dir = makeTempDir();
		const file = join(dir, "session.jsonl");
		writeSessionFile(file, dir, SESSION_LINES);
		const service = new SessionManagerService(SessionManager.inMemory());
		const session = await service.open(file);

		const header = session.getHeader();
		expect(header.model).toBe("anthropic/claude-opus-4");
		expect(header.thinkingLevel).toBe("high");
	});
});

describe("SessionManagerService: walking-skeleton scope (not implemented)", () => {
	it("throws NOT_IMPLEMENTED for append / updateInfo / fork / delete / export / import", async () => {
		const service = new SessionManagerService(SessionManager.inMemory());
		const session: Session = service.getBootSession();
		const expectNotImplemented = (fn: () => unknown) => {
			try {
				fn();
				throw new Error("expected NOT_IMPLEMENTED throw");
			} catch (error) {
				expect(error).toBeInstanceOf(PlatformError);
				expect((error as PlatformError).code).toBe("NOT_IMPLEMENTED");
			}
		};

		const entry: SessionEntry = {
			id: "x",
			type: SessionEntryType.Message,
			timestamp: 1,
			data: { role: "user", content: "hi" },
		};
		expectNotImplemented(() => session.append(entry));
		expectNotImplemented(() => session.updateInfo({ name: "renamed" }));
		expectNotImplemented(() => service.fork(session, "m1", {}));
		expectNotImplemented(() => service.delete(sessionId("x")));
		expectNotImplemented(() => service.export(sessionId("x"), "jsonl"));
		expectNotImplemented(() => service.import({}, "jsonl", { workspaceId: workspaceId("ws"), cwd: "/" }));
	});
});

describe("kernel injection via KernelServiceProvider session option", () => {
	it("injects the supplied SessionService into capability contexts (stub not used)", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "injected", timestamp: 1 });
		const service = new SessionManagerService(manager);
		kernel = createRuntime({
			builtins: [readCapability],
			services: { workspaceRoot: process.cwd(), session: service },
		});
		await kernel.initialize();
		await kernel.start();

		const context = kernel.capabilities.getContext(READ_ID);
		expect(context?.session).toBe(service);
		const boot = (context?.session as SessionManagerService).getBootSession();
		expect(boot.id).toBe(sessionId(manager.getSessionId()));
		expect((await boot.getEntries())[0]?.data).toEqual({ role: "user", content: "injected", timestamp: 1 });

		// The not-implemented stub is no longer installed for session.
		expect(kernel.services.session).toBe(service);
	});
});
