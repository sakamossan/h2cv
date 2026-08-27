import type { SendEvidence, SendVerdict, SendVerify } from "./sender.js";
import type { Stage } from "./stages.js";
import {
  INPUT_READY_STAGE_IDS,
  LAUNCH_STAGES,
  PROBLEMS,
  RETIRED,
  SELF_SEND_STAGES,
  SEND_STAGES,
  TRACE_RESULTS,
} from "./stages.js";

export type ErrorCode =
  | "usage"
  | "agent-vanished"
  | "send-unverified"
  | "not-ready"
  | "server-down"
  | "server-protocol-mismatch"
  | "tab-create-failed"
  | "start-failed"
  | "launch-timeout";
export type Topic =
  | "overview"
  | "failure-modes"
  | "output-contract"
  | "launch-sequence"
  | "input-ready"
  | "herdr-agent-alive"
  | "send-protocol"
  | "self-send";
export const ERROR_TOPIC = {
  usage: "output-contract",
  "agent-vanished": "herdr-agent-alive",
  "send-unverified": "send-protocol",
  "not-ready": "input-ready",
  "server-down": "launch-sequence",
  "server-protocol-mismatch": "launch-sequence",
  "tab-create-failed": "launch-sequence",
  "start-failed": "launch-sequence",
  "launch-timeout": "input-ready",
} as const satisfies Record<ErrorCode, Topic>;
export const VERIFY_ADVICE = {
  "herdr-agent-working": {
    condition:
      "a body that starts a turn (plain text / a skill invocation), on a round whose agent_status was not already working. Waits for the positive signal of a transition to working",
    advice:
      "the grace stage is only entered on this side, so a late submit can still be picked up",
  },
  "claude-box-cleared": {
    condition:
      "a command that starts no turn (/clear / /rename / /exit / /quit), or any body on a round that was already working before the keystroke. Watches for the command disappearing from the box",
    advice:
      "there is no positive signal, so an empty terminal box is itself the evidence. No grace stage is entered",
  },
} as const satisfies Record<
  SendVerify,
  {
    condition: string;
    advice: string;
  }
>;
export const SEND_VERDICT_ADVICE = {
  "not-delivered": {
    condition: "there is no enter row in the trace; the body never arrived",
    advice: "safe to re-fire",
  },
  "landed-not-submitted": {
    condition: "your own body is still in the terminal box",
    advice:
      "the body arrived but was not submitted. Nothing was cleaned up (this layer never presses Ctrl+C), so empty the box before re-firing. Exception: a command that starts no turn fired while the child is working leaves the box occupied by the child's own turn, so the residual is expected and the keystrokes are queued to take effect when the turn ends. Confirm with an agent get (done / gone) before re-firing or killing",
  },
  "submitted-late": {
    condition:
      "the evidence held during the grace stage or at the terminal read",
    advice: "do not re-fire (the child has already started moving)",
  },
  "submitted-unconfirmed": {
    condition:
      "Enter was pressed but the evidence never held, and the terminal box is either empty or holds a body that is not yours",
    advice: "it may have been accepted. Re-firing is dangerous",
  },
  unreadable: {
    condition: "the terminal box cannot be read",
    advice: "undecidable. Escalate to a human",
  },
} as const satisfies Record<
  SendVerdict,
  {
    condition: string;
    advice: string;
  }
>;
export const EVIDENCE_ADVICE = {
  "herdr-agent-working": {
    condition: "agent_status moved to working after the keystroke",
    advice: "submit confirmed. The child has started its turn",
  },
  "claude-box-cleared": {
    condition: "the command disappeared from the box after the keystroke",
    advice:
      "submit confirmed. claude is still alive. A body that starts a turn lands here when the pane was already working before the keystroke, because a working wait would have returned on the status it already held",
  },
  "herdr-agent-gone": {
    condition: "claude left the terminal after the keystroke",
    advice:
      "terminating commands (/exit / /quit) only. Covers both a closed pane and a shell respawn, and is also where a confirmed exit dialog lands",
  },
} as const satisfies Record<
  SendEvidence,
  {
    condition: string;
    advice: string;
  }
>;
export const PROVENANCE = {
  target: {
    origin: "herdr",
    upstream:
      "pane_id (the canonical pane id the destination flags resolved to, the only value this layer carries)",
    handoff: "yes — herdr agent get <target> / herdr pane read <target>",
  },
  pane: {
    origin: "herdr",
    upstream: "pane_id",
    handoff: "yes — herdr pane read <pane> (also accepted as a target)",
  },
  agentName: {
    origin: "herdr",
    upstream:
      "the name of herdr agent start <name>; also the tab label of herdr tab create --label when it was given rather than derived",
    handoff:
      "yes while claude is alive; the binding is released the moment claude exits",
  },
  lastAgentStatus: {
    origin: "herdr",
    upstream: "agent_status, read on the last round of the send",
    handoff: "no — a state value, not a handle",
  },
  paneTail: {
    origin: "herdr",
    upstream:
      "the output of a screen read (agent read / pane read --source recent)",
    handoff: "no — output text",
  },
  "detection (state / region / manifestVersion / rules)": {
    origin: "herdr",
    upstream: "a summary of agent explain --json",
    handoff: "no — output text",
  },
  stderr: {
    origin: "herdr",
    upstream: "the stderr of the herdr command that failed",
    handoff: "no — output text",
  },
  prompt: {
    origin: "claude",
    upstream: "the body typed into claude's input box",
    handoff: "no",
  },
  boxBody: {
    origin: "claude",
    upstream: "the contents of the claude Code TUI input box",
    handoff: "no",
  },
  "ok / error / hint / recovery / detail / message": {
    origin: "h2cv",
    upstream: "—",
    handoff: "no",
  },
  stage: {
    origin: "h2cv",
    upstream: "—",
    handoff: "no — the short id of the stage the run stopped in",
  },
  "sendVerdict / verify / evidence / armed / promptSent": {
    origin: "h2cv",
    upstream: "—",
    handoff: "no",
  },
  "attempts / probeCount / trace (attempt / stage / ms / result)": {
    origin: "h2cv",
    upstream: "—",
    handoff: "no",
  },
  "readyMs / elapsedMs / timeoutMs": {
    origin: "h2cv",
    upstream: "—",
    handoff: "no",
  },
} as const satisfies Record<
  string,
  {
    origin: string;
    upstream: string;
    handoff: string;
  }
