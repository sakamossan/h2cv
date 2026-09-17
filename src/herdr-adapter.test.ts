import type { CmdResult } from "./herdr-adapter.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { execNg, execOk, fakeExec } from "./__tests__/fakes.js";
import {
  HerdrAdapter,
  herdrErrorCode,
  parseBox,
  parseBoxBody,
  sleepSync,
  summarizeDetection,
} from "./herdr-adapter.js";

const RULE = `\x1b[0m\x1b[38;2;136;136;136m${"─".repeat(80)}\x1b[0m`;
const STATUS = [
  "  \u001B[0m\u001B[38;5;30mdevbox\u001B[0m\u001B[38;5;188m:\u001B[0m\u001B[38;5;155mprobe\u001B[0m",
  "  \u001B[0m\u001B[38;5;178mOpus 5\u001B[0m",
];
function screen(...boxLines: string[]): string {
  return [RULE, ...boxLines, RULE, ...STATUS].join("\r\n");
}
describe("parseBoxBody", () => {
  it("空の box は placeholder ヒント (dim) を本文として数えず空を返す", () => {
    const dump = screen(
      '❯ \u001B[0m\u001B[2mTry "how does <filepath> work?"\u001B[0m',
    );
    expect(parseBoxBody(dump)).toBe("");
  });
  it("入力済みの本文はそのまま返す (実入力は装飾なしで描かれる)", () => {
    expect(parseBoxBody(screen("❯ hello world"))).toBe("hello world");
  });
  it("送出済みで空になった box は空を返す", () => {
    expect(parseBoxBody(screen("❯"))).toBe("");
  });
  it("折り返した複数行の本文を空白 1 個で畳んで連結する", () => {
    const dump = screen(
      "❯ これは検証用の長い本文です。/loop 30m /run-in-the-loop という送出本文を模し",
      "  た文字列で、折り返しが起きる程度の長さにしてあります。abcdefghij klmnopqrst",
      "  uvwxyz 0123456789",
    );
    expect(parseBoxBody(dump)).toBe(
      "これは検証用の長い本文です。/loop 30m /run-in-the-loop という送出本文を模し " +
        "た文字列で、折り返しが起きる程度の長さにしてあります。abcdefghij klmnopqrst " +
        "uvwxyz 0123456789",
    );
  });
  it("本文が縦に溢れて上端の罫線と ❯ が画面外でも可視分を本文として返す", () => {
    const dump = ["  line 39", "  line 40", RULE, ...STATUS].join("\r\n");
    expect(parseBoxBody(dump)).toBe("line 39 line 40");
  });
  it("罫線が 1 本も無ければ判定不能として null を返す", () => {
    expect(parseBoxBody("no box here\r\njust text\r\n")).toBeNull();
  });
  it("セッション名を咥えた上端の罫線も上端として認める (#3205)", () => {
    const labeled = `${"─".repeat(94)} h2cv-3205 ─`;
    const dump = [labeled, "❯ hello world", RULE, ...STATUS].join("\r\n");
    expect(parseBox(dump)).toEqual({ body: "hello world", truncated: false });
  });
  it("ラベル付きの罫線は下端としては採らない (緩めるのは上端だけ。#3205)", () => {
    const labeled = `${"─".repeat(94)} h2cv-3205 ─`;
    const dump = [RULE, "❯ hello", labeled, ...STATUS].join("\r\n");
    expect(parseBoxBody(dump)).toBe("");
  });
  it("上端の罫線が見つかれば truncated: false (本文は全部画面内。#3205)", () => {
    expect(parseBox(screen("❯ hello world"))).toEqual({
      body: "hello world",
      truncated: false,
    });
  });
  it("下端の罫線しか無ければ truncated: true (読めたのは末尾側だけ。#3205)", () => {
    const dump = ["  line 39", "  line 40", RULE, ...STATUS].join("\r\n");
    expect(parseBox(dump)).toEqual({
      body: "line 39 line 40",
      truncated: true,
    });
  });
  it("workspace trust ダイアログは null ではなく空本文を返す (#1792)", () => {
    const AMBER = "\u001B[0m\u001B[38;2;255;193;7m";
    const GREY = "\u001B[0m\u001B[38;2;153;153;153m";
    const dump = [
      "",
      `${AMBER}${"─".repeat(120)}\x1b[0m`,
      ` ${AMBER}\x1b[1mAccessing workspace:\x1b[0m`,
      "",
      " \u001B[0m\u001B[1m/home/you/trust-probe\u001B[0m",
      "",
      " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
      " project, or work from your team). If not, take a moment to review what's in this folder first.",
      "",
      " Claude Code'll be able to read, edit, and execute files here.",
      "",
      ` ${GREY}Security guide\x1b[0m`,
      "",
      ` \x1b[0m\x1b[38;2;177;185;249m❯ No, exit\x1b[0m`,
      "   Yes, I trust this folder",
      "",
      ` ${GREY}Enter to confirm · Esc to cancel\x1b[0m`,
    ].join("\r\n");
    expect(parseBoxBody(dump)).toBe("");
  });
});
describe("HerdrAdapter.readBoxBody", () => {
  it("宛先へ visible + ansi で読み、stdout をそのままパーサへ渡す", () => {
    let seen: string[] = [];
    const client = new HerdrAdapter(
      fakeExec((bin, args) => {
        if (bin !== "herdr" || args[1] !== "read") return undefined;
        seen = args;
        return execOk(screen("❯ hello"));
      }),
    );
    expect(client.readBoxBody("w1:p1")).toBe("hello");
    expect(seen).toEqual([
      "agent",
      "read",
      "w1:p1",
      "--source",
      "visible",
      "--format",
      "ansi",
    ]);
  });
  it("herdr が非 0 終了なら判定不能として null を返す", () => {
    const client = new HerdrAdapter(fakeExec(() => execNg("agent not found")));
    expect(client.readBoxBody("w1:p1")).toBeNull();
  });
  it("罫線を含まない出力は判定不能として null を返す", () => {
    const client = new HerdrAdapter(fakeExec(() => execOk("box が無い画面")));
    expect(client.readBoxBody("w1:p1")).toBeNull();
  });
  it("readBox は readBoxBody と同じ argv で読み、truncated まで返す (#3205)", () => {
    let seen: string[] = [];
    const client = new HerdrAdapter(
      fakeExec((bin, args) => {
        if (bin !== "herdr" || args[1] !== "read") return undefined;
        seen = args;
        return execOk(screen("❯ hello"));
      }),
    );
    expect(client.readBox("w1:p1")).toEqual({
      body: "hello",
      truncated: false,
    });
    expect(seen).toEqual([
      "agent",
      "read",
      "w1:p1",
      "--source",
      "visible",
      "--format",
      "ansi",
    ]);
  });
});
describe("HerdrAdapter.readVisible", () => {
  it("宛先の visible frame を text で読み、stdout をそのまま返す", () => {
    let seen: string[] = [];
    const client = new HerdrAdapter(
      fakeExec((bin, args) => {
        if (bin !== "herdr" || args[1] !== "read") return undefined;
        seen = args;
        return execOk("tail line\n");
      }),
    );
    expect(client.readVisible("w1:p1")).toBe("tail line\n");
    expect(seen).toEqual([
      "agent",
      "read",
      "w1:p1",
      "--source",
      "visible",
      "--format",
      "text",
    ]);
  });
  it("読めなければ空文字 (診断出力なので判定不能と区別しない)", () => {
    const client = new HerdrAdapter(fakeExec(() => execNg("agent not found")));
    expect(client.readVisible("w1:p1")).toBe("");
  });
});
describe("HerdrAdapter.paneReadTail", () => {
  it("pane の visible frame を text で読み、stdout をそのまま返す", () => {
    let seen: string[] = [];
    const client = new HerdrAdapter(
      fakeExec((bin, args) => {
        if (bin !== "herdr" || args[1] !== "read") return undefined;
        seen = args;
        return execOk("$ \n");
      }),
    );
    expect(client.paneReadTail("w1:p1")).toBe("$ \n");
    expect(seen).toEqual([
      "pane",
      "read",
      "w1:p1",
      "--source",
      "visible",
      "--format",
      "text",
    ]);
  });
  it("読めなければ空文字", () => {
    const client = new HerdrAdapter(fakeExec(() => execNg("pane not found")));
    expect(client.paneReadTail("w1:p1")).toBe("");
  });
});
const RAW_IDLE: unknown = JSON.parse(
  readFileSync(
    new URL("./__tests__/explain-idle.json", import.meta.url),
    "utf8",
  ),
);
type RawRule = {
  evidence?: {
    region_preview?: string;
  };
};
describe("summarizeDetection", () => {
  it("core フィールドを camelCase へ写す (state は agent_status と一致しないことがある)", () => {
    const d = summarizeDetection(RAW_IDLE)!;
    expect(d.state).toBe("idle");
    expect(d.matchedRule).toEqual({
      id: "live_prompt_box",
      state: "idle",
      priority: 950,
      region: "prompt_box_body",
    });
    expect(d.visibleIdle).toBe(true);
    expect(d.visibleBlocker).toBe(false);
    expect(d.visibleWorking).toBe(false);
    expect(d.fallbackReason).toBeNull();
    expect(d.manifestVersion).toBe("2026.07.13.1");
  });
  it("正常時は screenDetectionSkipped / warning が生えない (コスト 0)", () => {
    const d = summarizeDetection(RAW_IDLE)!;
    expect("screenDetectionSkipped" in d).toBe(false);
    expect("warning" in d).toBe(false);
  });
  it("異常時だけ screenDetectionSkipped / warning が生える", () => {
    const d = summarizeDetection({
      state: "unknown",
      evaluated_rules: [],
      screen_detection_skipped: true,
      warning: "manifest reload failed",
    })!;
    expect(d.screenDetectionSkipped).toBe(true);
    expect(d.warning).toBe("manifest reload failed");
  });
  it("ルールは 12 件すべて残す (絞ると欠落の理由を呼び出し側が推論することになる)", () => {
    const d = summarizeDetection(RAW_IDLE)!;
    expect(d.rules).toHaveLength(12);
    expect(d.rules.map((r) => r.id)).toContain("osc_title_working");
    expect(d.rules.find((r) => r.id === "live_prompt_box")?.matched).toBe(true);
  });
  it("region_preview は regions へ dedup する (12 ルール → distinct 7 region)", () => {
    const d = summarizeDetection(RAW_IDLE)!;
    expect(Object.keys(d.regions).sort()).toEqual([
      "after_last_horizontal_rule",
      "bottom_non_empty_lines(3)",
      "bottom_non_empty_lines(5)",
      "osc_progress",
      "osc_title",
      "prompt_box_body",
      "whole_recent",
    ]);
    expect(d.regions.osc_title).toBe("✳ Claude Code");
    for (const r of d.rules) expect(r).not.toHaveProperty("regionPreview");
  });
  it("0 / 空配列の evidence は落とし、非 0 の count は残す", () => {
    const d = summarizeDetection(RAW_IDLE)!;
    const blocked = d.rules.find((r) => r.id === "live_blocked_form")!;
    expect(blocked.anyCount).toBe(5);
    expect(blocked.contains).toEqual(["enter to select", "esc to cancel"]);
    expect(blocked).not.toHaveProperty("allCount");
    expect(blocked).not.toHaveProperty("notCount");
    expect(blocked).not.toHaveProperty("regex");
    expect(blocked).not.toHaveProperty("lineRegex");
    expect(
      d.rules.find((r) => r.id === "osc_progress_idle"),
    ).not.toHaveProperty("regionBytes");
  });
  it("dedup と 0 落としで失敗 JSON へ載せられる大きさまで縮む", () => {
    const rules = (
      RAW_IDLE as {
        evaluated_rules: RawRule[];
      }
    ).evaluated_rules;
    const d = summarizeDetection(RAW_IDLE)!;
    const perRule = rules.reduce(
      (n, r) => n + JSON.stringify(r.evidence?.region_preview ?? "").length,
      0,
    );
    expect(JSON.stringify(Object.values(d.regions)).length).toBeLessThan(
      perRule * 0.6,
    );
    expect(JSON.stringify(d).length).toBeLessThan(
      JSON.stringify(RAW_IDLE).length * 0.7,
    );
  });
  it("形が想定外なら null (判定不能を捏造しない)", () => {
    expect(summarizeDetection(null)).toBeNull();
    expect(summarizeDetection("idle")).toBeNull();
    expect(summarizeDetection([])).toBeNull();
    expect(summarizeDetection({ evaluated_rules: [] })).toBeNull();
    expect(summarizeDetection({ state: "idle" })).toBeNull();
    expect(
      summarizeDetection({
        state: "idle",
        evaluated_rules: [{ matched: true }],
      }),
    ).toBeNull();
  });
  it("知らないフィールドや欠落したフィールドでは捨てずに読める分だけ写す", () => {
    const d = summarizeDetection({
      state: "blocked",
      evaluated_rules: [{ id: "future_rule", matched: true, novel_field: 1 }],
      matched_rule: { id: "future_rule" },
      visible_blocker: true,
      novel_top_level: "whatever",
    })!;
    expect(d.state).toBe("blocked");
    expect(d.visibleBlocker).toBe(true);
    expect(d.matchedRule).toEqual({ id: "future_rule" });
    expect(d.rules).toEqual([{ id: "future_rule", matched: true }]);
    expect(d.regions).toEqual({});
  });
});
describe("HerdrAdapter.agentExplain", () => {
  it("安定ハンドル宛に --json で撃ち、top-level のフィールドをそのまま要約する", () => {
    let seen: string[] = [];
    const client = new HerdrAdapter(
      fakeExec((bin, args) => {
        if (bin !== "herdr" || args[1] !== "explain") return undefined;
        seen = args;
        return execOk(JSON.stringify(RAW_IDLE));
      }),
    );
    expect(client.agentExplain("term_1")?.state).toBe("idle");
    expect(seen).toEqual(["agent", "explain", "term_1", "--json"]);
  });
  it("対象が消えていれば (非 0 + agent_not_found) null に丸める", () => {
    const client = new HerdrAdapter(
      fakeExec(() =>
        execNg('{"error":{"code":"agent_not_found","message":"..."}}'),
      ),
    );
    expect(client.agentExplain("term_gone")).toBeNull();
  });
  it("JSON として読めない応答も null (診断なので推測で埋めない)", () => {
    const client = new HerdrAdapter(fakeExec(() => execOk("not json")));
    expect(client.agentExplain("term_1")).toBeNull();
  });
});
describe("HerdrAdapter の argv 契約 (#1989)", () => {
  function recorder(stdout = "") {
    const seen: string[][] = [];
    const client = new HerdrAdapter(
      fakeExec((_bin, args) => {
        seen.push(args);
        return execOk(stdout);
      }),
    );
    return { client, seen };
  }
  it("waitIdle は --until idle --until done で待つ (done も入力を受け付ける状態)", () => {
    const { client, seen } = recorder();
    expect(client.waitIdle("w1:p1", 5000)).toBe(true);
    expect(seen[0]).toEqual([
      "agent",
      "wait",
      "w1:p1",
      "--until",
      "idle",
      "--until",
      "done",
      "--timeout",
      "5000",
    ]);
  });
  it("waitWorking は --until working 単独 (submit 成立の肯定シグナルを絞る)", () => {
    const { client, seen } = recorder();
    expect(client.waitWorking("w1:p1", 6000)).toBe(true);
    expect(seen[0]).toEqual([
      "agent",
      "wait",
      "w1:p1",
      "--until",
      "working",
      "--timeout",
      "6000",
    ]);
  });
  it("agentStart は --kind / --pane / --timeout を渡し、-- 以降に実行ファイル名を足さない", () => {
    const { client, seen } = recorder();
    expect(client.agentStart("agent-3", "w1:p1", ["--foo", "bar"])).toEqual({
      ok: true,
    });
    expect(seen[0]).toEqual([
      "agent",
      "start",
      "agent-3",
      "--kind",
      "claude",
      "--pane",
      "w1:p1",
      "--timeout",
      "300000",
      "--",
      "--foo",
      "bar",
    ]);
  });
  it("waitIdleOrBlocked は blocked を待ち受け集合に足す (fresh 起動の関門用)", () => {
    const { client, seen } = recorder();
    expect(client.waitIdleOrBlocked("w1:p1", 5000)).toBe(true);
    expect(seen[0]).toEqual([
      "agent",
      "wait",
      "w1:p1",
      "--until",
      "idle",
      "--until",
      "done",
      "--until",
      "blocked",
      "--timeout",
      "5000",
    ]);
  });
  it("agentStart は agent_not_ready を起動失敗にせず notReady 付きの成功で返す", () => {
    let calls = 0;
    const client = new HerdrAdapter(
      fakeExec(() => {
        calls += 1;
        return execNg(
          '{"error":{"code":"agent_not_ready","message":"agent agent-3 is blocked during startup and is not ready for prompts"},"id":"cli:agent:start"}',
        );
      }),
    );
    expect(client.agentStart("agent-3", "w1:p1", [])).toEqual({
      ok: true,
      notReady: true,
    });
    expect(calls).toBe(1);
  });
  it("agentStart は agent_pane_busy のときだけ撃ち直す (シェルのプロンプト待ち)", () => {
    let calls = 0;
    const client = new HerdrAdapter(
      fakeExec(() =>
        ++calls < 3
          ? execNg(
              '{"error":{"code":"agent_pane_busy","message":"not an available shell"}}',
            )
          : execOk(),
      ),
    );
    expect(client.agentStart("agent-3", "w1:p1", [])).toEqual({ ok: true });
    expect(calls).toBe(3);
  });
  it("agentStart は agent_pane_busy 以外の失敗を即返す (直らない失敗で粘らない)", () => {
    let calls = 0;
    const client = new HerdrAdapter(
      fakeExec(() => {
        calls += 1;
        return execNg('{"error":{"code":"invalid_argument"}}');
      }),
    );
    expect(client.agentStart("agent-3", "w1:p1", [])).toMatchObject({
      ok: false,
    });
    expect(calls).toBe(1);
  });
  it("tabCreate は tab_id と root pane の pane_id を両方返す", () => {
    const { client } = recorder(
      JSON.stringify({
        result: {
          tab: { tab_id: "w1:t2" },
          root_pane: { pane_id: "w1:p2" },
        },
      }),
    );
    expect(client.tabCreate("agent-3", "/tmp/ws")).toEqual({
      ok: true,
      tabId: "w1:t2",
      paneId: "w1:p2",
    });
  });
  it("tabCreate は root pane の pane_id を欠く応答を失敗として扱う", () => {
    const { client } = recorder(
      JSON.stringify({ result: { tab: { tab_id: "w1:t2" } } }),
    );
    expect(client.tabCreate("agent-3", "/tmp/ws")).toMatchObject({ ok: false });
  });
  it("本文送出は pane-level の send-text、キー送出は agent-level の send-keys", () => {
    const { client, seen } = recorder();
    client.paneSendText("w1:p1", "本文");
    client.agentSendKeys("w1:p1", "C-c");
    expect(seen[0]).toEqual(["pane", "send-text", "w1:p1", "本文"]);
    expect(seen[1]).toEqual(["agent", "send-keys", "w1:p1", "C-c"]);
  });
});
describe("herdrErrorCode", () => {
  it("stderr の error JSON から code を読む (0.7.5 実測の出力先)", () => {
    expect(
      herdrErrorCode(
        execNg(
          '{"error":{"code":"protocol_mismatch","message":"..."},"id":"x"}',
        ),
      ),
    ).toBe("protocol_mismatch");
  });
  it("stdout 側に出る版でも読む (出力先は版で揺れる)", () => {
    const r = {
      code: 1,
      stdout: '{"id":"x","error":{"code":"server_not_running"}}',
      stderr: "",
    };
    expect(herdrErrorCode(r)).toBe("server_not_running");
  });
  it("JSON でない生の I/O エラーは null (読めなかった)", () => {
    expect(
      herdrErrorCode(execNg("Error: Os { code: 2, kind: NotFound }")),
    ).toBeNull();
  });
  it("error を持たない JSON も null", () => {
    expect(herdrErrorCode(execNg('{"id":"x","result":{}}'))).toBeNull();
  });
});
describe("probeServer", () => {
  function adapter(r: CmdResult) {
    return new HerdrAdapter(
      fakeExec((_bin, args) => (args[0] === "agent" ? r : undefined)),
    );
  }
  it("成功は up", () => {
    expect(adapter(execOk("{}")).probeServer()).toBe("up");
  });
  it("protocol_mismatch は down ではなく protocol-mismatch", () => {
    expect(
      adapter(execNg('{"error":{"code":"protocol_mismatch"}}')).probeServer(),
    ).toBe("protocol-mismatch");
  });
  it("server_not_running は従来どおり down", () => {
    expect(
      adapter(execNg('{"error":{"code":"server_not_running"}}')).probeServer(),
    ).toBe("down");
  });
  it("未知の code / パース不能は down へ倒す (fail-open)", () => {
    expect(adapter(execNg('{"error":{"code":"whatever"}}')).probeServer()).toBe(
      "down",
    );
    expect(adapter(execNg("Error: Os { code: 2 }")).probeServer()).toBe("down");
  });
});
describe("paneWaitOutput", () => {
  const WAIT_MS = 60;
  function adapter(r: CmdResult, sleepMs = 0) {
    return new HerdrAdapter(
      fakeExec((_bin, args) => {
        if (args[0] !== "pane") return undefined;
        sleepSync(sleepMs);
        return r;
      }),
    );
  }
  const wait = (a: HerdrAdapter) =>
    a.paneWaitOutput("w1:p2", "h2cv-shell-ready-x", WAIT_MS);
  it("exit 0 は matched", () => {
    expect(wait(adapter(execOk()))).toBe("matched");
  });
  it("予算を使い切ってからの非 0 は timeout", () => {
    expect(wait(adapter(execNg("timed out"), WAIT_MS))).toBe("timeout");
  });
  it("予算を使わずに返る非 0 は unavailable (口の無い版は usage を吐いて即返る)", () => {
    const usage = {
      code: 2,
      stdout: "Manage panes\n\nUsage: herdr pane <COMMAND>",
      stderr: "",
    };
    expect(wait(adapter(usage))).toBe("unavailable");
  });
  it("消えた pane / 応答しない server も待てなかった側 (即時の非 0) へ落ちる", () => {
    expect(wait(adapter(execNg('{"error":{"code":"pane_not_found"}}')))).toBe(
      "unavailable",
    );
  });
});
