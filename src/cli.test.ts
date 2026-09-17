import type { ScreenDetection } from "./herdr-adapter.js";
import type { HerdrPort } from "./launcher.js";
import { describe, expect, it, vi } from "vitest";
import { fakeHerdrPort, fixedBox } from "./__tests__/fakes.js";
import { run } from "./cli.js";
import { hintFor, TOPICS } from "./explain.js";

const PANE = "w1:p2K";
const AGENT_NAME = "repo-2520";
function liveHerdr(): HerdrPort {
  return fakeHerdrPort({
    agentGet: vi.fn(() => ({
      pane_id: PANE,
      terminal_id: "term_1",
      agent: "claude",
    })),
  });
}
function absentHerdr(): HerdrPort {
  return fakeHerdrPort({ agentGet: () => null });
}
const DETECTION: ScreenDetection = {
  state: "blocked",
  matchedRule: { id: "live_blocked_form", state: "blocked" },
  visibleBlocker: true,
  visibleIdle: false,
  visibleWorking: false,
  fallbackReason: null,
  manifestVersion: "2026.07.13.1",
  rules: [{ id: "live_blocked_form", matched: true }],
  regions: { after_last_horizontal_rule: "enter to select\nesc to cancel" },
};
function unverifiedHerdr() {
  return {
    ...liveHerdr(),
    waitWorking: () => false,
    agentExplain: () => DETECTION,
  };
}
function launchableHerdr() {
  return {
    ...liveHerdr(),
    tabCreate: () => ({ ok: true as const, tabId: "tab-1", paneId: PANE }),
  };
}
const LAUNCH_ARGV = [
  "launch",
  "--cwd",
  "/wt/owner/repo/2063",
  "--agent-name",
  "repo-2063",
];
describe("h2cv launch (#2063)", () => {
  it("起動から送出まで通れば ok:true + pane / promptSent を返す", () => {
    const r = run(
      [...LAUNCH_ARGV, "--prompt", "/my-skill run the tests"],
      launchableHerdr(),
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: true,
      agentName: "repo-2063",
      pane: PANE,
      promptSent: true,
    });
  });
  it("--prompt 省略は起動だけで完了する (promptSent: false)", () => {
    const r = run(LAUNCH_ARGV, launchableHerdr());
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, promptSent: false });
  });
  it("-- 以降は claude の argv へ verbatim に素通しする", () => {
    const seen: string[][] = [];
    const herdr = {
      ...launchableHerdr(),
      agentStart: (_n: string, _p: string, argv: string[]) => {
        seen.push(argv);
        return { ok: true as const };
      },
    };
    run([...LAUNCH_ARGV, "--", "--model", "fable"], herdr);
    expect(seen).toEqual([["--model", "fable"]]);
  });
  it("素通し argv の中の --help はカタログ表示に化けない", () => {
    const r = run([...LAUNCH_ARGV, "--", "--help"], launchableHerdr());
    expect(JSON.parse(r.stdout).ok).toBe(true);
    expect(JSON.parse(r.stdout)).not.toHaveProperty("commands");
  });
  it("起動先を欠けば usage JSON + exit 1", () => {
    const r = run(["launch", "--agent-name", "repo-2063"], absentHerdr());
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      error: "usage",
    });
    expect(JSON.parse(r.stdout).detail).toContain("--cwd");
  });
  it("--agent-name を省けば pane id から生成した名前で起動する", () => {
    const r = run(
      ["launch", "--cwd", "/wt/owner/repo/2520"],
      launchableHerdr(),
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: true,
      agentName: "h2cv-w1-p2k",
      pane: PANE,
    });
  });
  it("書式の壊れた --pane は herdr を叩かず usage で落ちる (#2520)", () => {
    const herdr = {
      ...launchableHerdr(),
      probeServer: vi.fn(() => "up" as const),
    };
    const r = run(["launch", "--pane", "term_1"], herdr);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: "usage" });
    expect(JSON.parse(r.stdout).detail).toContain("w<N>:p<M>");
    expect(herdr.probeServer).not.toHaveBeenCalled();
  });
  it("--title は未知のオプションとして落ちる (#2369 で撤去)", () => {
    const r = run([...LAUNCH_ARGV, "--title", "app#2369"], launchableHerdr());
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: "usage" });
  });
  it("positional は取らない (-- を忘れた argv を黙って捨てない)", () => {
    const r = run([...LAUNCH_ARGV, "--model", "fable"], absentHerdr());
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: "usage" });
  });
  it.each([
    ["大文字を含む", "Repo-2281"],
    ["数字始まり", "2281-repo"],
    ["記号を含む", "repo.2281"],
    ["空白を含む", "repo 2281"],
    ["33 文字", "a".repeat(33)],
  ])(
    "herdr 制約に反する agent 名 (%s) は herdr を一切叩かず usage で落ちる",
    (_label, name) => {
      const herdr = {
        ...launchableHerdr(),
        probeServer: vi.fn(() => "up" as const),
        tabCreate: vi.fn(() => ({
          ok: true as const,
          tabId: "tab-1",
          paneId: PANE,
        })),
      };
      const r = run(["launch", "--cwd", "/tmp", "--agent-name", name], herdr);
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: "usage" });
      expect(JSON.parse(r.stdout).detail).toContain("--agent-name");
      expect(herdr.probeServer).not.toHaveBeenCalled();
      expect(herdr.tabCreate).not.toHaveBeenCalled();
    },
  );
  it("32 文字ちょうどの agent 名は通す (境界値)", () => {
    const name = `h2cv-${"a".repeat(27)}`;
    expect(name).toHaveLength(32);
    const r = run(
      ["launch", "--cwd", "/tmp", "--agent-name", name],
      launchableHerdr(),
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, agentName: name });
  });
  it("--pane を受けたら tab を作らずその pane へ起動する", () => {
    const herdr = {
      ...launchableHerdr(),
      probeServer: vi.fn(() => "up" as const),
      tabCreate: vi.fn(() => ({
        ok: true as const,
        tabId: "tab-1",
        paneId: PANE,
      })),
      agentStart: vi.fn(() => ({ ok: true as const })),
    };
    const r = run(
      ["launch", "--pane", PANE, "--agent-name", "repo-2334"],
      herdr,
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, pane: PANE });
    expect(herdr.tabCreate).not.toHaveBeenCalled();
    expect(herdr.probeServer).toHaveBeenCalled();
    expect(herdr.agentStart).toHaveBeenCalledWith(
      "repo-2334",
      PANE,
      expect.any(Array),
    );
  });
  it.each([
    ["両方指定", ["--cwd", "/tmp", "--pane", PANE]],
    ["どちらも無し", []],
  ])("起動先が排他 1 択にならない argv (%s) は usage で落ちる", (_l, flags) => {
    const herdr = { ...launchableHerdr(), tabCreate: vi.fn() };
    const r = run(["launch", ...flags, "--agent-name", "a"], herdr);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: "usage" });
    expect(JSON.parse(r.stdout).detail).toContain("--pane");
    expect(herdr.tabCreate).not.toHaveBeenCalled();
  });
  it("段ごとの失敗は固有の error code + 起動側 topic への hint で返す", () => {
    const herdr = {
      ...launchableHerdr(),
      tabCreate: () => ({ ok: false as const, stderr: "no tab" }),
    };
    const r = run(LAUNCH_ARGV, herdr);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      error: "tab-create-failed",
      cwd: "/wt/owner/repo/2063",
      hint: "h2cv explain launch-sequence",
    });
    expect(r.stderr).toContain("tab-create-failed");
    expect(r.stderr!.split("\n")).toHaveLength(1);
  });
});
describe("h2cv send", () => {
  it("submit 成立で ok:true + attempts / trace の JSON を返す", () => {
    const r = run(["send", "--pane", PANE, "hello world"], liveHerdr());
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: true,
      target: PANE,
      attempts: 1,
      evidence: "herdr-agent-working",
      trace: [
        { attempt: 1, stage: "alive", result: "ok" },
        { attempt: 1, stage: "box", result: "ok" },
        { attempt: 1, stage: "type", result: "ok" },
        { attempt: 1, stage: "enter", result: "ok" },
      ],
    });
  });
  it("宛先を解決できなければ agent-vanished + exit 1", () => {
    const r = run(["send", "--pane", PANE, "hello"], absentHerdr());
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      error: "agent-vanished",
      stage: "alive",
      trace: [{ attempt: 1, stage: "alive", result: "gone" }],
    });
    expect(r.stderr).toContain("agent-vanished — stage=alive");
  });
  it("submit を確認できなければ send-unverified + 終端スナップショット一式を返す (#1864)", () => {
    const r = run(["send", "--pane", PANE, "hello"], unverifiedHerdr());
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      error: "send-unverified",
      stage: "enter",
      verify: "herdr-agent-working",
      sendVerdict: "submitted-unconfirmed",
      detection: DETECTION,
    });
    expect(r.stderr).toContain(
      "stage=enter verify=herdr-agent-working sendVerdict=submitted-unconfirmed",
    );
    expect(r.stderr).toContain("jq .detection");
    expect(r.stderr!.split("\n")).toHaveLength(1);
  });
  it("引数不足は stdout の usage JSON + exit 1", () => {
    const r = run(["send", "--pane", PANE], absentHerdr());
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      error: "usage",
      detail: "send takes (--pane <paneId> | --agent-name <name>) <text>",
    });
    expect(r.stderr).toContain("send takes");
  });
  it("宛先を positional で渡したら herdr を叩かずに usage で落ちる (#2520)", () => {
    const herdr = liveHerdr();
    const r = run(["send", PANE, "hello"], herdr);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: "usage" });
    expect(JSON.parse(r.stdout).detail).toContain("--pane");
    expect(herdr.agentGet).not.toHaveBeenCalled();
  });
  it.each([
    ["agent 名", "agent-3"],
    ["terminal_id", "term_659ae3aa37a2c53"],
    ["alphabet に無い文字", "w1:pIL"],
  ])(
    "書式の壊れた --pane (%s) は herdr を叩かずに usage で落ちる",
    (_l, pane) => {
      const herdr = liveHerdr();
      const r = run(["send", "--pane", pane, "hello"], herdr);
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: "usage" });
      expect(JSON.parse(r.stdout).detail).toContain("w<N>:p<M>");
      expect(herdr.agentGet).not.toHaveBeenCalled();
    },
  );
  it("番号に大文字を含む pane id を受理する", () => {
    const r = run(["send", "--pane", "w1:p2K", "hello"], liveHerdr());
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, target: "w1:p2K" });
  });
  it.each([
    ["両方指定", ["--pane", PANE, "--agent-name", AGENT_NAME]],
    ["どちらも無し", []],
  ])("宛先が排他 1 択にならない argv (%s) は usage で落ちる", (_l, flags) => {
    const herdr = liveHerdr();
    const r = run(["send", ...flags, "hello"], herdr);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: "usage" });
    expect(JSON.parse(r.stdout).detail).toContain("--agent-name");
    expect(herdr.agentGet).not.toHaveBeenCalled();
  });
  it("--agent-name は agent get 1 回で pane id へ畳んでから撃つ", () => {
    const herdr = liveHerdr();
    const r = run(["send", "--agent-name", AGENT_NAME, "hello"], herdr);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, target: PANE });
    expect(herdr.agentGet).toHaveBeenCalledWith(AGENT_NAME);
  });
  it("--agent-name を引けなければ agent-vanished (何も撃たない)", () => {
    const herdr = absentHerdr();
    const r = run(["send", "--agent-name", AGENT_NAME, "hello"], herdr);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      error: "agent-vanished",
      agentName: AGENT_NAME,
    });
    expect(r.stderr).toContain("agent-vanished");
  });
});
function boxClearedUnverifiedHerdr() {
  let cleared = false;
  return {
    ...liveHerdr(),
    ...fixedBox(() => {
      if (!cleared) return "書きかけの下書き";
      cleared = false;
      return "";
    }),
    paneSendKeys: (_pane: string, keys: string) => {
      if (keys === "C-c") cleared = true;
    },
    agentExplain: () => DETECTION,
  };
}
describe("h2cv send (ターンを始めないコマンド)", () => {
  it("box クリアの確認で ok:true + evidence を返す", () => {
    const r = run(["send", "--pane", PANE, "/exit"], liveHerdr());
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: true,
      target: PANE,
      attempts: 1,
      evidence: "claude-box-cleared",
    });
  });
  it("撃った後に claude が居なくなった場合は evidence=herdr-agent-gone で ok:true (#1916)", () => {
    let exited = false;
    const r = run(["send", "--pane", PANE, "/exit"], {
      ...liveHerdr(),
      paneRun: () => {
        exited = true;
      },
      ...fixedBox(() => (exited ? null : "")),
      agentGet: () =>
        exited ? null : { pane_id: PANE, terminal_id: PANE, agent: "claude" },
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: true,
      target: PANE,
      evidence: "herdr-agent-gone",
    });
  });
  it("submit を確認できなければ working 検証と同じ形の失敗 JSON を返す (#1884)", () => {
    const r = run(
      ["send", "--pane", PANE, "/exit"],
      boxClearedUnverifiedHerdr(),
    );
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      error: "send-unverified",
      stage: "box",
      target: PANE,
      attempts: 1,
      verify: "claude-box-cleared",
      sendVerdict: "not-delivered",
      boxBody: "書きかけの下書き",
      detection: DETECTION,
    });
    expect(JSON.parse(r.stdout).trace).toEqual([
      { attempt: 1, stage: "alive", ms: expect.any(Number), result: "ok" },
      { attempt: 1, stage: "box", ms: expect.any(Number), result: "foreign" },
    ]);
    expect(r.stderr).toContain(
      "stage=box verify=claude-box-cleared sendVerdict=not-delivered",
    );
    expect(r.stderr!.split("\n")).toHaveLength(1);
  });
  it("宛先を解決できなければ agent-vanished + attempts / trace を返す", () => {
    const r = run(["send", "--pane", PANE, "/exit"], absentHerdr());
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      error: "agent-vanished",
      stage: "alive",
      attempts: 1,
      trace: [{ attempt: 1, stage: "alive", result: "gone" }],
    });
  });
  it("ターンを始めるスラッシュコマンドは working 検証のまま", () => {
    const r = run(["send", "--pane", PANE, "/my-skill 1"], liveHerdr());
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: true,
      target: PANE,
      attempts: 1,
      evidence: "herdr-agent-working",
    });
  });
  it("撤去した slash サブコマンドは unknown subcommand になる", () => {
    const r = run(["slash", "--pane", PANE, "/exit"], absentHerdr());
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      error: "usage",
      detail: "unknown subcommand: slash",
    });
  });
});
describe("h2cv wait-input-ready", () => {
  it("関門を通れば ok:true + ms を返す", () => {
    const r = run(["wait-input-ready", "--pane", PANE], liveHerdr());
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, target: PANE });
  });
  it("idle を確認できなければ not-ready + stage を返す", () => {
    const herdr = { ...liveHerdr(), waitIdle: () => false };
    const r = run(
      ["wait-input-ready", "--pane", PANE, "--timeout", "1000"],
      herdr,
    );
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      error: "not-ready",
      stage: "idle",
      detection: null,
    });
  });
  it("trust ダイアログを踏んだら not-ready ではなく untrusted-workspace (#2865)", () => {
    const agentSendKeys = vi.fn();
    const herdr = {
      ...liveHerdr(),
      readVisible: () => " Yes, I trust this folder",
      agentSendKeys,
    };
    const r = run(
      ["wait-input-ready", "--pane", PANE, "--detect-interstitial"],
      herdr,
    );
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      error: "untrusted-workspace",
      stage: "dialog",
      hint: "h2cv explain input-ready",
    });
    expect(JSON.parse(r.stdout).message).toContain("hasTrustDialogAccepted");
    expect(agentSendKeys).not.toHaveBeenCalled();
  });
  it("herdr が画面を分類できていれば detection として載せる (#1864)", () => {
    const herdr = {
      ...liveHerdr(),
      waitIdle: () => false,
      agentExplain: () => DETECTION,
    };
    const r = run(
      ["wait-input-ready", "--pane", PANE, "--timeout", "1000"],
      herdr,
    );
    expect(JSON.parse(r.stdout).detection).toEqual(DETECTION);
    expect(r.stderr).not.toContain("live_blocked_form");
    expect(r.stderr).toContain("jq .detection");
  });
  it("宛先を positional で渡したら herdr を叩かずに usage で落ちる (#2520)", () => {
    const waitIdle = vi.fn(() => true);
    const herdr = { ...liveHerdr(), waitIdle };
    const r = run(["wait-input-ready", PANE], herdr);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: "usage" });
    expect(JSON.parse(r.stdout).detail).toContain("--pane");
    expect(waitIdle).not.toHaveBeenCalled();
  });
  it("--agent-name も send と同じく pane id へ畳んでから関門へ入る (#2520)", () => {
    const herdr = liveHerdr();
    const r = run(["wait-input-ready", "--agent-name", AGENT_NAME], herdr);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, target: PANE });
    expect(herdr.agentGet).toHaveBeenCalledWith(AGENT_NAME);
  });
  it("--agent-name を引けなければ agent-vanished (#2520)", () => {
    const r = run(
      ["wait-input-ready", "--agent-name", AGENT_NAME],
      absentHerdr(),
    );
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      error: "agent-vanished",
      agentName: AGENT_NAME,
    });
  });
  it("未知フラグは Node のスタックトレースにせず usage JSON に畳む", () => {
    const r = run(["wait-input-ready", "--pane", PANE, "--bogus"], liveHerdr());
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: "usage" });
    expect(JSON.parse(r.stdout).detail).toContain("--bogus");
  });
});
describe("h2cv usage", () => {
  it("--help は JSON のコマンドカタログを stdout に出して exit 0", () => {
    const r = run(["--help"]);
    const catalog = JSON.parse(r.stdout);
    expect(r.exitCode).toBe(0);
    expect(catalog.ok).toBe(true);
    expect(catalog.commands.map((c: { name: string }) => c.name)).toEqual([
      "launch",
      "send",
      "wait-input-ready",
      "self-send",
      "explain",
    ]);
    for (const c of catalog.commands) {
      expect(Object.keys(c).sort()).toEqual([
        "args",
        "flags",
        "name",
        "summary",
      ]);
    }
    expect(catalog.target).toContain("terminal_id");
  });
  it("未知サブコマンドは usage JSON + exit 1", () => {
    const r = run(["frobnicate"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      error: "usage",
      detail: "unknown subcommand: frobnicate",
    });
    expect(r.stderr).toContain("unknown subcommand");
  });
});
describe("h2cv explain (#1826)", () => {
  it("引数なしはトピック一覧 + usage を exit 0 で返す", () => {
    const r = run(["explain"]);
    const out = JSON.parse(r.stdout);
    expect(r.exitCode).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.topics.map((t: { topic: string }) => t.topic)).toEqual(
      Object.keys(TOPICS),
    );
    expect(out.usage).toContain("h2cv explain");
  });
  it("トピック名で本文と判断表を返す", () => {
    const r = run(["explain", "send-protocol"]);
    const out = JSON.parse(r.stdout);
    expect(r.exitCode).toBe(0);
    expect(out).toMatchObject({ ok: true, topic: "send-protocol" });
    expect(Array.isArray(out.body)).toBe(true);
    expect(out.tables.sendVerdict).toContainEqual(
      expect.objectContaining({ sendVerdict: "submitted-late" }),
    );
    expect(out.tables.stage).toContainEqual(
      expect.objectContaining({ stage: "enter", name: "claude-submitted" }),
    );
  });
  it("失敗 JSON の error code からも同じトピックへ引ける", () => {
    const byCode = JSON.parse(run(["explain", "send-unverified"]).stdout);
    expect(byCode.topic).toBe("send-protocol");
    expect(JSON.parse(run(["explain", "not-ready"]).stdout).topic).toBe(
      "input-ready",
    );
  });
  it("未知トピックは topics 一覧を載せた usage JSON + exit 1", () => {
    const r = run(["explain", "bogus"]);
    const out = JSON.parse(r.stdout);
    expect(r.exitCode).toBe(1);
    expect(out).toMatchObject({ ok: false, error: "usage" });
    expect(out.detail).toContain("bogus");
    expect(out.topics).toHaveLength(Object.keys(TOPICS).length);
  });
});
describe("h2cv output contract (#1823)", () => {
  const notReady = () => ({ ...liveHerdr(), waitIdle: () => false });
  const cases: {
    name: string;
    argv: string[];
    herdr?: () => HerdrPort;
    ok: boolean;
  }[] = [
    { name: "--help", argv: ["--help"], ok: true },
    { name: "help", argv: ["help"], ok: true },
    { name: "send --help", argv: ["send", "--pane", PANE, "--help"], ok: true },
    { name: "no subcommand", argv: [], ok: false },
    { name: "unknown subcommand", argv: ["frobnicate"], ok: false },
    { name: "launch --help", argv: ["launch", "--help"], ok: true },
    {
      name: "launch ok",
      argv: [...LAUNCH_ARGV, "--prompt", "hi"],
      herdr: launchableHerdr,
      ok: true,
    },
    {
      name: "launch 起動のみ",
      argv: LAUNCH_ARGV,
      herdr: launchableHerdr,
      ok: true,
    },
    {
      name: "launch tab-create-failed",
      argv: LAUNCH_ARGV,
      herdr: () => ({
        ...launchableHerdr(),
        tabCreate: () => ({ ok: false as const, stderr: "no tab" }),
      }),
      ok: false,
    },
    {
      name: "launch session-disappeared",
      argv: LAUNCH_ARGV,
      herdr: () => ({ ...launchableHerdr(), agentGet: () => null }),
      ok: false,
    },
    { name: "launch 必須フラグ不足", argv: ["launch"], ok: false },
    {
      name: "launch 未知フラグ",
      argv: [...LAUNCH_ARGV, "--bogus"],
      ok: false,
    },
    {
      name: "send ok",
      argv: ["send", "--pane", PANE, "hi"],
      herdr: liveHerdr,
      ok: true,
    },
    {
      name: "send agent-vanished",
      argv: ["send", "--pane", PANE, "hi"],
      herdr: absentHerdr,
      ok: false,
    },
    {
      name: "send send-unverified",
      argv: ["send", "--pane", PANE, "hi"],
      herdr: unverifiedHerdr,
      ok: false,
    },
    { name: "send 引数不足", argv: ["send", "--pane", PANE], ok: false },
    { name: "send 宛先が positional", argv: ["send", PANE, "hi"], ok: false },
    {
      name: "send --agent-name ok",
      argv: ["send", "--agent-name", AGENT_NAME, "hi"],
      herdr: liveHerdr,
      ok: true,
    },
    {
      name: "send --agent-name agent-vanished",
      argv: ["send", "--agent-name", AGENT_NAME, "hi"],
      herdr: absentHerdr,
      ok: false,
    },
    {
      name: "send 宛先フラグ二重指定",
      argv: ["send", "--pane", PANE, "--agent-name", AGENT_NAME, "hi"],
      ok: false,
    },
    {
      name: "send box-cleared ok",
      argv: ["send", "--pane", PANE, "/exit"],
      herdr: liveHerdr,
      ok: true,
    },
    {
      name: "send box-cleared agent-vanished",
      argv: ["send", "--pane", PANE, "/exit"],
      herdr: absentHerdr,
      ok: false,
    },
    {
      name: "send box-cleared send-unverified",
      argv: ["send", "--pane", PANE, "/exit"],
      herdr: boxClearedUnverifiedHerdr,
      ok: false,
    },
    {
      name: "wait-input-ready ok",
      argv: ["wait-input-ready", "--pane", PANE],
      herdr: liveHerdr,
      ok: true,
    },
    {
      name: "wait-input-ready not-ready",
      argv: ["wait-input-ready", "--pane", PANE, "--timeout", "1000"],
      herdr: notReady,
      ok: false,
    },
    {
      name: "wait-input-ready not-ready (detection つき)",
      argv: ["wait-input-ready", "--pane", PANE, "--timeout", "1000"],
      herdr: () => ({ ...notReady(), agentExplain: () => DETECTION }),
      ok: false,
    },
    {
      name: "wait-input-ready 引数不足",
      argv: ["wait-input-ready"],
      ok: false,
    },
    {
      name: "wait-input-ready --agent-name ok",
      argv: ["wait-input-ready", "--agent-name", AGENT_NAME],
      herdr: liveHerdr,
      ok: true,
    },
    {
      name: "wait-input-ready --agent-name agent-vanished",
      argv: ["wait-input-ready", "--agent-name", AGENT_NAME],
      herdr: absentHerdr,
      ok: false,
    },
    {
      name: "wait-input-ready 宛先が positional",
      argv: ["wait-input-ready", PANE],
      ok: false,
    },
    {
      name: "wait-input-ready 不正な --timeout",
      argv: ["wait-input-ready", "--pane", PANE, "--timeout", "0"],
      ok: false,
    },
    {
      name: "wait-input-ready 未知フラグ",
      argv: ["wait-input-ready", "--pane", PANE, "--bogus"],
      ok: false,
    },
    { name: "explain 一覧", argv: ["explain"], ok: true },
    { name: "explain topic", argv: ["explain", "send-protocol"], ok: true },
    {
      name: "explain error code",
      argv: ["explain", "send-unverified"],
      ok: true,
    },
    { name: "explain 未知 topic", argv: ["explain", "bogus"], ok: false },
  ];
  function runCase(argv: string[], herdr?: () => HerdrPort) {
    return run(argv, (herdr ?? absentHerdr)());
  }
  it.each(cases)(
    "$name の stdout は 1 個の pretty JSON",
    ({ argv, herdr, ok }) => {
      const r = runCase(argv, herdr);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.ok).toBe(ok);
      expect(r.exitCode).toBe(ok ? 0 : 1);
      expect(r.stdout).toBe(JSON.stringify(parsed, null, 2));
    },
  );
  it.each(cases.filter((c) => !c.ok))(
    "$name の stderr は人間向けの 1 行",
    ({ argv, herdr }) => {
      const r = runCase(argv, herdr);
      expect(r.stderr).toBeTruthy();
      expect(r.stderr!.split("\n")).toHaveLength(1);
    },
  );
  it.each(cases.filter((c) => c.ok))(
    "$name の成功経路は stderr を汚さない",
    ({ argv, herdr }) => {
      const r = runCase(argv, herdr);
      expect(r.stderr).toBeUndefined();
    },
  );
  it.each(cases.filter((c) => !c.ok))(
    "$name の失敗 JSON に explain への hint が載る",
    ({ argv, herdr }) => {
      const payload = JSON.parse(runCase(argv, herdr).stdout);
      expect(payload.hint).toBe(hintFor(payload.error));
    },
  );
  it("サブコマンドの --help はカタログの該当 1 件を返す (#1947)", () => {
    const catalog = JSON.parse(runCase(["--help"]).stdout);
    const payload = JSON.parse(
      runCase(["send", "--pane", PANE, "--help"]).stdout,
    );
    expect(payload.command).toEqual(
      catalog.commands.find((c: { name: string }) => c.name === "send"),
    );
    expect(payload.target).toBe(catalog.target);
  });
  it("usage は回復手段 (recovery) と学習経路 (hint) を別フィールドで持つ", () => {
    const payload = JSON.parse(run(["frobnicate"]).stdout);
    expect(payload.recovery).toContain("--help");
    expect(payload.hint).toBe("h2cv explain output-contract");
  });
});
