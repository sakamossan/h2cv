import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { selfSendWatchLog } from "./self-send.js";

const BOGUS_PANE = "%h2cv-self-send-it-bogus-pane";
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");
const H2CV_ENTRY = join(PKG_ROOT, "bin", "h2cv.ts");
let cwdRoot: string | undefined;
afterEach(() => {
  if (cwdRoot) rmSync(cwdRoot, { recursive: true, force: true });
  cwdRoot = undefined;
});
const PROMPTS = ["/rename [exiting]h2cv-spawn-it", "/exit"];
it("detached watcher が tsx ローダを引き継ぎクラッシュせず終了する (任意の cwd から呼べる)", async () => {
  cwdRoot = mkdtempSync(join(tmpdir(), "h2cv-self-send-it-"));
  const armed = spawnSync(
    process.execPath,
    [TSX_CLI, H2CV_ENTRY, "self-send", ...PROMPTS],
    {
      cwd: cwdRoot,
      env: { ...process.env, HERDR_PANE_ID: BOGUS_PANE },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  expect(armed.status).toBe(0);
  expect(JSON.parse(armed.stdout)).toMatchObject({ ok: true, armed: true });
  const { log, payload } = await vi.waitFor(
    () => {
      const log = readFileSync(selfSendWatchLog(BOGUS_PANE), "utf8");
      const json = log.slice(log.indexOf("{"), log.lastIndexOf("}") + 1);
      try {
        return { log, payload: JSON.parse(json) };
      } catch {
        throw new Error(
          `watcher log がまだ完結した JSON になっていない: ${JSON.stringify(log)}`,
        );
      }
    },
    { timeout: 15000, interval: 100 },
  );
  expect(payload).toMatchObject({
    ok: false,
    error: "not-ready",
    target: BOGUS_PANE,
    prompts: PROMPTS,
    stage: "idle",
    hint: "h2cv explain input-ready",
    timeoutMs: 300000,
    elapsedMs: expect.any(Number),
  });
  expect(payload.elapsedMs).toBeLessThan(10000);
  expect(log).toContain("not-ready");
}, 40000);
