import { spawnSync } from "node:child_process";

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
export type CmdResult = {
  code: number;
  stdout: string;
  stderr: string;
};
export type Exec = (bin: string, args: string[]) => CmdResult;
export function cmd(bin: string, args: string[]): CmdResult {
  const p = spawnSync(bin, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: p.status ?? 1,
    stdout: p.stdout ?? "",
    stderr: p.stderr ?? "",
  };
}
export type AgentGetResponse = {
  name?: string;
  agent?: string;
  pane_id?: string;
  terminal_id?: string;
  agent_status?: string;
  cwd?: string;
  title?: string;
  tab_id?: string;
};
const SGR_RE = /\x1b\[([0-9;]*)m/g;
const BOX_RULE_RE = /^\s*─{10,}\s*$/;
const BOX_LABELED_RULE_RE = /^\s*─{10,}\s+\S[^─]*\s+─+\s*$/;
const isTopRule = (line: string) =>
  BOX_RULE_RE.test(line) || BOX_LABELED_RULE_RE.test(line);
const PROMPT_MARKER = "❯";
function applySgr(dim: boolean, params: string[]): boolean {
  let next = dim;
  for (let i = 0; i < params.length; ) {
    const p = params[i];
    if (p === "38" || p === "48" || p === "58") {
      const mode = params[i + 1];
      i += mode === "2" ? 5 : mode === "5" ? 3 : 1;
      continue;
    }
    if (p === "0" || p === "22") next = false;
    if (p === "2") next = true;
    i += 1;
  }
  return next;
}
export function stripDimAndSgr(line: string): string {
  let out = "";
  let dim = false;
  let last = 0;
  for (const m of line.matchAll(SGR_RE)) {
    const at = m.index ?? 0;
    if (!dim) out += line.slice(last, at);
    last = at + m[0].length;
    dim = applySgr(dim, m[1] === "" ? ["0"] : m[1].split(";"));
  }
  if (!dim) out += line.slice(last);
  return out;
}
export type BoxRead = {
  body: string;
  truncated: boolean;
};
export function parseBox(ansi: string): BoxRead | null {
  const lines = ansi.split(/\r?\n/).map(stripDimAndSgr);
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (BOX_RULE_RE.test(lines[i])) {
      bottom = i;
      break;
    }
  }
  if (bottom < 0) return null;
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--) {
    if (isTopRule(lines[i])) {
      top = i;
      break;
    }
  }
  let body = lines.slice(top + 1, bottom);
  const marker = body.findLastIndex((l) => l.includes(PROMPT_MARKER));
  if (marker >= 0) {
    const head = body[marker];
    body = [
      head.slice(head.indexOf(PROMPT_MARKER) + 1),
      ...body.slice(marker + 1),
    ];
  }
  return {
    body: body.join(" ").replace(/\s+/g, " ").trim(),
    truncated: top < 0,
  };
}
export function parseBoxBody(ansi: string): string | null {
  return parseBox(ansi)?.body ?? null;
}
export type DetectionRuleSummary = {
  id: string;
  state?: string;
  priority?: number;
  region?: string;
  matched: boolean;
  contains?: string[];
  regex?: string[];
  lineRegex?: string[];
  anyCount?: number;
  allCount?: number;
  notCount?: number;
  regionBytes?: number;
};
export type ScreenDetection = {
  state: string;
  matchedRule: {
    id: string;
    state?: string;
    priority?: number;
    region?: string;
  } | null;
  visibleBlocker: boolean;
  visibleIdle: boolean;
  visibleWorking: boolean;
  fallbackReason: string | null;
  manifestVersion: string | null;
  screenDetectionSkipped?: true;
  warning?: string;
  rules: DetectionRuleSummary[];
  regions: Record<string, string>;
};
const SCREEN_DETECTION_FIELD_SET: Record<
  keyof Required<ScreenDetection>,
  true
