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
    expect(columns.find((column) => column.name === "status")?.examples).toEqual(["0", "1", "2"]);
    expect(columns.find((column) => column.name === "customer_id")?.label).toBe("客户主键");
    expect(columns.find((column) => column.name === "customer_id")?.examples).toEqual(["1", "2"]);
    expect(wiki.search("ws", "基数").some((hit) => hit.type === "table")).toBe(true);
    expect(projection?.relations.some((relation) => relation.statement.includes("orders.customer_id = customer.id"))).toBe(true);
    expect(projection?.relations.some((relation) => /score=|overlap=|parentKey=/u.test(relation.statement))).toBe(false);
    expect(wiki.search("ws", "高频值").some((hit) => hit.type === "table")).toBe(true);
    expect(wiki.catalogPages("ws").some((page) => page.type === "value-domain" && page.title.includes("status"))).toBe(true);
    expect(wiki.lookupValues("ws", "db1", "0").some((hit) => hit.column === "status")).toBe(true);
    expect(wiki.lookupValues("ws", "db1", "1").some((hit) => hit.column === "id")).toBe(false);
    expect(wiki.lookupValues("ws", "db1", "1").some((hit) => hit.column === "customer_id")).toBe(true);
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
    expect(wiki.search("ws", "客户主键").some((hit) => hit.excerpt.includes("orders.customer_id") || hit.excerpt.includes("客户主键"))).toBe(true);
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
          ? { ...table, columns: table.columns.map((column) => column.name === "status" ? { ...column, samples: ["0", "9"] } : column) }
          : table)
      }
    });
    expect(changed.skipped).toBe(false);
    expect(wiki.lookupValues("ws", "db1", "9").some((hit) => hit.column === "status")).toBe(true);
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
        if (prompt.includes("闭合枚举")) {
          return JSON.stringify({
            items: [
              {
                subject: "orders.status",
                enum: true,
                labels: [
                  { value: "0", label: "新建" },
                  { value: "1", label: "完成" },
                  { value: "2", label: "取消" }
                ]
              },
              {
                subject: "customer.status",
                enum: true,
                labels: [
                  { value: "0", label: "新建" },
                  { value: "1", label: "完成" },
                  { value: "2", label: "取消" }
                ]
              }
            ]
          });
        }
        if (prompt.includes("keep")) {
          return JSON.stringify({
            items: [
              { subject: "orders.status", keep: true },
              { subject: "customer.status", keep: true },
              { subject: "orders.customer_id", keep: true }
            ]
          });
        }
        return JSON.stringify({ items: [] });
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
    const anchored = wiki.query("ws", "订单状态", ["db1"]);
    expect(anchored.some((hit) => hit.type === "concept" && hit.anchor === "orders.status")).toBe(true);
    expect(anchored.some((hit) => "content" in hit || "chunk_id" in hit)).toBe(false);
    expect(wiki.query("ws", "跨库客户", ["db1"]).some((hit) => hit.title.includes("跨库"))).toBe(false);
    expect(wiki.query("ws", "跨库客户", ["db1", "db2"]).some((hit) => hit.title.includes("跨库"))).toBe(true);
    expect(wiki.catalogPages("ws").some((page) => page.body.includes("没有落点的制度说明"))).toBe(false);

    const pinned = wiki.catalogPages("ws").find((page) => page.evidence_ids.includes("doc-anchored"));
    expect(pinned).toBeTruthy();
    wiki.pin("ws", pinned!.id, pinned!.body);
    wiki.forgetEvidence("ws", "doc-anchored");
    expect(wiki.catalogPages("ws").some((page) => page.id === pinned!.id && page.status === "human")).toBe(true);
    wiki.forgetEvidence("ws", "doc-bridge");
    expect(wiki.catalogPages("ws").some((page) => page.evidence_ids.includes("doc-bridge"))).toBe(false);
  });

  it("keeps repeated field comments on the column and does not mint a concept page", async () => {
    const wiki = createWiki();
    const tables = Array.from({ length: 10 }, (_, index) => ({
      name: `t${index}`,
      columns: [
        { name: "id", type: "integer", nullable: false, primaryKey: true, comment: "表主键", samples: ["1"] },
        { name: "created_at", type: "datetime", nullable: false, comment: "创建时间", samples: [] },
        { name: "enable", type: "varchar", nullable: false, comment: "enable", samples: ["Y"] },
        { name: "biz_code", type: "varchar", nullable: false, comment: index === 0 ? "特定资金渠道编码" : "资金渠道编码", samples: ["A"] }
      ]
    }));
    await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "facts_only", snapshot: { tables } });
    await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "semantic", llm: { complete: async () => "" } });
    const pages = wiki.catalogPages("ws");
    expect(pages.some((page) => page.type === "concept")).toBe(false);
    const table = pages.find((page) => page.id === "table:db1:t0");
    expect(table?.body).toContain("特定资金渠道编码");
    expect(table?.body).toContain("表主键");
  });

  it("deletes stale pages for a source when facts are rewritten", async () => {
    const wiki = createWiki();
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "facts_only",
      snapshot: {
        tables: [
          ...orders.tables,
          {
            name: "audit_log",
            columns: [
              { name: "note", type: "varchar", nullable: true, comment: "一次性审计附言", samples: ["alpha", "beta"] }
            ]
          }
        ]
      }
    });
    expect(wiki.catalogPages("ws").some((page) => page.title.includes("audit_log"))).toBe(true);
    wiki.pin("ws", "table:db1:audit_log", "人工保留的表说明", "note");
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "facts_only",
      snapshot: orders
    });
    const pages = wiki.catalogPages("ws");
    expect(pages.some((page) => page.id === "table:db1:audit_log" && page.status === "human")).toBe(true);
    expect(pages.some((page) => page.type === "concept" && page.title.includes("audit_log"))).toBe(false);
    expect(pages.some((page) => page.type === "value-domain" && page.title.includes("audit_log"))).toBe(false);
    expect(pages.some((page) => page.id === "table:db1:orders")).toBe(true);
  });

  it("writes a dictionary from comment codes and leaves other short domains for the model", async () => {
    const wiki = createWiki();
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "facts_only",
      snapshot: {
        tables: [{
          name: "orders",
          columns: [
            { name: "status", type: "varchar", nullable: false, comment: "Y-是，N-否", samples: ["Y", "N"] },
            { name: "kind", type: "varchar", nullable: false, samples: ["启用", "停用"] },
            { name: "customer_id", type: "integer", nullable: false, samples: ["1", "2"] }
          ]
        }]
      }
    });
    const pages = wiki.catalogPages("ws");
    expect(pages.some((page) => page.type === "value-domain" && page.title === "orders.status")).toBe(true);
    expect(pages.some((page) => page.type === "dictionary" && page.title === "orders.status" && /Y\t是/u.test(page.body))).toBe(true);
    expect(pages.some((page) => page.type === "value-domain" && page.title === "orders.kind")).toBe(true);
    expect(pages.some((page) => page.type === "dictionary" && page.title === "orders.kind")).toBe(false);
    expect(pages.some((page) => page.type === "dictionary" && page.title === "orders.customer_id")).toBe(false);
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "semantic",
      llm: {
        complete: async (prompt: string) => {
          if (prompt.includes("闭合枚举")) {
            return JSON.stringify({
              items: [{ subject: "orders.kind", enum: true, labels: [{ value: "启用", label: "已启用" }, { value: "停用", label: "已停用" }] }]
            });
          }
          return JSON.stringify({ items: [] });
        }
      }
    });
    const labeled = wiki.catalogPages("ws").find((page) => page.type === "dictionary" && page.title === "orders.kind");
    expect(labeled?.body).toMatch(/启用\t已启用/u);
  });

  it("does not ask the model to name columns or review wide value domains", async () => {
    const wiki = createWiki();
    const prompts: string[] = [];
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "facts_only",
      snapshot: {
        tables: [{
          name: "cust",
          columns: [
            { name: "cust_name", type: "varchar", nullable: false, samples: Array.from({ length: 40 }, (_, index) => `公司${index}`) },
            { name: "status", type: "varchar", nullable: false, samples: ["Y", "N"] }
          ]
        }]
      }
    });
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "semantic",
      llm: {
        complete: async (prompt: string) => {
          prompts.push(prompt);
          return JSON.stringify({ items: [] });
        }
      }
    });
    expect(prompts.some((prompt) => prompt.includes("业务叫法"))).toBe(false);
    expect(prompts.filter((prompt) => prompt.includes("闭合枚举"))).toHaveLength(1);
    expect(prompts.some((prompt) => prompt.includes("cust.cust_name"))).toBe(false);
    expect(prompts.some((prompt) => prompt.includes("cust.status"))).toBe(true);
    expect(wiki.catalogPages("ws").some((page) => page.type === "value-domain" && page.title === "cust.cust_name")).toBe(true);
  });

  it("keeps each sql candidate pending until a person adopts it", async () => {
    const wiki = createWiki();
    const llm: LlmClient = { complete: async () => "{\"items\":[]}" };
    await wiki.fileBackAcceptedSql({ workspaceId: "ws", sourceId: "sql-1", sql: "select 1", question: "甲部门人数", llm });
    await wiki.fileBackAcceptedSql({ workspaceId: "ws", sourceId: "sql-2", sql: "select 2", question: "乙部门人数", llm });
    const pages = wiki.catalogPages("ws").filter((page) => page.type === "query-pattern");
    expect(pages.map((page) => page.id).sort()).toEqual([
      "query-pattern:dialogue:query sql-1",
      "query-pattern:dialogue:query sql-2"
    ]);
    expect(pages.every((page) => page.status === "pending")).toBe(true);
    const before = await wiki.recallKnowledge("ws", "甲部门人数");
    expect(before.terms.some((hit) => hit.type === "query-pattern")).toBe(false);
    const first = pages.find((page) => page.id.endsWith("sql-1"));
    expect(first).toBeTruthy();
    wiki.pin("ws", first?.id ?? "", first?.body ?? "", "query");
    const after = await wiki.recallKnowledge("ws", "甲部门人数");
    expect(after.terms.some((hit) => hit.type === "query-pattern" && hit.page_id.endsWith("sql-1"))).toBe(true);
    expect(after.terms.some((hit) => hit.page_id.endsWith("sql-2"))).toBe(false);
  });

  it("links a question noun to a stored value and only then loads that table", async () => {
    const wiki = createWiki();
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "facts_only",
      snapshot: {
        tables: [
          {
            name: "spend",
            columns: [
              { name: "dept_name", type: "varchar", nullable: false, samples: ["研发第二部门", "研发第一部门"] },
              { name: "amount", type: "integer", nullable: false, samples: ["10", "20"] }
            ]
          },
          {
            name: "other",
            columns: [{ name: "note", type: "varchar", nullable: true, samples: ["无关"] }]
          }
        ],
        measuredRelations: [{
          left: "spend.dept_name",
          right: "other.note",
          score: 122.5,
          overlap: 122.5,
          name: 0,
          comment: 0,
          keyShape: 1,
          parentIsKey: true,
          veto: false
        }]
      }
    });
    const packet = await wiki.recallKnowledge("ws", "查询二部研发投入", ["db1"]);
    expect(packet.mentions.some((hit) => hit.text === "二部" && hit.table === "spend" && hit.column === "dept_name" && hit.value === "研发第二部门")).toBe(true);
    expect(packet.mentions.some((hit) => hit.text === "研发")).toBe(false);
    expect(packet.unlinked).toContain("研发");
    expect(packet.tables.map((table) => table.name)).toContain("spend");
    expect(packet.relations).toEqual([]);
    expect(packet.terms.some((hit) => hit.type === "value-domain")).toBe(false);
  });

  it("reruns semantic compile when the model identity changes", async () => {
    const wiki = createWiki();
    const llm: LlmClient = { complete: async () => JSON.stringify({ items: [] }) };
    await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "facts_only", snapshot: orders });
    const first = await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "semantic", llm, modelKey: "none" });
    const second = await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "semantic", llm, modelKey: "none" });
    const third = await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "semantic", llm, modelKey: "workspace-default" });
    expect(first.skipped).toBe(false);
    expect(second.skipped).toBe(true);
    expect(third.skipped).toBe(false);
    expect(third.llmCalls).toBeGreaterThan(0);
  });

  it("keeps value-domain pages to top K while the value index stays complete", async () => {
    const wiki = createWiki();
    const samples = Array.from({ length: 20 }, (_, index) => `city-${index}`);
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "facts_only",
      snapshot: {
        tables: [{ name: "geo", columns: [{ name: "city", type: "varchar", nullable: false, samples }] }]
      }
    });
    const domain = wiki.catalogPages("ws").find((page) => page.type === "value-domain" && page.title === "geo.city");
    const rows = (domain?.body ?? "").split("\n").filter((line) => line.includes("\t"));
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(wiki.lookupValues("ws", "db1", "city-19").some((hit) => hit.column === "city")).toBe(true);
  });

  it("publishes a measured relation only when the model calls it a foreign key", async () => {
    const wiki = createWiki();
    const snapshot = {
      tables: [
        {
          name: "orders",
          columns: [
            { name: "id", type: "integer", nullable: false, primaryKey: true, samples: ["1", "2"] },
            { name: "customer_id", type: "integer", nullable: false, samples: ["1", "2"] }
          ]
        },
        {
          name: "customer",
          columns: [{ name: "id", type: "integer", nullable: false, primaryKey: true, samples: ["1", "2", "3"] }]
        }
      ],
      measuredRelations: [{
        left: "orders.customer_id",
        right: "customer.id",
        score: 1,
        overlap: 1,
        name: 0.6,
        comment: 0,
        keyShape: 1,
        parentIsKey: true,
        veto: false
      }]
    };
    await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "facts_only", snapshot });
    expect(wiki.catalogPages("ws").some((page) => page.type === "relation")).toBe(false);
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "semantic",
      llm: {
        complete: async (prompt: string) => prompt.includes("foreign_key")
          ? JSON.stringify({ items: [{ subject: "customer.id~orders.customer_id", decision: "foreign_key" }] })
          : JSON.stringify({ items: [] })
      }
    });
    expect(wiki.catalogPages("ws").some((page) => page.type === "relation" && page.title.includes("orders.customer_id = customer.id"))).toBe(true);
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "facts_only",
      snapshot: {
        ...snapshot,
        tables: snapshot.tables.map((table) => table.name === "orders"
          ? { ...table, columns: table.columns.map((column) => column.name === "customer_id" ? { ...column, samples: ["1", "2", "2"] } : column) }
          : table)
      }
    });
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "semantic",
      llm: { complete: async () => JSON.stringify({ items: [] }) }
    });
    expect(wiki.catalogPages("ws").some((page) => page.type === "relation")).toBe(false);
  });

  it("drops an unlabeled dictionary when the model does not call it a closed enum", async () => {
    const wiki = createWiki();
    const snapshot = {
      tables: [{
        name: "orders",
        columns: [{ name: "kind", type: "varchar", nullable: false, samples: ["A", "B"] }]
      }]
    };
    await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "facts_only", snapshot });
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "semantic",
      llm: {
        complete: async (prompt: string) => prompt.includes("闭合枚举")
          ? JSON.stringify({ items: [{ subject: "orders.kind", enum: true, labels: [{ value: "A", label: "" }, { value: "B", label: "" }] }] })
          : JSON.stringify({ items: [] })
      }
    });
    expect(wiki.catalogPages("ws").some((page) => page.type === "dictionary" && page.title === "orders.kind")).toBe(true);
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "facts_only",
      snapshot: {
        tables: [{
          name: "orders",
          columns: [{ name: "kind", type: "varchar", nullable: false, samples: ["A", "B", "B"] }]
        }]
      }
    });
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "semantic",
      llm: { complete: async () => JSON.stringify({ items: [] }) }
    });
    expect(wiki.catalogPages("ws").some((page) => page.type === "dictionary")).toBe(false);
    expect(wiki.catalogPages("ws").some((page) => page.type === "value-domain" && page.title === "orders.kind")).toBe(true);
  });
});

