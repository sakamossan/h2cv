import type { HerdrSendPort, ScreenDetection } from "./herdr-adapter.js";
import type { SendEvidence, SendResult } from "./sender.js";
import type { TraceEntry } from "./stages.js";
import type { SessionTimings } from "./timings.js";
import { describe, expect, it, vi } from "vitest";
import { fakeSendPort } from "./__tests__/fakes.js";
import {
  AgentSender,
  BACKGROUND_WORK_RULE_IDS,
  classifyVerdict,
  inputReadyGate,
  isTurnlessCommand,
  matchOwnBody,
  splitChunks,
  TERMINATING_SLASH_COMMANDS,
  TURNLESS_SLASH_COMMANDS,
  waitInputAccepting,
} from "./sender.js";
import {
  EXIT_DIALOG_MAX_ENTERS,
  INTERSTITIAL_MAX_ENTERS,
  SEND_CHUNK_MAX_BYTES,
  SEND_MAX_ATTEMPTS,
} from "./stages.js";

const PANE = "w1:p1";
const AGENT = "agent-3";
const TEXT = "/loop 30m /run-in-the-loop";
function boxHerdr(opts: {
  read: () => string | null;
  truncated?: () => boolean;
  onSendText?: (text: string) => void;
  onSendKeys?: (keys: string) => void;
  working?: () => boolean;
  pane?: () => string | null;
  status?: () => string | undefined;
  agent?: () => string | null;
}) {
  const pane = opts.pane ?? (() => PANE);
  const agent = opts.agent ?? (() => AGENT);
  return {
    ...fakeSendPort(),
    agentGet: vi.fn(() => {
      const p = pane();
      const a = agent();
      return p === null
        ? null
        : {
            pane_id: p,
            agent_status: opts.status?.(),
            ...(a === null ? {} : { agent: a }),
          };
    }),
    readBox: vi.fn(() => {
      const body = opts.read();
      return body === null
        ? null
        : { body, truncated: opts.truncated?.() ?? false };
    }),
    readBoxBody: vi.fn(opts.read),
    paneSendText: vi.fn((_pane: string, text: string) =>
      opts.onSendText?.(text),
    ),
    agentSendKeys: vi.fn((_target: string, keys: string) =>
      opts.onSendKeys?.(keys),
    ),
    paneRun: vi.fn(),
    waitWorking: vi.fn(opts.working ?? (() => true)),
  } satisfies HerdrSendPort;
}
const TEST_TIMINGS: SessionTimings = {
  pollIntervalMs: 1,
  boxReadyTimeoutMs: 30,
  landingTimeoutMs: 30,
  slashSubmitFloorMs: 4,
  exitDialogGoneTimeoutMs: 20,
  inputReadyPollMs: 1,
  inputReadyTimeoutMs: 300,
  idleProbeSliceMs: 1,
  rcConnectTimeoutMs: 200,
  interstitialSettleMs: 5,
  readinessPanePollMs: 10,
  shellReadyTimeoutMs: 30,
  shellProbeWaitMs: 5,
};
const sender = (herdr: HerdrSendPort, timings?: Partial<SessionTimings>) =>
  new AgentSender(herdr, PANE, { ...TEST_TIMINGS, ...timings });
const bgDetection = (matchedRuleId: string): ScreenDetection => ({
  state: "working",
  matchedRule: { id: matchedRuleId, state: "working", priority: 965 },
  visibleBlocker: false,
  visibleIdle: false,
  visibleWorking: true,
  fallbackReason: null,
  manifestVersion: "2026.08.21.1",
  rules: [{ id: matchedRuleId, matched: true }],
  regions: {},
});
const marks = (trace: readonly TraceEntry[]) =>
  trace.map(
    (e) =>
      `${e.attempt === undefined ? "" : `${e.attempt} `}${e.stage}:${e.result}`,
  );
const attemptMarks = (n: number, ...stages: string[]) =>
  Array.from({ length: n }, (_, i) =>
    stages.map((s) => `${i + 1} ${s}`),
  ).flat();
