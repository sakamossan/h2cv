import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, test } from "vitest";
import { TESTED_WITH } from "./explain.js";
import { BACKGROUND_WORK_RULE_IDS } from "./sender.js";

const exTest = test.skipIf(!process.env.EXTERNAL);
const execFileAsync = promisify(execFile);
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const H2CV_BIN = join(PKG_ROOT, "dist", "bin", "h2cv.js");
const LAUNCH_TEST_TIMEOUT_MS = 7 * 60 * 1000;
const SMOKE_PROMPT = "ok とだけ返してください。ツールは使わないでください";
const LONG_SMOKE_PROMPT = `${"filler ".repeat(180)}ここまでの filler は無視して、ok とだけ返してください。ツールは使わないでください`;
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
const CLAUDE_CONFIG = join(homedir(), ".claude.json");
async function trustedProjects(): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(CLAUDE_CONFIG, "utf8"));
    const projects = (
      parsed as {
        projects?: unknown;
      }
    )?.projects;
    return projects && typeof projects === "object"
      ? (projects as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
async function expectUntrusted(cwd: string): Promise<void> {
  const projects = await trustedProjects();
  const trusted: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    const entry = projects[dir] as
      | {
          hasTrustDialogAccepted?: unknown;
        }
      | undefined;
    if (entry?.hasTrustDialogAccepted === true) trusted.push(dir);
    if (dir === parse(dir).root) break;
  }
  expect(
    trusted,
    `${cwd} の祖先が trust 済みなので trust ダイアログを踏めない。この検証はホストの状態に依存するので skip せず落とす`,
  ).toEqual([]);
}
async function forgetProject(cwd: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(CLAUDE_CONFIG, "utf8");
  } catch {
    return;
  }
  const parsed = JSON.parse(raw) as {
    projects?: Record<string, unknown>;
  };
  if (!parsed.projects || !(cwd in parsed.projects)) return;
  delete parsed.projects[cwd];
  await writeFile(
    CLAUDE_CONFIG,
    `${JSON.stringify(parsed, null, 2)}\n`,
    "utf8",
  );
}
async function trustProject(cwd: string): Promise<void> {
  const parsed = JSON.parse(await readFile(CLAUDE_CONFIG, "utf8")) as {
    projects?: Record<string, unknown>;
  };
  parsed.projects ??= {};
  const entry = parsed.projects[cwd];
  parsed.projects[cwd] = {
    ...(entry && typeof entry === "object" ? entry : {}),
    hasTrustDialogAccepted: true,
  };
  await writeFile(
    CLAUDE_CONFIG,
    `${JSON.stringify(parsed, null, 2)}\n`,
    "utf8",
  );
  const projects = await trustedProjects();
  expect(
    (
      projects[cwd] as
        | {
            hasTrustDialogAccepted?: unknown;
          }
        | undefined
    )?.hasTrustDialogAccepted,
    `${cwd} の trust 登録を読み戻せない`,
  ).toBe(true);
}
async function makeTrustedCwd(prefix: string): Promise<string> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await trustProject(cwd);
  return cwd;
}
async function makeUntrustedCwd(): Promise<string> {
  const cwd = await realpath(
    await mkdtemp(join(homedir(), "h2cv-smoke-untrusted-")),
  );
  const inited = await capture("git", ["init", "--quiet", cwd]);
  expect(inited.code, inited.stderr).toBe(0);
  await expectUntrusted(cwd);
  return cwd;
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
      let ruleIds: string[];
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
        const parsed = JSON.parse(explained.stdout);
        manifest = String(parsed.manifest_version ?? "");
        ruleIds = (parsed.evaluated_rules ?? []).map((r: { id: string }) =>
          String(r.id),
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      expect({
        claude: versionOf(claude.stdout),
        herdr: versionOf(herdr.stdout),
        manifest,
      }).toEqual({ ...TESTED_WITH });
      expect(
        ruleIds.length,
        "evaluated_rules が空 (manifest の読み方が変わった)",
      ).toBeGreaterThan(0);
      expect(
        BACKGROUND_WORK_RULE_IDS.filter((id) => !ruleIds.includes(id)),
        `BACKGROUND_WORK_RULE_IDS に manifest ${manifest} で実在しない id がある。上流がルールを落としたか改名した`,
      ).toEqual([]);
    },
  );
  exTest(
    "未 trust な cwd では Enter を撃たず untrusted-workspace で止まり、claude は生き残る",
    async () => {
      const agentName = `h2cv-untrusted-${randomUUID().slice(0, 8)}`;
      const cwd = await makeUntrustedCwd();
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
          ok: false,
          error: "untrusted-workspace",
          stage: "dialog",
          agentName,
          hint: "h2cv explain input-ready",
        });
        expect(launched.code).toBe(1);
        expect(
          (
            launched.json as {
              trace: {
                stage: string;
                result: string;
              }[];
            }
          ).trace,
        ).toContainEqual(
          expect.objectContaining({ stage: "dialog", result: "fail-closed" }),
        );
        const paneTail = String(launched.json["paneTail"] ?? "");
        const cursor = paneTail
          .split("\n")
          .filter((line) => line.includes("❯"))
          .map((line) => line.trim());
        expect(cursor, paneTail).toEqual(["❯ No, exit"]);
        expect(paneTail).toContain("Yes, I trust this folder");
        const pane = String(launched.json["pane"] ?? "");
        const alive = await capture("herdr", ["agent", "get", pane]);
        expect(alive.code, alive.stdout || alive.stderr).toBe(0);
        expect(JSON.parse(alive.stdout).result.agent).toMatchObject({
          name: agentName,
          agent_status: "blocked",
        });
      } finally {
        await closeTabByLabel(agentName).catch(() => undefined);
        await forgetProject(cwd).catch(() => undefined);
        await rm(cwd, { recursive: true, force: true });
      }
    },
    LAUNCH_TEST_TIMEOUT_MS,
  );
  exTest(
    "dist の CLI で launch → send + read-back 検証 → 不在確認まで通る",
    async () => {
      const agentName = `h2cv-smoke-${randomUUID().slice(0, 8)}`;
      const cwd = await makeTrustedCwd("h2cv-smoke-");
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
        await forgetProject(cwd).catch(() => undefined);
        await rm(cwd, { recursive: true, force: true });
      }
    },
    LAUNCH_TEST_TIMEOUT_MS,
  );
  exTest(
    "1 write で割れる長さの本文も chunk 送出で欠けずに届く",
    async () => {
      const agentName = `h2cv-smoke-long-${randomUUID().slice(0, 8)}`;
      const cwd = await makeTrustedCwd("h2cv-smoke-long-");
      try {
        const launched = await h2cv([
          "launch",
          "--cwd",
          cwd,
          "--agent-name",
          agentName,
          "--prompt",
          LONG_SMOKE_PROMPT,
          "--",
          "-n",
          agentName,
        ]);
        expect(launched.json, launched.stderr).toMatchObject({
          ok: true,
          agentName,
          promptSent: true,
        });
        expect(launched.code).toBe(0);
        const trace = (
          launched.json as {
            trace: {
              stage: string;
              result: string;
            }[];
          }
        ).trace;
        expect(trace.filter((e) => e.result === "partial")).toEqual([]);
        expect(trace).toContainEqual(
          expect.objectContaining({ stage: "type", result: "ok" }),
        );
        await closeTabByLabel(agentName);
        expect(await liveSessionNames()).not.toContain(agentName);
      } finally {
        await closeTabByLabel(agentName).catch(() => undefined);
        await forgetProject(cwd).catch(() => undefined);
        await rm(cwd, { recursive: true, force: true });
      }
    },
    LAUNCH_TEST_TIMEOUT_MS,
  );
});
