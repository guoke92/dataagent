import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { collectDatabaseSnapshot, LlmWiki, type DatabaseProbe } from "./index.js";
import { estimatedContainment, sketchFromValues } from "./minhash.js";

const databases: DatabaseSync[] = [];

const createWiki = (): LlmWiki => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return new LlmWiki(db);
};

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const finance = {
  dialect: "mysql",
  tables: [
    {
      name: "cust_company_info",
      columns: [
        { name: "id", type: "bigint", nullable: false, primaryKey: true, autoIncrement: false, samples: ["1000000000000001", "1000000000000002"] },
        { name: "cust_name", type: "varchar(128)", nullable: false, comment: "企业名称", samples: Array.from({ length: 40 }, (_, index) => `公司${index}`) },
        { name: "enable", type: "varchar(8)", nullable: false, comment: "Y-是，N-否", samples: ["Y", "N"] },
        { name: "secret", type: "varchar(255)", nullable: true, encrypted: true, lane: "skip" as const, cardinality: 12, nullRate: 0 },
        { name: "created_at", type: "datetime", nullable: false, min: "2024-01-01 00:00:00", max: "2024-12-31 00:00:00", cardinality: 2, rowCount: 2 },
        { name: "tags", type: "varchar(64)", nullable: true, samples: ["[\"A\",\"B\"]", "[\"A\"]", "[\"B\",\"C\"]"] }
      ]
    },
    {
      name: "authorization_agreement",
      columns: [
        { name: "id", type: "bigint", nullable: false, primaryKey: true, samples: ["9"] },
        { name: "company_id", type: "bigint", nullable: false, samples: ["1000000000000001", "1000000000000002"] },
        { name: "enable", type: "varchar(8)", nullable: false, samples: ["Y", "N"] },
        { name: "remark", type: "varchar(255)", nullable: true, comment: "备注", samples: ["说明一", "说明二"] }
      ],
      foreignKeys: [{ column: "company_id", refTable: "cust_company_info", refColumn: "id" }]
    }
  ],
  measuredRelations: [
    {
      left: "authorization_agreement.company_id",
      right: "cust_company_info.id",
      score: 1,
      overlap: 1,
      name: 0.6,
      comment: 0,
      keyShape: 1,
      parentIsKey: true,
      veto: false
    },
    {
      left: "authorization_agreement.enable",
      right: "cust_company_info.enable",
      score: 1,
      overlap: 1,
      name: 1,
      comment: 0,
      keyShape: 0.2,
      parentIsKey: false,
      veto: true
    }
  ]
};

