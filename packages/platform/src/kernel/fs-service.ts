/**
 * Walking-skeleton FileSystemService.
 *
 * A thin wrapper over node:fs for the methods the pilot capabilities need:
 * read / readBytes / exists / stat / resolve / getWorkspaceRoot, the (Step
 * 1.8) read-side directory operations list / glob that the find and ls
 * tools consume, and the (Step 1.9) write surface write / append / delete /
 * mkdir / copy / move that the write and edit tools consume. Only watch
 * still throws "not implemented" — the event system is a later roadmap
 * feature, not an fs-service concern.
 *
 * This service delegates to node:fs directly — the same filesystem the read
 * tool already used — so behaviour is unchanged while the injection point is
 * real.
 *
 * glob is a deterministic minimatch walk: the pattern is evaluated with
 * standard glob semantics (dotfile rule, `**` crossing segment boundaries),
 * workspace-relative by default and cwd-agnostic for absolute patterns (see
 * docs/RUNTIME_KERNEL_DESIGN.md). The walk root is the pattern's literal
 * (magic-free) prefix, so the search never traverses parts of the tree the
 * pattern cannot reach.
 */

import type { Dirent, Stats } from "node:fs";
import {
	access as fsAccess,
	appendFile as fsAppendFile,
	cp as fsCp,
	mkdir as fsMkdir,
	readdir as fsReaddir,
	readFile as fsReadFile,
	rename as fsRename,
	rm as fsRm,
	stat as fsStat,
	writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative as relativePath, resolve as resolvePath, sep } from "node:path";
import { minimatch } from "minimatch";
import { PlatformError } from "../error/index.ts";
import type {
	CopyOptions,
	DeleteOptions,
	FileStat,
	FileSystemService,
	GlobOptions,
	ListOptions,
	MkdirOptions,
	WatchHandle,
	WatchListener,
	WriteOptions,
} from "../service/index.ts";

function notImplemented(method: string): never {
	throw new PlatformError(`FileSystemService.${method} is not implemented in the walking skeleton`, {
		code: "NOT_IMPLEMENTED",
	});
}

/** The first glob-magic character index (skipping backslash escapes). */
function firstMagicIndex(pattern: string): number {
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "*" || ch === "?" || ch === "[" || ch === "{") {
			return i;
		}
	}
	return -1;
}

/** The literal (magic-free) prefix of a glob pattern, without trailing separators. */
function literalPrefix(pattern: string): string {
	const index = firstMagicIndex(pattern);
	const prefix = index === -1 ? pattern : pattern.slice(0, index);
	return prefix.replace(/[\\/]+$/, "");
}

function toPosix(value: string): string {
	return value.split(sep).join("/");
}

export class NodeFileSystemService implements FileSystemService {
	private readonly workspaceRoot: string;

	constructor(workspaceRoot: string) {
		this.workspaceRoot = workspaceRoot;
	}
	getWorkspaceRoot(): string {
		return this.workspaceRoot;
	}

	resolve(path: string): string {
		return isAbsolute(path) ? path : resolvePath(this.workspaceRoot, path);
	}

	async read(
		path: string,
		options?: { encoding?: "utf8" | "binary"; offset?: number; limit?: number },
	): Promise<string> {
		const buffer = await fsReadFile(this.resolve(path));
		let text = buffer.toString("utf-8");
		if (options?.offset !== undefined || options?.limit !== undefined) {
			const lines = text.split("\n");
			const start = options.offset ? Math.max(0, options.offset - 1) : 0;
			const end = options.limit !== undefined ? Math.min(start + options.limit, lines.length) : lines.length;
			text = lines.slice(start, end).join("\n");
		}
		return text;
	}

	async readBytes(path: string): Promise<Uint8Array> {
		return fsReadFile(this.resolve(path));
	}

	async exists(path: string): Promise<boolean> {
		try {
			await fsAccess(this.resolve(path));
			return true;
		} catch {
			return false;
		}
	}

	async stat(path: string): Promise<FileStat> {
		const stats = await fsStat(this.resolve(path));
		return this.toFileStat(this.resolve(path), stats);
	}

	async list(path: string, options: ListOptions = {}): Promise<FileStat[]> {
		const resolved = this.resolve(path);
		const results: FileStat[] = [];
		const walk = async (dir: string): Promise<void> => {
			const entries = await fsReaddir(dir, { withFileTypes: true });
			entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
			for (const entry of entries) {
				if (!options.includeHidden && entry.name.startsWith(".")) {
					continue;
				}
				const fullPath = join(dir, entry.name);
				const stats = await fsStat(fullPath);
				const stat = this.toFileStat(fullPath, stats);
				if (options.filter && !options.filter(stat)) {
					continue;
				}
				results.push(stat);
				if (options.recursive && stats.isDirectory()) {
					await walk(fullPath);
				}
			}
		};
		await walk(resolved);
		results.sort((a, b) => a.path.localeCompare(b.path));
		return results;
	}

