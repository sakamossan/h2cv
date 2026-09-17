import type { ErrorCode } from "./explain.js";
import type { LaunchResult } from "./launch.js";
import type { HerdrPort } from "./launcher.js";
import type { SelfSendEnv } from "./self-send.js";
import { parseArgs } from "node:util";
import { hintFor, listTopics, renderTopic, resolveTopic } from "./explain.js";
import { HerdrAdapter } from "./herdr-adapter.js";
import { runLaunch } from "./launch.js";
import { armWatcher, selfSend } from "./self-send.js";
import {
  AgentSender,
  inputReadyGate,
  lastStage,
  snapshotFields,
  UNTRUSTED_WORKSPACE_MESSAGE,
} from "./sender.js";
import { DEFAULT_SESSION_TIMINGS } from "./timings.js";

const WAIT_INPUT_READY_DEFAULT_TIMEOUT_MS =
  DEFAULT_SESSION_TIMINGS.inputReadyTimeoutMs;
export const AGENT_NAME_RE = /^[a-z][a-z0-9_-]*$/;
export const AGENT_NAME_MAX = 32;
const PANE_ID_CHAR = "[123456789A-HJKMNP-TV-Z0]";
export const PANE_ID_RE = new RegExp(`^w${PANE_ID_CHAR}+:p${PANE_ID_CHAR}+$`);
function paneIdErr(sub: string, target: string): RunResult | null {
  return PANE_ID_RE.test(target)
    ? null
    : usageErr(
        `${sub} --pane takes a canonical pane_id (w<N>:p<M>, where each number is base32 over 123456789ABCDEFGHJKMNPQRSTVWXYZ0); got "${target}". Get it with \`herdr agent get <name> | jq -r .result.agent.pane_id\`, or use $HERDR_PANE_ID`,
      );
}
type DestinationResult =
  | {
      ok: true;
      pane: string;
    }
  | {
      ok: false;
      result: RunResult;
    };
