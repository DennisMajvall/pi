/**
 * Tests for the walking-skeleton FileSystemService (NodeFileSystemService):
 * the Step 1.8 glob/list operations (minimatch walk semantics, ignore,
 * dotfile rule, absolute patterns) and the read-side surface they join
 * (resolve/stat/read/exists), plus the not-implemented write surface.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlatformError } from "../src/error/index.ts";
import { NodeFileSystemService } from "../src/kernel/fs-service.ts";
import type { FileStat } from "../src/service/index.ts";

const tempDirs: string[] = [];

function makeWorkspace(): { root: string; service: NodeFileSystemService } {
	const root = mkdtempSync(join(tmpdir(), "pi-platform-fs-"));
	tempDirs.push(root);
	mkdirSync(join(root, "src", "deep"), { recursive: true });
	mkdirSync(join(root, "sub"));
	mkdirSync(join(root, "node_modules"));
	mkdirSync(join(root, ".git"));
	writeFileSync(join(root, "a.ts"), "");
	writeFileSync(join(root, "b.ts"), "");
	writeFileSync(join(root, "README.md"), "");
	writeFileSync(join(root, ".hidden.ts"), "");
	writeFileSync(join(root, "src", "c.ts"), "");
	writeFileSync(join(root, "src", "x.spec.ts"), "");
	writeFileSync(join(root, "src", "deep", "d.ts"), "");
	writeFileSync(join(root, "sub", "e.json"), "");
	writeFileSync(join(root, "node_modules", "f.ts"), "");
	writeFileSync(join(root, ".git", "g.ts"), "");
	return { root, service: new NodeFileSystemService(root) };
}

function names(stats: FileStat[]): string[] {
	return stats.map((s) => s.name);
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});

describe("NodeFileSystemService glob", () => {
	it("matches basename patterns at the walk-root level only (no **)", async () => {
		const { service } = makeWorkspace();
		expect(await service.glob("*.ts")).toEqual(["a.ts", "b.ts"]);
	});

	it("matches recursive patterns with ** (dotfile rule applies)", async () => {
		const { root, service } = makeWorkspace();
		const results = await service.glob("**/*.ts");
		// .git/g.ts and .hidden.ts are excluded by the dotfile rule; the
		// node_modules entry is present because no ignore list was given.
		expect(results).toEqual(["a.ts", "b.ts", "node_modules/f.ts", "src/c.ts", "src/deep/d.ts", "src/x.spec.ts"]);
		expect(results).not.toContain(".git/g.ts");
		expect(results).not.toContain(".hidden.ts");
		// Every returned path exists on disk.
		for (const result of results) {
			expect(await service.exists(join(root, result))).toBe(true);
		}
	});

	it("applies ignore patterns to entries and prunes ignored directories", async () => {
		const { service } = makeWorkspace();
		const results = await service.glob("**/*.ts", { ignore: ["**/node_modules/**"] });
		expect(results).toEqual(["a.ts", "b.ts", "src/c.ts", "src/deep/d.ts", "src/x.spec.ts"]);
	});

	it("supports path-containing patterns with **", async () => {
		const { service } = makeWorkspace();
		expect(await service.glob("src/**/*.spec.ts")).toEqual(["src/x.spec.ts"]);
		expect(await service.glob("src/*.ts")).toEqual(["src/c.ts", "src/x.spec.ts"]);
	});

	it("supports brace alternation", async () => {
		const { service } = makeWorkspace();
		expect(await service.glob("*.{ts,md}")).toEqual(["a.ts", "b.ts", "README.md"]);
	});

	it("returns absolute paths with the absolute option", async () => {
		const { root, service } = makeWorkspace();
		const results = await service.glob("*.ts", { absolute: true });
		expect(results).toEqual([join(root, "a.ts"), join(root, "b.ts")]);
	});

	it("walks absolute patterns from their own literal prefix", async () => {
		const { root, service } = makeWorkspace();
		const results = await service.glob(join(root, "src", "**", "*.ts"), { absolute: true });
		expect(results).toEqual([
			join(root, "src", "c.ts"),
			join(root, "src", "deep", "d.ts"),
			join(root, "src", "x.spec.ts"),
		]);
	});

	it("excludes directories with nodir and includes them by default", async () => {
		const { service } = makeWorkspace();
		const withDirs = await service.glob("**");
		expect(withDirs).toContain("src");
		expect(withDirs).toContain("src/c.ts");
		const filesOnly = await service.glob("**", { nodir: true });
		expect(filesOnly).not.toContain("src");
		expect(filesOnly).toContain("src/c.ts");
	});

	it("matches literal (magic-free) patterns as exact entries", async () => {
		const { service } = makeWorkspace();
		expect(await service.glob(".hidden.ts")).toEqual([".hidden.ts"]);
		expect(await service.glob("README.md")).toEqual(["README.md"]);
		expect(await service.glob("nope.ts")).toEqual([]);
	});

	it("matches hidden entries via explicit dot segments", async () => {
		const { service } = makeWorkspace();
		expect(await service.glob(".git/**")).toEqual([".git/g.ts"]);
		expect(await service.glob("**/.*", { nodir: true })).toEqual([".hidden.ts"]);
	});

	it("returns no results for a missing walk root", async () => {
		const { service } = makeWorkspace();
		expect(await service.glob("missing/**")).toEqual([]);
		expect(await service.glob("missing/*.ts")).toEqual([]);
	});
});

