import type { LocalDataGateway } from "@datafoundry/data-gateway";
import { collectDatabaseSnapshot, LlmWiki, type LlmClient } from "@datafoundry/llm-wiki";

export const createLlmClientFromEnv = (): LlmClient | undefined => {
  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = process.env.LLM_BASE_URL;
  const model = process.env.LLM_MODEL;
  if (!apiKey || !baseUrl || !model) return undefined;
  return {
    complete: async (prompt: string) => {
      const response = await fetch(`${baseUrl.replace(/\/$/u, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [{ role: "user", content: prompt }]
        })
      });
      if (!response.ok) return "";
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      return body.choices?.[0]?.message?.content ?? "";
    }
  };
};

export const scanDatabaseFacts = async (input: {
  wiki: LlmWiki;
  gateway: LocalDataGateway;
  userId: string;
  workspaceId: string;
  datasourceId: string;
}): Promise<void> => {
  await writeDatabaseFacts(input);
};

export const scheduleDatabaseSemantic = (input: {
  wiki: LlmWiki;
  workspaceId: string;
  datasourceId: string;
}): void => {
  const llm = createLlmClientFromEnv();
  void input.wiki.scan({
    workspaceId: input.workspaceId,
    sourceId: input.datasourceId,
    sourceKind: "database",
    mode: "semantic",
    ...(llm ? { llm } : {})
  }).catch(() => undefined);
};

export const refreshWikiTable = async (input: {
  wiki: LlmWiki;
  gateway: LocalDataGateway;
  userId: string;
  workspaceId: string;
  datasourceId: string;
  tableName: string;
  columnName?: string;
}): Promise<void> => {
  const inspected = await input.gateway.inspectSchema({
    user_id: input.userId,
    workspace_id: input.workspaceId,
    datasource_id: input.datasourceId,
    table_names: [input.tableName]
  });
  const snapshot = await collectDatabaseSnapshot({
    ...(inspected.dialect ? { dialect: inspected.dialect } : {}),
    listTables: async () => inspected.tables
      .filter((table) => table.name === input.tableName)
      .map((table) => ({
        name: table.name,
        columns: table.columns.map((column) => ({
          name: column.name,
          type: column.type,
          nullable: column.nullable === true
        }))
      })),
    query: async (sql: string) => {
      const result = await input.gateway.runSqlReadonly({
        user_id: input.userId,
        workspace_id: input.workspaceId,
        datasource_id: input.datasourceId,
        sql,
        limit: 2000
      });
      return { columns: result.columns, rows: result.rows };
    }
  });
  input.wiki.refreshProfiles(input.workspaceId, input.datasourceId, snapshot, input.tableName, input.columnName);
};

export const rescanDatabase = async (input: {
  wiki: LlmWiki;
  gateway: LocalDataGateway;
  userId: string;
  workspaceId: string;
  datasourceId: string;
}): Promise<void> => {
  await scanDatabaseFacts(input);
  const llm = createLlmClientFromEnv();
  await input.wiki.scan({
    workspaceId: input.workspaceId,
    sourceId: input.datasourceId,
    sourceKind: "database",
    mode: "semantic",
    ...(llm ? { llm } : {})
  });
};

const writeDatabaseFacts = async (
  input: {
    wiki: LlmWiki;
    gateway: LocalDataGateway;
    userId: string;
    workspaceId: string;
    datasourceId: string;
  },
): Promise<void> => {
  const inspected = await input.gateway.inspectSchema({
    user_id: input.userId,
    workspace_id: input.workspaceId,
    datasource_id: input.datasourceId
  });
  const snapshot = await collectDatabaseSnapshot({
    ...(inspected.dialect ? { dialect: inspected.dialect } : {}),
    listTables: async () => inspected.tables.map((table) => ({
      name: table.name,
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.type,
        nullable: column.nullable === true
      }))
    })),
    query: async (sql: string) => {
      const result = await input.gateway.runSqlReadonly({
        user_id: input.userId,
        workspace_id: input.workspaceId,
        datasource_id: input.datasourceId,
        sql,
        limit: 2000
      });
      return { columns: result.columns, rows: result.rows };
    }
  });
  await input.wiki.scan({
    workspaceId: input.workspaceId,
    sourceId: input.datasourceId,
    sourceKind: "database",
    mode: "facts_only",
    snapshot
  });
};

export const ingestWikiText = async (input: {
  wiki: LlmWiki;
  workspaceId: string;
  sourceId: string;
  filename: string;
  content: string;
  datasourceIds?: string[];
}): Promise<void> => {
  const sourceKind = codeFilename(input.filename) ? "code" as const : "document" as const;
  const llm = createLlmClientFromEnv();
  const datasourceIds = input.datasourceIds ?? [];
  await input.wiki.scan({
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    sourceKind,
    mode: "facts_only",
    text: input.content,
    ...(datasourceIds.length > 0 ? { datasourceIds } : {})
  });
  await input.wiki.scan({
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    sourceKind,
    mode: "semantic",
    ...(datasourceIds.length > 0 ? { datasourceIds } : {}),
    ...(llm ? { llm } : {})
  });
};

const codeFilename = (filename: string): boolean =>
  /\.(ts|tsx|js|py|sql|java|go)$/iu.test(filename);
