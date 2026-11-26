import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { parseSample } from "../plugins/samples-plugin";

describe("parseSample", () => {
  test("shows the region between the markers, without the lines marked @hide", () => {
    const { code } = parseSample(
      [
        "//! not shown",
        "// @show:start",
        "use channelstack::Result;",
        "",
        '#[ignore = "needs a running agent"] // @hide',
        "#[tokio::test]",
        "async fn a() -> Result<()> {",
        "    Ok(())",
        "}",
        "// @show:end",
      ].join("\n"),
    );
    expect(code).toBe(
      ["use channelstack::Result;", "", "#[tokio::test]", "async fn a() -> Result<()> {", "    Ok(())", "}"].join("\n"),
    );
  });

  test("a step covers the lines a chained call continues on", () => {
    const { code, steps } = parseSample(
      [
        "fn a() {",
        "    // [!step 1]",
        "    let msg = ana",
        '        .say("hi")',
        "        .await?;",
        "",
        "    done();",
        "}",
      ].join("\n"),
    );
    expect(code.split("\n")).toHaveLength(7);
    expect(steps).toEqual([0, 1, 1, 1, 0, 0, 0]);
  });

  test("each home page example carries the same playback steps in every language", async () => {
    const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
    const scenes = [
      ["../samples/hero.test.ts", "../samples/python/test_deploy.py", "../examples/rust/src/home_slack.rs"],
      ["../samples/github.test.ts", "../samples/python/test_issues.py", "../examples/rust/src/home_github.rs"],
      ["../samples/linear.test.ts", "../samples/python/test_sessions.py", "../examples/rust/src/home_linear.rs"],
      ["../samples/notion.test.ts", "../samples/python/test_comments.py", "../examples/rust/src/home_notion.rs"],
    ];
    for (const files of scenes) {
      const stepSets = await Promise.all(
        files.map(async (file) => [...new Set(parseSample(await read(file)).steps.filter(Boolean))]),
      );
      expect(stepSets[1], files[1]).toEqual(stepSets[0]);
      expect(stepSets[2], files[2]).toEqual(stepSets[0]);
    }
  });
});
