import type { HerdrPort } from "./launcher.js";
import type { SessionTimings } from "./timings.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeLaunchPort, fakeSendPort } from "./__tests__/fakes.js";
import { AgentLauncher } from "./launcher.js";

const { sleeps } = vi.hoisted(() => ({ sleeps: [] as number[] }));
vi.mock("./herdr-adapter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./herdr-adapter.js")>()),
  sleepSync: (ms: number) => {
    sleeps.push(ms);
  },
}));
const PANE = "w1:p1";
const TEST_TIMINGS: SessionTimings = {
  pollIntervalMs: 1,
  boxReadyTimeoutMs: 30,
  landingTimeoutMs: 30,
  exitDialogGoneTimeoutMs: 20,
  slashSubmitFloorMs: 4,
  inputReadyPollMs: 1,
  inputReadyTimeoutMs: 300,
  idleProbeSliceMs: 1,
  rcConnectTimeoutMs: 200,
  interstitialSettleMs: 5,
  readinessPanePollMs: 10,
  shellReadyTimeoutMs: 30,
  shellProbeWaitMs: 5,
};
function readinessHerdr(opts: {
  box?: () => string | null;
  visible?: () => string;
  recent?: () => string;
  idle?: () => boolean;
  agent?: () => {
    pane_id?: string;
    agent_status?: string;
  } | null;
}) {
  return {
    ...fakeSendPort(),
    ...fakeLaunchPort(),
    agentGet: vi.fn(
      opts.agent ??
        (() => ({
          pane_id: PANE,
          agent_status: "idle",
        })),
    ),
    waitIdleOrBlocked: vi.fn(() => true),
    waitIdle: vi.fn(opts.idle ?? (() => true)),
    readRecent: vi.fn(opts.recent ?? (() => "")),
    readBoxBody: vi.fn(opts.box ?? (() => "")),
    readVisible: vi.fn(opts.visible ?? (() => "")),
    agentSendKeys: vi.fn(),
  } satisfies HerdrPort;
}
const launcher = (herdr: HerdrPort) =>
  new AgentLauncher(herdr, { timings: TEST_TIMINGS });
function fakeClock(): {
  advance: (ms: number) => void;
} {
  vi.useFakeTimers({ toFake: ["Date"] });
  let now = new Date("2026-07-28T09:00:00Z").getTime();
  vi.setSystemTime(now);
  return {
    advance: (ms) => {
      now += ms;
      vi.setSystemTime(now);
    },
  };
}
beforeEach(() => {
  sleeps.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});
describe("AgentLauncher.waitReadiness", () => {
  it("idle 到達後に入力受付関門を通してから readiness を返す (#1757)", () => {
    let reads = 0;
    const herdr = readinessHerdr({ box: () => (++reads < 3 ? null : "") });
    const result = launcher(herdr).waitReadiness(PANE);
    expect(result).toMatchObject({ ok: true, pane: PANE });
    expect(result.trace.map((e) => e.stage)).toEqual([
      "agent",
      "idle",
      "box",
      "rc",
    ]);
    expect(reads).toBe(3);
  });
  it("herdr は受け取った pane id 宛てに引く (agent 名では引かない #2520)", () => {
    const herdr = readinessHerdr({ recent: () => "" });
    launcher(herdr).waitReadiness(PANE);
    expect(herdr.agentGet).toHaveBeenCalledWith(PANE);
    expect(herdr.waitIdleOrBlocked).toHaveBeenCalledWith(
      PANE,
      expect.any(Number),
    );
  });
  it("pane がまだ割り当たっていなければ待って引き直す", () => {
    let gets = 0;
    const herdr = readinessHerdr({
      agent: () =>
        ++gets === 1 ? { agent_status: "idle" } : { pane_id: PANE },
    });
    expect(launcher(herdr).waitReadiness(PANE)).toMatchObject({ ok: true });
    expect(gets).toBeGreaterThanOrEqual(2);
    expect(sleeps).toEqual([TEST_TIMINGS.readinessPanePollMs]);
  });
  it("関門が deadline まで通らなければ stage 付きの launch-timeout に写像する", () => {
    const clock = fakeClock();
    const herdr = readinessHerdr({
      box: () => {
        clock.advance(60000);
        return null;
      },
      recent: () => "画面はまだ何も描かれていない",
    });
    expect(launcher(herdr).waitReadiness(PANE)).toMatchObject({
      ok: false,
      kind: "launch-timeout",
      stage: "box",
      paneTail: "画面はまだ何も描かれていない",
    });
  });
  it("agent が消えたら agent-vanished を返す (#2507 で session-disappeared から統合)", () => {
    const herdr = {
      ...fakeSendPort(),
      ...fakeLaunchPort(),
      agentGet: vi.fn(() => null),
    } satisfies HerdrPort;
    expect(launcher(herdr).waitReadiness(PANE)).toMatchObject({
      ok: false,
      kind: "agent-vanished",
      stage: "agent",
      trace: [{ stage: "agent", result: "gone", ms: expect.any(Number) }],
    });
  });
  it("fresh 経路では interstitial 検出が有効 (ダイアログを Enter で通す #1783)", () => {
    let visibles = 0;
    const herdr = readinessHerdr({
      visible: () =>
        ++visibles === 1 ? "New MCP server found in this project: probe" : "",
    });
    expect(launcher(herdr).waitReadiness(PANE)).toMatchObject({ ok: true });
    expect(herdr.agentSendKeys).toHaveBeenCalledWith(PANE, "Enter");
  });
});
