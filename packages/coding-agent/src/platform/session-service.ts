/**
 * Platform SessionService implementation: an adapter over the coding-agent
 * SessionManager (Step 1.7 extraction).
 *
 * The kernel stays generic; the host supplies the real session service
 * through KernelServiceProviderOptions at bootPlatformRuntime, following the
 * SettingsManagerService precedent. The service binds to the boot-time
 * manager (the documented session-scoping decision: the kernel is a process
 * singleton, so `getBootSession()` — and any future per-session write — refers
 * to the session that booted the runtime; `ToolExecutionContext.sessionId`
 * remains the per-execution identity).
 *
 * Walking-skeleton scope: the read surface of the contract is implemented
 * (create / open / list plus the handle's getters, getEntries, getHeader and
 * a no-op close). The write surface throws NOT_IMPLEMENTED: the contract's
 * generic entry model (caller-supplied id/timestamp/parentId, labels, data
 * blobs) does not fit SessionManager's typed appenders with internal identity
 * generation and leaf-pointer management — a generic appender would have to
 * replicate the manager's identity machinery (the settings set() precedent).
 * fork/delete/export/import have no SessionManager equivalent or need
 * per-session runtime machinery and are deferred as well.
 */

import { PlatformError } from "@earendil-works/pi-platform/error";
import { type SessionId, sessionId, type WorkspaceId, workspaceId } from "@earendil-works/pi-platform/identifier";
import {
	type CreateSessionOptions,
	type ExportFormat,
	type ExportResult,
	type ForkOptions,
	type GetEntriesOptions,
	type ImportOptions,
	type SessionEntry as PlatformSessionEntry,
	type SessionHeader as PlatformSessionHeader,
	type Session,
	SessionEntryType,
	type SessionInfo,
	type SessionService,
	type SessionSummary,
} from "@earendil-works/pi-platform/service";
import {
	type SessionEntry as ManagerSessionEntry,
	type SessionInfo as ManagerSessionInfo,
	SessionManager,
} from "../core/session-manager.ts";

function notImplemented(method: string): never {
	throw new PlatformError(`SessionService.${method} is not implemented in the walking skeleton`, {
		code: "NOT_IMPLEMENTED",
		metadata: { method },
	});
}

/** Manager timestamps are ISO strings; the contract uses Unix ms. */
function timestampMs(timestamp: string): number {
	return Date.parse(timestamp);
}

/**
 * Translate a manager entry into the contract's generic entry shape.
 * `data` carries the manager's entry-specific payload (the host data model,
 * e.g. message entries carry the AgentMessage). Manager `custom` and `label`
 * entries have no contract type and are omitted.
 */
function toContractEntry(entry: ManagerSessionEntry): PlatformSessionEntry | undefined {
	switch (entry.type) {
		case "message":
			return {
				id: entry.id,
				type: SessionEntryType.Message,
				timestamp: timestampMs(entry.timestamp),
				data: entry.message,
				parentId: entry.parentId ?? undefined,
			};
		case "thinking_level_change":
			return {
				id: entry.id,
				type: SessionEntryType.ThinkingLevelChange,
				timestamp: timestampMs(entry.timestamp),
				data: { thinkingLevel: entry.thinkingLevel },
				parentId: entry.parentId ?? undefined,
			};
		case "model_change":
			return {
				id: entry.id,
				type: SessionEntryType.ModelChange,
				timestamp: timestampMs(entry.timestamp),
				data: { provider: entry.provider, modelId: entry.modelId },
				parentId: entry.parentId ?? undefined,
			};
		case "compaction":
			return {
				id: entry.id,
				type: SessionEntryType.Compaction,
				timestamp: timestampMs(entry.timestamp),
				data: {
					summary: entry.summary,
					firstKeptEntryId: entry.firstKeptEntryId,
					tokensBefore: entry.tokensBefore,
					details: entry.details,
					usage: entry.usage,
					fromHook: entry.fromHook,
				},
				parentId: entry.parentId ?? undefined,
			};
		case "branch_summary":
			return {
				id: entry.id,
				type: SessionEntryType.BranchSummary,
				timestamp: timestampMs(entry.timestamp),
				data: {
					fromId: entry.fromId,
					summary: entry.summary,
					details: entry.details,
					usage: entry.usage,
					fromHook: entry.fromHook,
				},
				parentId: entry.parentId ?? undefined,
			};
		case "custom":
			// Manager extension-state entries have no contract type.
			return undefined;
		case "custom_message":
			return {
				id: entry.id,
				type: SessionEntryType.CustomMessage,
				timestamp: timestampMs(entry.timestamp),
				data: {
					customType: entry.customType,
					content: entry.content,
					details: entry.details,
					display: entry.display,
				},
				parentId: entry.parentId ?? undefined,
			};
		case "label":
			// Label entries have no contract type.
			return undefined;
		case "session_info":
			return {
				id: entry.id,
				type: SessionEntryType.SessionInfo,
				timestamp: timestampMs(entry.timestamp),
				data: { name: entry.name },
				parentId: entry.parentId ?? undefined,
			};
	}
}

