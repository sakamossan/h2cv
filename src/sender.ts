import type { HerdrSendPort, ScreenDetection } from "./herdr-adapter.js";
import type { StageId, TraceEntry, TraceResult } from "./stages.js";
import type { GateTimings, SendTimings } from "./timings.js";
import { sleepSync } from "./herdr-adapter.js";
import {
  EXIT_DIALOG_MAX_ENTERS,
  INTERSTITIAL_MAX_ENTERS,
  SEND_GRACE_MS,
  SEND_MAX_ATTEMPTS,
  SEND_VERIFY_TIMEOUT_MS,
} from "./stages.js";
import { DEFAULT_SESSION_TIMINGS } from "./timings.js";

const RC_CONNECTING_RE = /\/rc connecting/;
function isSameBody(boxBody: string, sendText: string): boolean {
  const strip = (s: string) => s.replace(/\s+/g, "");
  const box = strip(boxBody);
  const sent = strip(sendText);
  return box !== "" && (box === sent || sent.endsWith(box));
}
const INTERSTITIAL_RE =
  /New MCP server[s]? found in this project|Use this MCP server|Select any you wish to enable|Quick safety check: Is this a project you created or one you trust|Yes, I trust this folder/i;
const EXIT_DIALOG_RE = /Background work is running|Exit and stop tasks/;
function isBlocked(herdr: HerdrSendPort, target: string): boolean {
  return herdr.agentGet(target)?.agent_status === "blocked";
}
const BACKGROUND_WORK_RULE_IDS: readonly string[] = [
  "background_shell_working",
];
export type IdleOutcome = "idle" | "background-work" | "timeout";
function isBackgroundWorkOnly(
  herdr: HerdrSendPort,
  target: string,
  detection: ScreenDetection,
): boolean {
  const id = detection.matchedRule?.id;
  return (
    id !== undefined &&
    BACKGROUND_WORK_RULE_IDS.includes(id) &&
    herdr.readBoxBody(target) !== null
  );
}
export function waitInputAccepting(
  herdr: HerdrSendPort,
  target: string,
  deadline: number,
  settle: (timeoutMs: number) => boolean,
  sliceMs: number,
): IdleOutcome {
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "timeout";
    if (settle(Math.min(remaining, sliceMs))) return "idle";
    const detection = herdr.agentExplain(target);
    if (detection === null) return "timeout";
    if (isBackgroundWorkOnly(herdr, target, detection))
      return "background-work";
  }
}
export type InputGateResult =
  | {
      ok: true;
      elapsedMs: number;
      trace: TraceEntry[];
    }
  | {
      ok: false;
      stage: StageId;
      elapsedMs: number;
      trace: TraceEntry[];
      detection: ScreenDetection | null;
    };
export const TERMINATING_SLASH_COMMANDS = ["/exit", "/quit"];
export const TURNLESS_SLASH_COMMANDS = [
  ...TERMINATING_SLASH_COMMANDS,
  "/clear",
  "/rename",
];
export function isTurnlessCommand(text: string): boolean {
  return TURNLESS_SLASH_COMMANDS.includes(text.trim().split(/\s+/)[0] ?? "");
}
export type SendVerify = "herdr-agent-working" | "claude-box-cleared";
export type SendEvidence =
  | "herdr-agent-working"
  | "claude-box-cleared"
  | "herdr-agent-gone";
export type SendVerdict =
  | "not-delivered"
  | "landed-not-submitted"
  | "submitted-late"
  | "submitted-unconfirmed"
  | "unreadable";
type SendSnapshot = {
  attempts: number;
  trace: TraceEntry[];
  lastAgentStatus: string | null;
  boxBody: string | null;
  paneTail: string;
  detection: ScreenDetection | null;
};
export type SendResult =
  | {
      ok: true;
      attempts: number;
      trace: TraceEntry[];
      evidence: SendEvidence;
    }
  | {
      ok: false;
      reason: "agent-vanished";
      attempts: number;
      trace: TraceEntry[];
    }
  | ({
      ok: false;
      reason: "unverified";
      verify: SendVerify;
      sendVerdict: SendVerdict;
    } & SendSnapshot);
export function snapshotFields(
  sent: Extract<
    SendResult,
    {
      reason: "unverified";
    }
  >,
): Pick<
  SendSnapshot,
  "lastAgentStatus" | "boxBody" | "paneTail" | "detection"