describe("AgentSender.send", () => {
  it("box が空なら send → landing 確認 → Enter の順で撃ち、1 試行で成功する", () => {
    let box = "";
    const herdr = boxHerdr({
      read: () => box,
      onSendText: (text) => {
        box = text;
      },
      onSendKeys: () => {
        box = "";
      },
    });
    const result = sender(herdr).send(TEXT);
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(marks(result.trace)).toEqual([
      "1 alive:ok",
      "1 box:ok",
      "1 type:ok",
      "1 enter:ok",
    ]);
    expect(herdr.paneSendText).toHaveBeenCalledWith(PANE, TEXT);
    expect(herdr.waitWorking).toHaveBeenCalledWith(PANE, expect.any(Number));
    expect(herdr.agentSendKeys).toHaveBeenCalledWith(PANE, "Enter");
    expect(herdr.paneRun).not.toHaveBeenCalled();
  });
  it("Enter が食われて本文が box に残っても再タイプせず Enter だけ撃ち直す", () => {
    let box = "";
    let enters = 0;
    const herdr = boxHerdr({
      read: () => box,
      onSendText: (text) => {
        box = text;
      },
      onSendKeys: (keys) => {
        if (keys !== "Enter") return;
        enters += 1;
        if (enters >= 2) box = "";
      },
      working: () => enters >= 2,
    });
    const result = sender(herdr).send(TEXT);
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(marks(result.trace)).toEqual([
      "1 alive:ok",
      "1 box:ok",
      "1 type:ok",
      "1 enter:timeout",
      "2 alive:ok",
      "2 box:ok",
      "2 enter:ok",
    ]);
    expect(herdr.paneSendText).toHaveBeenCalledTimes(1);
    expect(enters).toBe(2);
  });
  it("box が空のまま landing しなければ再タイプ経路が働く (#1209 のドロップ救済)", () => {
    const herdr = boxHerdr({ read: () => "", working: () => false });
    const result = sender(herdr).send(TEXT);
    expect(result).toMatchObject({
      ok: false,
      reason: "unverified",
      sendVerdict: "not-delivered",
    });
    expect(marks(result.trace)).toEqual([
      ...attemptMarks(SEND_MAX_ATTEMPTS, "alive:ok", "box:ok", "type:timeout"),
      "grace:timeout",
    ]);
    expect(herdr.paneSendText).toHaveBeenCalledTimes(SEND_MAX_ATTEMPTS);
    expect(herdr.agentSendKeys).not.toHaveBeenCalled();
  });
  it("別内容が残っていたら何も撃たずに 1 周で止める (#2505)", () => {
    const herdr = boxHerdr({
      read: () => "書きかけの下書き",
      working: () => false,
    });
    const result = sender(herdr).send(TEXT);
    expect(result).toMatchObject({
      ok: false,
      reason: "unverified",
      attempts: 1,
      boxBody: "書きかけの下書き",
      sendVerdict: "not-delivered",
    });
    expect(marks(result.trace)).toEqual([
      "1 alive:ok",
      "1 box:foreign",
      "grace:timeout",
    ]);
    expect(herdr.paneSendText).not.toHaveBeenCalled();
    expect(herdr.agentSendKeys).not.toHaveBeenCalled();
  });
  it("box を読めなければ (null) 本文を撃たない", () => {
    const herdr = boxHerdr({ read: () => null, working: () => false });
    const result = sender(herdr).send(TEXT);
    expect(result).toMatchObject({
      ok: false,
      reason: "unverified",
      boxBody: null,
      sendVerdict: "unreadable",
    });
    expect(marks(result.trace)).toEqual([
      ...attemptMarks(SEND_MAX_ATTEMPTS, "alive:ok", "box:timeout"),
      "grace:timeout",
    ]);
    expect(herdr.paneSendText).not.toHaveBeenCalled();
    expect(herdr.agentSendKeys).not.toHaveBeenCalled();
  });
  it("送出本文が box に残ったまま上限に達したら landed-not-submitted で終わる (#1751)", () => {
    const herdr = boxHerdr({ read: () => TEXT, working: () => false });
    const result = sender(herdr).send(TEXT);
    expect(result).toMatchObject({
      ok: false,
      reason: "unverified",
      sendVerdict: "landed-not-submitted",
      boxBody: TEXT,
    });
    expect(marks(result.trace)).toEqual([
      ...attemptMarks(SEND_MAX_ATTEMPTS, "alive:ok", "box:ok", "enter:timeout"),
      "grace:timeout",
    ]);
    expect(
      herdr.agentSendKeys.mock.calls.filter(([, keys]) => keys !== "Enter"),
    ).toEqual([]);
  });
  it("上限到達後の grace で working に遷移したら submitted-late を返す (#1751)", () => {
    let box = "";
    let waits = 0;
    const herdr = boxHerdr({
      read: () => box,
      onSendText: (text) => {
        box = text;
      },
      working: () => ++waits > SEND_MAX_ATTEMPTS,
    });
    const result = sender(herdr).send(TEXT);
    expect(result).toMatchObject({
      ok: false,
      reason: "unverified",
      sendVerdict: "submitted-late",
      boxBody: TEXT,
    });
    expect(marks(result.trace).at(-1)).toBe("grace:ok");
  });
  it("終端 status が working なら grace が空振りでも submitted-late に倒す (#1751)", () => {
    let gets = 0;
    const herdr = boxHerdr({
      read: () => "",
      working: () => false,
      status: () => (++gets > SEND_MAX_ATTEMPTS ? "working" : "idle"),
    });
    expect(sender(herdr).send(TEXT)).toMatchObject({
      verify: "herdr-agent-working",
      sendVerdict: "submitted-late",
      lastAgentStatus: "working",
    });
  });
  it("折り返しでインデントの付いた box 本文も送出本文と同一とみなす", () => {
    let enters = 0;
    const herdr = boxHerdr({
      read: () => "/loop 30m /run-in-the- loop",
      onSendKeys: (keys) => {
        if (keys === "Enter") enters += 1;
      },
      working: () => true,
    });
    const result = sender(herdr).send(TEXT);
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(marks(result.trace)).toEqual([
      "1 alive:ok",
      "1 box:ok",
      "1 enter:ok",
    ]);
    expect(herdr.paneSendText).not.toHaveBeenCalled();
    expect(enters).toBe(1);
  });
});
describe("splitChunks (#3205)", () => {
  it("上限以下の本文は 1 要素 = 従来どおりの 1 write", () => {
    expect(splitChunks("abc", 10)).toEqual(["abc"]);
  });
  it("上限ちょうどでも割らない", () => {
    expect(splitChunks("abcde", 5)).toEqual(["abcde"]);
  });
  it("上限を 1 byte 超えたら割る", () => {
    expect(splitChunks("abcdef", 5)).toEqual(["abcde", "f"]);
  });
  it("マルチバイト文字を途中で割らない", () => {
    const chunks = splitChunks("あああああ", 7);
    expect(chunks).toEqual(["ああ", "ああ", "あ"]);
    for (const c of chunks)
      expect(Buffer.byteLength(c, "utf8")).toBeLessThanOrEqual(7);
  });
  it("空文字は空配列 (撃つものが無い)", () => {
    expect(splitChunks("", 10)).toEqual([]);
  });
  it("連結すると元の本文に戻る", () => {
    const text = "あいうえお ABCDE かきくけこ 12345";
    expect(splitChunks(text, 7).join("")).toBe(text);
  });
});
describe("matchOwnBody (#3205)", () => {
  const CHUNKS = ["aaa", "bbb", "ccc"];
  it("上端が見えていれば全 chunk の連結と完全一致で same", () => {
    expect(
      matchOwnBody({ body: "aaabbbccc", truncated: false }, CHUNKS),
    ).toEqual({
      kind: "same",
    });
  });
  it("上端が見えていれば chunk 境界の前方一致は prefix (載っている chunk 数を返す)", () => {
    expect(matchOwnBody({ body: "aaabbb", truncated: false }, CHUNKS)).toEqual({
      kind: "prefix",
      landed: 2,
    });
  });
  it("上端が見えていれば末尾だけの box は partial (先頭欠損はここで弾く)", () => {
    expect(matchOwnBody({ body: "ccc", truncated: false }, CHUNKS)).toEqual({
      kind: "partial",
    });
  });
  it("上端が画面外なら末尾一致を同一とみなす (縦溢れの救済。#1679)", () => {
    expect(matchOwnBody({ body: "ccc", truncated: true }, CHUNKS)).toEqual({
      kind: "same",
    });
  });
  it("上端が画面外でも、載っている最大の chunk 数を prefix として返す", () => {
    expect(matchOwnBody({ body: "abbb", truncated: true }, CHUNKS)).toEqual({
      kind: "prefix",
      landed: 2,
    });
  });
  it("空白は全部落として比べる (折り返しのインデント。#1679)", () => {
    expect(
      matchOwnBody({ body: " aaa bb\n b ccc ", truncated: false }, CHUNKS),
    ).toEqual({ kind: "same" });
  });
  it("paste 畳みの placeholder が挟まった box は partial (#3205)", () => {
    expect(
      matchOwnBody({ body: "[Pasted text #1]ccc", truncated: false }, CHUNKS),
    ).toEqual({ kind: "partial" });
  });
  it("placeholder だけの box も partial (本文がまるごと畳まれた形)", () => {
    expect(
      matchOwnBody(
        { body: "[Pasted text #2 +12 lines]", truncated: false },
        CHUNKS,
      ),
    ).toEqual({ kind: "partial" });
  });
  it("placeholder の判定は呼び出しをまたいで安定する (g フラグの lastIndex)", () => {
    const box = { body: "[Pasted text #1]ccc", truncated: false };
    expect(matchOwnBody(box, CHUNKS)).toEqual({ kind: "partial" });
    expect(matchOwnBody(box, CHUNKS)).toEqual({ kind: "partial" });
    expect(matchOwnBody(box, CHUNKS)).toEqual({ kind: "partial" });
  });
  it("本文のどこにも無い内容は foreign", () => {
    expect(
      matchOwnBody({ body: "書きかけの下書き", truncated: false }, CHUNKS),
    ).toEqual({
      kind: "foreign",
    });
  });
});
describe("AgentSender.send の先頭欠損の検知 (#3205)", () => {
  const LONG = "x".repeat(SEND_CHUNK_MAX_BYTES * 2 + 100);
  it("末尾だけが box に載ったら Enter を撃たず landed-partial で返す", () => {
    let enters = 0;
    const herdr = boxHerdr({
      read: () => "x".repeat(10),
      onSendKeys: (keys) => {
        if (keys === "Enter") enters += 1;
      },
      working: () => false,
    });
    const result = sender(herdr).send(LONG);
    expect(result).toMatchObject({
      ok: false,
      reason: "unverified",
      sendVerdict: "landed-partial",
    });
    expect(marks(result.trace)).toEqual([
      "1 alive:ok",
      "1 box:partial",
      "grace:timeout",
    ]);
    expect(enters).toBe(0);
  });
  it("タイプした chunk が断片でしか戻らなければ type:partial で止まる", () => {
    let enters = 0;
    let typed = 0;
    const herdr = boxHerdr({
      read: () => (typed === 0 ? "" : "x".repeat(10)),
      onSendText: () => {
        typed += 1;
      },
      onSendKeys: (keys) => {
        if (keys === "Enter") enters += 1;
      },
      working: () => false,
    });
    const result = sender(herdr).send(LONG);
    expect(result).toMatchObject({ ok: false, sendVerdict: "landed-partial" });
    expect(marks(result.trace)).toEqual([
      "1 alive:ok",
      "1 box:ok",
      "1 type:partial",
      "grace:timeout",
    ]);
    expect(enters).toBe(0);
  });
  it("縦溢れで末尾しか読めない box は従来どおり同一とみなして Enter へ進む (#1679)", () => {
    let enters = 0;
    const herdr = boxHerdr({
      read: () => LONG.slice(-50),
      truncated: () => true,
      onSendKeys: (keys) => {
        if (keys === "Enter") enters += 1;
      },
      working: () => true,
    });
    const result = sender(herdr).send(LONG);
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(marks(result.trace)).toEqual([
      "1 alive:ok",
      "1 box:ok",
      "1 enter:ok",
    ]);
    expect(herdr.paneSendText).not.toHaveBeenCalled();
    expect(enters).toBe(1);
  });
});
describe("AgentSender.send の chunk 送出 (#3205)", () => {
  const BODY = "あ".repeat(600) + "abc";
  const CHUNKS = splitChunks(BODY, SEND_CHUNK_MAX_BYTES);
  it("splitChunks の結果と paneSendText の呼び出し列が一致する", () => {
    expect(CHUNKS.length).toBe(3);
    let box = "";
    const herdr = boxHerdr({
      read: () => box,
      onSendText: (text) => {
        box += text;
      },
      onSendKeys: () => {
        box = "";
      },
      working: () => true,
    });
    const result = sender(herdr).send(BODY);
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(herdr.paneSendText.mock.calls.map((c: unknown[]) => c[1])).toEqual(
      CHUNKS,
    );
    expect(marks(result.trace)).toEqual([
      "1 alive:ok",
      "1 box:ok",
      "1 type:ok",
      "1 enter:ok",
    ]);
  });
  it("2 本目の chunk が落ちたら、次周は 1 本目を撃ち直さず続きから再開する", () => {
    let box = "";
    let drops = 1;
    const herdr = boxHerdr({
      read: () => box,
      onSendText: (text) => {
        if (text === CHUNKS[1] && drops > 0) {
          drops -= 1;
          return;
        }
        box += text;
      },
      onSendKeys: () => {
        box = "";
      },
      working: () => true,
    });
    const result = sender(herdr).send(BODY);
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(herdr.paneSendText.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      CHUNKS[0],
      CHUNKS[1],
      CHUNKS[1],
      CHUNKS[2],
    ]);
    expect(marks(result.trace)).toEqual([
      "1 alive:ok",
      "1 box:ok",
      "1 type:timeout",
      "2 alive:ok",
      "2 box:ok",
      "2 type:ok",
      "2 enter:ok",
    ]);
  });
});
describe("AgentSender.send の box read-back ポーリング (#1752)", () => {
  it("landing が途中の読みで来たら上限を待たずに Enter へ進む", () => {
    let reads = 0;
    const herdr = boxHerdr({
      read: () => (++reads >= 4 ? TEXT : ""),
    });
    const result = sender(herdr).send(TEXT);
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(marks(result.trace)).toEqual([
      "1 alive:ok",
      "1 box:ok",
      "1 type:ok",
      "1 enter:ok",
    ]);
    expect(herdr.readBox).toHaveBeenCalledTimes(4);
    expect(herdr.agentSendKeys).toHaveBeenCalledWith(PANE, "Enter");
  });
  it("box が null でも上限内に読めるようになれば同じ周で続行し attempt を消費しない", () => {
    let reads = 0;
    const herdr = boxHerdr({
      read: () => {
        reads += 1;
        if (reads < 3) return null;
        if (reads === 3) return "";
        return TEXT;
      },
    });
    const result = sender(herdr).send(TEXT);
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(marks(result.trace)).toEqual([
      "1 alive:ok",
      "1 box:ok",
      "1 type:ok",
      "1 enter:ok",
    ]);
    expect(herdr.paneSendText).toHaveBeenCalledTimes(1);
  });
  it("box クリア検証の空 box 分岐は下限を過ぎるまで submit 成立と判定しない", () => {
    const FLOOR_MS = 30;
    let ranAt: number | null = null;
    let firstReadAfterRun: number | null = null;
    const herdr = {
      ...boxHerdr({
        read: () => {
          if (ranAt !== null && firstReadAfterRun === null) {
            firstReadAfterRun = Date.now() - ranAt;
          }
          return "";
        },
      }),
      paneRun: vi.fn(() => {
        ranAt = Date.now();
      }),
    } satisfies HerdrSendPort;
    expect(
      sender(herdr, { slashSubmitFloorMs: FLOOR_MS }).send("/exit"),
    ).toEqual(
      clearedOk(
        "claude-box-cleared",
        1,
        "1 alive:ok",
        "1 box:ok",
        "1 type:ok",
        "1 enter:ok",
      ),
    );
    expect(firstReadAfterRun).toBeGreaterThanOrEqual(FLOOR_MS);
  });
});
describe("AgentSender.send の検証方式の分岐 (#2371)", () => {
  const dispatchHerdr = () => {
    let box = "";
    return boxHerdr({
      read: () => box,
      onSendText: (text) => {
        box = text;
      },
      onSendKeys: () => {
        box = "";
      },
    });
  };
  it("ターンを始めないコマンドは box クリア検証へ回る (working を一度も見ない)", () => {
    const herdr = dispatchHerdr();
    expect(sender(herdr).send("/clear")).toEqual(
      clearedOk(
        "claude-box-cleared",
        1,
        "1 alive:ok",
        "1 box:ok",
        "1 type:ok",
        "1 enter:ok",
      ),
    );
    expect(herdr.paneRun).toHaveBeenCalledWith(PANE, "/clear ");
    expect(herdr.paneSendText).not.toHaveBeenCalled();
    expect(herdr.waitWorking).not.toHaveBeenCalled();
  });
  it("引数付きでも先頭語で判定する (`/clear <name>` は box クリア検証)", () => {
    const herdr = dispatchHerdr();
    expect(sender(herdr).send("/clear 前の会話")).toEqual(
      clearedOk(
        "claude-box-cleared",
        1,
        "1 alive:ok",
        "1 box:ok",
        "1 type:ok",
        "1 enter:ok",
      ),
    );
    expect(herdr.paneRun).toHaveBeenCalledWith(PANE, "/clear 前の会話 ");
  });
  it("ターンを始めるスラッシュコマンドは working 検証へ回る", () => {
    const herdr = dispatchHerdr();
    const result = sender(herdr).send("/my-skill 1");
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect("via" in result).toBe(false);
    expect(herdr.paneSendText).toHaveBeenCalledWith(PANE, "/my-skill 1");
    expect(herdr.waitWorking).toHaveBeenCalled();
    expect(herdr.paneRun).not.toHaveBeenCalled();
  });
  it("平文はこれまでどおり working 検証", () => {
    const herdr = dispatchHerdr();
    expect(sender(herdr).send(TEXT)).toMatchObject({ ok: true });
    expect(herdr.waitWorking).toHaveBeenCalled();
  });
  it("先頭語の完全一致で見るので `/exit-foo` を巻き込まない", () => {
    const herdr = dispatchHerdr();
    sender(herdr).send("/exit-foo");
    expect(herdr.waitWorking).toHaveBeenCalled();
    expect(herdr.paneRun).not.toHaveBeenCalled();
  });
});
describe("isTurnlessCommand (#2371)", () => {
  it("一覧のコマンドは引数・末尾スペースの有無によらず真", () => {
    for (const text of [
      "/clear",
      "/clear ",
      "/clear 前の会話",
      "/exit",
      "/quit",
      "/rename",
      "/rename [exiting]my-session",
    ])
      expect(isTurnlessCommand(text)).toBe(true);
  });
  it("一覧に無い本文は偽 (working 検証へ fail-open する)", () => {
    for (const text of [
      "/compact",
      "/help",
      "/exit-foo",
      "/my-skill 1",
      TEXT,
      "",
    ])
      expect(isTurnlessCommand(text)).toBe(false);
  });
  it("終端コマンドは一覧の部分集合", () => {
    for (const cmd of TERMINATING_SLASH_COMMANDS)
      expect(TURNLESS_SLASH_COMMANDS).toContain(cmd);
  });
});
describe("AgentSender.send の宛先解決 (#1662 / #1989)", () => {
  it("送出の途中で agent が消えたら agent-vanished で即 abort し、跡地へ撃たない", () => {
    let alive = true;
    const herdr = boxHerdr({
      read: () => "",
      pane: () => (alive ? PANE : null),
      onSendText: () => {
        alive = false;
      },
      working: () => false,
    });
    const result = sender(herdr).send(TEXT);
    expect(result).toMatchObject({
      ok: false,
      reason: "agent-vanished",
      attempts: 2,
    });
    expect(marks(result.trace)).toEqual([
      "1 alive:ok",
      "1 box:ok",
      "1 type:timeout",
      "2 alive:gone",
    ]);
    expect(herdr.paneSendText).toHaveBeenCalledTimes(1);
    expect(herdr.agentSendKeys).not.toHaveBeenCalled();
  });
  it("agentGet が別の pane_id を返しても撃つ先は渡された pane id のまま (#2505)", () => {
    const panes = ["w1:p3", "w1:p2", "w1:p1"];
    let i = 0;
    const herdr = boxHerdr({
      read: () => TEXT,
      pane: () => panes[Math.min(i++, panes.length - 1)],
      working: () => false,
    });
    sender(herdr).send(TEXT);
    expect(herdr.agentSendKeys.mock.calls.map(([target]) => target)).toEqual(
      Array(SEND_MAX_ATTEMPTS).fill(PANE),
    );
  });
  it("宛先未取得 (null) なら宛先不明として何も撃たない", () => {
    const herdr = boxHerdr({ read: () => "" });
    const result = new AgentSender(herdr, null, TEST_TIMINGS).send(TEXT);
    expect(result).toMatchObject({
      ok: false,
      reason: "agent-vanished",
      attempts: 1,
    });
    expect(marks(result.trace)).toEqual(["1 alive:gone"]);
    expect(herdr.agentGet).not.toHaveBeenCalled();
    expect(herdr.paneSendText).not.toHaveBeenCalled();
  });
});
const t = (...ms: string[]): TraceEntry[] =>
  ms.map((m) => {
    const [stage, result] = m.split(":");
    return { stage, result, ms: 0 } as TraceEntry;
  });