>;
export type TableRow = Record<string, string>;
export type Tables = Record<string, TableRow[]>;
function toRows(
  keyColumn: string,
  advice: Record<string, Record<string, string>>,
): TableRow[] {
  return Object.entries(advice).map(([key, cells]) => ({
    [keyColumn]: key,
    ...cells,
  }));
}
function stageRows(stages: readonly Stage[]): TableRow[] {
  return stages.map((s) => ({
    stage: s.id,
    name: s.name,
    kind: s.kind,
    observes: s.observes.join(" + "),
    predicate: s.predicate,
    maxAttempts: s.maxAttempts,
    interval: s.interval,
    timeout: s.timeout,
    onLimit: s.onLimit,
    advice: s.advice,
    defends: s.defends.join(" "),
  }));
}
const stagesById = (ids: readonly string[], from: readonly Stage[]) =>
  from.filter((s) => ids.includes(s.id));
const LAUNCH_PIPELINE_STAGES = LAUNCH_STAGES.filter(
  (s) => !INPUT_READY_STAGE_IDS.includes(s.id as never),
);
export const TESTED_WITH = {
  claude: "2.1.246",
  herdr: "0.8.2",
  manifest: "2026.08.21.1",
} as const;
export const TOPICS: Record<
  Topic,
  {
    summary: string;
    body: string[];
    tables?: Tables;
  }