> {
  return {
    lastAgentStatus: sent.lastAgentStatus,
    boxBody: sent.boxBody,
    paneTail: sent.paneTail,
    detection: sent.detection,
  };
}
export function lastStage(trace: readonly TraceEntry[]): StageId {
  const stopped = [...trace].reverse().find((e) => e.stage !== "grace");
  return stopped?.stage ?? "alive";
}
function hasEnteredRound(trace: readonly TraceEntry[]): boolean {
  return trace.some((e) => e.stage === "enter");
}
export type ResolvedTarget = {
  agentLabel: string | null;
  agentStatus: string | null;
};
function isAgentGone(at: ResolvedTarget | null): boolean {
  return at === null || !at.agentLabel || at.agentStatus === "unknown";
}
export function classifyVerdict(
  verify: SendVerify,
  trace: readonly TraceEntry[],
  boxBody: string | null,
  agentStatus: string | null,
  lateWorking: boolean,
  sendText: string,
): SendVerdict {
  if (verify === "herdr-agent-working") {
    if (lateWorking || agentStatus === "working") return "submitted-late";
    if (boxBody === null) return "unreadable";
    if (boxBody !== "" && isSameBody(boxBody, sendText))
      return "landed-not-submitted";
    return hasEnteredRound(trace) ? "submitted-unconfirmed" : "not-delivered";
  }
  if (boxBody === null) return "unreadable";
  if (boxBody !== "") {
    if (isSameBody(boxBody, sendText)) return "landed-not-submitted";
    return hasEnteredRound(trace) ? "submitted-unconfirmed" : "not-delivered";
  }
  return hasEnteredRound(trace) ? "submitted-late" : "not-delivered";
}
export function inputReadyGate(
  herdr: HerdrSendPort,
  target: string,
  deadline: number,
  detectInterstitial: boolean,
  timings: GateTimings = DEFAULT_SESSION_TIMINGS,
  idleSpentMs = 0,
): InputGateResult {
  const startedAt = Date.now();
  const rcDeadline = startedAt + timings.rcConnectTimeoutMs;
  const spent = new Map<StageId, number>([["idle", idleSpentMs]]);
  const add = (stage: StageId, since: number) =>
    spent.set(stage, (spent.get(stage) ?? 0) + (Date.now() - since));
  const ended = new Map<StageId, TraceResult>();
  const rows = (): TraceEntry[] =>
    [...spent].map(([stage, ms]) => ({
      stage,
      ms,
      result: ended.get(stage) ?? "ok",
    }));
  let stage: StageId = "idle";
  let interstitialEnters = 0;
  let sawDialog = false;
  const fail = (s: StageId): InputGateResult => {
    const at = sawDialog ? "dialog" : s;
    ended.set(at, "timeout");
    return {
      ok: false,
      stage: at,
      elapsedMs: Date.now() - startedAt,
      trace: rows(),
      detection: herdr.agentExplain(target),
    };
  };
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return fail(stage);
    const idleStartedAt = Date.now();
    const settled = waitInputAccepting(
      herdr,
      target,
      deadline,
      (ms) =>
        detectInterstitial
          ? herdr.waitIdleOrBlocked(target, ms)
          : herdr.waitIdle(target, ms),
      timings.idleProbeSliceMs,
    );
    add("idle", idleStartedAt);
    if (settled === "timeout") {
      return fail("idle");
    }
    if (settled === "background-work") ended.set("idle", "background-work");
    const roundStartedAt = Date.now();
    const visible = herdr.readVisible(target);
    if (
      detectInterstitial &&
      interstitialEnters < INTERSTITIAL_MAX_ENTERS &&
      (isBlocked(herdr, target) || INTERSTITIAL_RE.test(visible))
    ) {
      sawDialog = true;
      stage = "dialog";
      herdr.agentSendKeys(target, "Enter");
      interstitialEnters++;
      sleepSync(timings.interstitialSettleMs);
      add("dialog", roundStartedAt);
      continue;
    }
    if (sawDialog)
      ended.set(
        "dialog",
        interstitialEnters >= INTERSTITIAL_MAX_ENTERS ? "fail-open" : "ok",
      );
    if (herdr.readBoxBody(target) === null) {
      stage = "box";
      sleepSync(timings.inputReadyPollMs);
      add("box", roundStartedAt);
      continue;
    }
    add("box", roundStartedAt);
    const rcStartedAt = Date.now();
    if (RC_CONNECTING_RE.test(visible)) {
      if (Date.now() < rcDeadline) {
        stage = "rc";
        sleepSync(timings.inputReadyPollMs);
        add("rc", rcStartedAt);
        continue;
      }
      add("rc", rcStartedAt);
      ended.set("rc", "fail-open");
      return { ok: true, elapsedMs: Date.now() - startedAt, trace: rows() };
    }
    add("rc", rcStartedAt);
    return { ok: true, elapsedMs: Date.now() - startedAt, trace: rows() };
  }
}
export class AgentSender {
  private readonly timings: SendTimings & GateTimings;
  constructor(
    private readonly herdr: HerdrSendPort,
    private readonly pane: string | null,
    timings?: Partial<SendTimings & GateTimings>,
  ) {
    this.timings = { ...DEFAULT_SESSION_TIMINGS, ...timings };
  }
  private pollBox(
    pane: string,
    timeoutMs: number,
    pred: (body: string | null) => boolean,
  ): string | null {
    const deadline = Date.now() + timeoutMs;
    let body = this.herdr.readBoxBody(pane);
    while (!pred(body) && Date.now() < deadline) {
      sleepSync(this.timings.pollIntervalMs);
      body = this.herdr.readBoxBody(pane);
    }
    return body;
  }
  private waitAgentGone(timeoutMs: number): boolean {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (isAgentGone(this.resolve())) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      sleepSync(Math.min(remaining, this.timings.inputReadyPollMs));
    }
  }
  resolve(): ResolvedTarget | null {
    const pane = this.pane;
    if (!pane) return null;
    const agent = this.herdr.agentGet(pane);
    return agent?.pane_id
      ? {
          agentLabel: agent.agent ?? null,
          agentStatus: agent.agent_status ?? null,
        }
      : null;
  }
  send(text: string): SendResult {
    const pane = this.pane;
    if (!pane)
      return {
        ok: false,
        reason: "agent-vanished",
        attempts: 1,
        trace: [{ attempt: 1, stage: "alive", ms: 0, result: "gone" }],
      };
    return isTurnlessCommand(text)
      ? this.sendVerifyBoxCleared(text, pane)
      : this.sendVerifyWorking(text, pane);
  }
  clearPrompt(): SendResult {
    return this.send("/clear");
  }
  private sendVerifyBoxCleared(rawCommand: string, pane: string): SendResult {
    const command = rawCommand.endsWith(" ") ? rawCommand : `${rawCommand} `;
    const terminating = TERMINATING_SLASH_COMMANDS.includes(command.trim());
    let attempts = 0;
    const trace: TraceEntry[] = [];
    const mark = (
      attempt: number,
      stage: StageId,
      startedAt: number,
      result: TraceResult,
    ) => trace.push({ attempt, stage, ms: Date.now() - startedAt, result });
    const goneAfterSend = (at: ResolvedTarget | null) =>
      terminating && hasEnteredRound(trace) && isAgentGone(at);
    let exitDialogEnters = 0;
    for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
      attempts = attempt;
      const aliveStartedAt = Date.now();
      const at = this.resolve();
      if (goneAfterSend(at))
        return { ok: true, attempts, trace, evidence: "herdr-agent-gone" };
      if (!at) {
        mark(attempt, "alive", aliveStartedAt, "gone");
        return { ok: false, reason: "agent-vanished", attempts, trace };
      }
      mark(attempt, "alive", aliveStartedAt, "ok");
      const t = this.timings;
      if (
        terminating &&
        exitDialogEnters < EXIT_DIALOG_MAX_ENTERS &&
        hasEnteredRound(trace) &&
        at.agentStatus === "blocked" &&
        EXIT_DIALOG_RE.test(this.herdr.readVisible(pane))
      ) {
        const dialogStartedAt = Date.now();
        this.herdr.agentSendKeys(pane, "Enter");
        exitDialogEnters++;
        const gone = this.waitAgentGone(t.exitDialogGoneTimeoutMs);
        mark(attempt, "dialog", dialogStartedAt, gone ? "ok" : "timeout");
        if (gone)
          return { ok: true, attempts, trace, evidence: "herdr-agent-gone" };
        continue;
      }
      const boxStartedAt = Date.now();
      const body = this.pollBox(pane, t.boxReadyTimeoutMs, (b) => b !== null);
      if (body === null) {
        mark(attempt, "box", boxStartedAt, "timeout");
        continue;
      }
      if (body === "") {
        mark(attempt, "box", boxStartedAt, "ok");
        const typeStartedAt = Date.now();
        this.herdr.paneRun(pane, command);
        mark(attempt, "type", typeStartedAt, "ok");
        const enterStartedAt = Date.now();
        sleepSync(t.slashSubmitFloorMs);
        if (this.pollBox(pane, t.landingTimeoutMs, (b) => b === "") === "") {
          mark(attempt, "enter", enterStartedAt, "ok");
          return { ok: true, attempts, trace, evidence: "claude-box-cleared" };
        }
        mark(attempt, "enter", enterStartedAt, "timeout");
        continue;
      }
      if (isSameBody(body, command)) {
        mark(attempt, "box", boxStartedAt, "ok");
        const enterStartedAt = Date.now();
        this.herdr.agentSendKeys(pane, "Enter");
        if (this.pollBox(pane, t.landingTimeoutMs, (b) => b === "") === "") {
          mark(attempt, "enter", enterStartedAt, "ok");
          return { ok: true, attempts, trace, evidence: "claude-box-cleared" };
        }
        mark(attempt, "enter", enterStartedAt, "timeout");
        continue;
      }
      mark(attempt, "box", boxStartedAt, "foreign");
      break;
    }
    if (terminating && hasEnteredRound(trace) && isAgentGone(this.resolve()))
      return { ok: true, attempts, trace, evidence: "herdr-agent-gone" };
    const boxBody = this.herdr.readBoxBody(pane);
    const lastAgentStatus = this.herdr.agentGet(pane)?.agent_status ?? null;
    const detection = this.herdr.agentExplain(pane);
    return {
      ok: false,
      reason: "unverified",
      verify: "claude-box-cleared",
      attempts,
      trace,
      sendVerdict: classifyVerdict(
        "claude-box-cleared",
        trace,
        boxBody,
        lastAgentStatus,
        false,
        command,
      ),
      lastAgentStatus,
      boxBody,
      paneTail: this.paneTail(20),
      detection,
    };
  }
  private sendVerifyWorking(sendText: string, pane: string): SendResult {
    let attempts = 0;
    let verify: SendVerify = "herdr-agent-working";
    const trace: TraceEntry[] = [];
    const mark = (
      attempt: number,
      stage: StageId,
      startedAt: number,
      result: TraceResult,
    ) => trace.push({ attempt, stage, ms: Date.now() - startedAt, result });
    for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
      attempts = attempt;
      const aliveStartedAt = Date.now();
      const at = this.resolve();
      if (!at) {
        mark(attempt, "alive", aliveStartedAt, "gone");
        return { ok: false, reason: "agent-vanished", attempts, trace };
      }
      mark(attempt, "alive", aliveStartedAt, "ok");
      const t = this.timings;
      verify =
        at.agentStatus === "working"
          ? "claude-box-cleared"
          : "herdr-agent-working";
      const submitted = () =>
        verify === "claude-box-cleared"
          ? this.pollBox(pane, t.landingTimeoutMs, (b) => b === "") === ""
          : this.herdr.waitWorking(pane, SEND_VERIFY_TIMEOUT_MS);
      const evidence: SendEvidence =
        verify === "claude-box-cleared"
          ? "claude-box-cleared"
          : "herdr-agent-working";
      const boxStartedAt = Date.now();
      const body = this.pollBox(pane, t.boxReadyTimeoutMs, (b) => b !== null);
      if (body === null) {
        mark(attempt, "box", boxStartedAt, "timeout");
        continue;
      }
      if (body !== "") {
        if (!isSameBody(body, sendText)) {
          mark(attempt, "box", boxStartedAt, "foreign");
          break;
        }
        mark(attempt, "box", boxStartedAt, "ok");
        const enterStartedAt = Date.now();
        this.herdr.agentSendKeys(pane, "Enter");
        if (submitted()) {
          mark(attempt, "enter", enterStartedAt, "ok");
          return { ok: true, attempts, trace, evidence };
        }
        mark(attempt, "enter", enterStartedAt, "timeout");
        continue;
      }
      mark(attempt, "box", boxStartedAt, "ok");
      const typeStartedAt = Date.now();
      this.herdr.paneSendText(pane, sendText);
      const landed = this.pollBox(
        pane,
        t.landingTimeoutMs,
        (b) => b !== null && b !== "",
      );
      if (landed === null || landed === "") {
        mark(attempt, "type", typeStartedAt, "timeout");
        continue;
      }
      mark(attempt, "type", typeStartedAt, "ok");
      const enterStartedAt = Date.now();
      this.herdr.agentSendKeys(pane, "Enter");
      if (submitted()) {
        mark(attempt, "enter", enterStartedAt, "ok");
        return { ok: true, attempts, trace, evidence };
      }
      mark(attempt, "enter", enterStartedAt, "timeout");
    }
    let lateWorking = false;
    if (verify === "herdr-agent-working") {
      const graceStartedAt = Date.now();
      lateWorking = this.herdr.waitWorking(pane, SEND_GRACE_MS);
      trace.push({
        stage: "grace",
        ms: Date.now() - graceStartedAt,
        result: lateWorking ? "ok" : "timeout",
      });
    }
    const boxBody = this.herdr.readBoxBody(pane);
    const lastAgentStatus = this.herdr.agentGet(pane)?.agent_status ?? null;
    const detection = this.herdr.agentExplain(pane);
    return {
      ok: false,
      reason: "unverified",
      verify,
      attempts,
      trace,
      sendVerdict: classifyVerdict(
        verify,
        trace,
        boxBody,
        lastAgentStatus,
        lateWorking,
        sendText,
      ),
      lastAgentStatus,
      boxBody,
      paneTail: this.paneTail(20),
      detection,
    };
  }
  paneTail(lines: number): string {
    return this.pane ? this.herdr.readRecent(this.pane, lines) : "";
  }
}