/** Translate a SessionInfo (list result) into the contract's summary shape. */
function toSessionSummary(info: ManagerSessionInfo, workspace: WorkspaceId): SessionSummary {
	return {
		id: sessionId(info.id),
		path: info.path,
		workspaceId: workspace,
		cwd: info.cwd,
		createdAt: info.created.getTime(),
		updatedAt: info.modified.getTime(),
		// Not derivable from SessionInfo without opening each session file
		// (model/thinkingLevel need a context scan; entryCount counts entries,
		// SessionInfo counts messages only; labels have no SessionInfo
		// equivalent). Documented skeleton gaps.
		model: undefined,
		thinkingLevel: undefined,
		entryCount: 0,
		labels: undefined,
	};
}

/**
 * Contract Session handle over a SessionManager. The reads are live views of
 * the manager (getters), so id/cwd/updatedAt stay current as the manager's
 * own write path appends entries.
 */
export class SessionManagerSession implements Session {
	readonly workspaceId: WorkspaceId;

	private readonly manager: SessionManager;

	constructor(manager: SessionManager, workspace: WorkspaceId) {
		this.manager = manager;
		this.workspaceId = workspace;
	}

	get id(): SessionId {
		return sessionId(this.manager.getSessionId());
	}

	get cwd(): string {
		return this.manager.getCwd();
	}

	get createdAt(): number {
		const header = this.manager.getHeader();
		return header ? timestampMs(header.timestamp) : 0;
	}

	get updatedAt(): number {
		const entries = this.manager.getEntries();
		const last = entries[entries.length - 1];
		return last ? timestampMs(last.timestamp) : this.createdAt;
	}

	async getEntries(options: GetEntriesOptions = {}): Promise<PlatformSessionEntry[]> {
		const { branch, types, since, until, limit } = options;
		const source = branch !== undefined ? this.manager.getBranch(branch) : this.manager.getEntries();
		let entries = source.map(toContractEntry).filter((entry): entry is PlatformSessionEntry => entry !== undefined);

		if (types !== undefined) {
			const allowed = new Set(types);
			entries = entries.filter((entry) => allowed.has(entry.type));
		}
		if (since !== undefined) {
			entries = entries.filter((entry) => entry.timestamp >= since);
		}
		if (until !== undefined) {
			entries = entries.filter((entry) => entry.timestamp <= until);
		}
		if (limit !== undefined) {
			entries = entries.slice(0, limit);
		}
		return entries;
	}

	getHeader(): PlatformSessionHeader {
		const header = this.manager.getHeader();
		if (!header) {
			throw new PlatformError("Session has no header", { code: "SESSION_ERROR" });
		}
		// model/thinkingLevel are entries in the manager, resolved via the
		// session context; the contract header carries them directly.
		const context = this.manager.buildSessionContext();
		return {
			version: header.version ?? 1,
			id: sessionId(header.id),
			cwd: header.cwd,
			createdAt: timestampMs(header.timestamp),
			model: context.model ? `${context.model.provider}/${context.model.modelId}` : undefined,
			thinkingLevel: context.thinkingLevel,
		};
	}

	append(_entry: PlatformSessionEntry): Promise<void> {
		notImplemented("append");
	}

	updateInfo(_info: Partial<SessionInfo>): Promise<void> {
		notImplemented("updateInfo");
	}

	async close(): Promise<void> {
		// SessionManager keeps no open file handles; persistence is synchronous
		// at append time, so there is nothing to release.
	}
}

export class SessionManagerService implements SessionService {
	private readonly manager: SessionManager;

	constructor(manager: SessionManager) {
		this.manager = manager;
	}

	/**
	 * Host-side accessor (not part of the SessionService contract): the
	 * handle bound to the boot-time manager — the walking skeleton's answer to
	 * "which session is the singleton service bound to". For the common
	 * single-session process this is the executing session.
	 */
	getBootSession(): Session {
		return new SessionManagerSession(this.manager, workspaceId(this.manager.getCwd()));
	}

	async create(options: CreateSessionOptions): Promise<Session> {
		const manager = SessionManager.create(options.cwd, undefined, {
			parentSession: options.parentSessionId,
		});
		// initialModel/initialThinkingLevel/metadata are accepted but not
		// recorded: recording them is a write, and the write side is deferred.
		return new SessionManagerSession(manager, options.workspaceId);
	}

	async open(path: string): Promise<Session> {
		const manager = SessionManager.open(path);
		// Pre-Workspaces a workspace is its project directory, so an opened
		// session's workspace is its cwd.
		return new SessionManagerSession(manager, workspaceId(manager.getCwd()));
	}

	async list(workspace: WorkspaceId): Promise<SessionSummary[]> {
		// Pre-Workspaces, a WorkspaceId is the project directory path; the
		// default session dir is derived from it (sessions are stored per-cwd).
		const infos = await SessionManager.list(workspace);
		return infos.map((info) => toSessionSummary(info, workspace));
	}

	fork(_source: Session, _entryId: string, _options: ForkOptions): Promise<Session> {
		notImplemented("fork");
	}

	delete(_sessionId: SessionId): Promise<void> {
		notImplemented("delete");
	}

	export(_sessionId: SessionId, _format: ExportFormat): Promise<ExportResult> {
		notImplemented("export");
	}

	import(_data: unknown, _format: ExportFormat, _options: ImportOptions): Promise<Session> {
		notImplemented("import");
	}
}