describe("wiki extract architecture", () => {
  it("keeps domain, top K, and a real key relation on the same business column", async () => {
    const wiki = createWiki();
    await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "facts_only", snapshot: finance });
    const pages = wiki.catalogPages("ws");
    expect(pages.some((page) => page.type === "value-domain" && page.title === "cust_company_info.cust_name")).toBe(true);
    expect(pages.some((page) => page.type === "value-domain" && page.title === "authorization_agreement.company_id")).toBe(false);
    const projection = wiki.projectSchema("ws", "db1");
    const name = projection?.tables.flatMap((table) => table.columns).find((column) => column.name === "cust_name");
    expect(name?.examples?.length).toBeGreaterThan(0);
    expect(projection?.relations.some((relation) => relation.statement.includes("authorization_agreement.company_id = cust_company_info.id"))).toBe(true);
    expect(projection?.relations.some((relation) => relation.statement.includes("enable = "))).toBe(false);
  });

  it("keeps time, snowflake, autoincrement, and secrets off the value index", async () => {
    const wiki = createWiki();
    await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "facts_only", snapshot: finance });
    expect(wiki.lookupValues("ws", "db1", "1000000000000001").some((hit) => hit.column === "id")).toBe(false);
    expect(wiki.lookupValues("ws", "db1", "2024-01-01 00:00:00").length).toBe(0);
    const secret = wiki.projectSchema("ws", "db1")?.tables
      .flatMap((table) => table.columns)
      .find((column) => column.name === "secret");
    expect(secret?.label).toBe("加密列");
    expect(secret?.examples).toBeUndefined();
    expect(secret?.range).toBeUndefined();
    const created = wiki.search("ws", "范围").find((hit) => hit.page_id === "table:db1:cust_company_info");
    expect(created?.excerpt).toContain("created_at");
  });

  it("splits short concat varchar values into domain members", async () => {
    const wiki = createWiki();
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "facts_only",
      snapshot: {
        tables: [{
          name: "cust_company_info",
          columns: [{
            name: "tags",
            type: "varchar(64)",
            nullable: true,
            lane: "domain",
            valueCounts: [
              { value: "[\"A\",\"B\"]", count: 2 },
              { value: "[\"A\"]", count: 1 }
            ],
            samples: ["[\"A\",\"B\"]", "[\"A\"]"]
          }]
        }]
      }
    });
    const domain = wiki.catalogPages("ws").find((page) => page.type === "value-domain" && page.title.endsWith(".tags"));
    expect(domain?.body).toContain("A\t");
    expect(domain?.body).toContain("B\t");
    expect(domain?.body.includes("[\"A\",\"B\"]")).toBe(false);
  });

  it("writes a dictionary page beside the value domain when comment lists codes", async () => {
    const wiki = createWiki();
    await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "facts_only", snapshot: finance });
    expect(wiki.catalogPages("ws").some((page) => page.type === "value-domain" && page.title === "cust_company_info.enable")).toBe(true);
    const dictionary = wiki.catalogPages("ws").find((page) => page.type === "dictionary" && page.title === "cust_company_info.enable");
    expect(dictionary?.body).toContain("kind=dictionary");
    expect(dictionary?.body).toMatch(/Y\t是/u);
  });

  it("does not publish low-cardinality pairs without a model", async () => {
    const wiki = createWiki();
    await wiki.scan({ workspaceId: "ws", sourceId: "db1", sourceKind: "database", mode: "facts_only", snapshot: finance });
    expect(wiki.catalogPages("ws").some((page) => page.type === "relation" && page.title.includes("enable"))).toBe(false);
  });

  it("leaves a measured key relation unpublished until the model accepts it as a foreign key", async () => {
    const wiki = createWiki();
    const snapshot = {
      tables: [
        {
          name: "child",
          columns: [{ name: "company_id", type: "bigint", nullable: false, samples: ["1", "2"] }]
        },
        {
          name: "parent",
          columns: [{ name: "id", type: "bigint", nullable: false, primaryKey: true, samples: ["1", "2", "3"] }]
        }
      ],
      measuredRelations: [{
        left: "child.company_id",
        right: "parent.id",
        score: 1,
        overlap: 1,
        name: 0.5,
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
          ? JSON.stringify({ items: [{ subject: "child.company_id~parent.id", decision: "foreign_key" }] })
          : JSON.stringify({ items: [] })
      }
    });
    expect(wiki.catalogPages("ws").some((page) => page.type === "relation" && page.title.includes("child.company_id = parent.id"))).toBe(true);
  });

  it("does not publish shared short codes or both-side id when the model refuses", async () => {
    const wiki = createWiki();
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "facts_only",
      snapshot: {
        tables: [
          {
            name: "left_t",
            columns: [
              { name: "id", type: "integer", nullable: false, primaryKey: true, samples: ["1", "2"] },
              { name: "code", type: "varchar", nullable: false, samples: ["A", "B"] }
            ]
          },
          {
            name: "right_t",
            columns: [
              { name: "id", type: "integer", nullable: false, primaryKey: true, samples: ["1", "2"] },
              { name: "code", type: "varchar", nullable: false, samples: ["A", "B"] }
            ]
          }
        ],
        measuredRelations: [
          {
            left: "left_t.id",
            right: "right_t.id",
            score: 1,
            overlap: 1,
            name: 1,
            comment: 0,
            keyShape: 1,
            parentIsKey: true,
            veto: false
          },
          {
            left: "left_t.code",
            right: "right_t.code",
            score: 1,
            overlap: 1,
            name: 1,
            comment: 0,
            keyShape: 0.2,
            parentIsKey: false,
            veto: false
          }
        ]
      }
    });
    await wiki.scan({
      workspaceId: "ws",
      sourceId: "db1",
      sourceKind: "database",
      mode: "semantic",
      llm: {
        complete: async (prompt: string) => prompt.includes("foreign_key")
          ? JSON.stringify({
            items: [
              { subject: "left_t.id~right_t.id", decision: "none" },
              { subject: "left_t.code~right_t.code", decision: "shared_code" }
            ]
          })
          : JSON.stringify({ items: [] })
      }
    });
    expect(wiki.catalogPages("ws").some((page) => page.type === "relation")).toBe(false);
  });

  it("uses minhash containment to find a subset foreign key", () => {
    const parent = sketchFromValues(["1000000000000001", "1000000000000002", "1000000000000003"]);
    const child = sketchFromValues(["1000000000000001", "1000000000000002"]);
    const enable = sketchFromValues(["Y", "N"]);
    expect(estimatedContainment(child, parent)).toBeGreaterThan(0.8);
    expect(estimatedContainment(enable, enable)).toBeGreaterThan(0.8);
  });

  it("collects encrypted columns without storing values and sketches range ids", async () => {
    const tables = {
      company: {
        id: ["1000000000000001", "1000000000000002"],
        name: ["甲", "乙"],
        secret: ["-----BEGIN RSA PRIVATE KEY-----abc", "-----BEGIN RSA PRIVATE KEY-----def"]
      }
    };
    const probe: DatabaseProbe = {
      dialect: "mysql",
      async listTables() {
        return [{
          name: "company",
          columns: [
            { name: "id", type: "bigint", nullable: false, primaryKey: true },
            { name: "name", type: "varchar(64)", nullable: false },
            { name: "secret", type: "varchar(255)", nullable: true }
          ]
        }];
      },
      async query(sql: string) {
        if (sql.includes("information_schema") || sql.includes("PRAGMA") || sql.includes("pg_")) {
          return { columns: ["column_name", "column_comment", "column_key", "extra"], rows: [] };
        }
        const column = /`(\w+)`/u.exec(sql)?.[1] ?? "";
        const values = tables.company[column as keyof typeof tables.company] ?? [];
        if (/SELECT DISTINCT/u.test(sql) || sql.includes("GROUP BY")) {
          const counts = new Map<string, number>();
          for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
          return {
            columns: sql.includes("COUNT(*)") ? ["v", "n"] : ["v"],
            rows: [...counts.entries()].map(([value, count]) => sql.includes("COUNT(*)") ? [value, count] : [value])
          };
        }
        if (sql.includes("COUNT(")) {
          return {
            columns: ["n", "filled", "card", "minv", "maxv"],
            rows: [[values.length, values.length, new Set(values).size, values[0], values.at(-1)]]
          };
        }
        return { columns: ["n"], rows: [[0]] };
      }
    };
    const snapshot = await collectDatabaseSnapshot(probe);
    const secret = snapshot.tables[0]?.columns.find((column) => column.name === "secret");
    const id = snapshot.tables[0]?.columns.find((column) => column.name === "id");
    const name = snapshot.tables[0]?.columns.find((column) => column.name === "name");
    expect(secret?.encrypted).toBe(true);
    expect(secret?.samples).toBeUndefined();
    expect(secret?.min).toBeUndefined();
    expect(id?.lane).toBe("range");
    expect(id?.sketch?.length).toBeGreaterThan(0);
    expect(id?.valueCounts).toBeUndefined();
    expect(name?.lane).toBe("domain");
    expect(name?.valueCounts?.map((item) => item.value).sort()).toEqual(["乙", "甲"]);
  });
});
