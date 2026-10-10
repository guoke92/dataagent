import { describe, expect, it } from "vitest";

import { columnLane, isClosedDictionary, isEncryptedPreview, isLargeFieldType, profileColumn, shouldPublishValueDomain, shouldSplitConcatColumn, splitConcatValue } from "./relations.js";

describe("column lanes", () => {
  it("keeps business columns on the domain lane", () => {
    expect(columnLane({ name: "status", type: "integer" })).toBe("domain");
    expect(columnLane({ name: "company_name", type: "varchar(128)" })).toBe("domain");
    expect(columnLane({ name: "city", type: "text", dialect: "postgresql" })).toBe("domain");
    expect(columnLane({ name: "customer_id", type: "integer" })).toBe("domain");
  });

  it("puts time and autoincrement on the range lane", () => {
    expect(columnLane({ name: "create_time", type: "datetime" })).toBe("range");
    expect(columnLane({ name: "updated_at", type: "timestamp" })).toBe("range");
    expect(columnLane({ name: "id", type: "bigint", autoIncrement: true })).toBe("range");
  });

  it("skips large fields and encrypted columns", () => {
    expect(columnLane({ name: "payload", type: "json" })).toBe("skip");
    expect(columnLane({ name: "file_bin", type: "blob" })).toBe("skip");
    expect(columnLane({ name: "body", type: "longtext" })).toBe("skip");
    expect(isLargeFieldType("text", "mysql")).toBe(true);
    expect(columnLane({ name: "note", type: "text", dialect: "mysql" })).toBe("skip");
    expect(columnLane({ name: "secret", type: "varchar(255)", encrypted: true })).toBe("skip");
  });

  it("profiles a high-cardinality column without blowing the stack", () => {
    const samples = Array.from({ length: 70_000 }, (_, index) => `code-${index}`);
    const profile = profileColumn("orders", "order_no", "varchar(64)", true, undefined, false, samples, samples.length, {
      stats: { rowCount: samples.length, cardinality: samples.length, nullRate: 0, min: "code-0", max: "code-9999" },
      lane: "domain"
    });
    expect(profile.samples).toHaveLength(70_000);
    expect(profile.maxLength).toBe("code-99999".length);
    expect(profile.cardinality).toBe(70_000);
    expect(profile.frequencies).toHaveLength(8);
    expect(profile.observed).toHaveLength(70_000);
  });

  it("publishes business values including company names and closed enums", () => {
    const names = profileColumn("cust", "cust_name", "varchar(128)", true, "企业名称", false, ["甲公司", "乙公司"], 20, {
      stats: { rowCount: 20, cardinality: 2, nullRate: 0 },
      valueCounts: [{ value: "甲公司", count: 12 }, { value: "乙公司", count: 8 }],
      lane: "domain"
    });
    expect(shouldPublishValueDomain(names)).toBe(true);
    expect(isClosedDictionary(names)).toBe(false);

    const enable = profileColumn("ca_fee_project_config", "enable", "varchar(8)", true, "enable", false, ["Y", "N"], 20, {
      stats: { rowCount: 20, cardinality: 2, nullRate: 0 },
      valueCounts: [{ value: "Y", count: 12 }, { value: "N", count: 8 }],
      lane: "domain"
    });
    expect(isClosedDictionary(enable)).toBe(true);

    const empty = profileColumn("ca_fee_project_config", "legacy_name", "varchar(64)", true, undefined, false, [], 20, {
      stats: { rowCount: 20, cardinality: 0, nullRate: 1 },
      lane: "skip"
    });
    expect(shouldPublishValueDomain(empty)).toBe(false);

    const snowflake = profileColumn("agreement", "id", "bigint", false, undefined, true, [
      "472883da98724279abbfac0d37578ce3",
      "5f38a8177ea3471b0a7f10cc5cf7ea40"
    ], 100, {
      stats: { rowCount: 100, cardinality: 100, nullRate: 0 },
      lane: "range"
    });
    expect(shouldPublishValueDomain(snowflake)).toBe(false);
  });

  it("recognizes encrypted previews and short concat values", () => {
    expect(isEncryptedPreview(["-----BEGIN RSA PRIVATE KEY-----abc"])).toBe(true);
    expect(isEncryptedPreview(["Y", "N"])).toBe(false);
    expect(splitConcatValue("[\"A\",\"B\"]")).toEqual(["A", "B"]);
    expect(shouldSplitConcatColumn(["[\"A\",\"B\"]", "[\"A\"]", "[\"B\",\"C\"]"])).toBe(true);
  });
});
