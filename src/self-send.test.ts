import type { HerdrSendPort } from "./herdr-adapter.js";
import type { SelfSendEnv } from "./self-send.js";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { fakeSendPort } from "./__tests__/fakes.js";
import { selfSend, selfSendWatchLog } from "./self-send.js";

const PANE = "w1:p1";
function env(over: Partial<SelfSendEnv> = {}): SelfSendEnv & {
  armed: {
    prompts: string[];
    logPath: string;
  }[];
} {
  const armed: {
    prompts: string[];
    logPath: string;
  }[] = [];
  return {
    pane: PANE,
    arm: (prompts, logPath) => armed.push({ prompts, logPath }),
    armed,
    ...over,
  };
}
function herdr(over: Partial<HerdrSendPort> = {}): HerdrSendPort {
  return {
    ...fakeSendPort(),
    agentGet: () => ({
      agent: "claude",
      agent_status: "idle",
      pane_id: PANE,
    }),
    ...over,
  };
}
describe("selfSend (武装モード)", () => {
  it("watcher を起こして armed を返す (この時点では何も撃っていない)", () => {
    const e = env();
    const r = selfSend(["/exit"], herdr(), e);
    expect(r).toEqual({
      ok: true,
      payload: { target: PANE, prompts: ["/exit"], armed: true },
    });
    expect(e.armed).toEqual([
      { prompts: ["/exit"], logPath: selfSendWatchLog(PANE) },
    ]);
  });
  it("複数コマンドは 1 つの watcher にまとめて渡す (順序はそのまま)", () => {
    const e = env();
    const r = selfSend(["/rename [exiting]my-session", "/exit"], herdr(), e);
    expect(r).toEqual({
      ok: true,
      payload: {
        target: PANE,
        prompts: ["/rename [exiting]my-session", "/exit"],
        armed: true,
      },
    });
    expect(e.armed).toHaveLength(1);
    expect(e.armed[0]?.prompts).toEqual([
      "/rename [exiting]my-session",
      "/exit",
    ]);
  });
  it("終端コマンドの後ろに何か続いたら usage (撃った時点で pane が無い)", () => {
    const e = env();
    const r = selfSend(["/exit", "/clear"], herdr(), e);
    expect(r).toMatchObject({ ok: false, error: "usage" });
    expect(
      String(
        (
          r as {
            summary: string;
          }
        ).summary,
      ),
    ).toContain("come last");
    expect(e.armed).toEqual([]);
  });
  it("スラッシュ以外が 1 つでも混ざれば全体を usage で弾く", () => {
    const e = env();
    expect(selfSend(["/clear", "こんにちは"], herdr(), e)).toMatchObject({
      ok: false,
      error: "usage",
    });
    expect(e.armed).toEqual([]);
  });
  it("pane が取れなければ usage (実行環境に宛先が無い)", () => {
    const r = selfSend(["/exit"], herdr(), env({ pane: null }));
    expect(r).toMatchObject({ ok: false, error: "usage" });
  });
  it("平文とスラッシュ以外は usage (send の担当領域)", () => {
    for (const argv of [[], ["こんにちは"], [""]]) {
      expect(selfSend(argv, herdr(), env())).toMatchObject({
        ok: false,
        error: "usage",
      });
    }
  });
});
describe("selfSend (watcher モード)", () => {
  it("idle 到達 + 入力欄が空なら送出して成功する", () => {
    const r = selfSend(["--watch", "/exit"], herdr(), env());
    expect(r).toMatchObject({
      ok: true,
      payload: {
        target: PANE,
        prompts: ["/exit"],
        sent: [{ prompt: "/exit", evidence: "claude-box-cleared" }],
      },
    });
  });
  it("ターンを始めるコマンドは working 検証で通る (#2371 / #2507)", () => {
    const r = selfSend(["--watch", "/my-skill 1"], herdr(), env());
    expect(r).toEqual({
      ok: true,
      payload: {
        target: PANE,
        prompts: ["/my-skill 1"],
        sent: [{ prompt: "/my-skill 1", evidence: "herdr-agent-working" }],
      },
    });
  });
  it("複数コマンドを順に打ち、成立した証拠を打った順で返す", () => {
    const typed: string[] = [];
    const r = selfSend(
      ["--watch", "/rename [exiting]my-session", "/exit"],
      herdr({
        paneRun: (_pane: string, text: string) => {
          typed.push(text);
        },
      }),
      env(),
    );
    expect(r).toMatchObject({
      ok: true,
      payload: {
        target: PANE,
        prompts: ["/rename [exiting]my-session", "/exit"],
        sent: [
          {
            prompt: "/rename [exiting]my-session",
            evidence: "claude-box-cleared",
          },
          { prompt: "/exit", evidence: "claude-box-cleared" },
        ],
      },
    });
    expect(typed).toEqual(["/rename [exiting]my-session ", "/exit "]);
  });
  it("途中で失敗したら残りを打たず、sent と failedAt を載せる", () => {
    const typed: string[] = [];
    const r = selfSend(
      ["--watch", "/clear", "/exit"],
      herdr({
        paneRun: (_pane: string, text: string) => {
          typed.push(text);
        },
        agentGet: () =>
          typed.length >= 1
            ? null
            : { agent: "claude", agent_status: "idle", pane_id: PANE },
      }),
      env(),
    );
    expect(r).toMatchObject({
      ok: false,
      error: "agent-vanished",
      payload: {
        stage: "alive",
        prompts: ["/clear", "/exit"],
        prompt: "/exit",
        failedAt: 2,
        sent: [{ prompt: "/clear", evidence: "claude-box-cleared" }],
      },
    });
    expect(typed).toEqual(["/clear "]);
  });
  it("ターンが明けなければ not-ready (stage=idle) で、撃たずに終わる", () => {
    let ran = 0;
    const r = selfSend(
      ["--watch", "/exit"],
      herdr({
        waitIdle: () => false,
        paneRun: () => {
          ran++;
        },
      }),
      env(),
    );
    expect(r).toMatchObject({
      ok: false,
      error: "not-ready",
      payload: {
        prompts: ["/exit"],
        stage: "idle",
        timeoutMs: expect.any(Number),
        elapsedMs: expect.any(Number),
      },
    });
    expect(ran).toBe(0);
  });
  it("background work が matched なら idle 相当で抜けて送出する", () => {
    const r = selfSend(
      ["--watch", "/exit"],
      herdr({
        waitIdle: () => false,
        agentExplain: () => ({
          state: "working",
          matchedRule: {
            id: "background_shell_working",
            state: "working",
            priority: 965,
          },
          visibleBlocker: false,
          visibleIdle: false,
          visibleWorking: true,
          fallbackReason: null,
          manifestVersion: "2026.08.21.1",
          rules: [{ id: "background_shell_working", matched: true }],
          regions: {},
        }),
      }),
      env(),
    );
    expect(r).toMatchObject({
      ok: true,
      payload: {
        prompts: ["/exit"],
        sent: [{ prompt: "/exit", evidence: "claude-box-cleared" }],
      },
    });
  });
  it("入力欄に書きかけがあれば not-ready (stage=draft) で、書きかけごと submit しない", () => {
    let ran = 0;
    const r = selfSend(
      ["--watch", "/exit"],
      herdr({
        readBoxBody: () => "書きかけ",
        paneRun: () => {
          ran++;
        },
      }),
      env(),
    );
    expect(r).toMatchObject({
      ok: false,
      error: "not-ready",
      payload: { prompts: ["/exit"], stage: "draft", boxBody: "書きかけ" },
    });
    expect(ran).toBe(0);
  });
  it("入力欄を読めない (判定不能) もキャンセル側へ倒し、値をそのまま載せる", () => {
    const r = selfSend(
      ["--watch", "/exit"],
      herdr({ readBoxBody: () => null }),
      env(),
    );
    expect(r).toMatchObject({
      ok: false,
      error: "not-ready",
      payload: { stage: "draft", boxBody: null },
    });
  });
  it("宛先が消えていれば agent-vanished", () => {
    const r = selfSend(
      ["--watch", "/exit"],
      herdr({ agentGet: () => null }),
      env(),
    );
    expect(r).toMatchObject({
      ok: false,
      error: "agent-vanished",
      payload: { stage: "alive" },
    });
  });
  it("submit を確認できなければ send-unverified に止まった段が載る (#2630)", () => {
    const r = selfSend(
      ["--watch", "/my-skill 1"],
      herdr({ waitWorking: () => false }),
      env(),
    );
    expect(r).toMatchObject({
      ok: false,
      error: "send-unverified",
      payload: { stage: "enter", prompt: "/my-skill 1", failedAt: 1 },
    });
    expect(
      (
        r as {
          summary: string;
        }
      ).summary,
    ).toContain("stage=enter");
  });
});
describe("selfSendWatchLog", () => {
  it("pane 別に割り、id の記号はファイル名として安全な文字へ潰す", () => {
    expect(selfSendWatchLog("w1:p2")).toBe(
      `${tmpdir()}/h2cv-self-send-watch-w1_p2.log`,
    );
    expect(selfSendWatchLog("w1:p2")).not.toBe(selfSendWatchLog("w1:p3"));
  });
});
