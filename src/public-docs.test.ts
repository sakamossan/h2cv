import type { HerdrPort } from "./launcher.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fakeHerdrPort } from "./__tests__/fakes.js";
import { AGENT_NAME_MAX, AGENT_NAME_RE, PANE_ID_RE, run } from "./cli.js";
import {
  ERROR_TOPIC,
  EVIDENCE_ADVICE,
  hintFor,
  resolveTopic,
  SEND_VERDICT_ADVICE,
  TESTED_WITH,
  TOPICS,
  VERIFY_ADVICE,
} from "./explain.js";
import { deriveAgentName } from "./launch.js";
import { TURNLESS_SLASH_COMMANDS } from "./sender.js";
import { ALL_STAGES, INPUT_READY_STAGE_IDS, TRACE_RESULTS } from "./stages.js";

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = readFileSync(join(PKG_DIR, "README.md"), "utf8");
const PKG = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as {
  name: string;
  engines: {
    node: string;
  };
};
type Catalog = {
  target: string;
  commands: {
    name: string;
    flags: {
      name: string;
      summary: string;
    }[];
    summary: string;
  }[];
};
const CATALOG = JSON.parse(run(["--help"]).stdout) as Catalog;
const CATALOG_PROSE = [
  CATALOG.target,
  ...CATALOG.commands.flatMap((c) => [
    c.summary,
    ...c.flags.map((f) => f.summary),
  ]),
].join("\n");
const README_PROSE = README.replace(/^```[\s\S]*?^```/gm, "");
const inlineCode = (md: string): string[] => [
  ...new Set([...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!)),
];
const fillPlaceholders = (s: string): string => s.replace(/<[^<>]*>/g, "0");
const kebabWords = (s: string): string[] =>
  fillPlaceholders(s).match(/[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g) ?? [];
const slashCommandLists = (s: string): string[][] =>
  [...s.matchAll(/\(([^()]*)\)/g)]
    .map((m) => m[1]!.match(/\/[a-z][a-z-]*/g) ?? [])
    .filter((cmds) => cmds.length >= 2);
const vocabulary = new Set([
  ...Object.keys(ERROR_TOPIC),
  ...Object.keys(TOPICS),
  ...Object.keys(EVIDENCE_ADVICE),
  ...Object.keys(SEND_VERDICT_ADVICE),
  ...Object.keys(VERIFY_ADVICE),
  ...ALL_STAGES.map((s) => s.id),
  ...CATALOG.commands.map((c) => c.name),
  ...CATALOG.commands
    .flatMap((c) => c.flags.map((f) => f.name))
    .flatMap(kebabWords),
  ...kebabWords(deriveAgentName("w0:p0")),
]);
const NOT_H2CV_VOCABULARY = ["herdr", "claude"];
describe("turnless コマンド一覧", () => {
  it.each([
    ["README", README_PROSE],
    ["--help の CATALOG", CATALOG_PROSE],
  ])("%s のコマンド一覧が TURNLESS_SLASH_COMMANDS と一致する", (_, text) => {
    const lists = slashCommandLists(text);
    expect(lists, "コマンド一覧の写しが見つからない").not.toHaveLength(0);
    for (const cmds of lists)
      expect([...cmds].sort()).toEqual([...TURNLESS_SLASH_COMMANDS].sort());
  });
  it("CATALOG が名指しするコマンドがすべて TURNLESS_SLASH_COMMANDS に実在する", () => {
    for (const cmd of CATALOG_PROSE.match(/\/[a-z][a-z-]*/g) ?? [])
      expect(TURNLESS_SLASH_COMMANDS, cmd).toContain(cmd);
  });
});
describe("input-ready の段列", () => {
  it("CATALOG が書く段の並びが INPUT_READY_STAGE_IDS と一致する", () => {
    const m = CATALOG_PROSE.match(/\(([a-z]+(?: -> [a-z]+)+)\)/);
    expect(m, "CATALOG に段列が見つからない").not.toBeNull();
    expect(m![1]!.split(" -> ")).toEqual([...INPUT_READY_STAGE_IDS]);
  });
});
describe("agent 名の制約", () => {
  const m = CATALOG_PROSE.match(
    /at most (\d+) characters of (\[[^\]]+\]) starting with a lowercase letter/,
  );
  it("CATALOG が書く上限が AGENT_NAME_MAX と一致する", () => {
    expect(m, "CATALOG に名前制約が見つからない").not.toBeNull();
    expect(Number(m![1])).toBe(AGENT_NAME_MAX);
  });
  it("CATALOG が書く字種が AGENT_NAME_RE と同じ名前を受理する", () => {
    expect(m, "CATALOG に名前制約が見つからない").not.toBeNull();
    const declared = new RegExp(`^[a-z]${m![2]}*$`);
    const ascii = Array.from({ length: 95 }, (_, i) =>
      String.fromCharCode(32 + i),
    );
    for (const c of ascii) {
      expect(declared.test(c), `先頭 ${JSON.stringify(c)}`).toBe(
        AGENT_NAME_RE.test(c),
      );
      expect(declared.test(`a${c}`), `2 文字目 ${JSON.stringify(c)}`).toBe(
        AGENT_NAME_RE.test(`a${c}`),
      );
    }
  });
});
describe("正準 pane id の書式", () => {
  const alphabet = inlineCode(README_PROSE).find((c) =>
    /^[0-9A-Z]{16,}$/.test(c),
  );
  it("README が書く alphabet の全文字を PANE_ID_RE が受理する", () => {
    expect(alphabet, "README に base32 alphabet が見つからない").toBeDefined();
    for (const c of alphabet!)
      expect(PANE_ID_RE.test(`w${c}:p${c}`), `${c} が弾かれる`).toBe(true);
  });
  it("上流が採番しない除外文字を README も PANE_ID_RE も持たない", () => {
    for (const c of "ILOU") {
      expect(
        alphabet,
        `${c} が README の alphabet に混ざっている`,
      ).not.toContain(c);
      expect(PANE_ID_RE.test(`w${c}:p${c}`), `${c} が受理される`).toBe(false);
    }
  });
  it.each([
    ["README", README_PROSE],
    ["--help の CATALOG", CATALOG_PROSE],
  ])(
    "%s の pane id テンプレートが PANE_ID_RE を通る形をしている",
    (_, text) => {
      const shapes = [...text.matchAll(/w<[^<>]+>:p<[^<>]+>/g)].map(
        (m) => m[0],
      );
      expect(shapes, "pane id テンプレートが見つからない").not.toHaveLength(0);
      for (const shape of shapes)
        expect(PANE_ID_RE.test(fillPlaceholders(shape)), shape).toBe(true);
    },
  );
  it("README が挙げる実例をそのまま PANE_ID_RE が受理する", () => {
    const examples = inlineCode(README_PROSE).filter((c) =>
      /^w[0-9A-Z]+:p[0-9A-Z]+$/.test(c),
    );
    expect(examples, "pane id の実例が見つからない").not.toHaveLength(0);
    for (const example of examples)
      expect(PANE_ID_RE.test(example), example).toBe(true);
  });
});
describe("agentName の生成名", () => {
  it.each([
    ["README", README_PROSE],
    ["--help の CATALOG", CATALOG_PROSE],
  ])("%s の生成名テンプレートが deriveAgentName と一致する", (_, text) => {
    const shapes = [...text.matchAll(/h2cv-w<[^<>]+>-p<[^<>]+>/g)].map(
      (m) => m[0],
    );
    expect(shapes, "生成名テンプレートが見つからない").not.toHaveLength(0);
    for (const shape of shapes) {
      const paneShape = shape.replace(/^h2cv-/, "").replace("-p", ":p");
      expect(deriveAgentName(fillPlaceholders(paneShape))).toBe(
        fillPlaceholders(shape),
      );
    }
  });
});
describe("explain のトピック名", () => {
  it("README が挙げる `h2cv explain <arg>` の引数がすべて解決する", () => {
    const args = [...README.matchAll(/h2cv explain ([a-z][a-z0-9-]*)/g)].map(
      (m) => m[1]!,
    );
    expect(args, "explain の使用例が見つからない").not.toHaveLength(0);
    for (const arg of args)
      expect(resolveTopic(arg), `${arg} が解決しない`).not.toBeNull();
  });
});
describe("kebab-case の語彙", () => {
  it.each([
    ["README", README_PROSE],
    ["--help の CATALOG", CATALOG_PROSE],
  ])("%s の inline code の kebab-case 語がすべて実装に実在する", (_, text) => {
    const unknown = inlineCode(text)
      .flatMap(kebabWords)
      .filter((w) => !vocabulary.has(w) && !NOT_H2CV_VOCABULARY.includes(w));
    expect([...new Set(unknown)]).toEqual([]);
  });
});
describe("出力 JSON の写し", () => {
  const PANE = "w1:p2K";
  const liveHerdr = (): HerdrPort =>
    fakeHerdrPort({
      agentGet: () => ({
        pane_id: PANE,
        terminal_id: "term_1",
        agent: "claude",
      }),
    });
  const unverifiedHerdr = (): HerdrPort => ({
    ...liveHerdr(),
    waitWorking: () => false,
  });
  const emitted = (herdr: HerdrPort): Record<string, unknown> =>
    JSON.parse(run(["send", "--pane", PANE, "hello"], herdr).stdout);
  const blocks = [...README.matchAll(/^```json\n([\s\S]*?)^```/gm)].map(
    (m) => JSON.parse(m[1]!) as Record<string, unknown>,
  );
  const shown = {
    success: blocks.filter((b) => b["ok"] === true),
    failure: blocks.filter((b) => b["ok"] === false),
  };
  const VALUE_VOCABULARY: Record<string, string[]> = {
    error: Object.keys(ERROR_TOPIC),
    evidence: Object.keys(EVIDENCE_ADVICE),
    sendVerdict: Object.keys(SEND_VERDICT_ADVICE),
    verify: Object.keys(VERIFY_ADVICE),
    stage: ALL_STAGES.map((st) => st.id),
    result: Object.keys(TRACE_RESULTS),
  };
  const checkVocabulary = (obj: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(obj)) {
      const vocabulary = VALUE_VOCABULARY[key];
      if (vocabulary && typeof value === "string")
        expect(vocabulary, `${key}: ${value}`).toContain(value);
    }
  };
  it.each([
    ["成功", "success", liveHerdr],
    ["失敗", "failure", unverifiedHerdr],
  ] as const)(
    "README の %s ブロックのキーが実出力に実在する",
    (_, kind, herdr) => {
      const real = emitted(herdr());
      expect(shown[kind], "json ブロックが見つからない").not.toHaveLength(0);
      for (const block of shown[kind])
        for (const key of Object.keys(block))
          expect(real, key).toHaveProperty(key);
    },
  );
  it.each([
    ["成功", "success", liveHerdr],
    ["失敗", "failure", unverifiedHerdr],
  ] as const)(
    "README の %s ブロックの trace 行が実出力と同じ形をしている",
    (_, kind, herdr) => {
      const realRows = (emitted(herdr())["trace"] ?? []) as Record<
        string,
        unknown
      >[];
      for (const block of shown[kind])
        for (const row of (block["trace"] ?? []) as Record<string, unknown>[]) {
          expect(realRows, "実出力に trace 行が無い").not.toHaveLength(0);
          for (const key of Object.keys(row))
            expect(realRows[0], key).toHaveProperty(key);
          checkVocabulary(row);
        }
    },
  );
  it("README が挙げる値がすべて実装の語彙に実在する", () => {
    expect(blocks, "json ブロックが見つからない").not.toHaveLength(0);
    for (const block of blocks) checkVocabulary(block);
  });
  const emittedKeys = (): Set<string> => {
    const launchable = (): HerdrPort => ({
      ...liveHerdr(),
      tabCreate: () => ({ ok: true as const, tabId: "tab-1", paneId: PANE }),
    });
    const samples = [
      emitted(liveHerdr()),
      emitted(unverifiedHerdr()),
      JSON.parse(
        run(
          ["launch", "--cwd", "/wt/owner/repo/1", "--prompt", "hi"],
          launchable(),
        ).stdout,
      ),
      JSON.parse(run(["frobnicate"]).stdout),
    ];
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object")
        for (const [k, v] of Object.entries(value)) {
          keys.add(k);
          walk(v);
        }
    };
    samples.forEach(walk);
    return keys;
  };
  it("README の散文が名指しする出力キーがすべて実出力に実在する", () => {
    const keys = emittedKeys();
    const unknown = inlineCode(README_PROSE)
      .filter((c) => /^[a-z][A-Za-z0-9]*$/.test(c))
      .filter(
        (c) =>
          !keys.has(c) &&
          !vocabulary.has(c) &&
          !NOT_H2CV_VOCABULARY.includes(c),
      );
    expect([...new Set(unknown)]).toEqual([]);
  });
  it("README が挙げる hint が error から引いたものと一致する", () => {
    for (const block of shown.failure)
      if (typeof block["hint"] === "string")
        expect(block["hint"]).toBe(
          hintFor(block["error"] as Parameters<typeof hintFor>[0]),
        );
  });
});
describe("パッケージのメタデータ", () => {
  it("README の install 行が package.json の name と一致する", () => {
    const m = README.match(/^npm install -g (\S+)$/m);
    expect(m, "README に install 行が見つからない").not.toBeNull();
    expect(m![1]).toBe(PKG.name);
  });
  it("README の Node.js 下限が engines と一致する", () => {
    const m = README.match(/^- Node\.js (\d+) or newer/m);
    expect(m, "README に Node.js の要件行が見つからない").not.toBeNull();
    expect(PKG.engines.node).toBe(`>=${m![1]}`);
  });
  it("tested-with 行が TESTED_WITH と一致する", () => {
    const m = README.match(
      /^Tested with claude (\S+) \/ herdr (\S+) \(agent detection manifest (\S+)\)\.$/m,
    );
    expect(m, "README に tested-with 行が見つからない").not.toBeNull();
    expect({ claude: m![1], herdr: m![2], manifest: m![3] }).toEqual({
      ...TESTED_WITH,
    });
  });
});
