import { describe, expect, it } from "vitest";

import { collectDatabaseSnapshot, type DatabaseProbe } from "./index.js";

describe("collectDatabaseSnapshot resume", () => {
  it("skips profiled tables and reports relation progress with a pair index", async () => {
    const profiled: string[] = [];
    const messages: string[] = [];
    const probe: DatabaseProbe = {
      dialect: "sqlite",
      async listTables() {
        return [
          { name: "done", columns: [{ name: "id", type: "varchar", nullable: false, primaryKey: true }] },
          { name: "todo", columns: [{ name: "id", type: "varchar", nullable: false, primaryKey: true }] }
        ];
      },
      async query(sql: string) {
        if (sql.includes("done") && !sql.includes("todo")) {
          throw new Error(`profiled table was queried again: ${sql}`);
        }
        return { columns: ["n", "v"], rows: [[1]] };
      }
    };

    const snapshot = await collectDatabaseSnapshot(probe, {
      seedTables: [{
        name: "done",
        profiled: true,
        columns: [{ name: "id", type: "varchar", nullable: false, primaryKey: true, rowCount: 1, cardinality: 1, nullRate: 0 }]
      }],
      onTable: (table) => {
        profiled.push(table.name);
      },
      onProgress: (progress) => {
        if (progress.message) messages.push(progress.message);
      }
    });

    expect(profiled).toEqual(["todo"]);
    expect(snapshot.tables.map((table) => table.name)).toEqual(["done", "todo"]);
    expect(messages.some((message) => message.includes("已完成 1/2"))).toBe(true);
    expect(messages.some((message) => message.startsWith("画像 done"))).toBe(false);
    expect(messages.some((message) => message.startsWith("测量字段关联 ("))).toBe(true);
  });
});
