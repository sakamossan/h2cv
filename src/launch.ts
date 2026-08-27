import type { ErrorCode } from "./explain.js";
import type { HerdrPort } from "./launcher.js";
import type { StageId, TraceEntry, TraceResult } from "./stages.js";
import type { SessionTimings } from "./timings.js";
import { basename } from "node:path";
import {
  SERVER_DOWN_MESSAGE,
  SERVER_PROTOCOL_MISMATCH_MESSAGE,
} from "./herdr-adapter.js";
import { AgentLauncher } from "./launcher.js";
import { AgentSender, lastStage, snapshotFields } from "./sender.js";

export type LaunchDestination =
  | {
      cwd: string;
      paneId?: never;
    }
  | {
      paneId: string;
      cwd?: never;
    };
export type LaunchRequest = LaunchDestination & {
  agentName?: string;
  prompt?: string;
  claudeArgv?: string[];
};
export type LaunchDeps = {
  herdr: HerdrPort;
  timings?: Partial<SessionTimings>;
};
export type LaunchSuccess = {
  ok: true;
  agentName: string;
  pane: string;
  promptSent: boolean;
  readyMs: number;
  trace: TraceEntry[];
  attempts?: number;
};
export type LaunchFailure = {
  error: ErrorCode;
  stage: StageId;
} & Record<string, unknown>;
export type LaunchResult =
  | {
      ok: true;
      value: LaunchSuccess;
    }
  | {
      ok: false;
      failure: LaunchFailure;
    };
function fail(
  error: ErrorCode,
  stage: StageId,
  rest: Record<string, unknown>,
): LaunchResult {
  return { ok: false, failure: { error, stage, ...rest } };
}
export function deriveAgentName(paneId: string): string {
  return `h2cv-${paneId.replaceAll(":", "-").toLowerCase()}`;
}
export function runLaunch(req: LaunchRequest, deps: LaunchDeps): LaunchResult {
  const launcher = new AgentLauncher(deps.herdr, {
    ...(deps.timings === undefined ? {} : { timings: deps.timings }),
  });
  const trace: TraceEntry[] = [];
  const mark = (stage: StageId, startedAt: number, result: TraceResult) =>
    trace.push({ stage, ms: Date.now() - startedAt, result });
  const probeStartedAt = Date.now();
  const probe = deps.herdr.probeServer();
  if (probe !== "up") {
    mark("probe", probeStartedAt, "timeout");
    return probe === "protocol-mismatch"
      ? fail("server-protocol-mismatch", "probe", {
          message: SERVER_PROTOCOL_MISMATCH_MESSAGE,
          trace,
        })
      : fail("server-down", "probe", { message: SERVER_DOWN_MESSAGE, trace });
  }
  mark("probe", probeStartedAt, "ok");
  let paneId: string;
  if (req.paneId === undefined) {
    const tabStartedAt = Date.now();
    const tab = launcher.createTab(req.agentName ?? basename(req.cwd), req.cwd);
    if (!tab.ok) {
      mark("tab", tabStartedAt, "timeout");
      return fail("tab-create-failed", "tab", {
        agentName: req.agentName,
        cwd: req.cwd,
        stderr: tab.stderr,
        trace,
      });
    }
    mark("tab", tabStartedAt, "ok");
    paneId = tab.paneId;
  } else {
    paneId = req.paneId;
  }
  const agentName = req.agentName ?? deriveAgentName(paneId);
  const shellStartedAt = Date.now();
  const shell = launcher.waitShellReady(paneId);
  if (!shell.ok) {
    mark("shell", shellStartedAt, "timeout");
    return fail("start-failed", "shell", {
      agentName,
      stderr: `shell-not-ready: pane ${paneId} did not answer the probe handshake (probeCount=${shell.probeCount}, elapsedMs=${shell.elapsedMs})`,
      probeCount: shell.probeCount,
      paneTail: shell.paneTail,
      trace,
    });
  }
  mark("shell", shellStartedAt, "ok");
  const startStartedAt = Date.now();
  const start = launcher.start(agentName, paneId, [...(req.claudeArgv ?? [])]);
  if (!start.ok) {
    mark("start", startStartedAt, "timeout");
    return fail("start-failed", "start", {
      agentName,
      stderr: start.stderr,
      trace,
    });
  }
  mark("start", startStartedAt, start.notReady === true ? "fail-open" : "ok");
  const readiness = launcher.waitReadiness(paneId);
  trace.push(...readiness.trace);
  if (!readiness.ok) {
    return readiness.kind === "agent-vanished"
      ? fail("agent-vanished", readiness.stage, {
          agentName,
          trace,
        })
      : fail("launch-timeout", readiness.stage, {
          agentName,
          timeoutMs: readiness.timeoutMs,
          paneTail: readiness.paneTail,
          detection: readiness.detection,
          trace,
        });
  }
  const pane = readiness.pane;
  const readyMs = readiness.elapsedMs;
  const base = {
    ok: true as const,
    agentName,
    pane,
  };
  const sendText = req.prompt ?? "";
  if (sendText === "") {
    return {
      ok: true,
      value: {
        ...base,
        promptSent: false,
        readyMs,
        trace,
      },
    };
  }
  const sender = new AgentSender(deps.herdr, pane, deps.timings);
  const sent = sender.send(sendText);
  trace.push(...sent.trace);
  if (!sent.ok) {
    if (sent.reason === "agent-vanished") {
      return fail("agent-vanished", "alive", {
        agentName,
        pane,
        attempts: sent.attempts,
        trace,
        message:
          "The target agent disappeared while the body was being sent (nothing was typed into the abandoned pane)",
      });
    }
    return fail("send-unverified", lastStage(sent.trace), {
      agentName,
      pane,
      attempts: sent.attempts,
      trace,
      verify: sent.verify,
      sendVerdict: sent.sendVerdict,
      ...snapshotFields(sent),
    });
  }
  return {
    ok: true,
    value: {
      ...base,
      promptSent: true,
      attempts: sent.attempts,
      readyMs,
      trace,
    },
  };
}