describe("classifyVerdict (working 検証)", () => {
  const verdict = (
    trace: TraceEntry[],
    boxBody: string | null,
    status: string | null,
    lateWorking: boolean,
    truncated = false,
  ) =>
    classifyVerdict(
      "herdr-agent-working",
      trace,
      boxBody === null ? null : { body: boxBody, truncated },
      status,
      lateWorking,
      TEXT,
    );
  it("grace で working を掴んだら submitted-late (再着火しない)", () => {
    expect(verdict(t("type:timeout"), "", null, true)).toBe("submitted-late");
  });
  it("終端 status が working でも submitted-late", () => {
    expect(verdict(t("type:timeout"), "", "working", false)).toBe(
      "submitted-late",
    );
  });
  it("終端 box に送出本文が残っていれば landed-not-submitted", () => {
    expect(verdict(t("enter:timeout"), TEXT, "idle", false)).toBe(
      "landed-not-submitted",
    );
  });
  it("折り返しでインデントが付いた残留も landed-not-submitted として拾う", () => {
    expect(
      verdict(t("enter:timeout"), "/loop 30m /run-in-the- loop", "idle", false),
    ).toBe("landed-not-submitted");
  });
  it("終端 box に本文の断片しか無ければ landed-partial (#3205)", () => {
    expect(verdict(t("enter:timeout"), TEXT.slice(-8), "idle", false)).toBe(
      "landed-partial",
    );
  });
  it("上端が画面外なら同じ末尾でも landed-not-submitted (縦溢れの救済。#1679)", () => {
    expect(
      verdict(t("enter:timeout"), TEXT.slice(-8), "idle", false, true),
    ).toBe("landed-not-submitted");
  });
  it("Enter は撃てたが終端 box が空なら submitted-unconfirmed (再着火は危険)", () => {
    expect(verdict(t("type:timeout", "enter:timeout"), "", "idle", false)).toBe(
      "submitted-unconfirmed",
    );
  });
  it("Enter を一度も撃てていなければ not-delivered (再着火してよい)", () => {
    expect(verdict(t("type:timeout", "box:timeout"), "", "idle", false)).toBe(
      "not-delivered",
    );
  });
  it("Enter を撃てた周があれば別内容の残留は submitted-unconfirmed (#2526)", () => {
    expect(
      verdict(
        t("type:timeout", "enter:timeout"),
        "書きかけの下書き",
        "idle",
        false,
      ),
    ).toBe("submitted-unconfirmed");
  });
  it("Enter を撃てた周が無ければ別内容の残留は not-delivered", () => {
    expect(
      verdict(
        t("box:foreign", "box:foreign"),
        "書きかけの下書き",
        "idle",
        false,
      ),
    ).toBe("not-delivered");
  });
  it("終端 box を読めなければ unreadable (判断不能)", () => {
    expect(verdict(t("box:timeout"), null, "idle", false)).toBe("unreadable");
  });
});
describe("inputReadyGate", () => {
  function gateHerdr(opts: {
    box?: () => string | null;
    visible?: () => string;
    idle?: () => boolean;
    status?: () => string;
  }) {
    const status = opts.status ?? (() => "idle");
    return {
      ...fakeSendPort(),
      agentGet: vi.fn(() => ({
        pane_id: PANE,
        agent_status: status(),
      })),
      waitIdle: vi.fn(opts.idle ?? (() => true)),
      waitIdleOrBlocked: vi.fn(opts.idle ?? (() => true)),
      readBoxBody: vi.fn(opts.box ?? (() => "")),
      readVisible: vi.fn(opts.visible ?? (() => "")),
      agentSendKeys: vi.fn(),
    } satisfies HerdrSendPort;
  }
  const gate = (
    herdr: HerdrSendPort,
    opts?: {
      deadlineMs?: number;
      detectInterstitial?: boolean;
      timings?: Partial<SessionTimings>;
    },
  ) =>
    inputReadyGate(
      herdr,
      PANE,
      Date.now() + (opts?.deadlineMs ?? 60000),
      opts?.detectInterstitial ?? true,
      { ...TEST_TIMINGS, ...opts?.timings },
    );
  it("box 罫線が描かれるまで通さない (穴 A)", () => {
    let reads = 0;
    const herdr = gateHerdr({ box: () => (++reads < 3 ? null : "") });
    const result = gate(herdr);
    expect(result).toMatchObject({ ok: true });
    expect(marks(result.trace)).toContain("rc:ok");
    expect(reads).toBe(3);
  });
  it("/rc connecting… が出ている間は通さない (穴 B)", () => {
    let reads = 0;
    const herdr = gateHerdr({
      visible: () =>
        ++reads < 3
          ? "● high · /effort\n/rc connecting…"
          : "devbox:app#1757 ⎇ wt/app  …  /rc active",
    });
    const result = gate(herdr);
    expect(result).toMatchObject({ ok: true });
    expect(marks(result.trace)).toContain("rc:ok");
    expect(reads).toBe(3);
  });
  it("/rc reconnecting は関門にしない (接続実績がある = TUI は初期化済み)", () => {
    const herdr = gateHerdr({ visible: () => "…  /rc reconnecting" });
    expect(gate(herdr)).toMatchObject({ ok: true });
    expect(herdr.readVisible).toHaveBeenCalledTimes(1);
  });
  it("/rc connecting… のまま RC 予算を使い切ったら trace に fail-open を残して通す", () => {
    const herdr = gateHerdr({ visible: () => "/rc connecting…" });
    const result = gate(herdr, { timings: { rcConnectTimeoutMs: 20 } });
    expect(result).toMatchObject({ ok: true });
    expect(marks(result.trace)).toContain("rc:fail-open");
  });
  it("box が描かれないまま deadline に達したら stage: box で fail する", () => {
    const herdr = gateHerdr({ box: () => null });
    expect(gate(herdr, { deadlineMs: 20 })).toMatchObject({
      ok: false,
      stage: "box",
    });
  });
  it("status の待ちが timeout / エラーで false を返したら stage: idle で fail する", () => {
    const herdr = gateHerdr({ idle: () => false });
    expect(gate(herdr)).toMatchObject({ ok: false, stage: "idle" });
  });
  it("集合が空なので background work が matched でも予算まで待って timeout する", () => {
    const herdr = {
      ...gateHerdr({ idle: () => false }),
      agentExplain: vi.fn(() => bgDetection("background_shell_working")),
    };
    expect(gate(herdr, { deadlineMs: 30 })).toMatchObject({
      ok: false,
      stage: "idle",
    });
    expect(herdr.agentExplain.mock.calls.length).toBeGreaterThan(1);
  });
  it("分類そのものを読めなければ粘らず畳む (宛先が消えた / server が落ちた)", () => {
    const herdr = gateHerdr({ idle: () => false });
    const startedAt = Date.now();
    expect(gate(herdr)).toMatchObject({ ok: false, stage: "idle" });
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
  it("fresh 起動経路は blocked を待ち受け集合に足した待ちを使う", () => {
    const herdr = gateHerdr({});
    expect(gate(herdr, { detectInterstitial: true })).toMatchObject({
      ok: true,
    });
    expect(herdr.waitIdleOrBlocked).toHaveBeenCalled();
    expect(herdr.waitIdle).not.toHaveBeenCalled();
  });
  it("reuse 経路は従来どおり idle / done だけを待つ", () => {
    const herdr = gateHerdr({});
    expect(gate(herdr, { detectInterstitial: false })).toMatchObject({
      ok: true,
    });
    expect(herdr.waitIdle).toHaveBeenCalled();
    expect(herdr.waitIdleOrBlocked).not.toHaveBeenCalled();
  });
  describe("interstitial 関門 (#1783)", () => {
    const MCP_DIALOG = [
      "",
      "─".repeat(80),
      "  New MCP server found in this project: probe-dummy",
      "",
      "  MCP servers may execute code or access system resources. All tool calls",
      "  require approval. Learn more in the MCP documentation.",
      "",
      "  ❯ 1. Use this MCP server",
      "    2. Use this and all future MCP servers in this project",
      "    3. Continue without using this MCP server",
      "",
      "  Enter to confirm · Esc to cancel",
    ].join("\n");
    const MCP_DIALOG_MULTI = [
      "",
      "─".repeat(80),
      "  2 new MCP servers found in this project",
      "  Select any you wish to enable.",
      "",
      "  MCP servers may execute code or access system resources. All tool calls",
      "  require approval. Learn more in the MCP documentation.",
      "",
      "  ❯ [✔] context7",
      "    [✔] deepwiki",
      " Space to select · Enter to confirm · Esc to reject all",
    ].join("\n");
    const TRUST_DIALOG = [
      "",
      "─".repeat(120),
      " Accessing workspace:",
      "",
      " /home/you/trust-probe",
      "",
      " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
      " project, or work from your team). If not, take a moment to review what's in this folder first.",
      "",
      " Claude Code'll be able to read, edit, and execute files here.",
      "",
      " Security guide",
      "",
      " ❯ No, exit",
      "   Yes, I trust this folder",
      "",
      " Enter to confirm · Esc to cancel",
    ].join("\n");
    it("ダイアログが出ていれば Enter で通してから関門を通す", () => {
      let visibles = 0;
      const herdr = gateHerdr({
        visible: () => (++visibles === 1 ? MCP_DIALOG : ""),
      });
      expect(gate(herdr)).toMatchObject({ ok: true });
      expect(herdr.agentSendKeys).toHaveBeenCalledWith(PANE, "Enter");
    });
    it("workspace trust ダイアログ (実機ダンプ) は Enter を撃たずに畳む", () => {
      const herdr = gateHerdr({ visible: () => TRUST_DIALOG });
      expect(gate(herdr)).toMatchObject({
        ok: false,
        reason: "untrusted-workspace",
        stage: "dialog",
      });
      expect(herdr.agentSendKeys).not.toHaveBeenCalled();
    });
    it("trust で畳んだ段は trace に fail-closed で載る", () => {
      const herdr = gateHerdr({ visible: () => TRUST_DIALOG });
      const result = gate(herdr);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.trace).toContainEqual(
        expect.objectContaining({ stage: "dialog", result: "fail-closed" }),
      );
    });
    it("trust は blocked 主判定より先に評価する (blocked でも撃たない)", () => {
      const herdr = gateHerdr({
        visible: () => TRUST_DIALOG,
        status: () => "blocked",
      });
      expect(gate(herdr)).toMatchObject({ reason: "untrusted-workspace" });
      expect(herdr.agentSendKeys).not.toHaveBeenCalled();
    });
    it("reuse 経路では trust の文言が画面にあっても畳まない", () => {
      const herdr = gateHerdr({ visible: () => TRUST_DIALOG });
      expect(gate(herdr, { detectInterstitial: false })).toMatchObject({
        ok: true,
      });
      expect(herdr.agentSendKeys).not.toHaveBeenCalled();
    });
    it("MCP 複数ダイアログ (2.1.226 実機ダンプ) も Enter 1 回で通過する", () => {
      let visibles = 0;
      const herdr = gateHerdr({
        visible: () => (++visibles === 1 ? MCP_DIALOG_MULTI : ""),
      });
      expect(gate(herdr)).toMatchObject({ ok: true });
      expect(herdr.agentSendKeys).toHaveBeenCalledTimes(1);
    });
    it("凍結文言に一致しなくても agent_status が blocked なら Enter で通す", () => {
      let rounds = 0;
      const herdr = gateHerdr({
        visible: () => "an unknown first-run dialog",
        status: () => (++rounds === 1 ? "blocked" : "idle"),
      });
      expect(gate(herdr)).toMatchObject({ ok: true });
      expect(herdr.agentSendKeys).toHaveBeenCalledWith(PANE, "Enter");
      expect(herdr.agentSendKeys).toHaveBeenCalledTimes(1);
    });
    it("reuse 経路では blocked でも Enter を撃たない (ターン中の許可プロンプトを踏まない)", () => {
      const herdr = gateHerdr({ status: () => "blocked" });
      expect(gate(herdr, { detectInterstitial: false })).toMatchObject({
        ok: true,
      });
      expect(herdr.agentSendKeys).not.toHaveBeenCalled();
    });
    it("blocked が続いても Enter は上限までしか撃たない (fail-open)", () => {
      const herdr = gateHerdr({ status: () => "blocked" });
      expect(gate(herdr)).toMatchObject({ ok: true });
      expect(herdr.agentSendKeys).toHaveBeenCalledTimes(
        INTERSTITIAL_MAX_ENTERS,
      );
    });
    it("後の周で描かれたダイアログも Enter で通過する", () => {
      let visibles = 0;
      const herdr = gateHerdr({
        box: () => (visibles <= 1 ? null : ""),
        visible: () => (++visibles === 2 ? MCP_DIALOG : ""),
      });
      expect(gate(herdr)).toMatchObject({ ok: true });
      expect(herdr.agentSendKeys).toHaveBeenCalledTimes(1);
    });
    it("Enter 上限を超えたら撃つのをやめ、box / RC が通れば通す (fail-open)", () => {
      const herdr = gateHerdr({ visible: () => MCP_DIALOG });
      expect(gate(herdr)).toMatchObject({ ok: true });
      expect(herdr.agentSendKeys).toHaveBeenCalledTimes(
        INTERSTITIAL_MAX_ENTERS,
      );
    });
    it("dialog を観測したまま timeout したら stage: dialog を返す", () => {
      const herdr = gateHerdr({ box: () => null, visible: () => MCP_DIALOG });
      expect(gate(herdr, { deadlineMs: 50 })).toMatchObject({
        ok: false,
        stage: "dialog",
      });
    });
    it("detectInterstitial = false では凍結値が画面にあっても Enter を撃たない", () => {
      const herdr = gateHerdr({ visible: () => MCP_DIALOG });
      expect(gate(herdr, { detectInterstitial: false })).toMatchObject({
        ok: true,
      });
      expect(herdr.agentSendKeys).not.toHaveBeenCalled();
    });
    it("MCP 側の実文言をすべて検出する (凍結値の追従確認)", () => {
      for (const line of [
        "New MCP server found in this project: probe-dummy",
        "  ❯ 1. Use this MCP server",
        "2 new MCP servers found in this project",
        "Select any you wish to enable.",
      ]) {
        const herdr = gateHerdr({ visible: () => line });
        gate(herdr);
        expect(herdr.agentSendKeys, line).toHaveBeenCalledWith(PANE, "Enter");
      }
    });
    it("trust 側の実文言はどちらの行でも撃たずに畳む (凍結値の追従確認)", () => {
      for (const line of [
        " Quick safety check: Is this a project you created or one you trust? (Like your own code,",
        "   Yes, I trust this folder",
      ]) {
        const herdr = gateHerdr({ visible: () => line });
        expect(gate(herdr), line).toMatchObject({
          reason: "untrusted-workspace",
        });
        expect(herdr.agentSendKeys, line).not.toHaveBeenCalled();
      }
    });
  });
});
describe("waitInputAccepting の background work 判定 (#2989)", () => {
  const FAKE_IDS = ["fake_background_working"] as const;
  const wait = (
    herdr: HerdrSendPort,
    opts?: {
      ruleIds?: readonly string[];
      budgetMs?: number;
    },
  ) =>
    waitInputAccepting(
      herdr,
      PANE,
      Date.now() + (opts?.budgetMs ?? 60000),
      () => false,
      TEST_TIMINGS.idleProbeSliceMs,
      opts?.ruleIds ?? FAKE_IDS,
    );
  it("本番の集合は空 (上流が background_shell_working を落とした)", () => {
    expect(BACKGROUND_WORK_RULE_IDS).toEqual([]);
  });
  it("集合に載る id が matched で box が読めるなら background-work で抜ける", () => {
    const herdr = {
      ...fakeSendPort(),
      readBoxBody: vi.fn(() => ""),
      agentExplain: vi.fn(() => bgDetection(FAKE_IDS[0])),
    } satisfies HerdrSendPort;
    expect(wait(herdr)).toBe("background-work");
    expect(herdr.agentExplain).toHaveBeenCalledWith(PANE);
  });
  it("box が読めない間は集合に載っていても抜けない (入力欄が描かれていない)", () => {
    const herdr = {
      ...fakeSendPort(),
      readBoxBody: vi.fn(() => null),
      agentExplain: vi.fn(() => bgDetection(FAKE_IDS[0])),
    } satisfies HerdrSendPort;
    expect(wait(herdr, { budgetMs: 30 })).toBe("timeout");
  });
  it("集合外のルールなら予算まで待って timeout する", () => {
    const herdr = {
      ...fakeSendPort(),
      readBoxBody: vi.fn(() => ""),
      agentExplain: vi.fn(() => bgDetection("osc_title_working")),
    } satisfies HerdrSendPort;
    expect(wait(herdr, { budgetMs: 30 })).toBe("timeout");
    expect(herdr.agentExplain.mock.calls.length).toBeGreaterThan(1);
  });
  it("集合が空なら既定の呼び出しはどの matched rule でも抜けない", () => {
    const herdr = {
      ...fakeSendPort(),
      readBoxBody: vi.fn(() => ""),
      agentExplain: vi.fn(() => bgDetection(FAKE_IDS[0])),
    } satisfies HerdrSendPort;
    expect(
      waitInputAccepting(
        herdr,
        PANE,
        Date.now() + 30,
        () => false,
        TEST_TIMINGS.idleProbeSliceMs,
      ),
    ).toBe("timeout");
  });
});
function clearedOk(
  evidence: SendEvidence,
  attempts: number,
  ...rows: string[]
) {
  return {
    ok: true,
    attempts,
    trace: rows.map((m) => {
      const [attempt, rest] = m.split(" ");
      const [stage, result] = rest.split(":");
      return {
        attempt: Number(attempt),
        stage,
        result,
        ms: expect.any(Number),
      };
    }),
    evidence,
  };
}
describe("AgentSender.clearPrompt", () => {
  it("box に /clear が残っていれば再タイプせず Enter だけ撃つ", () => {
    let box = "/clear";
    const herdr = boxHerdr({
      read: () => box,
      onSendKeys: (keys) => {
        if (keys === "Enter") box = "";
      },
    });
    expect(sender(herdr).clearPrompt()).toEqual(
      clearedOk(
        "claude-box-cleared",
        1,
        "1 alive:ok",
        "1 box:ok",
        "1 enter:ok",
      ),
    );
    expect(herdr.paneRun).not.toHaveBeenCalled();
    expect(herdr.agentSendKeys).toHaveBeenCalledWith(PANE, "Enter");
  });
  it("box が空なら本文 + Enter のアトミック送出をそのまま使う", () => {
    const herdr = boxHerdr({ read: () => "" });
    expect(sender(herdr).clearPrompt()).toEqual(
      clearedOk(
        "claude-box-cleared",
        1,
        "1 alive:ok",
        "1 box:ok",
        "1 type:ok",
        "1 enter:ok",
      ),
    );
    expect(herdr.paneRun).toHaveBeenCalledWith(PANE, "/clear ");
  });
  it("agent が消えていれば /clear を撃たずに agent-vanished を返す (#1662)", () => {
    const herdr = boxHerdr({ read: () => "", pane: () => null });
    expect(sender(herdr).clearPrompt()).toMatchObject({
      ok: false,
      reason: "agent-vanished",
    });
    expect(herdr.paneRun).not.toHaveBeenCalled();
    expect(herdr.agentSendKeys).not.toHaveBeenCalled();
  });
});
describe("AgentSender.send の box クリア検証 (#1699)", () => {
  it("任意のコマンドを受け取り、TUI 補完メニュー対策の末尾スペースを内側で付ける", () => {
    const herdr = boxHerdr({ read: () => "" });
    expect(sender(herdr).send("/exit")).toEqual(
      clearedOk(
        "claude-box-cleared",
        1,
        "1 alive:ok",
        "1 box:ok",
        "1 type:ok",
        "1 enter:ok",
      ),
    );
    expect(herdr.paneRun).toHaveBeenCalledWith(PANE, "/exit ");
  });
  it("末尾スペース付きで渡されても二重に付けない", () => {
    const herdr = boxHerdr({ read: () => "" });
    expect(sender(herdr).send("/exit ")).toEqual(
      clearedOk(
        "claude-box-cleared",
        1,
        "1 alive:ok",
        "1 box:ok",
        "1 type:ok",
        "1 enter:ok",
      ),
    );
    expect(herdr.paneRun).toHaveBeenCalledWith(PANE, "/exit ");
  });
});
function boxClearedFailure(result: SendResult) {
  if (result.ok) throw new Error("box クリア検証が失敗しなかった");
  return result;
}
describe("AgentSender.send の box クリア検証の失敗返り値 (#1884)", () => {
  it("上限まで回ったら trace / sendVerdict / 終端スナップショットを載せて fail する", () => {
    const herdr = boxHerdr({ read: () => "/exit " });
    const result = boxClearedFailure(sender(herdr).send("/exit"));
    expect(result).toMatchObject({
      ok: false,
      reason: "unverified",
      attempts: SEND_MAX_ATTEMPTS,
      sendVerdict: "landed-not-submitted",
      lastAgentStatus: null,
      boxBody: "/exit ",
      paneTail: "",
      detection: null,
    });
    expect(marks(result.trace)).toEqual(
      attemptMarks(SEND_MAX_ATTEMPTS, "alive:ok", "box:ok", "enter:timeout"),
    );
    expect(
      herdr.agentSendKeys.mock.calls.filter(([, keys]) => keys !== "Enter"),
    ).toEqual([]);
  });
  it("別内容が残っていたら 1 周で止まり、何も撃たない (#2505)", () => {
    const herdr = boxHerdr({ read: () => "書きかけの下書き" });
    const result = boxClearedFailure(sender(herdr).send("/exit"));
    expect(result).toMatchObject({
      sendVerdict: "not-delivered",
      attempts: 1,
      boxBody: "書きかけの下書き",
    });
    expect(marks(result.trace)).toEqual(["1 alive:ok", "1 box:foreign"]);
    expect(herdr.paneRun).not.toHaveBeenCalled();
    expect(herdr.agentSendKeys).not.toHaveBeenCalled();
  });
  it("別内容で止めた後に終端 box だけ空でも not-delivered (#1914)", () => {
    let reads = 0;
    const herdr = boxHerdr({
      read: () => (reads++ < 1 ? "書きかけの下書き" : ""),
    });
    const result = boxClearedFailure(sender(herdr).send("/exit"));
    expect(result).toMatchObject({
      sendVerdict: "not-delivered",
      boxBody: "",
    });
    expect(marks(result.trace)).toEqual(["1 alive:ok", "1 box:foreign"]);
    expect(herdr.paneRun).not.toHaveBeenCalled();
  });
  it("box を読めないまま上限に達したら unreadable で、何も撃たない", () => {
    const herdr = boxHerdr({ read: () => null });
    const result = boxClearedFailure(sender(herdr).send("/exit"));
    expect(result).toMatchObject({
      sendVerdict: "unreadable",
      boxBody: null,
    });
    expect(marks(result.trace)).toEqual(
      attemptMarks(SEND_MAX_ATTEMPTS, "alive:ok", "box:timeout"),
    );
    expect(herdr.paneRun).not.toHaveBeenCalled();
    expect(herdr.agentSendKeys).not.toHaveBeenCalled();
  });
  it("agent-vanished にも attempts / trace が載る (終端スナップショットは持たない)", () => {
    const herdr = boxHerdr({ read: () => "", pane: () => null });
    expect(sender(herdr).send("/exit")).toEqual({
      ok: false,
      reason: "agent-vanished",
      attempts: 1,
      trace: [
        { attempt: 1, stage: "alive", ms: expect.any(Number), result: "gone" },
      ],
    });
  });
});
describe("AgentSender.send の終端コマンド判定 (#1916)", () => {
  function exitingHerdr(opts: {
    after: "pane-closed" | "shell-respawn" | "status-unknown";
  }) {
    let exited = false;
    const gone = () => exited && opts.after !== "pane-closed";
    return {
      ...boxHerdr({
        read: () => (exited ? null : ""),
        pane: () => (exited && opts.after === "pane-closed" ? null : PANE),
        agent: () => (gone() && opts.after === "shell-respawn" ? null : AGENT),
        status: () =>
          gone() && opts.after === "status-unknown" ? "unknown" : "idle",
      }),
      paneRun: vi.fn(() => {
        exited = true;
      }),
    } satisfies HerdrSendPort;
  }
  it.each(["pane-closed", "shell-respawn", "status-unknown"] as const)(
    "/exit を撃った後に claude が居なくなれば成功 (%s)",
    (after) => {
      const herdr = exitingHerdr({ after });
      expect(sender(herdr).send("/exit")).toEqual(
        clearedOk(
          "herdr-agent-gone",
          2,
          "1 alive:ok",
          "1 box:ok",
          "1 type:ok",
          "1 enter:timeout",
        ),
      );
      expect(herdr.paneRun).toHaveBeenCalledWith(PANE, "/exit ");
    },
  );
  it("alias の /quit も終端コマンドとして扱う", () => {
    const herdr = exitingHerdr({ after: "pane-closed" });
    expect(sender(herdr).send("/quit")).toEqual(
      clearedOk(
        "herdr-agent-gone",
        2,
        "1 alive:ok",
        "1 box:ok",
        "1 type:ok",
        "1 enter:timeout",
      ),
    );
  });
  it("box が先に空へ戻ったケースは evidence=claude-box-cleared", () => {
    const herdr = boxHerdr({ read: () => "" });
    expect(sender(herdr).send("/exit")).toEqual(
      clearedOk(
        "claude-box-cleared",
        1,
        "1 alive:ok",
        "1 box:ok",
        "1 type:ok",
        "1 enter:ok",
      ),
    );
  });
  it("撃つ前から消えている /exit は agent-vanished のまま", () => {
    const herdr = boxHerdr({ read: () => "", pane: () => null });
    expect(sender(herdr).send("/exit")).toEqual({
      ok: false,
      reason: "agent-vanished",
      attempts: 1,
      trace: [
        { attempt: 1, stage: "alive", ms: expect.any(Number), result: "gone" },
      ],
    });
  });
  it("非終端コマンド (/clear) を撃った後に消えても agent-vanished のまま", () => {
    const herdr = exitingHerdr({ after: "pane-closed" });
    expect(sender(herdr).send("/clear")).toEqual({
      ok: false,
      reason: "agent-vanished",
      attempts: 2,
      trace: [
        { attempt: 1, stage: "alive", ms: expect.any(Number), result: "ok" },
        { attempt: 1, stage: "box", ms: expect.any(Number), result: "ok" },
        { attempt: 1, stage: "type", ms: expect.any(Number), result: "ok" },
        {
          attempt: 1,
          stage: "enter",
          ms: expect.any(Number),
          result: "timeout",
        },
        { attempt: 2, stage: "alive", ms: expect.any(Number), result: "gone" },
      ],
    });
  });
  it("上限に達した後に消えていたケースも取りこぼさない", () => {
    let enters = 0;
    let exited = false;
    const herdr = boxHerdr({
      read: () => (exited ? null : "/exit "),
      pane: () => (exited ? null : PANE),
      onSendKeys: (keys) => {
        if (keys !== "Enter") return;
        enters++;
        if (enters >= SEND_MAX_ATTEMPTS) exited = true;
      },
    });
    expect(sender(herdr).send("/exit")).toEqual(
      clearedOk(
        "herdr-agent-gone",
        SEND_MAX_ATTEMPTS,
        ...attemptMarks(
          SEND_MAX_ATTEMPTS,
          "alive:ok",
          "box:ok",
          "enter:timeout",
        ),
      ),
    );
    expect(enters).toBe(SEND_MAX_ATTEMPTS);
  });
});
describe("classifyVerdict (box クリア検証)", () => {
  const COMMAND = "/clear ";
  const verdict = (trace: TraceEntry[], boxBody: string | null) =>
    classifyVerdict(
      "claude-box-cleared",
      trace,
      boxBody === null ? null : { body: boxBody, truncated: false },
      "idle",
      false,
      COMMAND,
    );
  const ENTERED = t("enter:timeout");
  it("終端 box が読めなければ unreadable (判断不能)", () => {
    expect(verdict(ENTERED, null)).toBe("unreadable");
  });
  it("終端 box が空 + Enter を撃てた周があれば submitted-late", () => {
    expect(verdict(ENTERED, "")).toBe("submitted-late");
  });
  it("終端 box にコマンドが残っていれば landed-not-submitted", () => {
    expect(verdict(ENTERED, "/clear")).toBe("landed-not-submitted");
  });
  it("折り返しでインデントが付いた残留も landed-not-submitted として拾う", () => {
    expect(verdict(ENTERED, "  /cle ar")).toBe("landed-not-submitted");
  });
  it("終端 box にコマンドの断片しか無ければ landed-partial (#3205)", () => {
    expect(verdict(ENTERED, "ear")).toBe("landed-partial");
  });
  it("Enter を撃てた周があれば別内容の残留は submitted-unconfirmed (#2526)", () => {
    expect(verdict(ENTERED, "書きかけの下書き")).toBe("submitted-unconfirmed");
  });
  it("Enter を撃てた周が無ければ別内容の残留は not-delivered", () => {
    expect(verdict(t("box:foreign", "box:foreign"), "書きかけの下書き")).toBe(
      "not-delivered",
    );
  });
  it("Enter を撃てた周が無く終端 box が空なら not-delivered (#1914)", () => {
    expect(verdict(t("box:foreign", "box:foreign"), "")).toBe("not-delivered");
  });
  it("空 box でも enter を撃てた周があれば submitted-late のまま", () => {
    expect(verdict(t("box:foreign", "enter:timeout"), "")).toBe(
      "submitted-late",
    );
  });
});
describe("detection の同梱 (#1864)", () => {
  const DETECTION: ScreenDetection = {
    state: "blocked",
    matchedRule: { id: "live_blocked_form", state: "blocked" },
    visibleBlocker: true,
    visibleIdle: false,
    visibleWorking: false,
    fallbackReason: null,
    manifestVersion: "2026.07.13.1",
    rules: [{ id: "live_blocked_form", matched: true }],
    regions: { after_last_horizontal_rule: "enter to select" },
  };
  it("send の上限到達 (unverified) に載り、終端スナップショットと同時点で撮られる", () => {
    const herdr = {
      ...boxHerdr({ read: () => TEXT, working: () => false }),
      agentExplain: vi.fn(() => DETECTION),
    };
    const result = sender(herdr).send(TEXT);
    expect(result).toMatchObject({
      ok: false,
      reason: "unverified",
      sendVerdict: "landed-not-submitted",
      detection: DETECTION,
    });
    expect(herdr.agentExplain).toHaveBeenCalledTimes(1);
    expect(herdr.agentExplain).toHaveBeenCalledWith(PANE);
  });
  it("box クリア検証の上限到達 (unverified) にも載る (#1884)", () => {
    const herdr = {
      ...boxHerdr({ read: () => "/exit " }),
      agentExplain: vi.fn(() => DETECTION),
    };
    const result = sender(herdr).send("/exit");
    expect(result).toMatchObject({
      ok: false,
      reason: "unverified",
      sendVerdict: "landed-not-submitted",
      detection: DETECTION,
    });
    expect(herdr.agentExplain).toHaveBeenCalledTimes(1);
    expect(herdr.agentExplain).toHaveBeenCalledWith(PANE);
  });
  it("送出が成立した経路では撃たない (成功時のコストを増やさない)", () => {
    const herdr = {
      ...fakeSendPort(),
      agentGet: () => ({ pane_id: PANE }),
      agentExplain: vi.fn(() => DETECTION),
    };
    expect(sender(herdr).send(TEXT).ok).toBe(true);
    expect(herdr.agentExplain).not.toHaveBeenCalled();
  });
  it("agent-vanished では撃たない (宛先を解決できないと確定している)", () => {
    const herdr = {
      ...boxHerdr({ read: () => "", pane: () => null }),
      agentExplain: vi.fn(() => DETECTION),
    };
    expect(sender(herdr).send(TEXT)).toMatchObject({
      reason: "agent-vanished",
    });
    expect(herdr.agentExplain).not.toHaveBeenCalled();
  });
  it("inputReadyGate の失敗に stage / ms と同時点の detection が載る", () => {
    const herdr = {
      ...boxHerdr({ read: () => "" }),
      waitIdle: () => false,
      agentExplain: vi.fn(() => DETECTION),
    };
    const gate = inputReadyGate(
      herdr,
      PANE,
      Date.now() + 50,
      false,
      TEST_TIMINGS,
    );
    expect(gate).toMatchObject({
      ok: false,
      stage: "idle",
      detection: DETECTION,
    });
    expect(herdr.agentExplain).toHaveBeenCalledWith(PANE);
  });
  it("観測できなければ null (herdr が非 0 / 宛先が消えた)", () => {
    const herdr = boxHerdr({ read: () => TEXT, working: () => false });
    expect(sender(herdr).send(TEXT)).toMatchObject({ detection: null });
  });
});
describe("AgentSender.send の exit ダイアログ段 (#2608)", () => {
  const EXIT_DIALOG = [
    "  Background work is running",
    "  The following will stop when you exit:",
    "",
    "  shell · sleep 1800",
    "",
    "  ❯ 1. Exit and stop tasks",
    "    2. Move to background and exit",
    "    3. Stay",
    "",
    "  Enter to confirm · Esc to cancel",
  ].join("\n");
  function dialogHerdr(
    opts: {
      status?: string;
      visible?: string;
      sticky?: boolean;
    } = {},
  ) {
    let phase: "prompt" | "dialog" | "exited" = "prompt";
    const status = opts.status ?? "blocked";
    const visible = opts.visible ?? EXIT_DIALOG;
    return {
      ...boxHerdr({
        read: () =>
          phase === "exited"
            ? null
            : phase === "dialog"
              ? "Background work is running / shell · sleep 1800"
              : "",
        pane: () => (phase === "exited" ? null : PANE),
        status: () => (phase === "dialog" ? status : "idle"),
        onSendKeys: (keys) => {
          if (keys === "Enter" && phase === "dialog" && !opts.sticky)
            phase = "exited";
        },
      }),
      readVisible: vi.fn(() => (phase === "dialog" ? visible : "")),
      paneRun: vi.fn(() => {
        phase = "dialog";
      }),
      agentSendKeys: vi.fn((_target: string, keys: string) => {
        if (keys === "Enter" && phase === "dialog" && !opts.sticky)
          phase = "exited";
      }),
    } satisfies HerdrSendPort;
  }
  it("blocked + 凍結文言なら Enter を 1 回撃って agent-gone に着地する", () => {
    const herdr = dialogHerdr();
    expect(sender(herdr).send("/exit")).toEqual(
      clearedOk(
        "herdr-agent-gone",
        2,
        "1 alive:ok",
        "1 box:ok",
        "1 type:ok",
        "1 enter:timeout",
        "2 alive:ok",
        "2 dialog:ok",
      ),
    );
    expect(herdr.agentSendKeys).toHaveBeenCalledTimes(1);
    expect(herdr.agentSendKeys).toHaveBeenCalledWith(PANE, "Enter");
  });
  it("blocked でも凍結文言が無ければ撃たず、現行どおり foreign で終わる", () => {
    const herdr = dialogHerdr({ visible: "Do you want to proceed?" });
    expect(sender(herdr).send("/exit")).toMatchObject({
      ok: false,
      reason: "unverified",
      verify: "claude-box-cleared",
      sendVerdict: "submitted-unconfirmed",
      lastAgentStatus: "blocked",
    });
    expect(herdr.agentSendKeys).not.toHaveBeenCalled();
  });
  it("凍結文言があっても blocked でなければ撃たない", () => {
    const herdr = dialogHerdr({ status: "idle" });
    expect(sender(herdr).send("/exit")).toMatchObject({
      ok: false,
      reason: "unverified",
      sendVerdict: "submitted-unconfirmed",
    });
    expect(herdr.agentSendKeys).not.toHaveBeenCalled();
  });
  it("ダイアログが消えなくても Enter は上限の 1 回まで (fail-open)", () => {
    const herdr = dialogHerdr({ sticky: true });
    const result = sender(herdr).send("/exit");
    expect(result).toMatchObject({
      ok: false,
      reason: "unverified",
      sendVerdict: "submitted-unconfirmed",
      lastAgentStatus: "blocked",
    });
    expect(marks(result.trace)).toEqual([
      "1 alive:ok",
      "1 box:ok",
      "1 type:ok",
      "1 enter:timeout",
      "2 alive:ok",
      "2 dialog:timeout",
      "3 alive:ok",
      "3 box:foreign",
    ]);
    expect(herdr.agentSendKeys).toHaveBeenCalledTimes(EXIT_DIALOG_MAX_ENTERS);
  });
  it("非終端コマンド (/clear) では段そのものを評価しない", () => {
    const herdr = dialogHerdr();
    const result = sender(herdr).send("/clear");
    expect(result).toMatchObject({
      ok: false,
      reason: "unverified",
      sendVerdict: "submitted-unconfirmed",
    });
    expect(herdr.agentSendKeys).not.toHaveBeenCalled();
    expect(marks(result.trace).filter((m) => m.includes("dialog:"))).toEqual(
      [],
    );
  });
  it("平文 (working 検証) でも段そのものを評価しない", () => {
    const herdr = dialogHerdr();
    const result = sender(herdr).send(TEXT);
    expect(marks(result.trace).filter((m) => m.includes("dialog:"))).toEqual(
      [],
    );
  });
});
describe("AgentSender.send の送出前 working (#2608)", () => {
  it("撃つ前から working なら waitWorking を証拠にせず box クリアで成立させる", () => {
    let box = "";
    const herdr = boxHerdr({
      read: () => box,
      status: () => "working",
      onSendText: (text) => {
        box = text;
      },
      onSendKeys: (keys) => {
        if (keys === "Enter") box = "";
      },
    });
    expect(sender(herdr).send(TEXT)).toEqual(
      clearedOk(
        "claude-box-cleared",
        1,
        "1 alive:ok",
        "1 box:ok",
        "1 type:ok",
        "1 enter:ok",
      ),
    );
    expect(herdr.waitWorking).not.toHaveBeenCalled();
  });
  it("失敗しても grace を踏まず、box クリア側の表で分類する", () => {
    let box = "";
    const herdr = boxHerdr({
      read: () => box,
      status: () => "working",
      onSendText: (text) => {
        box = text;
      },
    });
    const result = sender(herdr).send(TEXT);
    expect(result).toMatchObject({
      ok: false,
      reason: "unverified",
      verify: "claude-box-cleared",
      sendVerdict: "landed-not-submitted",
      lastAgentStatus: "working",
      boxBody: TEXT,
    });
    expect(marks(result.trace)).not.toContain("grace:ok");
    expect(marks(result.trace)).not.toContain("grace:timeout");
    expect(herdr.waitWorking).not.toHaveBeenCalled();
  });
  it("1 周目 working / 2 周目 idle の混在では周ごとに証拠を選び直す", () => {
    let box = "";
    let gets = 0;
    const herdr = boxHerdr({
      read: () => box,
      status: () => (++gets === 1 ? "working" : "idle"),
      onSendText: (text) => {
        box = text;
      },
    });
    expect(sender(herdr).send(TEXT)).toEqual(
      clearedOk(
        "herdr-agent-working",
        2,
        "1 alive:ok",
        "1 box:ok",
        "1 type:ok",
        "1 enter:timeout",
        "2 alive:ok",
        "2 box:ok",
        "2 enter:ok",
      ),
    );
    expect(herdr.waitWorking).toHaveBeenCalledTimes(1);
  });
});
