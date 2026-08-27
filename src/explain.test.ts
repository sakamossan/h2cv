import { describe, expect, it } from "vitest";
import {
  ERROR_TOPIC,
  hintFor,
  listTopics,
  renderTopic,
  resolveTopic,
  SEND_VERDICT_ADVICE,
  TOPICS,
} from "./explain.js";
import { ALL_STAGES, PROBLEMS, RETIRED } from "./stages.js";

describe("resolveTopic", () => {
  it("トピック名をそのまま引ける", () => {
    expect(resolveTopic("send-protocol")).toBe("send-protocol");
    expect(resolveTopic("output-contract")).toBe("output-contract");
  });
  it("エラーコードからトピックへ解決する", () => {
    expect(resolveTopic("send-unverified")).toBe("send-protocol");
    expect(resolveTopic("agent-vanished")).toBe("herdr-agent-alive");
    expect(resolveTopic("not-ready")).toBe("input-ready");
    expect(resolveTopic("usage")).toBe("output-contract");
  });
  it("未知は null", () => {
    expect(resolveTopic("no-such-topic")).toBeNull();
    expect(resolveTopic("")).toBeNull();
  });
});
describe("hintFor", () => {
  it("エラーコードに対応するトピックへの入口を返す", () => {
    expect(hintFor("send-unverified")).toBe("h2cv explain send-protocol");
    expect(hintFor("usage")).toBe("h2cv explain output-contract");
  });
  it("全エラーコードの hint がそのまま resolveTopic で引ける (コピペで往復できる)", () => {
    for (const code of Object.keys(
      ERROR_TOPIC,
    ) as (keyof typeof ERROR_TOPIC)[]) {
      const arg = hintFor(code).replace("h2cv explain ", "");
      expect(resolveTopic(arg)).toBe(ERROR_TOPIC[code]);
    }
  });
});
describe("listTopics / renderTopic", () => {
  it("全トピックが 1 行サマリつきで並ぶ", () => {
    const out = listTopics();
    expect(out.map((t) => t.topic)).toEqual(Object.keys(TOPICS));
    for (const t of out) expect(t.summary).toBeTruthy();
  });
  it("全トピックの本文が行の配列で返る (pretty JSON の中で縦に読めること)", () => {
    for (const topic of Object.keys(TOPICS) as (keyof typeof TOPICS)[]) {
      const out = renderTopic(topic);
      expect(out.topic).toBe(topic);
      expect(Array.isArray(out.body)).toBe(true);
      for (const line of out.body) expect(line).not.toContain("\n");
    }
  });
  it("判断表を持つトピックだけ tables が載る", () => {
    expect(renderTopic("send-protocol").tables).toEqual({
      stage: expect.any(Array),
      result: expect.any(Array),
      verify: expect.any(Array),
      sendVerdict: expect.any(Array),
      evidence: expect.any(Array),
    });
    expect(renderTopic("input-ready").tables).toEqual({
      stage: expect.any(Array),
    });
    expect(renderTopic("output-contract").tables).toEqual({
      provenance: expect.any(Array),
    });
    expect(renderTopic("failure-modes").tables).toEqual({
      problems: expect.any(Array),
      retired: expect.any(Array),
    });
    expect(renderTopic("overview").tables).toBeUndefined();
  });
  it("tables の各行は key 列を先頭に持つ", () => {
    const rows = renderTopic("send-protocol").tables!.sendVerdict;
    expect(Object.keys(rows[0])).toEqual([
      "sendVerdict",
      "condition",
      "advice",
    ]);
    expect(rows.map((r) => r.sendVerdict)).toEqual(
      Object.keys(SEND_VERDICT_ADVICE),
    );
  });
});
describe("registry と explain の突き合わせ (#2507)", () => {
  const allRows = Object.values(TOPICS).flatMap((t) =>
    Object.values(t.tables ?? {}).flat(),
  );
  it("registry の全段 id がどこかの表に出る", () => {
    const shown = new Set(allRows.map((r) => r.stage).filter(Boolean));
    for (const stage of ALL_STAGES)
      expect(shown, `${stage.id} がどの表にも出ていない`).toContain(stage.id);
  });
  it("PROBLEMS / RETIRED の全 id が failure-modes に出る", () => {
    const tables = renderTopic("failure-modes").tables!;
    expect(tables.problems.map((r) => r.problem)).toEqual(
      Object.keys(PROBLEMS),
    );
    expect(tables.retired.map((r) => r.retired)).toEqual(Object.keys(RETIRED));
  });
  it("段の defends が指す問題 id はすべて PROBLEMS に実在する", () => {
    for (const stage of ALL_STAGES)
      for (const id of stage.defends)
        expect(PROBLEMS, `${stage.id} の ${id}`).toHaveProperty(id);
  });
});
