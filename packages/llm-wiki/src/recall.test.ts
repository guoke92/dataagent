import { describe, expect, it } from "vitest";

import { parseDictionaryLabels, stripStructuralLinkLines } from "./recall.js";

describe("dictionary label parsing", () => {
  it("parses values: lists and strips structural links", () => {
    const raw = [
      "values: douyin, xiaohongshu, tmall, wechat",
      "所属列 [[orders#channel]]",
      "所属表 [[orders]]",
      "所属列 [[orders#channel]]",
      "所属表 [[orders]]"
    ].join("\n");
    expect(stripStructuralLinkLines(raw)).toBe("values: douyin, xiaohongshu, tmall, wechat");
    expect(parseDictionaryLabels(raw)).toEqual(["douyin", "xiaohongshu", "tmall", "wechat"]);
  });

  it("parses frequency dictionary lines without navigation noise", () => {
    const raw = [
      "护肤套装 = 护肤套装 × 8 (0.250)",
      "精华 = 精华 × 8 (0.250)",
      "所属列 [[orders#category]]",
      "所属表 [[orders]]"
    ].join("\n");
    expect(parseDictionaryLabels(raw)).toEqual(["护肤套装", "精华"]);
  });

  it("keeps distinct value=label pairs", () => {
    expect(parseDictionaryLabels("0 = 新建 × 3 (0.5)\n1 = 完成 × 3 (0.5)")).toEqual([
      "0 = 新建",
      "1 = 完成"
    ]);
  });

  it("skips cardinality metadata lines", () => {
    expect(parseDictionaryLabels("cardinality=3\n0\t1\t0.500\n1\t1\t0.500")).toEqual(["0", "1"]);
  });

  it("keeps labels from dictionary tab rows", () => {
    expect(parseDictionaryLabels("kind=dictionary\n0\t新建\t3\t0.500\n1\t完成\t3\t0.500")).toEqual([
      "0 = 新建",
      "1 = 完成"
    ]);
  });
});
