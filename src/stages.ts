import type { SessionTimings } from "./timings.js";
import {
  AGENT_START_RETRIES,
  AGENT_START_RETRY_MS,
  AGENT_START_TIMEOUT_MS,
} from "./herdr-adapter.js";
import { DEFAULT_SESSION_TIMINGS } from "./timings.js";

export type StageKind = "act+verify" | "gate" | "act";
export type Observes =
  | "herdr-cli"
  | "herdr-agent-status"
  | "claude-screen"
  | "none";
export type TraceResult =
  | "ok"
  | "timeout"
  | "foreign"
  | "gone"
  | "fail-open"
  | "background-work";
export type StageId =
  | "probe"
  | "tab"
  | "shell"
  | "start"
  | "agent"
  | "idle"
  | "dialog"
  | "box"
  | "rc"
  | "alive"
  | "type"
  | "enter"
  | "grace"
  | "arm"
  | "draft";
export type TraceEntry = {
  attempt?: number;
  stage: StageId;
  ms: number;
  result: TraceResult;
};
export const SEND_VERIFY_TIMEOUT_MS = 6000;
export const SEND_GRACE_MS = 10000;
export const SELF_SEND_IDLE_TIMEOUT_MS = 300000;
export const SEND_MAX_ATTEMPTS = 5;
export const INTERSTITIAL_MAX_ENTERS = 5;
export const EXIT_DIALOG_MAX_ENTERS = 1;
const BUDGETS = {
  ...DEFAULT_SESSION_TIMINGS,
  SEND_VERIFY_TIMEOUT_MS,
  SEND_GRACE_MS,
  SELF_SEND_IDLE_TIMEOUT_MS,
  AGENT_START_RETRY_MS,
  AGENT_START_TIMEOUT_MS,
} satisfies Record<string, number> & Record<keyof SessionTimings, number>;
type BudgetName = keyof typeof BUDGETS;
const budget = (name: BudgetName): string => `${name} ${BUDGETS[name]}`;
const NONE = "—";
const WITHIN_BUDGET = "within the budget";
export type ProblemId =
  | "P1"
  | "P2"
  | "P3"
  | "P4"
  | "P5"
  | "P6"
  | "P7"
  | "P8"
  | "P9"
  | "P10"
  | "P11"
  | "P12"
  | "P13"
  | "P14"
  | "P15"
  | "P16"
  | "P17"
  | "P18"
  | "P19"
  | "P20"
  | "P21"
  | "P22"
  | "P23"
  | "P24"
  | "P25"
  | "P26"
  | "P27"
  | "P28"
  | "P29"
  | "P30"
  | "P31";
