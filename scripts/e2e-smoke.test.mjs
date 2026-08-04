/**
 * E2E smoke test: run the real pi CLI end-to-end with a free OpenRouter model
 * and a basic tool-using task.
 *
 * Verifies the fundamental path a real user hits: CLI boot -> session
 * creation (which boots the platform runtime, the default execution path for
 * the builtin tools) -> a model completing a task that requires writing and
 * reading a file through the tools.
 *
 * Skipped when OPENROUTER_API_KEY is not set (CI, offline). The model is the
 * free OpenRouter nvidia/nemotron model by default; override with
 * PI_E2E_SMOKE_MODEL to use a different one.
 *
 * Run with: npm run test:e2e-smoke
 * (Also picked up by `npm run test:scripts` via the scripts/*.test.mjs glob.)
 *
 * The run is fully isolated: a scratch HOME/XDG/TMPDIR under the OS temp dir
 * keeps it away from the user's real configuration, and the scratch dir is
 * removed afterwards.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(
  REPO_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);
const CLI = join(REPO_ROOT, "packages", "coding-agent", "src", "cli.ts");

const MODEL =
  process.env.PI_E2E_SMOKE_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b:free";

const PROMPT =
  "Create a file named output.txt in the current directory containing exactly the text 'hello from smoke'. Then read it back and reply with only the file's contents.";

/** Run the CLI, collecting stdout/stderr, with a hard timeout. */
function runCli(args, { cwd, env, timeoutMs }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(TSX, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

test(
  "pi completes a file task with the free OpenRouter model (platform boot + tools)",
  {
    skip: process.env.OPENROUTER_API_KEY
      ? false
      : "OPENROUTER_API_KEY not set; skipping e2e smoke",
    retry: 1,
  },
  async () => {
    const base = mkdtempSync(join(tmpdir(), "pi-e2e-smoke-"));
    const work = join(base, "work");
    const home = join(base, "home");
    const config = join(base, "config");
    const cache = join(base, "cache");
    const tmp = join(base, "tmp");
    for (const dir of [work, home, config, cache, tmp]) {
      mkdirSync(dir, { recursive: true });
    }

    try {
      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: config,
        XDG_CACHE_HOME: cache,
        TMPDIR: tmp,
        TMP: tmp,
        TEMP: tmp,
        PI_PROVIDER: "openrouter",
      };

      const { code, stdout, stderr } = await runCli(
        [
          "--tsconfig",
          join(REPO_ROOT, "tsconfig.json"),
          CLI,
          "-p",
          "--model",
          MODEL,
          PROMPT,
        ],
        { cwd: work, env, timeoutMs: 180_000 },
      );

      const details = `exit=${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
      assert.equal(code, 0, `pi exited non-zero (${details})`);
      // The platform is the default execution path for the builtin tools;
      // a kernel boot failure prints this warning and falls back to legacy.
      assert.ok(
        !stderr.includes("[platform] runtime failed to start"),
        `platform runtime failed to boot; fell back to legacy paths (${details})`,
      );
      const file = join(work, "output.txt");
      assert.ok(existsSync(file), `output.txt was not created (${details})`);
      assert.equal(
        readFileSync(file, "utf8").trim(),
        "hello from smoke",
        `output.txt has unexpected contents (${details})`,
      );
      assert.match(
        stdout,
        /hello from smoke/,
        `model output missing the file contents (${details})`,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);
