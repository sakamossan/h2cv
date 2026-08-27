import type {
  CmdResult,
  Exec,
  HerdrLaunchPort,
  HerdrSendPort,
} from "../herdr-adapter.js";
import type { HerdrPort } from "../launcher.js";
import type { SessionTimings } from "../timings.js";

export function fakeSendPort(): HerdrSendPort {
  let box = "";
  return {
    agentGet: () => null,
    waitIdle: () => true,
    waitIdleOrBlocked: () => true,
    waitWorking: () => true,
    readRecent: () => "",
    readVisible: () => "",
    agentExplain: () => null,
    paneRun: () => {
      box = "";
    },
    paneSendText: (_pane: string, text: string) => {
      box = text;
    },
    readBoxBody: () => box,
    agentSendKeys: () => {
      box = "";
    },
  };
}
export function fakeLaunchPort(): HerdrLaunchPort {
  return {
    probeServer: () => "up",
    tabCreate: () => ({ ok: true, tabId: "tab-1", paneId: "w1:p1" }),
    paneWaitOutput: () => true,
    paneReadRecent: () => "",
    agentStart: () => ({ ok: true }),
  };
}
export function fakeHerdrPort(over: Partial<HerdrPort> = {}): HerdrPort {
  return {
    ...fakeSendPort(),
    ...fakeLaunchPort(),
    agentGet: () => ({
      agent: "claude",
      agent_status: "idle",
      pane_id: "w1:p1",
    }),
    ...over,
  };
}
export const FAST_TIMINGS: Partial<SessionTimings> = {
  pollIntervalMs: 1,
  boxReadyTimeoutMs: 10,
  landingTimeoutMs: 10,
  slashSubmitFloorMs: 1,
  exitDialogGoneTimeoutMs: 20,
  inputReadyPollMs: 1,
  inputReadyTimeoutMs: 200,
  idleProbeSliceMs: 1,
  interstitialSettleMs: 1,
  readinessPanePollMs: 1,
  shellReadyTimeoutMs: 20,
  shellProbeWaitMs: 5,
};
export type ExecRouter = (bin: string, args: string[]) => CmdResult | undefined;
export function fakeExec(router: ExecRouter): Exec {
  return (bin, args) => {
    const r = router(bin, args);
    if (r) return r;
    throw new Error(`unmocked exec call: ${bin} ${args.join(" ")}`);
  };
}
export function execOk(stdout = ""): CmdResult {
  return { code: 0, stdout, stderr: "" };
}
export function execNg(stderr = ""): CmdResult {
  return { code: 1, stdout: "", stderr };
}