export type Problem = {
  symptom: string;
  mechanism: string;
  defence: string;
  stage: string;
};
export const PROBLEMS = {
  P1: {
    symptom:
      "The first Enter of a slash command is eaten, and the body stays in the box without being submitted",
    mechanism:
      "The TUI opens the slash completion menu, and the Enter that `pane run` attaches atomically is consumed by the menu selection",
    defence:
      "Append a single space to commit the menu selection, and if the read-back still shows your own body, press Enter again without retyping",
    stage: "enter",
  },
  P2: {
    symptom:
      "Seconds pass between agent_status going idle and the TUI accepting input, and a body typed in that window disappears",
    mechanism:
      'herdr\'s idle guarantees nothing beyond "the claude process is up and is not processing anything". Measured on the current pinned versions, a 1.25 s window still remains between idle and the box border being drawn',
    defence:
      "Do not treat idle as readiness. Pass dialog / box / rc before typing",
    stage: "box",
  },
  P3: {
    symptom:
      "A retry retypes the same body after the residual one, and the trailing Enter submits the concatenation as a single prompt",
    mechanism:
      "The body and the Enter were resent as one atomic `pane run`. The child's first prompt became the same command twice, concatenated",
    defence:
      'Split "type the body" from "press Enter", and retype the body only right after a read-back showing the box is empty',
    stage: "type",
  },
  P4: {
    symptom:
      "A pane id held across time points at a different pane, and the retry loop becomes the thing that misdelivers",
    mechanism:
      "Position-based pane ids shifted up when another pane closed. Verification was done against the agent name, so the broken correspondence went undetected",
    defence:
      "Hold exactly one canonical pane id and re-read liveness at the top of every attempt. If it cannot be resolved, abort without typing into the remains",
    stage: "alive",
  },
  P5: {
    symptom:
      "A first-run dialog looks like an empty input box, and the body is typed into the dialog",
    mechanism:
      "The dialog frame is a ceiling-only border, so parseBoxBody finds only the bottom edge and returns an empty body. It is not null, so the box gate passes",
    defence:
      "Put dialog before box, take agent_status blocked as the primary signal and the frozen wording as a fallback, and clear it with Enter",
    stage: "dialog",
  },
  P6: {
    symptom:
      "While Remote Control is connecting, keystrokes are silently dropped. There is no error and no residue, so a read-back cannot catch it",
    mechanism:
      "A 1.6 s window remains between the box being drawn and `/rc connecting` disappearing. herdr does not know the string, so it cannot be read from the status",
    defence:
      "Wait until `/rc connecting` disappears from the visible frame. The check is negative, so a status line truncated by the terminal width falls to fail-open",
    stage: "rc",
  },
  P7: {
    symptom:
      "Pressing Enter into a box that holds someone else's body submits that body as your own prompt",
    mechanism:
      "Pressing Enter without reading the box submits whatever a previous send, a human or another tool left there",
    defence:
      "Read the box and branch before typing. Your own body gets Enter only; a foreign body types nothing, presses nothing and stops with a report",
    stage: "box",
  },
  P8: {
    symptom: "A loop that empties the input box kills the session",
    mechanism:
      "Ctrl+C clears the box on the first press and ends the session on the second. A screen such as the /model picker reads as a foreign body every round, so a press-until-empty loop runs to the attempt limit",
    defence:
      "This layer never presses Ctrl+C. A foreign body stops the send and is reported (boxBody / paneTail / detection); emptying the box is the caller's or a human's call",
    stage: "box",
  },
  P9: {
    symptom:
      "Wording that disappeared seconds ago is read as present, so the past gets verified",
    mechanism: "Scrollback keeps the frames the TUI flushed on every redraw",
    defence: "Read only the visible frame",
    stage: "cross-cutting",
  },
  P10: {
    symptom:
      "The read-back cannot be compared with the sent body, and an empty box does not look empty either",
    mechanism:
      "A text dump emits wide characters cell by cell with spaces between them. An empty input box holds a dim placeholder hint",
    defence:
      "Read as ansi, drop the dim ranges, and compare with all whitespace stripped. A suffix match counts as identical too",
    stage: "cross-cutting",
  },
  P11: {
    symptom:
      'The three endings of "the submit could not be verified" are confused and the same instruction is fired twice',
    mechanism:
      'The return value cannot tell "nothing arrived" from "only the body arrived with no Enter" from "it was submitted late"',
    defence:
      'Classify the terminal state into the five values of sendVerdict. submitted-late says "do not re-fire" by name',
    stage: "grace / terminal",
  },
  P12: {
    symptom:
      "Tabs of finished sessions pile up until no new tab can be created and every launch stops",
    mechanism:
      "One tab holds 1 pty + 2 pipes worth of fds until the server runs out of its soft nofile",
    defence:
      "This layer holds no defence. Raising the ceiling and sweeping empty tabs both belong to whoever starts the server; here it surfaces as tab-create-failed",
    stage: "tab",
  },
  P13: {
    symptom:
      "A bash running its rc eats the start command's keystrokes, and upstream burns 5 minutes before failing",
    mechanism:
      "Upstream's available-shell check only looks at whether the pane's child is a shell, so a bash running .bashrc / direnv passes too. A terminal running its rc consumes and discards input",
    defence:
      "Read back a nonce-carrying echo probe to confirm the prompt was reached before typing. If the marker does not appear, type the probe again",
    stage: "shell",
  },
  P14: {
    symptom:
      "Right after only the binary is replaced, the old server holds the socket and every command fails",
    mechanism:
      "The running old server and the new client speak incompatible protocols. Reading that as absence recommends the wrong recovery",
    defence:
      "Read the error code of `agent list` and keep protocol-mismatch distinct from down. Unknown codes and raw I/O errors fail open to down",
    stage: "probe",
  },
  P15: {
    symptom:
      "When agent start's default 30 s timeout expires, upstream releases the binding of the agent name",
    mechanism:
      'The upstream readiness wait and the downstream budget are out of step, so a timeout stops meaning "not ready yet" and starts meaning "the target is lost"',
    defence:
      "Always pass --timeout explicitly, set to the same value as the readiness budget",
    stage: "start",
  },
  P16: {
    symptom:
      "Putting the executable name after agent start's -- gets that word submitted as the first prompt",
    mechanism:
      "--kind supplies the canonical executable and everything after -- is appended as arguments only. agent start itself returns success, so it is stepped on silently",
    defence:
      "Never include the executable name. The argv is passed through verbatim and this layer holds no startup policy",
    stage: "start",
  },
  P17: {
    symptom:
      "Every launch into a cwd that raises a first-run dialog fails as start-failed",
    mechanism:
      "Upstream no longer clears the first-run prompt by itself and returns agent_not_ready the moment its detector reports Blocked. The agent name stays bound and answers agent get / agent send-keys",
    defence:
      "Do not treat agent_not_ready as a failure. Fail open to the dialog stage and record having passed through it in the trace",
    stage: "start",
  },
  P18: {
    symptom: "The budget is burnt in front of a dialog nobody will close",
    mechanism:
      "Upstream classifies trust and single-MCP dialogs as blocked. With a wait set of idle / done alone the wait cannot finish (measured: 5018 ms to time out, 6 ms once blocked is added)",
    defence:
      "Add blocked to the wait set on the fresh-launch path only. The send path for an existing pane does not add it, because there blocked means a human is being waited on",
    stage: "idle",
  },
  P19: {
    symptom:
      "As concurrency rises the pane width runs out, the box wrapping breaks and send verification stops passing",
    mechanism: "Launching into a split leaves one pane a fraction of the width",
    defence:
      "Start in the single pane of a dedicated tab. A single pane means the full window width, so width exhaustion disappears structurally",
    stage: "tab",
  },
  P20: {
    symptom:
      "Typing into yourself during your own turn is not accepted, and the process cannot observe that fact until its turn ends",
    mechanism:
      "The sender is also the recipient, and the waiter must not be bound to the parent's lifetime",
    defence:
      "Hand the send to a detached watcher and wait from the outside for the target to go idle",
    stage: "arm / idle (self-send)",
  },
  P21: {
    symptom:
      "Typing into an input box that holds a draft submits the draft along with it, or concatenates the command after it",
    mechanism: "self-send can target a pane a human is touching",
    defence:
      "Confirm readBoxBody is exactly empty before typing. Undecidable (null) falls to the cancel side too, and the value that was read goes into the failure JSON as-is",
    stage: "draft",
  },
  P22: {
    symptom:
      "The success of /exit cannot be told apart from agent-vanished (nothing was ever typed)",
    mechanism:
      "When the submit lands claude exits by itself, so the pane-side state changes before the box can be observed going empty. The terminal state is not singular either (the pane closes, or the shell respawns in it)",
    defence:
      'Add herdr-agent-gone to the evidence and treat "claude left after the keystroke" as a success. It only holds in conjunction with the evidence of having typed (an enter row in the trace)',
    stage: "enter",
  },
  P23: {
    symptom:
      "A command that starts no turn never rises to working, so working verification cannot work at all",
    mechanism:
      "/clear, /rename, /exit and /quit are handled by claude on the spot",
    defence:
      "Pick the verify predicate from the first word of the body. If the list is wrong it falls open to the working side and returns submitted-unconfirmed, never a false success",
    stage: "enter",
  },
  P24: {
    symptom:
      'An empty box that has not landed yet is misread as "submitted and cleared"',
    mechanism:
      "Box-clear verification has no positive signal, and reading at 0 ms right after an atomic send picks up the empty from before the typing rendered",
    defence: "Put a floor in front of the polling on the empty-box branch only",
    stage: "enter",
  },
  P25: {
    symptom:
      "A round is thrown away and an attempt spent even though the send succeeded, because of a delay in rendering",
    mechanism:
      'The "sleep a fixed time and read once" shape breaks the moment the TUI redraw exceeds that time',
    defence:
      'Split the unit of the wait from "how long to sleep" to "the upper bound of the wait", and re-read on a tick until the bound',
    stage: "every gate stage",
  },
  P26: {
    symptom:
      'Nothing arrived, yet it falls to "do not re-fire" and the lane is left empty',
    mechanism:
      "When the box goes back to empty after rounds that only ended in timeout / foreign, a terminal read alone cannot tell that apart from a completed submit",
    defence:
      "Narrow it with whether the trace holds an enter row, both when the terminal box is empty and when it holds a foreign residual. Without one it falls to not-delivered (safe to re-fire); with one the foreign residual falls to submitted-unconfirmed",
    stage: "terminal",
  },
  P27: {
    symptom: "A misfiring frozen value presses Enter forever",
    mechanism:
      "The dialog wording is a frozen value that changes with claude's version, and an existing pane's conversation body can match it",
    defence:
      "Cap the Enters and fail open beyond that, deferring to the box / rc checks. The dialog stage is only evaluated on the fresh-launch path and on the exit dialog of a terminating command",
    stage: "dialog",
  },
  P28: {
    symptom:
      "In an environment where RC can never be established, the launch itself stops",
    mechanism:
      "Where `/rc failed` is returned or the network is down, `/rc connecting` never disappears",
    defence:
      "Give the rc stage its own budget and fail open beyond it into the send phase",
    stage: "rc",
  },
  P29: {
    symptom:
      "A pane whose turn is over never goes idle, so the gate burns the whole budget and the send never happens",
    mechanism:
      "From manifest 2026.08.21.1 herdr classifies a leftover run_in_background shell as working (background_shell_working, priority 965, above live_prompt_box at 950). Upstream calls it intended, so it will not change",
    defence:
      "Slice the idle wait, read agent explain on every slice that times out, and treat it as idle when the matched rule is background work and the prompt box is readable. Being the matched rule is itself the evidence that every higher-priority working rule (claude's own OSC title spinner included) said otherwise",
    stage: "idle (launch / self-send)",
  },
  P30: {
    symptom:
      "An /exit stops in front of a confirmation dialog, and the pane stays blocked, holding its lane",
    mechanism:
      "With a background shell still alive, recent claude versions answer /exit with a confirmation dialog. Its footer makes herdr classify the pane as blocked, and the next round of box-clear verification reads the dialog as a foreign residual and leaves the loop at once",
    defence:
      "Only on a round after a terminating command was typed, press Enter once on the conjunction of blocked and the frozen wording, taking the default choice that stops the tasks. Beyond the cap nothing is pressed and it falls back to the existing classification",
    stage: "dialog (send)",
  },
  P31: {
    symptom:
      "On a pane that was already working before the keystroke, a send reports success even though nothing arrived",
    mechanism:
      "`agent wait` returns immediately when the status is already in the --until set at subscription time; there is no mode that waits for a transition. On a pane whose agent_status is working, the working wait therefore holds regardless of what the Enter did",
    defence:
      "When the agent_status captured at the top of the round is working, take the box clearing as the evidence for that round instead of the transition to working. The grace stage after the attempt limit is skipped for the same reason",
    stage: "enter / grace",
  },
} as const satisfies Record<ProblemId, Problem>;
export type RetiredId =
  | "R1"
  | "R2"
  | "R3"
  | "R4"
  | "R5"
  | "R6"
  | "R7"
  | "R8"
  | "R9"
  | "R10";
