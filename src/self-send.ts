import type { ErrorCode } from "./explain.js";
import type { HerdrSendPort } from "./herdr-adapter.js";
import type { SendEvidence } from "./sender.js";
import type { StageId } from "./stages.js";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSender,
  lastStage,
  snapshotFields,
  TERMINATING_SLASH_COMMANDS,
  waitInputAccepting,
} from "./sender.js";
import { SELF_SEND_IDLE_TIMEOUT_MS } from "./stages.js";
import { DEFAULT_SESSION_TIMINGS } from "./timings.js";

export const SELF_SEND_WATCH_FLAG = "--watch";
export function selfSendWatchLog(pane: string): string {
  return join(
    tmpdir(),
    `h2cv-self-send-watch-${pane.replace(/[^A-Za-z0-9_-]/g, "_")}.log`,
  );
}
export type SelfSendEnv = {
  pane: string | null;
  arm: (prompts: string[], logPath: string) => void;
};
const SELF_SEND_GATES = ["idle", "draft"] as const satisfies readonly StageId[];
export type SelfSendResult =
  | {
      ok: true;
      payload: Record<string, unknown>;
    }
  | {
      ok: false;
      error: ErrorCode;
      payload: Record<string, unknown>;
      summary: string;
    };
export function armWatcher(prompts: string[], logPath: string): void {
  const logFd = openSync(logPath, "w");
  spawn(
    process.execPath,
    [
      ...process.execArgv,
      process.argv[1],
      "self-send",
      SELF_SEND_WATCH_FLAG,
      ...prompts,
    ],
    { stdio: ["ignore", logFd, logFd], detached: true },
  ).unref();
  closeSync(logFd);
}
export function selfSend(
  argv: string[],
  herdr: HerdrSendPort,
  env: SelfSendEnv,
): SelfSendResult {
  const pane = env.pane;
  if (!pane) {
    const detail =
      "not running under a herdr pane ($HERDR_PANE_ID unset); cannot self-send";
    return { ok: false, error: "usage", payload: { detail }, summary: detail };
  }
  const watching = argv[0] === SELF_SEND_WATCH_FLAG;
  const prompts = watching ? argv.slice(1) : argv;
  const notSlash = prompts.find((p) => !p || !p.startsWith("/"));
  if (prompts.length === 0 || notSlash !== undefined) {
    const detail = `self-send takes one or more slash commands (e.g. "/rename [exiting]my-session" "/exit"); got ${prompts.length === 0 ? "no argument" : JSON.stringify(notSlash)}`;
    return { ok: false, error: "usage", payload: { detail }, summary: detail };
  }
  const terminatingAt = prompts.findIndex((p) =>
    TERMINATING_SLASH_COMMANDS.includes(p.trim()),
  );
  if (terminatingAt !== -1 && terminatingAt !== prompts.length - 1) {
    const detail = `a terminating command (${TERMINATING_SLASH_COMMANDS.join(" / ")}) can only come last; got ${JSON.stringify(prompts[terminatingAt])} at ${terminatingAt + 1}/${prompts.length}`;
    return { ok: false, error: "usage", payload: { detail }, summary: detail };
  }
  if (!watching) {
    env.arm(prompts, selfSendWatchLog(pane));
    return { ok: true, payload: { target: pane, prompts, armed: true } };
  }
  const waitStartedAt = Date.now();
  const settled = waitInputAccepting(
    herdr,
    pane,
    waitStartedAt + SELF_SEND_IDLE_TIMEOUT_MS,
    (ms) => herdr.waitIdle(pane, ms),
    DEFAULT_SESSION_TIMINGS.idleProbeSliceMs,
  );
  if (settled === "timeout") {
    return {
      ok: false,
      error: "not-ready",
      payload: {
        target: pane,
        prompts,
        stage: SELF_SEND_GATES[0],
        timeoutMs: SELF_SEND_IDLE_TIMEOUT_MS,
        elapsedMs: Date.now() - waitStartedAt,
        paneTail: herdr.readRecent(pane, 20),
        detection: herdr.agentExplain(pane),
      },
      summary: `self-send ${pane}: not-ready — stage=idle (${Date.now() - waitStartedAt}ms; read the screen classification with \`| jq .detection\`)`,
    };
  }
  const boxBody = herdr.readBoxBody(pane);
  if (boxBody !== "") {
    return {
      ok: false,
      error: "not-ready",
      payload: {
        target: pane,
        prompts,
        stage: SELF_SEND_GATES[1],
        boxBody,
      },
      summary: `self-send ${pane}: not-ready — stage=draft (nothing was typed because the input box holds a draft)`,
    };
  }
  const sender = new AgentSender(herdr, pane);
  const sent: {
    prompt: string;
    evidence: SendEvidence;
  }[] = [];
  for (const [index, prompt] of prompts.entries()) {
    const result = sender.send(prompt);
    if (result.ok) {
      sent.push({ prompt, evidence: result.evidence });
      continue;
    }
    const failedAt = index + 1;
    const where = `${failedAt}/${prompts.length}`;
    if (result.reason === "agent-vanished") {
      return {
        ok: false,
        error: "agent-vanished",
        payload: {
          stage: "alive",
          target: pane,
          prompts,
          prompt,
          failedAt,
          sent,
          attempts: result.attempts,
          trace: result.trace,
        },
        summary: `self-send ${pane} ${prompt} (${where}): agent-vanished — stage=alive — the target could not be resolved and nothing was ever typed`,
      };
    }
    return {
      ok: false,
      error: "send-unverified",
      payload: {
        stage: lastStage(result.trace),
        target: pane,
        prompts,
        prompt,
        failedAt,
        sent,
        attempts: result.attempts,
        trace: result.trace,
        verify: result.verify,
        sendVerdict: result.sendVerdict,
        ...snapshotFields(result),
      },
      summary: `self-send ${pane} ${prompt} (${where}): send-unverified — stage=${lastStage(result.trace)} verify=${result.verify} sendVerdict=${result.sendVerdict} lastAgentStatus=${result.lastAgentStatus} attempts=${result.attempts} (read the box / pane dumps and the screen classification with \`| jq -r .boxBody\` / \`| jq -r .paneTail\` / \`| jq .detection\`)`,
    };
  }
  return { ok: true, payload: { target: pane, prompts, sent } };
}
