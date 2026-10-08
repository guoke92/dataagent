import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { LlmWiki, type LlmClient } from "./index.js";

const databases: DatabaseSync[] = [];

const createWiki = (): LlmWiki => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return new LlmWiki(db);
};

const orders = {
  dialect: "postgresql",
  tables: [
    {
      name: "orders",
      columns: [
        { name: "customer_id", type: "integer", nullable: false, comment: "客户主键", samples: ["1", "1", "2", "2"] },
        { name: "status", type: "integer", nullable: false, samples: ["0", "1", "2"] }
      ],
      foreignKeys: [{ column: "customer_id", refTable: "customer", refColumn: "id" }]
    },
    {
      name: "customer",
      columns: [
        { name: "id", type: "integer", nullable: false, primaryKey: true, comment: "客户主键", samples: ["1", "2", "3"] },
        { name: "status", type: "integer", nullable: false, samples: ["0", "1", "2"] }
      ]
    }
  ]
};

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("llm-wiki", () => {
  it("writes ground in facts_only without calling the model or writing descriptions", async () => {
    const wiki = createWiki();
    const llm: LlmClient = { complete: async () => { throw new Error("LLM_CALLED"); } };
    const result = await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "facts_only",
      snapshot: orders,
      llm
    });
    expect(result.llmCalls).toBe(0);
    expect(wiki.catalogPages("ws").some((page) => page.type === "column")).toBe(false);
    const relation = wiki.catalogPages("ws").find((page) => page.type === "relation");
    expect(relation?.body).toContain("[[orders#customer_id]]");
    expect(relation?.body).toContain("[[orders]]");
    expect(relation?.body).toContain("[[customer#id]]");
    const projection = wiki.projectSchema("ws", "db1");
    expect(projection?.tables.map((table) => table.name)).toEqual(["customer", "orders"]);
    const columns = projection?.tables.flatMap((table) => table.columns) ?? [];
    expect(columns.find((column) => column.name === "status")?.label).toBeUndefined();
    expect(columns.find((column) => column.name === "status")?.examples).toBeUndefined();
    expect(columns.find((column) => column.name === "customer_id")?.label).toBe("客户主键");
    expect(columns.find((column) => column.name === "customer_id")?.examples).toBeUndefined();
    expect(wiki.search("ws", "基数").some((hit) => hit.type === "table")).toBe(true);
    expect(projection?.relations.some((relation) => relation.statement.includes("orders.customer_id = customer.id"))).toBe(true);
    expect(projection?.relations.some((relation) => /score=|overlap=|parentKey=/u.test(relation.statement))).toBe(false);
    expect(wiki.search("ws", "高频值").some((hit) => hit.type === "table")).toBe(true);
  });

  it("keeps database ground unchanged when a document is refreshed", async () => {
    const wiki = createWiki();
    await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "facts_only", snapshot: orders });
    const before = wiki.projectSchema("ws", "db1");
    const fingerprintBefore = wiki.sourceFingerprint("ws", "database", "db1");
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "doc1",
      sourceKind: "document",
      mode: "facts_only",
      text: "客户: 下单的人\n"
    });
    expect(wiki.sourceFingerprint("ws", "database", "db1")).toBe(fingerprintBefore);
    expect(wiki.projectSchema("ws", "db1")?.tables).toEqual(before?.tables);
  });

  it("lets documents own terms, the database own column names, and code own the bridge", async () => {
    const wiki = createWiki();
    const llm: LlmClient = { complete: async () => JSON.stringify({ short: "客户编号", long: "订单上的客户编号，整数。" }) };
    await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "facts_only", snapshot: orders });
    await wiki.scan({ workspaceId: "ws", sourceId: "doc1", sourceKind: "document", mode: "facts_only", text: "客户: 下单的人\n" });
    await wiki.scan({ workspaceId: "ws", sourceId: "doc1", sourceKind: "document", mode: "semantic", llm });
    expect(wiki.search("ws", "下单的人").some((hit) => hit.type === "concept" && hit.excerpt.includes("下单的人"))).toBe(true);
    expect(wiki.search("ws", "客户主键").some((hit) => hit.type === "concept" && hit.excerpt.includes("orders.customer_id"))).toBe(true);
    expect(wiki.search("ws", "客户 ->").some((hit) => hit.type === "concept" && hit.excerpt.includes("->"))).toBe(false);
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "code1",
      sourceKind: "code",
      mode: "facts_only",
      text: "bridge 客户 -> orders.customer_id\njoin orders.customer_id = customer.id 应用订单归属\n"
    });
    await wiki.scan({ workspaceId: "ws", sourceId: "code1", sourceKind: "code", mode: "semantic", llm });
    expect(wiki.search("ws", "orders.customer_id").some((hit) => hit.excerpt.includes("客户 ->"))).toBe(true);
    expect(wiki.projectSchema("ws", "db1")?.tables.flatMap((table) => table.columns).map((column) => column.name)).toContain("customer_id");
    const relations = wiki.search("ws", "orders.customer_id = customer.id");
    expect(relations.some((hit) => hit.type === "relation")).toBe(true);
    expect(wiki.search("ws", "orders.customer_id = customer.id").some((hit) => hit.type === "relation")).toBe(true);
    expect(wiki.search("ws", "orders.status").some((hit) => hit.type === "relation")).toBe(false);
  });

  it("ranks compiled wiki pages by exact logical identity before loose semantic text", async () => {
    const wiki = createWiki();
    await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "facts_only", snapshot: orders });
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "doc1",
      sourceKind: "document",
      mode: "facts_only",
      text: "订单状态: 订单所处的业务阶段\n"
    });
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "doc1",
      sourceKind: "document",
      mode: "semantic",
      llm: { complete: async () => "" }
    });
    const hits = wiki.query("ws", "订单状态");
    expect(hits[0]?.type).toBe("concept");
    expect(hits.every((hit) => !hit.excerpt.includes("所属列"))).toBe(true);
    expect(wiki.query("ws", "order").some((hit) => /order_id/u.test(`${hit.title} ${hit.excerpt}`))).toBe(false);
  });

  it("skips an unchanged database snapshot and refreshes when sampled values change", async () => {
    const wiki = createWiki();
    const first = await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "facts_only", snapshot: orders });
    const second = await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "facts_only", snapshot: orders });
    expect(first.skipped).toBe(false);
    expect(second.skipped).toBe(true);
    const changed = await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "facts_only",
      snapshot: {
        ...orders,
        tables: orders.tables.map((table) => table.name === "customer"
          ? { ...table, columns: table.columns.map((column) => column.name === "id" ? { ...column, samples: ["90"] } : column) }
          : table)
      }
    });
    expect(changed.skipped).toBe(false);
    expect(wiki.lookupValues("ws", "db1", "90").some((hit) => hit.column === "id")).toBe(true);
  });

  it("looks up values without rewriting pages", async () => {
    const wiki = createWiki();
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "facts_only",
      snapshot: {
        tables: [{
          name: "customer",
          columns: [{ name: "name", type: "text", nullable: true, samples: ["Fresno County Office", "Other"] }]
        }]
      }
    });
    const before = wiki.projectSchema("ws", "db1");
    const hits = wiki.lookupValues("ws", "db1", "Fresno County Office");
    expect(hits).toEqual([{ table: "customer", column: "name", match: "exact", sample: "Fresno County Office" }]);
    expect(wiki.projectSchema("ws", "db1")).toEqual(before);
  });

  it("keeps a human-reviewed field while refreshing the other fields", async () => {
    const wiki = createWiki();
    const llm: LlmClient = { complete: async () => JSON.stringify({ short: "新描述", long: "更长的新描述。" }) };
    await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "facts_only", snapshot: orders });
    wiki.pin("ws", "table:db1:orders", "人工钉住的列说明", "customer_id");
    await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "semantic", llm });
    const page = wiki.search("ws", "人工钉住的列说明").find((hit) => hit.page_id === "table:db1:orders");
    expect(page?.excerpt).toContain("人工钉住的列说明");
    expect(wiki.search("ws", "基数").find((hit) => hit.page_id === "table:db1:orders")?.excerpt).toContain("基数");
  });

  it("projects clean dictionary labels without wikilink noise", async () => {
    const wiki = createWiki();
    const llm: LlmClient = {
      complete: async (prompt: string) => {
        if (prompt.includes("字典")) {
          return JSON.stringify({
            decision: "dictionary",
            labels: [
              { value: "0", label: "新建" },
              { value: "1", label: "完成" },
              { value: "2", label: "取消" }
            ]
          });
        }
        return JSON.stringify({ short: "" });
      }
    };
    await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "facts_only", snapshot: orders });
    await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "semantic", llm });
    const status = wiki.projectSchema("ws", "db1")?.tables
      .flatMap((table) => table.columns)
      .find((column) => column.name === "status");
    expect(status?.labels).toEqual(["0 = 新建", "1 = 完成", "2 = 取消"]);
    const relation = wiki.projectSchema("ws", "db1")?.relations[0]?.statement ?? "";
    expect(relation).toBe("orders.customer_id = customer.id");
  });

  it("keeps wiki scope, anchors, outline, and deletion on one contract", async () => {
    const wiki = createWiki();
    await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "facts_only", snapshot: orders });
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "db2",
      sourceKind: "database",
      mode: "facts_only",
      snapshot: {
        tables: [{ name: "other", columns: [{ name: "id", type: "integer", nullable: false, samples: ["1"] }] }]
      }
    });
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "doc-anchored",
      sourceKind: "document",
      mode: "facts_only",
      datasourceIds: ["db1"],
      text: "订单状态: 业务阶段 orders.status\n"
    });
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "doc-anchored",
      sourceKind: "document",
      mode: "semantic",
      datasourceIds: ["db1"],
      llm: { complete: async () => "" }
    });
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "doc-bridge",
      sourceKind: "document",
      mode: "facts_only",
      datasourceIds: ["db1", "db2"],
      text: "跨库客户: 对应 orders.customer_id\n"
    });
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "doc-bridge",
      sourceKind: "document",
      mode: "semantic",
      datasourceIds: ["db1", "db2"],
      llm: { complete: async () => "" }
    });
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "doc-loose",
      sourceKind: "document",
      mode: "facts_only",
      datasourceIds: ["db1"],
      text: "这是一段没有落点的制度说明。\n"
    });
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "doc-loose",
      sourceKind: "document",
      mode: "semantic",
      datasourceIds: ["db1"],
      llm: { complete: async () => "" }
    });

    const outline = wiki.outlineText("ws", ["db1"]);
    expect(outline).toContain("orders");
    expect(outline).not.toContain("nullable");
    const anchored = await wiki.recall("ws", "订单状态", ["db1"]);
    expect(anchored.some((hit) => hit.type === "concept" && hit.anchor === "orders.status")).toBe(true);
    expect(anchored.some((hit) => "content" in hit || "chunk_id" in hit)).toBe(false);
    expect((await wiki.recall("ws", "跨库客户", ["db1"])).some((hit) => hit.title.includes("跨库"))).toBe(false);
    expect((await wiki.recall("ws", "跨库客户", ["db1", "db2"])).some((hit) => hit.title.includes("跨库"))).toBe(true);
    expect(wiki.catalogPages("ws").some((page) => page.body.includes("没有落点的制度说明"))).toBe(false);

    const pinned = wiki.catalogPages("ws").find((page) => page.evidence_ids.includes("doc-anchored"));
    expect(pinned).toBeTruthy();
    wiki.pin("ws", pinned!.id, pinned!.body);
    wiki.forgetEvidence("ws", "doc-anchored");
    expect(wiki.catalogPages("ws").some((page) => page.id === pinned!.id && page.status === "human")).toBe(true);
    wiki.forgetEvidence("ws", "doc-bridge");
    expect(wiki.catalogPages("ws").some((page) => page.evidence_ids.includes("doc-bridge"))).toBe(false);
  });
});