describe("NodeFileSystemService list", () => {
	it("lists direct entries sorted, excluding hidden by default", async () => {
		const { service } = makeWorkspace();
		const entries = await service.list(".");
		expect(names(entries)).toEqual(["a.ts", "b.ts", "node_modules", "README.md", "src", "sub"]);
		for (const entry of entries) {
			expect(entry.path.startsWith(service.getWorkspaceRoot())).toBe(true);
		}
	});

	it("includes hidden entries with includeHidden", async () => {
		const { service } = makeWorkspace();
		const entries = await service.list(".", { includeHidden: true });
		expect(names(entries)).toEqual([".git", ".hidden.ts", "a.ts", "b.ts", "node_modules", "README.md", "src", "sub"]);
	});

	it("recurses into subdirectories with recursive", async () => {
		const { service } = makeWorkspace();
		const entries = await service.list("src", { recursive: true });
		expect(names(entries)).toEqual(["c.ts", "deep", "d.ts", "x.spec.ts"]);
	});

	it("applies the filter option per entry", async () => {
		const { service } = makeWorkspace();
		const files = await service.list(".", { filter: (stat) => stat.isFile });
		expect(names(files)).toEqual(["a.ts", "b.ts", "README.md"]);
	});

	it("reports isFile/isDirectory/size/name per entry", async () => {
		const { service } = makeWorkspace();
		const entries = await service.list(".");
		const src = entries.find((e) => e.name === "src");
		const aTs = entries.find((e) => e.name === "a.ts");
		expect(src?.isDirectory).toBe(true);
		expect(src?.isFile).toBe(false);
		expect(aTs?.isFile).toBe(true);
		expect(aTs?.size).toBe(0);
	});

	it("rejects for a missing directory and for a file path", async () => {
		const { service } = makeWorkspace();
		await expect(service.list("missing")).rejects.toThrow();
		await expect(service.list("a.ts")).rejects.toThrow();
	});
});

describe("NodeFileSystemService write surface", () => {
	it("throws NOT_IMPLEMENTED for write/append/delete/mkdir/copy/move/watch", async () => {
		const { service } = makeWorkspace();
		for (const call of [
			service.write("x", "y"),
			service.append("x", "y"),
			service.delete("x"),
			service.mkdir("x"),
			service.copy("a", "b"),
			service.move("a", "b"),
		]) {
			await expect(call).rejects.toThrow(PlatformError);
			await expect(call).rejects.toThrow(/not implemented/i);
		}
		expect(() => service.watch("x", { onChange: () => {} })).toThrow(/not implemented/i);
	});
});