> = {
  overview: {
    summary:
      "A reliability layer that starts a claude session over herdr and hands it an instruction. It never promises delivery; it verifies what happened and classifies it",
    body: [
      "The name is a coordinate, not a brand: h2c is the seam between herdr and claude, v is",
      "verifiably. This layer promises no delivery. It verifies what happened and classifies it.",
      "",
      "Three areas of responsibility:",
      "- start a session and carry it to the point where it accepts input",
      "  (launch-sequence / input-ready)",
      "- send into an existing pane with read-back verification",
      "  (herdr-agent-alive / send-protocol)",
      "- bridge a failure classification to the decision the caller can take",
      "  (this explain and output-contract)",
      "",
      "Why the layer is needed: bare herdr never confirms that a submit landed. Checking by",
      "read-back of the box whether the completion menu ate the Enter, whether the keystrokes",
      "went out before the TUI finished initializing, whether the body stayed in the box —",
      "then retrying, and on failure returning a machine-readable classification",
      "(`stage` / `trace` / `sendVerdict`) — is why this package exists. Structurally removing",
      '"typed before initialization" requires owning the startup sequence, so the scope covers',
      "the whole path: launch -> wait for input readiness -> send -> verify.",
      "",
      "It holds no policy. It adds not a single startup argv and only passes through whatever",
      "follows `--`; it has no face for closing a tab it opened, no retry counter, no state file.",
      '"When, at whom, and how many times to fire" is the caller\'s decision; what lives here is',
      "only what happened as a result of firing.",
      "",
      "Two couplings:",
      "- herdr (transport) — abstracted behind two narrow ports (`HerdrSendPort` for sending,",
      "  `HerdrLaunchPort` for launching), but the adapter (the exec glue over the herdr CLI) is",
      "  bundled, so in practice it is fixed. The ports are not an abstraction sold as a swap",
      '  layer; they are an inventory of "which side depends on what part of herdr" plus a test',
      "  injection point. herdr itself is only exec'd as an external command, never bundled or",
      "  redistributed",
      "- claude TUI (protocol) — frozen values such as the box border structure, the completion",
      "  menu eating Enter, the `/rc` status label, the dim placeholder and the first-run dialog",
      "  wording are hardcoded. They are not abstracted",
      "",
      `tested-with: claude ${TESTED_WITH.claude} / herdr ${TESTED_WITH.herdr} (agent detection manifest ${TESTED_WITH.manifest}). The frozen`,
      "values (first-run dialog wording, `/rc` label, box borders, the drawing convention for the",
      "dim placeholder) were copied from the binaries and live dumps of those versions, so a new",
      "claude version needs a follow-up. Version drift is handled as fail-open plus an observation",
      "(`detection`); it never stops the launch itself.",
      "",
      "herdr's agent detection manifest moves independently of the binary and does not stop",
      "changing when the version is pinned (it is updated as a remote cache). If the way",
      "`detection` reads seems to have changed, suspect the manifest version first.",
      "",
      "See also: h2cv explain failure-modes (the index of the accident modes that actually",
      "happened, the defence against each, and the stage it lives in)",
    ],
  },
  "failure-modes": {
    summary:
      "The index of what this layer defends against: every problem that actually happened in production, the mechanism behind it, the defence, and the stage the defence lives in",
    body: [
      "Read this table against the stage tables in the other topics. The stage column names the",
      "stage that holds the defence, and every stage table carries a defends column pointing",
      "back here, so the two directions of the index stay in step.",
      "",
      "Not every entry lives in a single stage, and the stage column says so in its own words.",
      "Some are cross-cutting hygiene that every screen-reading stage sits on (read only the",
      "visible frame; read as ansi, drop the dim placeholder, compare with all whitespace",
      "stripped); others name a pair of stages, the shape shared by every gate stage, or the",
      "terminal, where the run is classified rather than acted on.",
      "",
      "The second table is the defences that were removed. They are kept so that the history can",
      "be looked up when someone proposes reintroducing one.",
      "",
      "Ctrl+C appears in both tables and it is worth being explicit about which side it is on:",
      "this layer never presses it. A foreign body in the input box stops the send and gets",
      "reported; emptying the box is the caller's or a human's call.",
    ],
    tables: {
      problems: toRows("problem", PROBLEMS),
      retired: toRows("retired", RETIRED),
    },
  },
  "output-contract": {
    summary:
      "stdout is always exactly one pretty JSON document, stderr is one human-facing line. --help is no exception",
    body: [
      "Declaration: both the caller and the destination are Claude Code. That the destination is",
      "the claude TUI is obvious, but this package was not built for a human to type by hand",
      "either. It is plumbing for one AI agent to hand an instruction to another; both ends are",
      "LLMs, and only this middle has to be deterministic. Operationally humans do read the",
      "output (debugging, incident forensics), so there are affordances for them — but never at",
      "the cost of stdout's machine readability.",
      "",
      "That stance already shapes the implementation in several places (trace rows carry short",
      "stage ids rather than the full words used in the top-level fields, so that a run of many",
      "stages still reads compactly to the parent, which is an LLM).",
      "",
      "Invariants:",
      "- success, failure, argument error, --help alike: stdout is always exactly one pretty JSON",
      "  document (2-space indent). Warnings, progress and diagnostics never mix into stdout",
      "- a failure JSON carries a code in error, and hint (h2cv explain <topic>) is attached",
      "  automatically by fail(). There is a single choke point so that forgetting it is",
      "  structurally impossible",
      "- stderr is a one-line human-facing summary. The caller can reach every decision from",
      "  stdout alone, without reading stderr at all",
      "- non-interactive and TTY-independent. No colors, no spinners, no confirmation prompts,",
      "  and it never waits on stdin",
      "",
      'Why: the contract is really "the caller writes one rule, JSON.parse the stdout". No route',
      "should force them to also read prose on stderr or a Node stack trace. The formatting is",
      "pretty so that a human can read it without piping through jq (single-line compact only",
      "matters once the output becomes an NDJSON stream, which does not apply where one run is",
      "one document).",
      "",
      "usage means the wrong face was used (unknown subcommand / missing argument / malformed",
      "--timeout / unknown flag). The recovery field carries the way out (look it up again with",
      "--help) while hint points at explain as the learning path. They are different things, so",
      "they are not folded into one field. --help returns the command catalog as structured data",
      "with exit 0 and is caught after the subcommand is resolved but before the real work",
      "starts, so there is no route where a --help turns into a send or another side effect.",
      "",
      "On failure the things a human actually wants — boxBody / paneTail — are multi-line text",
      "escaped to \\n inside a JSON string, so even pretty-printed they stay one long line. The",
      "one-line stderr summary is the entry point; read the dump itself with `| jq -r .paneTail`.",
      "The screen classification (detection) is treated the same way.",
      "",
      "This explain is bound by the same contract. That is why the body is an array of lines",
      "rather than a multi-line string, and why the decision tables stay structured data (tables)",
      "instead of being flattened into prose.",
      "",
      "Field names follow their provenance, which the table below carries per field. A value",
      "copied from upstream keeps the upstream spelling — verbatim for claude, snake_case to",
      "camelCase only for herdr — so a key you recognise from `claude agents --json` or",
      "`herdr agent get` names the same thing here, and the names this layer invented for itself",
      "avoid the words the two upstreams already use for something else.",
      "",
      "The handoff column is deliberately not encoded in the names: a short key is worth something",
      'too, and spending a prefix on every key to say "this one is a handle" does not pay for',
      "itself. Read it before reaching for herdr yourself — half of these values save you a",
      "lookup, and the other half fail as arguments.",
    ],
    tables: { provenance: toRows("field", PROVENANCE) },
  },
  "launch-sequence": {
    summary:
      "Startup is a pipeline of named stages with no branches: probe -> tab -> shell -> start -> agent -> the input-ready stages -> send. The destination is an exclusive choice between a cwd (which creates a dedicated tab) and an existing pane, and either way a probe handshake confirms the shell reached its prompt before the start is typed. There is no face for tearing down (closing what it started belongs to the layer that owns the resources)",
    body: [
      "Spec: source of truth is AgentLauncher in launcher.ts. Before the question of when it is",
      "safe to type comes the question of starting the session at all. The order is fixed so",
      "there is no room to slip a decision in between, and wrapping it in a server liveness probe",
      "in front and a send behind gives `h2cv launch` (source of truth: runLaunch in launch.ts).",
      "",
      "The stage table below is that pipeline as far as the session being recognised; the four",
      "stages that follow it are the input-ready column and have their own topic and their own",
      "table. Every failure JSON carries the stage it stopped in as `stage`, independently of the",
      "error code — the two are different axes, and the onLimit column is where they meet (two",
      "stages share start-failed, and one stage can produce two codes).",
      "",
      "Every stage that ran also leaves a row in `trace` — the same array the send stages write",
      "into, with launch rows carrying no attempt number. That is where a fail-open shows up: the",
      "agent_not_ready pass-through is a start row with result fail-open, and the RC budget",
      "running out is an rc row with result fail-open. Neither is a top-level boolean any more.",
      "",
      "A start is always fresh. There is no face for observing whether an existing session is",
      "live, and no decision about closing it or firing at it again; all this does is start one.",
      "When prompt is empty (including omitted) the send stages are skipped and it completes with",
      "the start alone, with promptSent false in the success JSON — that covers the usage where",
      "you start a session and a human hands it the instruction later.",
      "",
      "The probe handshake is not made redundant by 0.8.2's readiness wait. What upstream added",
      "there is a 2-second retry over the window where a new pane falls to agent_pane_busy; it",
      "still looks at process state and does not address a keystroke being eaten by a bash that is",
      "running its rc. Measured on 0.8.2, tab creation to the probe's read-back still takes a",
      "median of 720 ms (12 runs, a real worktree cwd with a .envrc), so the window is still",
      "there. probeCount >= 2 did not occur in those 12 runs, which is not proof the retry is",
      'unnecessary — being eaten is timing-dependent, so "it did not reproduce" is not taken as',
      "evidence of safety. Past the pre-gate there is no re-fire policy either: the window between",
      "the handshake and the keystroke is essentially zero, and stacking further insurance on top",
      "of that is not a reliability layer's job.",
      "",
      "Four things this layer refuses to hold, because holding them would take a decision away",
      "from the caller:",
      "- There is no startup policy. start() only passes through the argv after --, and whether to",
      "  add --dangerously-skip-permissions / --remote-control / --model is the caller's decision.",
      "  The one-command version (h2cv launch) likewise adds not a single argv and only passes",
      "  through whatever follows --. Likewise, what to do when a session of the same name is",
      "  already live (fire at it again / close it and start over) is the caller's decision, and",
      "  this layer does not even observe it",
      "- The agent name is optional, and it is only needed because agent start takes a name as a",
      "  required positional. Omit --agent-name and h2cv derives h2cv-w<N>-p<M> from the pane it",
      "  is starting into; the name that was used comes back as agentName either way. Given, it",
      "  is also the tab label on the --cwd path (omitted, that label is the basename of --cwd)",
      "- A name that was given is validated at the CLI entry point (`h2cv launch`). Upstream",
      "  accepts [a-z0-9_-] starting with a lowercase letter, at most 32 characters (the source is",
      "  herdr's valid_agent_name); passing a violation through would get as far as the start stage",
      "  before failing with invalid_agent_name, leaving the created tab behind as debris. It is",
      "  classified as usage (an argument error) — the caller's decision is \"fix the name and fire",
      '  again", the same as for an unknown flag. The library face (runLaunch) holds no',
      "  validation: a user calling it directly gets upstream's invalid_agent_name as the stderr",
      "  of start-failed, which is enough to decide from",
      "- The launcher holds no state, neither the destination nor the name. Keeping the target is",
      "  the user's responsibility, and there is exactly one point to obtain it: the success JSON",
      "  of the launch",
      "",
      "There is no face for tearing down. The layer that created the tab should also be the layer",
      "that closes it, and that layer is not here but the caller that owns creating and destroying",
      "resources as one unit (upstream does not close the tab when the agent exits and has no",
      "auto-close option, so somebody does have to).",
      "",
      "The waits in the startup sequence sit on the same injection point as the send path",
      "(SessionTimings in timings.ts); no bare numeric literals are left. The overall budget for",
      "the input-ready stages is inputReadyTimeoutMs, and it is on that same injection point even",
      "though it is also a public value returned to the caller (it appears in the JSON as",
      "launch-timeout's timeoutMs) — it is one stage attribute, so it gets one definition. agent",
      "start's --timeout is pinned to that same budget, but that one is a frozen value matched to",
      "the upstream ceiling.",
      "",
      "The herdr server itself is not started. A cold ssh has no resident server and the CLI does",
      'not autostart one, but starting it lies outside "start a session and get a string into the',
      'input box" (it is process lifecycle management), so this layer only probes for liveness and',
      "fails with server-down when it is absent, with zero side effects on either path.",
      "",
      "See also: h2cv explain input-ready (once it is up, when it is safe to type) /",
      "          h2cv launch (--cwd <dir> | --pane <paneId>) [--agent-name <name>] [--prompt <text>] [-- <argv...>]",
    ],
    tables: { stage: stageRows(LAUNCH_PIPELINE_STAGES) },
  },
  "input-ready": {
    summary:
      "Never treat idle as sufficient. Pass four stages in order: idle -> dialog -> box -> rc",
    body: [
      "Spec: source of truth is inputReadyGate in sender.ts and the stage registry in stages.ts.",
      "herdr's agent_status == idle guarantees nothing beyond \"the claude process is up and is not",
      'processing anything". It cannot tell an idle right after startup, with the TUI not yet',
      "initialized, from an idle that finished initializing and is waiting for input; and since",
      "herdr's events.wait returns immediately when the status already matches at subscription",
      "time, waiting with --status idle passes while the TUI is still drawing (measured from the",
      "first-run dialog being cleared: idle at +563 ms, the box border at +1817 ms,",
      "`/rc connecting` gone at +3412 ms). The send retry budget then burns down inside that",
      "window.",
      "",
      "Invariant: after idle, pass the remaining stages before entering the send phase. The four",
      "of them are called the input-ready stages, and the table below is the whole of it. The",
      "name carries no prefix on purpose: the first stage reads herdr's status and the other",
      "three read claude's screen, so claiming either prefix for the whole would misfile one of",
      "them.",
      "",
      "Dialog detection is primarily herdr's agent_status == blocked, with the frozen values",
      "(INTERSTITIAL_RE) kept as a fallback for dialogs that stay classified as idle. Measured on",
      `claude ${TESTED_WITH.claude} / herdr ${TESTED_WITH.herdr} (manifest ${TESTED_WITH.manifest}), two of the three`,
      "first-run dialogs — workspace trust and the single-MCP one — report blocked (their footer",
      "`Enter to confirm · Esc to cancel` matches the live_blocked_form rule) and agent start",
      "returns agent_not_ready for them. The multi-MCP one stays idle with matched_rule null,",
      "because its footer reads `Space to select · Enter to confirm · Esc to reject all` and the",
      "rule requires `esc to cancel`; blocked alone would never clear it, which is why the frozen",
      "values stay.",
      "",
      "The idle stage is not a single long wait. It is fired in slices of idleProbeSliceMs, and",
      "every slice that times out is followed by one agent explain. When the matched rule is one",
      "of the background-work rules (BACKGROUND_WORK_RULE_IDS in sender.ts, today just",
      "background_shell_working) and the prompt box is readable, the stage passes anyway and the",
      "trace carries a background-work row. Upstream says working; the pane accepts input all the",
      "same. Since manifest 2026.08.21.1 a leftover run_in_background shell keeps agent_status at",
      "working forever (priority 965, above the idle live_prompt_box at 950), and upstream calls",
      "that intended, so without this the gate burns its whole budget",
      "on a pane whose turn ended minutes ago. Being the matched rule is the evidence that",
      "matters: everything above it, claude's own OSC title spinner (osc_title_working, 1100)",
      "included, said not-working, and claude puts that title back to idle as soon as the turn",
      "ends. That is also why background_agents_working is not in the set — measured on",
      "2026-08-25 it does match, but the same screen carries the spinner title, so the matched",
      "rule is osc_title_working and a live turn cannot be told apart from it.",
      "",
      "If agent explain cannot be read at all, the wait is folded rather than continued: a",
      "classification that cannot be read leaves no way to judge the way out, and returning the",
      "failure to the caller shows the cause sooner than burning the budget. On a live pane it is",
      "a local read, so null there means the target is gone or the server is down.",
      "",
      "Screen reads target only the currently rendered frame, and each round reads once and",
      "shares that read between the dialog check and the rc check (no extra herdr calls).",
      "Scrollback is not used because the TUI flushes past frames on every redraw (`/rc",
      'connecting`, a dialog already cleared), which makes it unusable for asking "is that string',
      'on screen right now".',
      "",
      '`stage` on not-ready says "where the wait ran out". dialog is reported in',
      "preference to the other stages if it was observed even once — after the Enter limit is",
      "exceeded the loop keeps spinning on box / rc, so reporting whichever stage happened to be",
      "last would erase the cause. Either way the trace holds one row per stage entered, with the",
      "time spent in it, so a stage that quietly ate the budget is readable even when it is not",
      "the one being reported.",
      "",
      "detection is what herdr classified that same screen as at that same instant; read it",
      "against stage. If stage=dialog while every state=blocked rule reports matched=false,",
      "suspect that the frozen values (INTERSTITIAL_RE / herdr's classification definitions) have",
      "drifted with claude's version — comparing rules[].contains against regions[<region>] shows",
      "which wording disagrees with the real screen. The contents of regions are already split",
      "per cell (wide characters break apart with a space between them), so they are for a human",
      "or an LLM to read, not for string matching. Every evaluated rule is included — narrowing",
      'the list would force the caller to reason about "why is this rule missing from this',
      'error". If the shape of the raw response is unexpected, detection is returned as null',
      "wholesale (never fabricate a decision). Only the top-level state / evaluated_rules and",
      "each rule's id are checked strictly; everything else is copied only where the type fits —",
      "if a single added upstream field made detection disappear entirely, its value as forensic",
      "material would be gone.",
      "",
      "Why (the accident this closed): as launch concurrency rose, herdr's agent_status detection",
      "lagged and it increasingly missed the moment claude dips to non-idle during startup. The",
      'launches that had been succeeding were only saved by the accident of "non-idle happened to',
      'be observed, so we ended up waiting a few seconds"; when it is missed, the send starts',
      "inside that same sub-second window and always misses. Over a little more than three hours",
      "there were 7 send-unverified cases, and the longest session occupied a lane doing nothing",
      "for 1 hour 52 minutes.",
      "",
      "The onLimit column names launch-timeout because that is the code on the launch path. Run on",
      "its own (`h2cv wait-input-ready`) the same stages fail as not-ready instead; the codes",
      "differ only so the caller can tell whether a session was started at all. The stages run",
      "exactly once per launch, and there is no second pass before the send.",
      "",
      "See also: h2cv wait-input-ready (--pane <paneId> | --agent-name <name>) [--timeout <ms>] [--detect-interstitial]",
    ],
    tables: {
      stage: stageRows(stagesById(INPUT_READY_STAGE_IDS, LAUNCH_STAGES)),
    },
  },
  "herdr-agent-alive": {
    summary:
      "Carry exactly one canonical pane id around, and use that same value for both agent-level and pane-level operations. Re-read liveness at the top of every attempt",
    body: [
      "Spec: the target is a single kind of value, the canonical pane id (source of truth:",
      "resolve in sender.ts). A closed pane id is never reused and the gap survives a server",
      "restart, so holding one across a wait or a retry can never end up pointing at a different",
      "agent. $HERDR_PANE_ID contains that canonical pane id.",
      "",
      "It is spelled w<N>:p<M>, but neither number is decimal: upstream numbers them in base32",
      "over 123456789ABCDEFGHJKMNPQRSTVWXYZ0 (I, L, O and U are left out to stay unambiguous), so",
      "anything past the ninth pane carries an uppercase letter and reads like w1:p2K. Match it as",
      "a decimal and most of the panes on a busy host are refused at the door.",
      "",
      "The canonical pane id is the only value that travels. A destination is given as exactly",
      "one of --pane <paneId> or --agent-name <name>, and the name is folded into a pane id by a",
      "single agent get at the CLI entry point, before anything is typed; a name that resolves to",
      "nothing fails as agent-vanished right there. The name never goes any further, because its",
      "binding is released the moment claude exits, so it is not a handle you can carry across",
      "waits and retries. The terminal_id shows up in the agent's output but cannot be used as a",
      "destination at all (agent_not_found), and neither can an agent label (claude and friends).",
      "Obtain the pane id yourself with `herdr agent get <name> | jq -r .result.agent.pane_id`, or",
      "read $HERDR_PANE_ID.",
      "",
      "Operations split into agent-level and pane-level, but the value you pass is the same pane",
      "id in both cases.",
      "- agent-level: reading the screen, sending keys (Enter / C-c), waitIdle / waitWorking",
      "- pane-level: sending a body (send-text), atomic body + Enter (run)",
      "",
      'Key sending sits at agent-level because upstream closes the "press Enter into a pane where',
      'claude is not running" route on its own (if the agent is gone it exits non-zero with',
      "agent_not_found).",
      "",
      "Invariant: the pane it types into never comes from an agent get response — it is the value",
      "it was handed, and the pane_id that comes back is only checked against it. Name resolution",
      "is not part of this layer; it happens once, at the entry point, and the one place an agent",
      "name still reaches herdr is `agent start <NAME>`, which takes a name as a required",
      "positional.",
      "",
      "agent-vanished means the target could not be resolved and nothing was ever typed. It is",
      'distinguished at the type level from "not working yet", so no route exists that keeps',
      "typing into the remains of a vanished agent. It covers two stages and `stage` says which",
      "one — alive re-reads liveness at the top of every send attempt, agent waits for a freshly",
      "started agent to be recognised — because the mechanism and the decision are the same on",
      "both.",
      "",
      "Why (the accident this closed): herdr used to have position-based pane_ids, and closing",
      "one shifted the rest up. While the caller was holding such a string across send retries,",
      "the target pane closed and the shift made the same string point at another agent's pane.",
      "Send verification was performed against the agent name, so the broken correspondence went",
      'undetected, and the retry loop that reads "not turning working" as "not sent yet" became',
      "the very thing that misdelivered. The session that received the stray instruction ran it",
      "to completion. Pane ids are stable now, but the conclusion stands: pin the thing you type",
      "into and the thing you read from to the same entity.",
      "",
      "See also: h2cv explain send-protocol (what to type) / input-ready (when to type)",
    ],
    tables: {
      stage: [
        ...stageRows(stagesById(["alive"], SEND_STAGES)),
        ...stageRows(stagesById(["agent"], LAUNCH_STAGES)),
      ],
    },
  },
  "send-protocol": {
    summary:
      "Retype the body only right after a read-back has confirmed the box is empty",
    body: [
      "Spec: source of truth is send in sender.ts and readBoxBody in herdr-adapter.ts. The route",
      'for handing claude an instruction over herdr can do nothing beyond "operate the TUI prompt',
      'box", and both reading and writing that box involve guesswork.',
      "",
      "Reading the box (readBoxBody) reads the currently rendered screen as ansi and returns",
      'string | null. An empty string means "the box is empty"; null means "the box region could',
      'not be located = undecidable"; separating the two is the premise of the protocol. A',
      "non-zero exit (the target disappeared, and so on) also folds to null: the protocol falls to",
      '"type nothing" on null, so no route exists where a disappearance is mistaken for empty and',
      "typed into.",
      "- Never read from scrollback. The TUI flushes old frames on every redraw, so the last",
      "  prompt line found may belong to a frame from before the body was entered",
      "- The output format is ansi. text output emits wide characters cell by cell with spaces",
      "  between them, which cannot be compared with the sent body, and telling the placeholder",
      "  hint apart requires SGR anyway",
      "- The box region is the range between the borders. When the body overflows vertically the",
      "  top border scrolls off screen, so if no top is found, every visible line above the bottom",
      "  is treated as body (only the tail end is readable then)",
      "- When the input box is empty the TUI draws a placeholder hint in dim (SGR 2). The wording",
      "  is a frozen value that changes with the version, so string matching cannot catch it, but",
      '  the rendering distinction "hints are dim, real input is unstyled" works as a structural',
      "  signal, so the dim ranges are dropped before deciding emptiness",
      "",
      "The attempt limit stays at 5 and is not raised — the observation that it is close to the",
      "limit is itself the alarm. Since polling removes idle rounds, attempts pins to 1 and the",
      "alarm loses resolution, so read the per-stage ms in trace instead (even at attempt 1, a",
      "stage whose ms is pinned at its bound reveals the anomaly).",
      "",
      "Every failure JSON also carries the stage it stopped in as `stage`, the same key launch",
      "puts there, so a caller that branches on error never has to also branch on which",
      "subcommand produced the failure. The value is the last stage in trace with `grace`",
      "skipped: grace is stepped once after a bound is reached on every route, so reporting it",
      "verbatim would collapse every failure into the same stage. The one exception is a",
      "destination that never resolved to a pane, where no stage was stepped and none is",
      "reported.",
      "",
      "sendVerdict is what tells the endings of an unverified send apart in a single field, and",
      "the table below says whether re-firing is allowed for each. A submit that arrives after the",
      "grace period may be classified as not-delivered; that is a classification error only,",
      "because no keystroke follows the classification.",
      "",
      "Nothing is tidied up afterwards. The box is left holding whatever it holds and the pane is",
      "not closed — a pane sitting on an unsubmitted body is a state to report, not one to fix",
      "from here, and the transcript is the next piece of forensic material.",
      "",
      "send picks the verification style internally from the body, by an exact match of the first",
      "word against a frozen list (TURNLESS_SLASH_COMMANDS in sender.ts); the verify table below",
      'says what each style watches for. The user does not need to know "does this command start a',
      'turn", so one face, send, suffices, and which style was used comes back as verify.',
      "",
      "The style is also narrowed per round by the agent_status the alive stage captured. A wait",
      "for working returns immediately when the status is already in the waited-for set at",
      "subscription time, and there is no mode that waits for a transition, so on a pane that was",
      "already working before the keystroke the working wait would hold no matter what the Enter",
      "did. Such a round takes the box clearing as its evidence instead, and its success comes",
      "back as claude-box-cleared. Rounds decide this one by one, so a single send can start on",
      "the box and end on the transition; verify carries the predicate the last round actually",
      "applied, and sendVerdict is read from that predicate's table. Being already working is",
      "never a reason to refuse the send — queueing a command at a child mid-turn is a route that",
      "is relied on — only a reason to be honest about the evidence.",
      "",
      "The list holds only commands that start no turn and return to the prompt box after submit.",
      "/compact calls the model to summarize, so it rises to working and belongs to working",
      "verification. Built-in commands that open a dialog, such as /help or /model, do not rise to",
      "working either, but the screen after submit is not a prompt box, so neither verification",
      "resolves them (the box cannot be read, or the picker is read as a foreign residual). The",
      "caller's available decisions do not change, so they are not added to the list.",
      "",
      "Only terminating commands (/exit and its alias /quit; the frozen list is",
      "TERMINATING_SLASH_COMMANDS in sender.ts) widen the success test beyond the box going empty",
      'to also cover "claude left that terminal after the keystroke". The terminal state is not',
      "singular there — the pane may close, or stay while the shell respawns in it — so the",
      "vocabulary of the test is the same as the empty-shell test (no agent label / agent_status",
      "is unknown) rather than anything about the pane being alive.",
      "",
      "Terminating commands also get their own dialog stage, in front of the box read. With a",
      "background shell still alive, claude answers the command with a confirmation dialog rather",
      "than exiting, and its footer makes the pane read as blocked while the box reads as a",
      "foreign residual — the send would stop there and leave the dialog standing. On a round",
      "after the command was typed, blocked and the frozen dialog wording together are answered",
      "with a single Enter on the default choice, which stops the background tasks, and the stage",
      "then waits on its own budget for claude to leave the terminal — an exit carries a session",
      "end hook, which does not fit inside a round's box budget. The two signals are required",
      "together here, unlike",
      "the fresh-launch dialog stage where either suffices: on an existing pane, blocked alone",
      "would also describe a permission prompt raised while the command sat queued, and answering",
      "that is not this layer's call. Beyond one Enter nothing more is pressed and the round falls",
      "back to the foreign branch.",
      "",
      "detection is the screen classification at the same instant as the terminal snapshot",
      '(boxBody / lastAgentStatus / paneTail); it layers "how herdr classified it" on top of "what',
      'was visible". Even with sendVerdict=not-delivered, a state=blocked means a screen blocking',
      "input was up, so the judgement that it is safe to re-fire does not hold as-is: read the",
      "screen with `herdr agent read <pane> --source recent` to confirm nobody is part-way through",
      "answering, close the screen with `herdr agent send-keys <pane> esc`, then send again.",
      "Conversely, if the winning rule is an ordinary prompt box and the send still does not go",
      "through, suspect the send side (width exhaustion, bracketed paste) rather than the screen.",
      "It is not captured for agent-vanished, where the target cannot be resolved.",
      "",
      "Why (the accident this closed): the first Enter got eaten by the slash completion menu so",
      "the body stayed in the box, and when the next attempt's residual check fell to empty, the",
      "atomic send pasted the same body after the existing one and the trailing Enter submitted",
      "A+A (the recipient's first prompt became the same command twice, concatenated).",
      "",
      "See also: h2cv explain herdr-agent-alive (where to type) / input-ready (when to type)",
    ],
    tables: {
      stage: stageRows(SEND_STAGES),
      result: toRows("result", TRACE_RESULTS),
      verify: toRows("verify", VERIFY_ADVICE),
      sendVerdict: toRows("sendVerdict", SEND_VERDICT_ADVICE),
      evidence: toRows("evidence", EVIDENCE_ADVICE),
    },
  },
  "self-send": {
    summary:
      "A send whose target is pinned to the caller's own pane. A detached watcher waits from the outside for the caller's turn to end",
    body: [
      "Spec: source of truth is self-send.ts. This is the face for a session to end itself or",
      "fold its own context (`/exit` / `/clear`), and the target is pinned to the pane this very",
      "process is running in. It is the only subcommand that takes no target argument, because",
      "there is exactly one possible target.",
      "",
      "Two reasons it cannot simply be typed, which is why a detached watcher sits in the middle:",
      "- the sender is also the recipient. While the caller's own turn is busy the input box",
      "  accepts nothing, and the process cannot observe that fact until its turn ends. So the",
      "  send is handed to another process that waits from the outside for the caller's turn to",
      "  end and go idle",
      "- the waiter must not be bound to the parent's lifetime. It has to keep waiting after the",
      "  caller exits, so the watcher is started detached and cut loose from its parent",
      "",
      "A call without the internal flag starts the watcher and returns `armed: true` immediately,",
      "with nothing typed at that point. The watcher is this same executable re-invoked with the",
      "internal flag, which is not listed in the command catalog — it is not a face the user",
      "passes directly. Starting it has to carry over the runtime arguments (loader hooks and the",
      "like); dropping them starts an executable that runs through a TypeScript loader under bare",
      "node, and it crashes right after spawn. Nobody reads the watcher's output, so swallowing it",
      'would remove any way to investigate "it armed and then nothing happened" after the fact —',
      "so it goes to a per-pane log (a single host-wide file would corrupt the record when several",
      "sessions arm at once and truncation collides with a write).",
      "",
      "More than one command may be given, and a single watcher types them in the order given",
      "after waiting once for the caller's turn to end. That is what makes \"set the state, then",
      'finish" (a rename followed by an exit) expressible in one call: arming twice would neither',
      "order the two sends nor keep both records, because the watcher log is per-pane and is",
      "truncated on every call. A command that ends the session may only come last — anything",
      "queued behind it could never be typed, so it is rejected as usage rather than dropped in",
      "silence. If one of them fails the rest are not typed, and the failure JSON carries sent",
      "(what did land, with its evidence) and failedAt (which one broke, 1-based).",
      "",
      "Only slash commands are accepted. Plain text has no reason to target the caller itself",
      "(that is `send`'s job), so this face is kept to operating on the session itself. The send",
      "itself goes through the same entry point as send, so the verification style is likewise",
      "chosen from the body — `/exit` is verified by box clearing (and agent-gone), while a",
      "command that starts a turn, such as a skill invocation, is verified by the transition to",
      "working.",
      "",
      "The failure codes are the same ones the other subcommands use, and once the send itself has",
      "started the tables in send-protocol apply unchanged. The stages here are a different set",
      "from the input-ready stages, even though idle appears in both — the predicate differs",
      "(blocked is not waited on here), so the two are separate rows. Which set applies is decided",
      "by the subcommand that was run.",
      "",
      "The idle wait shares its helper with the input-ready gate, so the background-work way out",
      "applies here too: a session that finished its work with a run_in_background shell still",
      "alive is classified as working forever, and without it nothing would ever be typed.",
      "Measured on 2026-08-25 that was exactly what happened — 300 s of budget spent, then",
      "not-ready with stage=idle and detection.matchedRule.id background_shell_working.",
      "",
      "Getting past that gate is not the same as the session ending. From claude 2.1.243 an",
      "`/exit` with a live background shell opens a confirmation dialog (Exit and stop tasks /",
      "Move to background and exit / Stay). The command lands and submits, but the box then holds",
      "the dialog rather than going empty, and the pane reads as blocked. That dialog is answered",
      "here, by the dialog stage of the send: one Enter on the default choice, which stops the",
      "background tasks, and then the exit is awaited as usual (evidence herdr-agent-gone, with a",
      "dialog row in the trace). The reasoning is that the sender is the session itself — a",
      "self-send /exit is a session deciding to end, and a detached watcher has no reader to",
      "escalate to, so leaving the dialog standing means the pane holds its lane forever. The",
      "default is taken rather than Move to background and exit, because nothing is meant to",
      "outlive a session that asked to end. Enter is pressed only when blocked and the frozen",
      "wording hold together, and only once; anything else falls back to send-unverified with",
      "sendVerdict submitted-unconfirmed and lastAgentStatus blocked, for the human or the caller",
      "to answer. Read the mechanism of the gate itself and why only one rule counts in",
      "h2cv explain input-ready.",
      "",
      "See also: h2cv self-send </command> [</command>...]",
    ],
    tables: { stage: stageRows(SELF_SEND_STAGES) },
  },
};
export function hintFor(code: ErrorCode): string {
  return `h2cv explain ${ERROR_TOPIC[code]}`;
}
export function resolveTopic(arg: string): Topic | null {
  if (arg in TOPICS) return arg as Topic;
  if (arg in ERROR_TOPIC) return ERROR_TOPIC[arg as ErrorCode];
  return null;
}
export function listTopics(): {
  topic: Topic;
  summary: string;
}[] {
  return Object.entries(TOPICS).map(([topic, { summary }]) => ({
    topic: topic as Topic,
    summary,
  }));
}
export function renderTopic(topic: Topic): {
  topic: Topic;
  summary: string;
  body: string[];
  tables?: Tables;
} {
  const { summary, body, tables } = TOPICS[topic];
  return { topic, summary, body, ...(tables ? { tables } : {}) };
}