	async glob(pattern: string, options: GlobOptions = {}): Promise<string[]> {
		const posixPattern = toPosix(pattern);
		const absolutePattern = isAbsolute(posixPattern);
		const prefix = literalPrefix(posixPattern);
		const walkRoot = absolutePattern ? prefix || "/" : join(this.workspaceRoot, prefix);
		const ignore = options.ignore ?? [];

		// A literal (magic-free) pattern names one entry: the walk root itself.
		if (firstMagicIndex(posixPattern) === -1) {
			const candidate = absolutePattern ? toPosix(walkRoot) : toPosix(relativePath(this.workspaceRoot, walkRoot));
			try {
				const stats = await fsStat(walkRoot);
				if (options.nodir && stats.isDirectory()) {
					return [];
				}
				const excludes = (entry: string): boolean =>
					ignore.some((item) => minimatch(entry, item) || minimatch(entry, item.replace(/\/\*\*$/, "")));
				if (excludes(candidate)) {
					return [];
				}
				return options.absolute || absolutePattern ? [toPosix(walkRoot)] : [candidate];
			} catch {
				return [];
			}
		}

		// A directory whose path matches an ignore pattern must not be
		// descended into; `**/node_modules/**` only matches contents, so the
		// trailing `/**` is stripped to also catch the directory itself.
		const ignoreDirPatterns = ignore.map((entry) => entry.replace(/\/\*\*$/, ""));

		const matchesIgnore = (candidate: string): boolean =>
			ignore.some((entry) => minimatch(candidate, entry) || minimatch(candidate, entry.replace(/\/\*\*$/, "")));

		// Directories the walk should not descend into: ignored dirs, and
		// hidden dirs the pattern cannot reach (a `**` segment or an explicit
		// dot-leading segment is required to match inside a dot-directory).
		const skipDescend = (relativePosix: string): boolean => {
			const relNoSlash = relativePosix.replace(/\/+$/, "");
			if (ignoreDirPatterns.some((entry) => minimatch(relNoSlash, entry))) {
				return true;
			}
			if (relNoSlash.startsWith(".")) {
				return !(posixPattern.includes("**") || hasDotSegment(posixPattern));
			}
			return false;
		};

		const results: string[] = [];
		const walk = async (dir: string): Promise<void> => {
			let entries: Dirent[];
			try {
				entries = await fsReaddir(dir, { withFileTypes: true });
			} catch {
				return; // unreadable directory (e.g. permissions): not a match surface
			}
			entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
			for (const entry of entries) {
				const fullPath = join(dir, entry.name);
				const candidate = absolutePattern ? toPosix(fullPath) : toPosix(relativePath(this.workspaceRoot, fullPath));
				if (matchesIgnore(candidate)) {
					continue;
				}
				if (entry.isDirectory()) {
					if (skipDescend(candidate)) {
						continue;
					}
					if (!options.nodir && minimatch(candidate, posixPattern)) {
						results.push(candidate);
					}
					if (posixPattern.includes("**")) {
						await walk(fullPath);
					}
					continue;
				}
				if (minimatch(candidate, posixPattern)) {
					results.push(candidate);
				}
			}
		};
		await walk(walkRoot);
		results.sort((a, b) => a.localeCompare(b));
		return options.absolute || absolutePattern ? results.map((entry) => this.resolve(entry)) : results;
	}

	async write(path: string, content: string | Uint8Array, options?: WriteOptions): Promise<void> {
		const resolved = this.resolve(path);
		if (options?.createDirs) {
			await fsMkdir(dirname(resolved), { recursive: true });
		}
		const writeOptions: Record<string, unknown> = {};
		if (typeof content === "string") {
			writeOptions.encoding = options?.encoding ?? "utf8";
		}
		if (options?.mode !== undefined) {
			writeOptions.mode = options.mode;
		}
		await fsWriteFile(resolved, content, writeOptions);
	}

	async append(path: string, content: string): Promise<void> {
		await fsAppendFile(this.resolve(path), content, "utf-8");
	}

	async delete(path: string, options?: DeleteOptions): Promise<void> {
		await fsRm(this.resolve(path), {
			recursive: options?.recursive ?? false,
			force: options?.force ?? false,
		});
	}

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
		await fsMkdir(this.resolve(path), {
			recursive: options?.recursive ?? false,
			mode: options?.mode,
		});
	}

	async copy(source: string, dest: string, options?: CopyOptions): Promise<void> {
		const overwrite = options?.overwrite ?? false;
		await fsCp(this.resolve(source), this.resolve(dest), {
			recursive: true,
			force: overwrite,
			// With force: false node silently ignores an existing dest; errorOnExist
			// turns the no-clobber default into a loud error.
			errorOnExist: !overwrite,
			preserveTimestamps: options?.preserveTimestamps ?? false,
		});
	}

	async move(source: string, dest: string): Promise<void> {
		await fsRename(this.resolve(source), this.resolve(dest));
	}

	watch(_path: string, _listener: WatchListener): WatchHandle {
		notImplemented("watch");
	}

	private toFileStat(path: string, stats: Stats): FileStat {
		return {
			path,
			name: path.split(/[\\/]/).pop() ?? path,
			isFile: stats.isFile(),
			isDirectory: stats.isDirectory(),
			size: stats.size,
			modifiedAt: stats.mtimeMs,
			createdAt: stats.ctimeMs,
		};
	}
}

/**
 * Whether a glob pattern contains a segment that starts with a dot
 * (e.g. `.*`, `.git/**`), i.e. could match hidden entries below the current
 * level when combined with a `**` walk.
 */
function hasDotSegment(pattern: string): boolean {
	return pattern.split("/").some((segment) => segment.startsWith(".") && segment.length > 1);
}
