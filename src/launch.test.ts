import type { LaunchDeps, LaunchRequest } from "./launch.js";
import type { HerdrPort } from "./launcher.js";
import { describe, expect, it } from "vitest";
import { fakeHerdrPort, FAST_TIMINGS } from "./__tests__/fakes.js";
import { runLaunch } from "./launch.js";

const REQ: LaunchRequest = {
  cwd: "/wt/owner/repo/2063",
  agentName: "repo-2063",
  prompt: "/my-skill run the tests",
};
function deps(herdr: HerdrPort = fakeHerdrPort()): LaunchDeps {
  return { herdr, timings: FAST_TIMINGS };
}
function idleUntil(nth: number): Partial<HerdrPort> {
  let calls = 0;
  const answer = () => ++calls < nth;
  return { waitIdle: answer, waitIdleOrBlocked: answer };
}
describe("runLaunch", () => {
  it("happy path: 起動 → 関門 → 送出まで通って成功 JSON を返す", () => {
    const r = runLaunch(REQ, deps());
    expect(r).toMatchObject({
      ok: true,
      value: {
        ok: true,
        agentName: "repo-2063",
        pane: "w1:p1",
        promptSent: true,
        attempts: 1,
      },
    });
    if (!r.ok) throw new Error("expected ok");
    expect(Object.keys(r.value).sort()).toEqual([
      "agentName",
      "attempts",
      "ok",
      "pane",
      "promptSent",
      "readyMs",
      "trace",
    ]);
    expect(r.value.trace.map((e) => `${e.attempt ?? "-"} ${e.stage}`)).toEqual([
      "- probe",
      "- tab",
      "- shell",
      "- start",
      "- agent",
      "- idle",
      "- box",
      "- rc",
      "1 alive",
      "1 box",
      "1 type",
      "1 enter",
    ]);
  });
  it("prompt 未指定は送出経路ごと飛ばして起動だけで完了する", () => {
    const { prompt: _dropped, ...noPrompt } = REQ;
    const r = runLaunch(noPrompt, deps());
    if (!r.ok) throw new Error("expected ok");
    expect(r.value).toMatchObject({ promptSent: false, pane: "w1:p1" });
    expect(r.value).not.toHaveProperty("attempts");
    expect(r.value).toHaveProperty("readyMs");
  });
  it("prompt が空文字でも同じ (起動だけの意思表示)", () => {
    const r = runLaunch({ ...REQ, prompt: "" }, deps());
    expect(r).toMatchObject({ ok: true, value: { promptSent: false } });
  });
  it("cwd は tab create へそのまま渡る (起動 cwd を決めるのは呼び出し側)", () => {
    const seen: string[] = [];
    const herdr = fakeHerdrPort({
      tabCreate: (label, cwd) => {
        seen.push(`${label} ${cwd}`);
        return { ok: true, tabId: "t1", paneId: "w1:p1" };
      },
    });
    runLaunch(REQ, deps(herdr));
    expect(seen).toEqual(["repo-2063 /wt/owner/repo/2063"]);
  });
  describe("agentName 省略", () => {
    const { agentName: _dropped, ...NO_NAME } = REQ;
    it("pane id から生成した名前で起動し、成功 JSON にもその名前が載る", () => {
      const started: string[] = [];
      const herdr = fakeHerdrPort({
        agentStart: (name) => {
          started.push(name);
          return { ok: true };
        },
      });
      const r = runLaunch(NO_NAME, deps(herdr));
      expect(r).toMatchObject({
        ok: true,
        value: { agentName: "h2cv-w1-p1", pane: "w1:p1" },
      });
      expect(started).toEqual(["h2cv-w1-p1"]);
    });
    it("tab の label は cwd の basename になる (名前が無くても tab を見分けられる)", () => {
      const seen: string[] = [];
      const herdr = fakeHerdrPort({
        tabCreate: (label, cwd) => {
          seen.push(`${label} ${cwd}`);
          return { ok: true, tabId: "t1", paneId: "w1:p1" };
        },
      });
      runLaunch(NO_NAME, deps(herdr));
      expect(seen).toEqual(["2063 /wt/owner/repo/2063"]);
    });
    it("--pane 経路でも受け取った pane id から生成し、大文字は小文字へ落とす", () => {
      const started: string[] = [];
      const herdr = fakeHerdrPort({
        agentStart: (name) => {
          started.push(name);
          return { ok: true };
        },
        agentGet: () => ({
          agent: "claude",
          agent_status: "idle",
          pane_id: "w9:p2K",
        }),
      });
      const r = runLaunch({ paneId: "w9:p2K", prompt: "" }, deps(herdr));
      expect(r).toMatchObject({
        ok: true,
        value: { agentName: "h2cv-w9-p2k" },
      });
      expect(started).toEqual(["h2cv-w9-p2k"]);
    });
  });
  it("起動 argv は 1 本も足さず、claudeArgv をそのまま素通しする", () => {
    const seen: string[][] = [];
    const herdr = fakeHerdrPort({
      agentStart: (_name, _pane, argv) => {
        seen.push(argv);
        return { ok: true };
      },
    });
    runLaunch(
      { ...REQ, claudeArgv: ["--model", "fable", "--append", "x"] },
      deps(herdr),
    );
    expect(seen).toEqual([["--model", "fable", "--append", "x"]]);
  });
  it("server が居なければ何も起こさず server-down", () => {
    const started: string[] = [];
    const herdr = fakeHerdrPort({
      probeServer: () => "down",
      tabCreate: (label) => {
        started.push(label);
        return { ok: true, tabId: "t1", paneId: "w1:p1" };
      },
    });
    expect(runLaunch(REQ, deps(herdr))).toMatchObject({
      ok: false,
      failure: {
        error: "server-down",
        message: expect.stringContaining("herdr server"),
      },
    });
    expect(started).toEqual([]);
  });
  it("server が非互換なら server-protocol-mismatch (server-down に畳まない)", () => {
    const started: string[] = [];
    const herdr = fakeHerdrPort({
      probeServer: () => "protocol-mismatch",
      tabCreate: (label) => {
        started.push(label);
        return { ok: true, tabId: "t1", paneId: "w1:p1" };
      },
    });
    expect(runLaunch(REQ, deps(herdr))).toMatchObject({
      ok: false,
      failure: {
        error: "server-protocol-mismatch",
        message: expect.stringContaining("herdr server stop"),
      },
    });
    expect(started).toEqual([]);
  });
  it("tab 作成の失敗は tab-create-failed (cwd 込みで返す)", () => {
    const herdr = fakeHerdrPort({
      tabCreate: () => ({ ok: false, stderr: "no tab" }),
    });
    expect(runLaunch(REQ, deps(herdr))).toMatchObject({
      ok: false,
      failure: {
        error: "tab-create-failed",
        agentName: "repo-2063",
        cwd: "/wt/owner/repo/2063",
        stderr: "no tab",
      },
    });
  });
  it("プローブ握手が通らなければ start-failed で止まり、agent start へ進まない", () => {
    const started: string[] = [];
    const herdr = fakeHerdrPort({
      paneWaitOutput: () => false,
      paneReadRecent: () => "$ ",
      agentStart: (name) => {
        started.push(name);
        return { ok: true };
      },
    });
    const r = runLaunch(REQ, deps(herdr));
    expect(r).toMatchObject({
      ok: false,
      failure: {
        error: "start-failed",
        agentName: "repo-2063",
        stderr: expect.stringContaining("shell-not-ready"),
        paneTail: "$ ",
      },
    });
    if (r.ok) throw new Error("expected not ok");
    expect(r.failure.probeCount).toBeGreaterThan(0);
    expect(started).toEqual([]);
  });
  it("agent start が agent_not_ready でも start-failed にせず readiness まで進む", () => {
    const herdr = fakeHerdrPort({
      agentStart: () => ({ ok: true, notReady: true }),
    });
    const r = runLaunch(REQ, deps(herdr));
    expect(r).toMatchObject({ ok: true, value: { ok: true, pane: "w1:p1" } });
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.trace).toContainEqual({
      stage: "start",
      ms: expect.any(Number),
      result: "fail-open",
    });
  });
  it("通常の起動では start 段が result: ok で載る", () => {
    const r = runLaunch(REQ, deps());
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.trace).toContainEqual({
      stage: "start",
      ms: expect.any(Number),
      result: "ok",
    });
  });
  it("1 回飲まれてもプローブを打ち直して起動まで進む", () => {
    let waits = 0;
    const herdr = fakeHerdrPort({ paneWaitOutput: () => ++waits >= 2 });
    expect(runLaunch(REQ, deps(herdr))).toMatchObject({
      ok: true,
      value: { promptSent: true },
    });
    expect(waits).toBe(2);
  });
  it("起動の失敗は start-failed", () => {
    const herdr = fakeHerdrPort({
      agentStart: () => ({ ok: false, stderr: "boom" }),
    });
    expect(runLaunch(REQ, deps(herdr))).toMatchObject({
      ok: false,
      failure: { error: "start-failed", stage: "start", stderr: "boom" },
    });
  });
  it("起動したはずの agent が消えていれば agent-vanished (#2507 で統合)", () => {
    const herdr = fakeHerdrPort({ agentGet: () => null });
    expect(runLaunch(REQ, deps(herdr))).toMatchObject({
      ok: false,
      failure: {
        error: "agent-vanished",
        stage: "agent",
        agentName: "repo-2063",
      },
    });
  });
  it("入力受付まで届かなければ launch-timeout (止まった段を stage に載せる)", () => {
    const sends: string[] = [];
    const herdr = fakeHerdrPort({
      ...idleUntil(2),
      paneSendText: (_pane, text) => {
        sends.push(text);
      },
    });
    expect(runLaunch(REQ, deps(herdr))).toMatchObject({
      ok: false,
      failure: {
        error: "launch-timeout",
        agentName: "repo-2063",
        stage: "idle",
      },
    });
    expect(sends).toEqual([]);
  });
  it("送出中に宛先が消えたら agent-vanished (跡地には撃たない)", () => {
    let gets = 0;
    const herdr = fakeHerdrPort({
      agentGet: () =>
        ++gets > 1
          ? null
          : { agent: "claude", agent_status: "idle", pane_id: "w1:p1" },
    });
    expect(runLaunch(REQ, deps(herdr))).toMatchObject({
      ok: false,
      failure: { error: "agent-vanished", pane: "w1:p1" },
    });
  });
  describe("--pane (既存 pane 経路)", () => {
    const PANE_REQ: LaunchRequest = {
      paneId: "w9:p3",
      agentName: "repo-2334",
      prompt: "/my-skill run the tests",
    };
    it("server は検査するが tab は作らず、渡された pane へ起動して送出まで通る", () => {
      const probed: number[] = [];
      const herdr = fakeHerdrPort({
        probeServer: () => {
          probed.push(1);
          return "up";
        },
        tabCreate: () => ({ ok: false, stderr: "呼ばれてはいけない" }),
        agentGet: () => ({
          agent: "claude",
          agent_status: "idle",
          pane_id: "w9:p3",
        }),
      });
      expect(runLaunch(PANE_REQ, deps(herdr))).toMatchObject({
        ok: true,
        value: { agentName: "repo-2334", pane: "w9:p3", promptSent: true },
      });
      expect(probed).toEqual([1]);
    });
    it("server が居なければ pane 経路でも即座に server-down", () => {
      const herdr = fakeHerdrPort({
        probeServer: () => "down",
        agentStart: () => ({ ok: false, stderr: "呼ばれてはいけない" }),
      });
      expect(runLaunch(PANE_REQ, deps(herdr))).toMatchObject({
        ok: false,
        failure: { error: "server-down" },
      });
    });
    it("起動 (agent start) の宛先は受け取った pane", () => {
      const seen: string[] = [];
      const herdr = fakeHerdrPort({
        agentStart: (_name, pane) => {
          seen.push(pane);
          return { ok: true };
        },
        agentGet: () => ({
          agent: "claude",
          agent_status: "idle",
          pane_id: "w9:p3",
        }),
      });
      runLaunch(PANE_REQ, deps(herdr));
      expect(seen).toEqual(["w9:p3"]);
    });
    it("受け取った pane でもプローブ握手を踏み直し、通らなければ start-failed", () => {
      const started: string[] = [];
      const probed: string[] = [];
      const herdr = fakeHerdrPort({
        paneRun: (pane) => {
          probed.push(pane);
        },
        paneWaitOutput: () => false,
        paneReadRecent: () => "$ ",
        agentStart: (name) => {
          started.push(name);
          return { ok: true };
        },
      });
      expect(runLaunch(PANE_REQ, deps(herdr))).toMatchObject({
        ok: false,
        failure: {
          error: "start-failed",
          agentName: "repo-2334",
          stderr: expect.stringContaining("w9:p3"),
        },
      });
      expect(probed).toContain("w9:p3");
      expect(started).toEqual([]);
    });
  });
  it("submit 成立を確認できなければ誤った成功を返さず send-unverified", () => {
    const herdr = fakeHerdrPort({
      waitWorking: () => false,
      readBoxBody: () => "先客の本文",
      agentSendKeys: () => {},
    });
    expect(runLaunch(REQ, deps(herdr))).toMatchObject({
      ok: false,
      failure: {
        error: "send-unverified",
        stage: "box",
        sendVerdict: "not-delivered",
      },
    });
  });
});