> = {
  state: true,
  matchedRule: true,
  visibleBlocker: true,
  visibleIdle: true,
  visibleWorking: true,
  fallbackReason: true,
  manifestVersion: true,
  screenDetectionSkipped: true,
  warning: true,
  rules: true,
  regions: true,
};
export const SCREEN_DETECTION_FIELDS = Object.keys(SCREEN_DETECTION_FIELD_SET);
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNonZero(v: unknown): number | undefined {
  return typeof v === "number" && v !== 0 ? v : undefined;
}
function asStrings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
}
function compact<T extends object>(o: T): T {
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) delete (o as Record<string, unknown>)[k];
  }
  return o;
}
export function summarizeDetection(raw: unknown): ScreenDetection | null {
  if (!isRecord(raw)) return null;
  const state = asString(raw.state);
  if (state === undefined || !Array.isArray(raw.evaluated_rules)) return null;
  const regions: Record<string, string> = {};
  const rules: DetectionRuleSummary[] = [];
  for (const r of raw.evaluated_rules) {
    if (!isRecord(r)) return null;
    const id = asString(r.id);
    if (id === undefined) return null;
    const evidence = isRecord(r.evidence) ? r.evidence : {};
    const region = asString(r.region);
    const preview = asString(evidence.region_preview);
    if (region !== undefined && preview !== undefined && !regions[region]) {
      regions[region] = preview;
    }
    rules.push(
      compact({
        id,
        state: asString(r.state),
        priority: typeof r.priority === "number" ? r.priority : undefined,
        region,
        matched: r.matched === true,
        contains: asStrings(evidence.contains),
        regex: asStrings(evidence.regex),
        lineRegex: asStrings(evidence.line_regex),
        anyCount: asNonZero(evidence.any_count),
        allCount: asNonZero(evidence.all_count),
        notCount: asNonZero(evidence.not_count),
        regionBytes: asNonZero(evidence.region_bytes),
      }),
    );
  }
  const matched = raw.matched_rule;
  const matchedId = isRecord(matched) ? asString(matched.id) : undefined;
  const warning = asString(raw.warning);
  return {
    state,
    matchedRule:
      isRecord(matched) && matchedId !== undefined
        ? compact({
            id: matchedId,
            state: asString(matched.state),
            priority:
              typeof matched.priority === "number"
                ? matched.priority
                : undefined,
            region: asString(matched.region),
          })
        : null,
    visibleBlocker: raw.visible_blocker === true,
    visibleIdle: raw.visible_idle === true,
    visibleWorking: raw.visible_working === true,
    fallbackReason: asString(raw.fallback_reason) ?? null,
    manifestVersion: asString(raw.manifest_version) ?? null,
    ...(raw.screen_detection_skipped === true
      ? { screenDetectionSkipped: true as const }
      : {}),
    ...(warning !== undefined ? { warning } : {}),
    rules,
    regions,
  };
}
export function herdrErrorCode(r: CmdResult): string | null {
  for (const stream of [r.stderr, r.stdout]) {
    const text = stream.trim();
    if (text === "") continue;
    try {
      const code = JSON.parse(text)?.error?.code;
      if (typeof code === "string" && code !== "") return code;
    } catch {}
  }
  return null;
}
export type HerdrServerProbe = "up" | "down" | "protocol-mismatch";
const PROTOCOL_MISMATCH_CODE = "protocol_mismatch";
export const SERVER_DOWN_MESSAGE =
  "No herdr server is running (the api socket is unreachable). Start one with" +
  " `herdr server` (or whatever keeps it resident on your host), then fire again" +
  " (this layer does not start servers).";
export const SERVER_PROTOCOL_MISMATCH_MESSAGE =
  "The running herdr server speaks a protocol incompatible with the client" +
  " (only the binary was replaced and the old server is still up)." +
  " Check the versions with `herdr status`, stop it with `herdr server stop`," +
  " then fire again once it is back up with the new binary (whatever keeps it" +
  " resident will restart it; otherwise start it yourself)." +
  " Stopping closes every running pane.";
export type PaneWaitResult = "matched" | "timeout" | "unavailable";
const PROBE_WAIT_ENTERED_RATIO = 0.5;
export const PROBE_UNAVAILABLE_MESSAGE =
  "`herdr pane wait-output` returned without waiting, so the shell probe could" +
  " not be answered. Either the running herdr is older than the subcommand" +
  " (it landed in 0.8.2 and older builds print the usage and exit non-zero), or" +
  " the pane is gone / the server stopped answering. Check with `herdr status`" +
  " and `herdr pane list`, upgrade herdr if it is behind the tested-with version" +
  " (`h2cv explain overview` prints it), then fire again.";
export const AGENT_START_TIMEOUT_MS = 300000;
const AGENT_PANE_BUSY = "agent_pane_busy";
export const AGENT_START_RETRY_MS = 300;
export const AGENT_START_RETRIES = 100;
const AGENT_NOT_READY = "agent_not_ready";
export type TabCreateResult =
  | {
      ok: true;
      tabId: string;
      paneId: string;
    }
  | {
      ok: false;
      stderr: string;
    };
