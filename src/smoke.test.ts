import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, test } from "vitest";
import { TESTED_WITH } from "./explain.js";

const exTest = test.skipIf(!process.env.EXTERNAL);
const execFileAsync = promisify(execFile);
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const H2CV_BIN = join(PKG_ROOT, "dist", "bin", "h2cv.js");
const LAUNCH_TEST_TIMEOUT_MS = 7 * 60 * 1000;
const SMOKE_PROMPT = "ok とだけ返してください。ツールは使わないでください";
type Captured = {
  code: number;
  stdout: string;
  stderr: string;
};
async function capture(
  file: string,
  args: string[],
  opts: {
    cwd?: string;
    timeoutMs?: number;
  } = {},
): Promise<Captured> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      maxBuffer: 32 * 1024 * 1024,
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}
async function h2cv(args: string[]): Promise<
  Captured & {
    json: Record<string, unknown>;
  }
> {
  const r = await capture(process.execPath, [H2CV_BIN, ...args]);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    throw new Error(
      `h2cv ${args.join(" ")}: stdout が JSON として読めない (exit=${r.code})\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
    );
  }
  return { ...r, json };
}
async function closeTabByLabel(label: string): Promise<void> {
  const ids = async () => {
    const r = await capture("herdr", ["tab", "list"]);
    if (r.code !== 0) return [];
    const tabs: {
      tab_id?: string;
      label?: string;
    }[] = JSON.parse(r.stdout)?.result?.tabs ?? [];
    return tabs.flatMap((t) =>
      t.label === label && t.tab_id ? [t.tab_id] : [],
    );
  };
  const hit = await ids();
  if (hit.length !== 1) return;
  await capture("herdr", ["tab", "close", hit[0]]);
  expect(await ids()).toEqual([]);
}
async function liveSessionNames(): Promise<string[]> {
  const r = await capture("claude", ["agents", "--json"]);
  if (r.code !== 0) return [];
  const agents: {
    name?: string;
  }[] = JSON.parse(r.stdout);
  return Array.isArray(agents)
    ? agents.flatMap((a) => (a.name ? [a.name] : []))
    : [];
}
function versionOf(text: string): string {
  return text.match(/\d+\.\d+\.\d+/)?.[0] ?? "";
}
describe("h2cv 実機スモーク (EXTERNAL)", () => {
  beforeAll(async () => {
    if (!process.env.EXTERNAL) return;
    const built = await capture("npm", ["run", "build"], {
      cwd: PKG_ROOT,
      timeoutMs: 300000,
    });
    expect(
      built.code,
      `dist のビルドに失敗した\n${built.stdout}\n${built.stderr}`,
    ).toBe(0);
  }, 300000);
  exTest(
    "実機の claude / herdr / manifest の版が TESTED_WITH と一致する",
    async () => {
      const [claude, herdr] = await Promise.all([
        capture("claude", ["--version"]),
        capture("herdr", ["--version"]),
      ]);
      expect(claude.code, claude.stderr).toBe(0);
      expect(herdr.code, herdr.stderr).toBe(0);
      const dir = await mkdtemp(join(tmpdir(), "h2cv-smoke-manifest-"));
      let manifest: string;
      try {
        const fixture = join(dir, "screen.txt");
        await writeFile(fixture, "hello\n", "utf8");
        const explained = await capture("herdr", [
          "agent",
          "explain",
          "--file",
          fixture,
          "--agent",
          "claude",
          "--json",
        ]);
        expect(explained.code, explained.stderr).toBe(0);
        manifest = String(JSON.parse(explained.stdout).manifest_version ?? "");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      expect({
        claude: versionOf(claude.stdout),
        herdr: versionOf(herdr.stdout),
        manifest,
      }).toEqual({ ...TESTED_WITH });
    },
  );
  exTest(
    "dist の CLI で launch → send + read-back 検証 → 不在確認まで通る",
    async () => {
      const agentName = `h2cv-smoke-${randomUUID().slice(0, 8)}`;
      const cwd = await mkdtemp(join(tmpdir(), "h2cv-smoke-"));
      try {
        const launched = await h2cv([
          "launch",
          "--cwd",
          cwd,
          "--agent-name",
          agentName,
          "--prompt",
          SMOKE_PROMPT,
          "--",
          "-n",
          agentName,
        ]);
        expect(launched.json, launched.stderr).toMatchObject({
          ok: true,
          agentName,
          promptSent: true,
          trace: expect.any(Array),
        });
        expect(launched.code).toBe(0);
        const stages = (
          launched.json as {
            trace: {
              stage: string;
            }[];
          }
        ).trace.map((e) => e.stage);
        expect(stages.slice(0, 5)).toEqual([
          "probe",
          "tab",
          "shell",
          "start",
          "agent",
        ]);
        expect(stages).toContain("enter");
        await closeTabByLabel(agentName);
        expect(await liveSessionNames()).not.toContain(agentName);
      } finally {
        await closeTabByLabel(agentName).catch(() => undefined);
        await rm(cwd, { recursive: true, force: true });
      }
    },
    LAUNCH_TEST_TIMEOUT_MS,
  );
});