export const RETIRED = {
  R1: {
    defence:
      "Clean a foreign residual out with Ctrl+C and confirm it is empty before sending",
    reason:
      "The harm of the second Ctrl+C ending the session is easier to confirm in practice than the branch working, and it was asymmetric with the self-send draft guard (which stops without typing). Cleaning is the caller's or a human's call",
  },
  R2: {
    defence:
      "Suppress repeated Ctrl+C with an armed flag, and re-arm on every observation of an empty box",
    reason:
      "Ctrl+C is no longer pressed at all, so there is nothing to suppress",
  },
  R3: {
    defence:
      "Return the box to empty with Ctrl+C after the attempt limit, extended to box-clear verification as well",
    reason:
      "Same as above. A residual is a state to report, not one to fix here",
  },
  R4: {
    defence:
      "Name resolution carried inside the send and launch paths, deciding the destination as it went",
    reason:
      "Resolution happens once, at the CLI entry point: --agent-name is folded into a canonical pane id by a single agent get before anything is typed, and every layer below it holds a pane id only. What is left inside the paths is liveness plus reading agent_status and the agent label",
  },
  R5: {
    defence: "An identity check against an expected agent name",
    reason:
      "Never introduced. A closed pane id is never reused, a launch creates its own tab, and self-send targets its own pane. The only route that could type at a different agent is a human firing by hand, and they are looking at the pane while they do it",
  },
  R6: {
    defence: "Pushing a pane title",
    reason:
      "Returned to the layer that owns creating and destroying the pane as one unit",
  },
  R7: {
    defence: "Injecting startup argv",
    reason:
      "Policy is carried by the caller's argv. This layer passes everything after -- through verbatim",
  },
  R8: {
    defence: "Auto-starting the herdr server",
    reason:
      "Process lifecycle management is outside this layer. Liveness is returned as three values and the caller decides whether to continue",
  },
  R9: {
    defence: "A face for tearing down (a liveness listing and closing a tab)",
    reason:
      "Moved to the shape where the layer that created the tab is also the layer that closes it",
  },
  R10: {
    defence: "An upper bound for the box going empty after Ctrl+C",
    reason:
      "A dead leftover whose readers disappeared with R1 / R3. Removed together with its type",
  },
} as const satisfies Record<
  RetiredId,
  {
    defence: string;
    reason: string;
  }