export class HerdrAdapter {
  constructor(protected readonly exec: Exec = cmd) {}
  agentGet(target: string): AgentGetResponse | null {
    const r = this.exec("herdr", ["agent", "get", target]);
    if (r.code !== 0) return null;
    try {
      return JSON.parse(r.stdout)?.result?.agent ?? null;
    } catch {
      return null;
    }
  }
  waitIdle(target: string, timeoutMs: number): boolean {
    return (
      this.exec("herdr", [
        "agent",
        "wait",
        target,
        "--until",
        "idle",
        "--until",
        "done",
        "--timeout",
        String(timeoutMs),
      ]).code === 0
    );
  }
  waitIdleOrBlocked(target: string, timeoutMs: number): boolean {
    return (
      this.exec("herdr", [
        "agent",
        "wait",
        target,
        "--until",
        "idle",
        "--until",
        "done",
        "--until",
        "blocked",
        "--timeout",
        String(timeoutMs),
      ]).code === 0
    );
  }
  waitWorking(target: string, timeoutMs: number): boolean {
    return (
      this.exec("herdr", [
        "agent",
        "wait",
        target,
        "--until",
        "working",
        "--timeout",
        String(timeoutMs),
      ]).code === 0
    );
  }
  private agentRead(target: string, args: string[]): string | null {
    const r = this.exec("herdr", ["agent", "read", target, ...args]);
    return r.code !== 0 ? null : r.stdout;
  }
  readVisible(target: string): string {
    return (
      this.agentRead(target, ["--source", "visible", "--format", "text"]) ?? ""
    );
  }
  readBox(target: string): BoxRead | null {
    const text = this.agentRead(target, [
      "--source",
      "visible",
      "--format",
      "ansi",
    ]);
    return text === null ? null : parseBox(text);
  }
  readBoxBody(target: string): string | null {
    return this.readBox(target)?.body ?? null;
  }
  agentExplain(target: string): ScreenDetection | null {
    const r = this.exec("herdr", ["agent", "explain", target, "--json"]);
    if (r.code !== 0) return null;
    try {
      return summarizeDetection(JSON.parse(r.stdout));
    } catch {
      return null;
    }
  }
  agentSendKeys(target: string, keys: string): void {
    this.exec("herdr", ["agent", "send-keys", target, keys]);
  }
  paneRun(pane: string, text: string): void {
    this.exec("herdr", ["pane", "run", pane, text]);
  }
  paneSendText(pane: string, text: string): void {
    this.exec("herdr", ["pane", "send-text", pane, text]);
  }
  probeServer(): HerdrServerProbe {
    const r = this.exec("herdr", ["agent", "list"]);
    if (r.code === 0) return "up";
    return herdrErrorCode(r) === PROTOCOL_MISMATCH_CODE
      ? "protocol-mismatch"
      : "down";
  }
  tabCreate(label: string, cwd: string): TabCreateResult {
    const r = this.exec("herdr", [
      "tab",
      "create",
      "--cwd",
      cwd,
      "--label",
      label,
      "--no-focus",
    ]);
    if (r.code !== 0) return { ok: false, stderr: r.stderr.trim() };
    try {
      const result = JSON.parse(r.stdout)?.result;
      const tabId = result?.tab?.tab_id;
      const paneId = result?.root_pane?.pane_id;
      if (
        typeof tabId === "string" &&
        tabId &&
        typeof paneId === "string" &&
        paneId
      )
        return { ok: true, tabId, paneId };
    } catch {}
    return {
      ok: false,
      stderr:
        "could not parse tab_id / root_pane.pane_id from `herdr tab create`",
    };
  }
  paneWaitOutput(
    pane: string,
    match: string,
    timeoutMs: number,
  ): PaneWaitResult {
    const startedAt = Date.now();
    const r = this.exec("herdr", [
      "pane",
      "wait-output",
      pane,
      "--match",
      match,
      "--source",
      "visible",
      "--timeout",
      String(timeoutMs),
    ]);
    if (r.code === 0) return "matched";
    return Date.now() - startedAt >= timeoutMs * PROBE_WAIT_ENTERED_RATIO
      ? "timeout"
      : "unavailable";
  }
  paneReadTail(pane: string): string {
    const r = this.exec("herdr", [
      "pane",
      "read",
      pane,
      "--source",
      "visible",
      "--format",
      "text",
    ]);
    return r.code !== 0 ? "" : r.stdout;
  }
  agentStart(
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
    const argv = [
      "agent",
      "start",
      name,
      "--kind",
      "claude",
      "--pane",
      paneId,
      "--timeout",
      String(AGENT_START_TIMEOUT_MS),
      "--",
      ...claudeArgs,
    ];
    for (let i = 0; ; i++) {
      const r = this.exec("herdr", argv);
      if (r.code === 0) return { ok: true };
      if (herdrErrorCode(r) === AGENT_NOT_READY)
        return { ok: true, notReady: true };
      const stderr = r.stderr.trim();
      if (!stderr.includes(AGENT_PANE_BUSY) || i >= AGENT_START_RETRIES) {
        return { ok: false, stderr };
      }
      sleepSync(AGENT_START_RETRY_MS);
    }
  }
}
export type HerdrSendPort = Pick<
  HerdrAdapter,
  | "agentGet"
  | "waitIdle"
  | "waitIdleOrBlocked"
  | "waitWorking"
  | "readVisible"
  | "readBox"
  | "readBoxBody"
  | "agentExplain"
  | "agentSendKeys"
  | "paneRun"
  | "paneSendText"
>;
export type HerdrLaunchPort = Pick<
  HerdrAdapter,
  "probeServer" | "tabCreate" | "paneWaitOutput" | "paneReadTail" | "agentStart"
>;
