import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { H2CV_VERSION } from "./version.js";

describe("H2CV_VERSION", () => {
  it("package.json の version と一致する", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      version: string;
    };
    expect(H2CV_VERSION).toBe(pkg.version);
  });
});