>;
export type Stage = {
  id: StageId;
  name: string;
  kind: StageKind;
  observes: readonly Observes[];
  predicate: string;
  maxAttempts: string;
  interval: string;
  timeout: string;
  onLimit: string;
  advice: string;
  defends: readonly ProblemId[];
};
export const LAUNCH_STAGES = [
  {
    id: "probe",
    name: "herdr-server-up",
    kind: "gate",
    observes: ["herdr-cli"],
    predicate:
      "`agent list` exits 0. A non-zero exit whose error code is protocol_mismatch is a separate value",
    maxAttempts: "1",
    interval: NONE,
    timeout: NONE,
    onLimit: "fail-closed: server-down / server-protocol-mismatch",
    advice:
      "Nothing was created and nothing was typed. Start the server (server-down), or stop the old one and bring it back up (server-protocol-mismatch), then fire again",
    defends: ["P14"],
  },
  {
    id: "tab",
    name: "herdr-tab-created",
    kind: "act",
    observes: ["herdr-cli"],
    predicate:
      "`tab create --cwd --label --no-focus` returns a tab_id and the root pane's pane_id",
    maxAttempts: "1",
    interval: NONE,
    timeout: NONE,
    onLimit: "fail-closed: tab-create-failed",
    advice:
      "The server could not create a tab; suspect fd exhaustion from tabs of finished sessions. Raising the ceiling and sweeping them are the server owner's call",
    defends: ["P12", "P19"],
  },
  {
    id: "shell",
    name: "shell-ready",
    kind: "act+verify",
    observes: ["claude-screen"],
    predicate:
      "types `echo h2cv''-shell-ready-<nonce>` and h2cv-shell-ready-<nonce> appears on the visible frame",
    maxAttempts: WITHIN_BUDGET,
    interval: budget("shellProbeWaitMs"),
    timeout: budget("shellReadyTimeoutMs"),
    onLimit:
      "fail-closed: start-failed (stderr starts with shell-not-ready, and probeCount / paneTail are attached)",
    advice:
      "The start was never typed. The pane never reached its prompt, so read paneTail and suspect the rc; the tab is the caller's to reclaim",
    defends: ["P13"],
  },
  {
    id: "start",
    name: "herdr-agent-started",
    kind: "act+verify",
    observes: ["herdr-cli"],
    predicate: `\`agent start <name> --kind claude --pane <id> --timeout ${AGENT_START_TIMEOUT_MS} -- <argv>\` exits 0`,
    maxAttempts: `${AGENT_START_RETRIES} for agent_pane_busy only`,
    interval: budget("AGENT_START_RETRY_MS"),
    timeout: NONE,
    onLimit:
      "fail-closed: start-failed. agent_not_ready is fail-open: a start / fail-open row in the trace",
    advice:
      "Read the upstream message in stderr. An invalid argv or an invalid agent name lands here, and neither is fixed by firing again unchanged",
    defends: ["P15", "P16", "P17"],
  },
  {
    id: "agent",
    name: "herdr-agent-recognized",
    kind: "gate",
    observes: ["herdr-agent-status"],
    predicate:
      "`agent get <pane>` returns, and the pane_id it carries is the one that was started into",
    maxAttempts: WITHIN_BUDGET,
    interval: budget("readinessPanePollMs"),
    timeout: budget("inputReadyTimeoutMs"),
    onLimit:
      "fail-closed: agent-vanished (agent get returns nothing) / launch-timeout (the budget ran out)",
    advice:
      "The agent that had been started is gone from herdr. Nothing was typed, so it is safe to fire again after reclaiming the tab",
    defends: [],
  },
  {
    id: "idle",
    name: "herdr-agent-idle",
    kind: "gate",
    observes: ["herdr-agent-status", "claude-screen"],
    predicate:
      "`agent wait --until idle --until done --until blocked` exits 0 (primary), fired in slices. On a slice that times out, an `agent explain` whose matched rule is background work plus a readable prompt box also passes (fallback)",
    maxAttempts: WITHIN_BUDGET,
    interval: budget("idleProbeSliceMs"),
    timeout: budget("inputReadyTimeoutMs"),
    onLimit: "fail-closed: launch-timeout",
    advice:
      "agent_status never settled before the budget ran out, or the screen classification could not be read at all. Nothing was typed. Check that the pane is alive, then fire again. A background-work row means the gate passed on the fallback",
    defends: ["P18", "P29"],
  },
  {
    id: "dialog",
    name: "claude-first-run-dialog-dismissed",
    kind: "act+verify",
    observes: ["herdr-agent-status", "claude-screen"],
    predicate:
      "agent_status is not blocked (primary) and the frozen dialog wording is absent from the visible frame (fallback). If false, press Enter",
    maxAttempts: `${INTERSTITIAL_MAX_ENTERS}`,
    interval: budget("interstitialSettleMs"),
    timeout: budget("inputReadyTimeoutMs"),
    onLimit:
      "fail-open: defer to the next gates (what was observed stays in the trace as a dialog row)",
    advice:
      "The dialog does not clear on Enter, or it is classified as neither blocked nor a frozen value. Escalate to a human and compare detection against the real screen",
    defends: ["P5", "P27"],
  },
  {
    id: "box",
    name: "claude-box-drawn",
    kind: "gate",
    observes: ["claude-screen"],
    predicate: "readBoxBody(pane) is not null",
    maxAttempts: WITHIN_BUDGET,
    interval: budget("inputReadyPollMs"),
    timeout: budget("inputReadyTimeoutMs"),
    onLimit: "fail-closed: launch-timeout",
    advice:
      "The input box border was never drawn before the budget ran out. Nothing was typed. Raise the budget, then fire again",
    defends: ["P2", "P25"],
  },
  {
    id: "rc",
    name: "claude-remote-control-connected",
    kind: "gate",
    observes: ["claude-screen"],
    predicate: "`/rc connecting` is absent from the visible frame",
    maxAttempts: WITHIN_BUDGET,
    interval: budget("inputReadyPollMs"),
    timeout: budget("rcConnectTimeoutMs"),
    onLimit: "fail-open: an rc / fail-open row in the trace",
    advice:
      "Remote Control could not be established in time, and the send phase was entered anyway. If the send then fails, suspect the keystrokes being dropped",
    defends: ["P6", "P28"],
  },
] as const satisfies readonly Stage[];
export const INPUT_READY_STAGE_IDS = [
  "idle",
  "dialog",
  "box",
  "rc",
] as const satisfies readonly StageId[];
export const SEND_STAGES = [
  {
    id: "alive",
    name: "herdr-agent-alive",
    kind: "gate",
    observes: ["herdr-agent-status"],
    predicate:
      "`agent get` returns and carries a pane_id. agent_status and the agent label are captured in the same read",
    maxAttempts: "1 per attempt",
    interval: NONE,
    timeout: NONE,
    onLimit: "fail-closed: agent-vanished (aborts without typing anything)",
    advice:
      "The target could not be resolved and nothing was ever typed. Clean up the lane and fire again",
    defends: ["P4", "P22"],
  },
  {
    id: "dialog",
    name: "claude-exit-dialog-confirmed",
    kind: "act+verify",
    observes: ["herdr-agent-status", "claude-screen"],
    predicate:
      "on a round after a terminating command was typed, agent_status is blocked (primary) and the frozen exit-dialog wording is on the visible frame (conjunction). If both hold, press Enter once, taking the default choice that stops the background tasks, then wait for claude to leave the terminal",
    maxAttempts: `${EXIT_DIALOG_MAX_ENTERS}`,
    interval: budget("inputReadyPollMs"),
    timeout: budget("exitDialogGoneTimeoutMs"),
    onLimit:
      "fail-open: nothing is pressed and the round falls to the box stage's foreign branch",
    advice:
      "Only evaluated for terminating commands. A dialog row followed by evidence herdr-agent-gone means the confirmation was answered; a round that reaches the foreign branch instead means either the wording moved or something other than the exit dialog is blocking the pane",
    defends: ["P30", "P27"],
  },
  {
    id: "box",
    name: "claude-box-drawn",
    kind: "gate",
    observes: ["claude-screen"],
    predicate:
      "readBoxBody(pane) is not null. The value that was read branches four ways (empty / your own body / a foreign body / undecidable)",
    maxAttempts: WITHIN_BUDGET,
    interval: budget("pollIntervalMs"),
    timeout: budget("boxReadyTimeoutMs"),
    onLimit:
      "next attempt (result timeout). A foreign body leaves the loop immediately with result foreign",
    advice:
      "Nothing was typed on that round. A foreign body is reported in boxBody / paneTail / detection, and emptying the box is the caller's or a human's call",
    defends: ["P7", "P8", "P25"],
  },
  {
    id: "type",
    name: "claude-box-landed",
    kind: "act+verify",
    observes: ["claude-screen"],
    predicate:
      "`pane send-text` types the body and readBoxBody comes back non-empty",
    maxAttempts: WITHIN_BUDGET,
    interval: budget("pollIntervalMs"),
    timeout: budget("landingTimeoutMs"),
    onLimit:
      "next attempt (result timeout). The next round retypes only after a read-back showing the box is empty, so nothing gets concatenated",
    advice:
      "The body was typed but its landing could not be read back. Nothing was submitted",
    defends: ["P3"],
  },
  {
    id: "enter",
    name: "claude-submitted",
    kind: "act+verify",
    observes: ["herdr-agent-status", "claude-screen"],
    predicate:
      "`agent send-keys <pane> Enter` is pressed and the evidence chosen by verify holds. verify is picked per round, from the body and from the agent_status captured by that round's alive stage",
    maxAttempts: WITHIN_BUDGET,
    interval: budget("pollIntervalMs"),
    timeout: `per predicate (${budget("SEND_VERIFY_TIMEOUT_MS")} for herdr-agent-working, ${budget("landingTimeoutMs")} for claude-box-cleared)`,
    onLimit: "next attempt (result timeout)",
    advice:
      "Enter was pressed but the evidence never held. Read sendVerdict: re-firing is dangerous unless it says not-delivered",
    defends: ["P1", "P22", "P23", "P24", "P31"],
  },
  {
    id: "grace",
    name: "submit-grace",
    kind: "gate",
    observes: ["herdr-agent-status"],
    predicate:
      "after the attempt limit, `agent wait --until working` succeeds within the grace period. Skipped when the last round captured working at its top",
    maxAttempts: "1",
    interval: NONE,
    timeout: budget("SEND_GRACE_MS"),
    onLimit:
      "fail-open: if it holds the verdict is submitted-late, otherwise the terminal snapshot is taken",
    advice:
      "Only entered when verify is herdr-agent-working. A result of ok means the child started moving late, so do not re-fire. No grace row at all means the wait would have returned on the status the pane already held, so it was not worth ten seconds",
    defends: ["P11", "P31"],
  },
] as const satisfies readonly Stage[];
export const SELF_SEND_STAGES = [
  {
    id: "arm",
    name: "self-send-armed",
    kind: "act",
    observes: ["none"],
    predicate: "re-invokes itself detached with the internal watch flag",
    maxAttempts: "1",
    interval: NONE,
    timeout: NONE,
    onLimit:
      "fail-closed: usage (no pane in the environment, or the body is not a slash command)",
    advice:
      "Nothing was typed and no watcher was started. Fix the argument, or run it from inside a pane",
    defends: ["P20"],
  },
  {
    id: "idle",
    name: "herdr-agent-idle",
    kind: "gate",
    observes: ["herdr-agent-status", "claude-screen"],
    predicate:
      "`agent wait --until idle --until done` exits 0 (primary), fired in slices. blocked is not waited on, because on an existing pane it means a human is being waited on. On a slice that times out, an `agent explain` whose matched rule is background work plus a readable prompt box also passes (fallback)",
    maxAttempts: "1 per slice",
    interval: budget("idleProbeSliceMs"),
    timeout: budget("SELF_SEND_IDLE_TIMEOUT_MS"),
    onLimit: "fail-closed: not-ready",
    advice:
      "Nothing was typed. An elapsedMs far below the budget means the target could not be resolved or its screen classification could not be read; close to the budget means the caller's own turn never finished",
    defends: ["P20", "P29"],
  },
  {
    id: "draft",
    name: "claude-box-empty",
    kind: "gate",
    observes: ["claude-screen"],
    predicate: "readBoxBody(pane) is exactly empty. null does not hold either",
    maxAttempts: "1",
    interval: NONE,
    timeout: NONE,
    onLimit:
      "fail-closed: not-ready (the value that was read is put into boxBody)",
    advice:
      "Nothing was typed. This closes the path that would submit the draft along with the command, so a human has to empty the input box before sending again",
    defends: ["P21"],
  },
] as const satisfies readonly Stage[];
export const TRACE_RESULTS = {
  ok: {
    meaning: "the predicate held",
    stages: "every stage",
  },
  timeout: {
    meaning: "it did not hold within the budget",
    stages: "every stage that has a timeout",
  },
  foreign: {
    meaning: "the box held a body that was not the one being sent",
    stages: "box (send)",
  },
  gone: {
    meaning: "the target disappeared",
    stages: "alive (send) / agent (launch)",
  },
  "fail-open": {
    meaning: "the limit was reached but the next stage was entered anyway",
    stages: "dialog / rc / start (agent_not_ready)",
  },
  "background-work": {
    meaning:
      "the predicate did not hold, but agent explain showed the only thing keeping the agent at working was background work, so the next stage was entered",
    stages: "idle (launch / self-send)",
  },
} as const satisfies Record<
  TraceResult,
  {
    meaning: string;
    stages: string;
  }
>;
export const ALL_STAGES: readonly Stage[] = [
  ...LAUNCH_STAGES,
  ...SEND_STAGES,
  ...SELF_SEND_STAGES,
];
