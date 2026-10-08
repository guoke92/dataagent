import type { DataGateway } from "@datafoundry/data-gateway";
import { LlmWiki } from "@datafoundry/llm-wiki";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { createDataFoundryToolRegistry } from "./data-tools.js";

const seedWiki = async (workspaceId: string, datasourceId: string): Promise<{ db: DatabaseSync; wiki: LlmWiki }> => {
  const db = new DatabaseSync(":memory:");
  const wiki = new LlmWiki(db);
  await wiki.scan({
    workspaceId,
    sourceId: datasourceId,
    sourceKind: "database",
    mode: "facts_only",
    snapshot: {
      dialect: "sqlite",
      tables: [{ name: "orders", columns: [{ name: "id", type: "integer", nullable: false }] }]
    }
  });
  return { db, wiki };
};

describe("data tool SQL reuse", () => {
  it("reuses an exact successful SQL result within one run and schema", async () => {
    let executionCount = 0;
    const { db, wiki } = await seedWiki("workspace-1", "orders");
    const dataGateway = {
      inspectSchema: async () => ({ datasource_id: "orders", dialect: "sqlite", tables: [] }),
      runSqlReadonly: async () => {
        executionCount += 1;
        return {
          columns: ["value"],
          rows: [[1]],
          row_count: 1,
          audit_log_id: "audit-1",
          artifact_id: "artifact-1",
          elapsed_ms: 1
        };
      }
    } as unknown as DataGateway;
    try {
      const registry = createDataFoundryToolRegistry({
        dataGateway,
        emitter: { emit: () => undefined },
        runContext: {
          user_id: "user-1",
          workspace_id: "workspace-1",
          session_id: "session-1",
          run_id: "run-cache",
          user_input: "analyze orders",
          chat_mode: "copilotkit",
          enabled_datasource_ids: ["orders"],
          selected_datasource_id: "orders",
          model_name: "test-model"
        },
        wikiCatalog: wiki
      });
      const schema = await registry.inspectSchema({ datasource_id: "orders" });

      const first = await registry.runSqlReadonly({ schema_id: schema.schema_id, sql: "SELECT 1", limit: 10 });
      const second = await registry.runSqlReadonly({ schema_id: schema.schema_id, sql: "SELECT 1", limit: 10 });
      await registry.runSqlReadonly({ schema_id: schema.schema_id, sql: "SELECT 1", limit: 20 });

      expect(first.cache_hit).toBeUndefined();
      expect(second).toMatchObject({ cache_hit: true, result: { audit_log_id: "audit-1" } });
      expect(executionCount).toBe(2);
      expect(registry.state.sql_execution_count).toBe(2);
      expect(schema.schema_id.startsWith("wiki_")).toBe(true);
    } finally {
      wiki.close();
      db.close();
    }
  });

  it("serves inspect_schema from the wiki and rejects missing projections", async () => {
    const db = new DatabaseSync(":memory:");
    const wiki = new LlmWiki(db);
    await wiki.scan({
      workspaceId: "workspace-1",
      sourceId: "orders",
      sourceKind: "database",
      mode: "facts_only",
      snapshot: {
        dialect: "sqlite",
        tables: [{ name: "customer", columns: [{ name: "city", type: "text", nullable: true, samples: ["Fresno", "Fresno", "Oakland"] }] }]
      }
    });
    let inspects = 0;
    const dataGateway = {
      inspectSchema: async () => {
        inspects += 1;
        return { datasource_id: "orders", dialect: "sqlite", tables: [] };
      }
    } as unknown as DataGateway;
    const registry = createDataFoundryToolRegistry({
      dataGateway,
      emitter: { emit: () => undefined },
      runContext: {
        user_id: "user-1",
        workspace_id: "workspace-1",
        session_id: "session-1",
        run_id: "run-wiki",
        user_input: "Fresno 在哪一列",
        chat_mode: "copilotkit",
        enabled_datasource_ids: ["orders"],
        selected_datasource_id: "orders",
        model_name: "test-model"
      },
      wikiCatalog: wiki
    });
    try {
      const projected = await registry.inspectSchema({ datasource_id: "orders" });
      expect(projected.schema_id.startsWith("wiki_")).toBe(true);
      expect(projected.tables.map((table) => table.name)).toEqual(["customer"]);
      expect(inspects).toBe(0);
      const hits = await registry.lookupValues({ literal: "Fresno" });
      expect(hits.hits).toEqual([{ table: "customer", column: "city", match: "exact", sample: "Fresno" }]);
      const empty = new LlmWiki(db);
      const blocked = createDataFoundryToolRegistry({
        dataGateway,
        emitter: { emit: () => undefined },
        runContext: {
          user_id: "user-1",
          workspace_id: "workspace-1",
          session_id: "session-1",
          run_id: "run-wiki-missing",
          user_input: "schema",
          chat_mode: "copilotkit",
          enabled_datasource_ids: ["missing"],
          selected_datasource_id: "missing",
          model_name: "test-model"
        },
        wikiCatalog: empty
      });
      await expect(blocked.inspectSchema({ datasource_id: "missing" })).rejects.toThrow("WIKI_KNOWLEDGE_UNAVAILABLE");
      expect(inspects).toBe(0);
      empty.close();
    } finally {
      wiki.close();
      db.close();
    }
  });
});