function resolveDestination(
  sub: string,
  values: {
    pane?: string;
    "agent-name"?: string;
  },
  herdr: HerdrPort,
): DestinationResult {
  const pane = values.pane || undefined;
  const agentName = values["agent-name"] || undefined;
  if (!pane === !agentName) {
    return {
      ok: false,
      result: usageErr(
        `${sub} takes exactly one destination flag: --pane <paneId> | --agent-name <name>`,
      ),
    };
  }
  if (pane !== undefined) {
    const bad = paneIdErr(sub, pane);
    return bad ? { ok: false, result: bad } : { ok: true, pane };
  }
  const resolved = herdr.agentGet(agentName as string)?.pane_id;
  if (!resolved) {
    return {
      ok: false,
      result: fail(
        { ok: false, error: "agent-vanished", agentName },
        `${sub} --agent-name ${agentName}: agent-vanished — the name resolved to no pane and nothing was ever typed`,
      ),
    };
  }
  return { ok: true, pane: resolved };
}
const DESTINATION_FLAGS = [
  {
    name: "--pane <paneId>",
    summary:
      "Canonical pane id (`w<N>:p<M>`, each number base32 over 123456789ABCDEFGHJKMNPQRSTVWXYZ0) of the destination (mutually exclusive with --agent-name; exactly one of the two is required)",
  },
  {
    name: "--agent-name <name>",
    summary:
      "Agent name of the destination, folded into a pane id by a single `agent get` before anything is typed. A name that resolves to nothing fails as agent-vanished (mutually exclusive with --pane)",
  },
] as const;
const CATALOG = {
  target:
    "Every command that addresses an existing session takes its destination as exactly one of two flags: `--pane <paneId>` or `--agent-name <name>`. `--pane` is a canonical pane_id (`w<N>:p<M>`), the handle to carry around: a closed pane_id is never reused, so the same value stays valid across waits and retries. Get it with `herdr agent get <name> | jq -r .result.agent.pane_id`, or read $HERDR_PANE_ID. `--agent-name` is folded into a pane_id by a single `agent get` at the entry point and never travels any further, because the name binding is released the moment claude exits; a name that resolves to nothing fails as agent-vanished. A terminal_id and an agent label are not accepted as either",
  commands: [
    {
      name: "launch",
      args: ["[-- <claude argv...>]"],
      flags: [
        {
          name: "--cwd <dir>",
          summary:
            "Startup cwd. Creates a dedicated tab and is passed through as that tab's cwd (mutually exclusive with --pane; exactly one of the two is required)",
        },
        {
          name: "--pane <paneId>",
          summary:
            "Canonical pane id to start into. Creates no tab and starts into a pane you already prepared (mutually exclusive with --cwd; creating and reclaiming the tab is the caller's responsibility)",
        },
        {
          name: "--agent-name <name>",
          summary:
            "Agent name (optional). herdr needs one to start an agent at all, so omitting it derives `h2cv-w<N>-p<M>` from the pane. Given, it is also the tab label on the --cwd path (omitted, that label is the basename of --cwd), and it must be at most 32 characters of [a-z0-9_-] starting with a lowercase letter (a herdr constraint). Either way the name that was used comes back as agentName in the success JSON. No claude-side session name (-n) is added, so pass one yourself after -- if you need it",
        },
        {
          name: "--prompt <text>",
          summary:
            "Body to send right after startup. Omitted or empty means nothing is sent and the run completes with the startup alone (promptSent is false in the success JSON)",
        },
      ],
      summary:
        "Run startup through send + read-back verification in one command (takes no target; adds not a single claude argv and only passes through whatever follows --)",
    },
    {
      name: "send",
      args: ["<text>"],
      flags: [...DESTINATION_FLAGS],
      summary:
        "Send plain text or a slash command. A body that starts a turn is verified by the transition to working; a command that starts no turn (/clear /rename /exit /quit) is verified by the box clearing (which one was used is reported in verify in the failure JSON)",
    },
    {
      name: "wait-input-ready",
      args: [],
      flags: [
        ...DESTINATION_FLAGS,
        {
          name: "--timeout <ms>",
          summary: `Upper bound for the wait. Defaults to ${WAIT_INPUT_READY_DEFAULT_TIMEOUT_MS}`,
        },
        {
          name: "--detect-interstitial",
          summary:
            "Clear the first-run dialog with Enter, except the workspace trust one, which fails as untrusted-workspace without pressing anything (fresh-launch path only; it misfires on an existing pane)",
        },
      ],
      summary:
        "Pass only the input-ready stages (idle -> dialog -> box -> rc) and send nothing",
    },
    {
      name: "self-send",
      args: ["</command>", "[</command>...]"],
      flags: [],
      summary:
        "Send one or more slash commands to your own pane ($HERDR_PANE_ID) (a single detached watcher waits for the caller's turn to end, then types them in the order given; a terminating command such as /exit may only come last; takes no target)",
    },
    {
      name: "explain",
      args: ["[<topic|error-code>]"],
      flags: [],
      summary:
        "Bridge a failure JSON's classification to the decision you can take next (no argument lists the topics)",
    },
  ],
} as const;
const HELP_HINT = "run `h2cv --help` for the command catalog";
export type RunResult = {
  exitCode: 0 | 1;
  stdout: string;
  stderr?: string;
};
function jsonOut(exitCode: 0 | 1, payload: Record<string, unknown>): RunResult {
  return { exitCode, stdout: JSON.stringify(payload, null, 2) };
}
function fail(
  payload: {
    ok: false;
    error: ErrorCode;
    hint?: never;
  } & Record<string, unknown>,
  summary: string,
): RunResult {
  return {
    ...jsonOut(1, { ...payload, hint: hintFor(payload.error) }),
    stderr: summary,
  };
}
function usageErr(detail: string, extra?: Record<string, unknown>): RunResult {
  return fail(
    { ok: false, error: "usage", detail, recovery: HELP_HINT, ...extra },
    detail,
  );
}
function summarizeLaunch(failure: {
  error: ErrorCode;
  [k: string]: unknown;
}): string {
  const parts: string[] = [];
  let nested = false;
  for (const [k, v] of Object.entries(failure)) {
    if (k === "error" || v === undefined) continue;
    if (v !== null && typeof v === "object") {
      nested = true;
      continue;
    }
    const s = String(v).replace(/\s+/g, " ").trim();
    parts.push(`${k}=${s.length > 120 ? `${s.slice(0, 120)}…` : s}`);
  }
  if (nested)
    parts.push("(read the structured detail from the stdout JSON with jq)");
  return [`launch: ${failure.error} —`, ...parts].join(" ");
}
function renderLaunch(outcome: LaunchResult): RunResult {
  if (outcome.ok) return jsonOut(0, outcome.value);
  const { error, ...rest } = outcome.failure;
  return fail({ ok: false, error, ...rest }, summarizeLaunch(outcome.failure));
}
export function run(
  argv: string[],
  herdr: HerdrPort = new HerdrAdapter(),
  selfSendEnv: SelfSendEnv = {
    pane: process.env.HERDR_PANE_ID || null,
    arm: armWatcher,
  },
): RunResult {
  const [sub, ...rest] = argv;
  if (sub === "--help" || sub === "help") {
    return jsonOut(0, { ok: true, ...CATALOG });
  }
  const dashdash = rest.indexOf("--");
  const own = dashdash === -1 ? rest : rest.slice(0, dashdash);
  const passthrough = dashdash === -1 ? [] : rest.slice(dashdash + 1);
  if (own.includes("--help")) {
    const command = CATALOG.commands.find((c) => c.name === sub);
    if (command) {
      return jsonOut(0, { ok: true, target: CATALOG.target, command });
    }
  }
  switch (sub) {
    case "launch": {
      let parsed;
      try {
        parsed = parseArgs({
          args: own,
          allowPositionals: true,
          options: {
            cwd: { type: "string" },
            pane: { type: "string" },
            "agent-name": { type: "string" },
            prompt: { type: "string" },
          },
        });
      } catch (e) {
        return usageErr(
          `launch: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (parsed.positionals.length > 0) {
        return usageErr(
          `launch takes no positional arguments; got ${parsed.positionals.join(" ")}. Put the argv for claude after --`,
        );
      }
      const { cwd, pane, prompt } = parsed.values;
      const agentName = parsed.values["agent-name"];
      const target =
        cwd && !pane ? { cwd } : pane && !cwd ? { paneId: pane } : null;
      if (!target) {
        return usageErr(
          "launch takes (--cwd <dir> | --pane <paneId>) [--agent-name <name>] [--prompt <text>] [-- <claude argv...>]",
        );
      }
      if (pane) {
        const badPane = paneIdErr("launch", pane);
        if (badPane) return badPane;
      }
      if (agentName !== undefined) {
        if (agentName.length > AGENT_NAME_MAX) {
          return usageErr(
            `launch: --agent-name must be at most ${AGENT_NAME_MAX} characters (a herdr constraint); got ${agentName.length} characters "${agentName}"`,
          );
        }
        if (!AGENT_NAME_RE.test(agentName)) {
          return usageErr(
            `launch: --agent-name must be [a-z0-9_-] starting with a lowercase letter (a herdr constraint); got "${agentName}"`,
          );
        }
      }
      return renderLaunch(
        runLaunch(
          {
            ...target,
            ...(agentName === undefined ? {} : { agentName }),
            ...(prompt === undefined ? {} : { prompt }),
            ...(passthrough.length > 0 ? { claudeArgv: passthrough } : {}),
          },
          { herdr },
        ),
      );
    }
    case "send": {
      let parsed;
      try {
        parsed = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            pane: { type: "string" },
            "agent-name": { type: "string" },
          },
        });
      } catch (e) {
        return usageErr(`send: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (parsed.positionals.length > 1) {
        return usageErr(
          `send takes a single <text> positional; got ${parsed.positionals.join(" ")}. The destination is a flag: --pane <paneId> | --agent-name <name>`,
        );
      }
      const text = parsed.positionals[0];
      if (!text) {
        return usageErr(
          "send takes (--pane <paneId> | --agent-name <name>) <text>",
        );
      }
      const destination = resolveDestination("send", parsed.values, herdr);
      if (!destination.ok) return destination.result;
      const target = destination.pane;
      const sent = new AgentSender(herdr, target).send(text);
      if (sent.ok) {
        return jsonOut(0, {
          ok: true,
          target,
          attempts: sent.attempts,
          trace: sent.trace,
          evidence: sent.evidence,
        });
      }
      if (sent.reason === "agent-vanished") {
        return fail(
          {
            ok: false,
            error: "agent-vanished",
            stage: "alive",
            target,
            attempts: sent.attempts,
            trace: sent.trace,
          },
          `send ${target}: agent-vanished — stage=alive — the target could not be resolved and nothing was ever typed`,
        );
      }
      return fail(
        {
          ok: false,
          error: "send-unverified",
          stage: lastStage(sent.trace),
          target,
          attempts: sent.attempts,
          trace: sent.trace,
          verify: sent.verify,
          sendVerdict: sent.sendVerdict,
          ...snapshotFields(sent),
        },
        `send ${target}: send-unverified — stage=${lastStage(sent.trace)} verify=${sent.verify} sendVerdict=${sent.sendVerdict} lastAgentStatus=${sent.lastAgentStatus} attempts=${sent.attempts} (read the box / pane dumps and the screen classification with \`| jq -r .boxBody\` / \`| jq -r .paneTail\` / \`| jq .detection\`)`,
      );
    }
    case "wait-input-ready": {
      let parsed;
      try {
        parsed = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            pane: { type: "string" },
            "agent-name": { type: "string" },
            timeout: { type: "string" },
            "detect-interstitial": { type: "boolean" },
          },
        });
      } catch (e) {
        return usageErr(
          `wait-input-ready: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (parsed.positionals.length > 0) {
        return usageErr(
          `wait-input-ready takes no positional arguments; got ${parsed.positionals.join(" ")}. The destination is a flag: --pane <paneId> | --agent-name <name>`,
        );
      }
      const destination = resolveDestination(
        "wait-input-ready",
        parsed.values,
        herdr,
      );
      if (!destination.ok) return destination.result;
      const target = destination.pane;
      const timeoutMs = parsed.values.timeout
        ? Number(parsed.values.timeout)
        : WAIT_INPUT_READY_DEFAULT_TIMEOUT_MS;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return usageErr(
          `--timeout must be a positive number of ms; got ${parsed.values.timeout}`,
        );
      }
      const gate = inputReadyGate(
        herdr,
        target,
        Date.now() + timeoutMs,
        parsed.values["detect-interstitial"] === true,
      );
      if (gate.ok)
        return jsonOut(0, {
          ok: true,
          target,
          elapsedMs: gate.elapsedMs,
          trace: gate.trace,
        });
      const untrusted = gate.reason === "untrusted-workspace";
      return fail(
        {
          ok: false,
          error: untrusted ? "untrusted-workspace" : "not-ready",
          target,
          stage: gate.stage,
          elapsedMs: gate.elapsedMs,
          trace: gate.trace,
          ...(untrusted ? { message: UNTRUSTED_WORKSPACE_MESSAGE } : {}),
          detection: gate.detection,
        },
        untrusted
          ? `wait-input-ready ${target}: untrusted-workspace — stage=${gate.stage} (${gate.elapsedMs}ms; nothing was pressed, read the recovery in \`| jq -r .message\`)`
          : `wait-input-ready ${target}: not-ready — stage=${gate.stage} (${gate.elapsedMs}ms; read the screen classification with \`| jq .detection\`)`,
      );
    }
    case "self-send": {
      const out = selfSend(rest, herdr, selfSendEnv);
      return out.ok
        ? jsonOut(0, { ok: true, ...out.payload })
        : out.error === "usage"
          ? usageErr(String(out.payload.detail))
          : fail({ ok: false, error: out.error, ...out.payload }, out.summary);
    }
    case "explain": {
      const arg = rest[0];
      if (!arg) {
        return jsonOut(0, {
          ok: true,
          topics: listTopics(),
          usage: "h2cv explain <topic|error-code>",
        });
      }
      const topic = resolveTopic(arg);
      if (!topic)
        return usageErr(`unknown topic: ${arg}`, { topics: listTopics() });
      return jsonOut(0, { ok: true, ...renderTopic(topic) });
    }
    default:
      return usageErr(
        sub
          ? `unknown subcommand: ${sub}`
          : "no subcommand given; expected one of launch|send|wait-input-ready|self-send|explain",
      );
  }
}
