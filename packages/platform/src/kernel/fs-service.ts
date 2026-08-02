/**
 * Walking-skeleton FileSystemService.
 *
 * A thin wrapper over node:fs for the methods the pilot capability needs
 * (read / readBytes / exists / stat / resolve / getWorkspaceRoot). All other
 * methods throw "not implemented".
 *
 * This service delegates to node:fs directly — the same filesystem the read
 * tool already used — so behaviour is unchanged while the injection point is
 * real.
 */

import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { PlatformError } from "../error/index.ts";
import type { FileStat, FileSystemService } from "../service/index.ts";

function notImplemented(method: string): never {
	throw new PlatformError(`FileSystemService.${method} is not implemented in the walking skeleton`, {
		code: "NOT_IMPLEMENTED",
	});
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
		return {
			path: this.resolve(path),
			name: path.split(/[\\/]/).pop() ?? path,
			isFile: stats.isFile(),
			isDirectory: stats.isDirectory(),
			size: stats.size,
			modifiedAt: stats.mtimeMs,
			createdAt: stats.ctimeMs,
		};
	}

	async write(): Promise<void> {
		notImplemented("write");
	}

	async append(): Promise<void> {
		notImplemented("append");
	}

	async delete(): Promise<void> {
		notImplemented("delete");
	}

	async list(): Promise<FileStat[]> {
		notImplemented("list");
	}

	async glob(): Promise<string[]> {
		notImplemented("glob");
	}

	async mkdir(): Promise<void> {
		notImplemented("mkdir");
	}

	async copy(): Promise<void> {
		notImplemented("copy");
	}

	async move(): Promise<void> {
		notImplemented("move");
	}

	watch(): never {
		notImplemented("watch");
	}
}
