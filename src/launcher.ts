import type {
  HerdrLaunchPort,
  HerdrSendPort,
  ScreenDetection,
  TabCreateResult,
} from "./herdr-adapter.js";
import type { StageId, TraceEntry, TraceResult } from "./stages.js";
import type { GateTimings, LaunchTimings } from "./timings.js";
import { sleepSync } from "./herdr-adapter.js";
import { inputReadyGate } from "./sender.js";
import { DEFAULT_SESSION_TIMINGS } from "./timings.js";

export type HerdrPort = HerdrLaunchPort & HerdrSendPort;
export type LaunchReadinessResult =
  | {
      ok: true;
      pane: string;
      elapsedMs: number;
      trace: TraceEntry[];
    }
  | {
      ok: false;
      kind: "agent-vanished" | "launch-timeout";
      stage: StageId;
      trace: TraceEntry[];
      timeoutMs?: number;
      paneTail?: string;
      detection?: ScreenDetection | null;
    };
export type ShellGateResult =
  | {
      ok: true;
      probeCount: number;
      elapsedMs: number;
    }
  | {
      ok: false;
      probeCount: number;
      elapsedMs: number;
      paneTail: string;
    };
const PROBE_MARKER_PREFIX = "h2cv-shell-ready-";
const PROBE_TYPED_PREFIX = "echo h2cv''-shell-ready-";
let probeSeq = 0;
function probeNonce(): string {
  return `${process.pid.toString(36)}-${(++probeSeq).toString(36)}-${Date.now().toString(36)}`;
}
export type AgentLauncherOptions = {
  timings?: Partial<LaunchTimings & GateTimings>;
};
export class AgentLauncher {
  private readonly timings: LaunchTimings & GateTimings;
  constructor(
    private readonly herdr: HerdrPort,
    opts: AgentLauncherOptions = {},
  ) {
    this.timings = { ...DEFAULT_SESSION_TIMINGS, ...opts.timings };
  }
  createTab(label: string, cwd: string): TabCreateResult {
    return this.herdr.tabCreate(label, cwd);
  }
  waitShellReady(paneId: string): ShellGateResult {
    const startedAt = Date.now();
    const deadline = startedAt + this.timings.shellReadyTimeoutMs;
    const nonce = probeNonce();
    for (let probes = 1; ; probes++) {
      this.herdr.paneRun(paneId, `${PROBE_TYPED_PREFIX}${nonce}`);
      const remaining = deadline - Date.now();
      if (
        remaining > 0 &&
        this.herdr.paneWaitOutput(
          paneId,
          `${PROBE_MARKER_PREFIX}${nonce}`,
          Math.min(this.timings.shellProbeWaitMs, remaining),
        )
      ) {
        return {
          ok: true,
          probeCount: probes,
          elapsedMs: Date.now() - startedAt,
        };
      }
      if (Date.now() >= deadline) {
        return {
          ok: false,
          probeCount: probes,
          elapsedMs: Date.now() - startedAt,
          paneTail: this.herdr.paneReadRecent(paneId, 20),
        };
      }
    }
  }
  start(
    name: string,
    paneId: string,
    claudeArgs: string[],
  ):
    | {
        ok: true;
        notReady?: true;
      }
    | {
        ok: false;
        stderr: string;
      } {
    return this.herdr.agentStart(name, paneId, claudeArgs);
  }
  waitReadiness(paneId: string): LaunchReadinessResult {
    const timeoutMs = this.timings.inputReadyTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    let agentMs = 0;
    let idleMs = 0;
    let stage: StageId = "agent";
    const preRows = (result: TraceResult): TraceEntry[] =>
      stage === "agent"
        ? [{ stage: "agent", ms: agentMs, result }]
        : [
            { stage: "agent", ms: agentMs, result: "ok" },
            { stage: "idle", ms: idleMs, result },
          ];
    while (true) {
      if (Date.now() >= deadline) {
        return {
          ok: false,
          kind: "launch-timeout",
          stage,
          trace: preRows("timeout"),
          timeoutMs,
          paneTail: this.herdr.readRecent(paneId, 20),
        };
      }
      const agentStartedAt = Date.now();
      const agent = this.herdr.agentGet(paneId);
      agentMs += Date.now() - agentStartedAt;
      if (!agent) {
        stage = "agent";
        return {
          ok: false,
          kind: "agent-vanished",
          stage: "agent",
          trace: preRows("gone"),
        };
      }
      if (agent.pane_id !== paneId) {
        stage = "agent";
        sleepSync(this.timings.readinessPanePollMs);
        agentMs += this.timings.readinessPanePollMs;
        continue;
      }
      stage = "idle";
      const remaining = deadline - Date.now();
      const idleStartedAt = Date.now();
      const settled = this.herdr.waitIdleOrBlocked(
        paneId,
        Math.max(remaining, 0),
      );
      idleMs += Date.now() - idleStartedAt;
      if (settled) {
        const gate = inputReadyGate(
          this.herdr,
          paneId,
          deadline,
          true,
          this.timings,
          idleMs,
        );
        const agentRow: TraceEntry = {
          stage: "agent",
          ms: agentMs,
          result: "ok",
        };
        if (!gate.ok) {
          return {
            ok: false,
            kind: "launch-timeout",
            stage: gate.stage,
            trace: [agentRow, ...gate.trace],
            timeoutMs,
            paneTail: this.herdr.readRecent(paneId, 20),
            detection: gate.detection,
          };
        }
        return {
          ok: true,
          pane: paneId,
          elapsedMs: gate.elapsedMs,
          trace: [agentRow, ...gate.trace],
        };
      }
    }
  }
}
