import type { LocalDataGateway } from "@datafoundry/data-gateway";
import { collectDatabaseSnapshot, LlmWiki, type DatabaseSnapshot, type DatabaseTableSnapshot, type LlmClient, type WikiScanProgress } from "@datafoundry/llm-wiki";
import type { JobRecord, MetadataStore } from "@datafoundry/metadata";

import { preferConnectedResourceId } from "./model-profile-connection-status.js";

export const WIKI_SCAN_JOB_TYPE = "datasource-introspect";

export class WikiScanRunner {
  private tail: Promise<void> = Promise.resolve();

  enqueue(run: () => Promise<void>): void {
    this.tail = this.tail.then(() => run(), () => run());
  }
}

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const llmClientFrom = (apiKey: string, baseUrl: string, model: string, timeoutMs: number): LlmClient => ({
  complete: async (prompt: string) => {
    try {
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
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) return "";
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      return body.choices?.[0]?.message?.content ?? "";
    } catch {
      return "";
    }
  }
});

export const createLlmClientFromEnv = (): LlmClient | undefined => {
  const apiKey = process.env.LLM_API_KEY?.trim();
  const baseUrl = process.env.LLM_BASE_URL?.trim();
  const model = process.env.LLM_MODEL?.trim();
  if (!apiKey || !baseUrl || !model) return undefined;
  return llmClientFrom(apiKey, baseUrl, model, 120_000);
};

export const createLlmClientForWorkspace = (
  metadataStore: MetadataStore,
  userId: string,
  workspaceId: string
): { llm?: LlmClient; modelKey: string } => {
  const profiles = metadataStore.configResources.list({
    workspace_id: workspaceId,
    user_id: userId,
    kind: "model-profile"
  }).filter((item) => item.default_enabled && item.status !== "disabled" && item.status !== "archived");
  const selected = profiles.find((item) => item.id === preferConnectedResourceId(profiles));
  if (selected) {
    let credentials: Record<string, unknown> = {};
    if (selected.secret_ref) {
      try {
        credentials = metadataStore.secrets.get({
          ref: selected.secret_ref,
          workspace_id: workspaceId,
          user_id: userId
        });
      } catch {
        credentials = {};
      }
    }
    const apiKey = stringValue(credentials.apiKey) ?? stringValue(credentials.api_key);
    const baseUrl = stringValue(selected.payload.baseUrl) ?? stringValue(selected.payload.base_url);
    const model = stringValue(selected.payload.modelName) ?? stringValue(selected.payload.model) ?? stringValue(selected.payload.model_name);
    const timeoutMs = typeof selected.payload.timeoutMs === "number" && selected.payload.timeoutMs > 0
      ? selected.payload.timeoutMs
      : 120_000;
    if (apiKey && baseUrl && model) {
      return { llm: llmClientFrom(apiKey, baseUrl, model, timeoutMs), modelKey: `${selected.id}@${selected.revision}` };
    }
  }
  const envClient = createLlmClientFromEnv();
  return envClient
    ? { llm: envClient, modelKey: `env:${process.env.LLM_MODEL?.trim() ?? ""}` }
    : { modelKey: "none" };
};

export type WikiScanRequest = {
  runner: WikiScanRunner;
  metadataStore: MetadataStore;
  wiki: LlmWiki;
  gateway: LocalDataGateway;
  userId: string;
  workspaceId: string;
  datasourceId: string;
  tableName?: string;
  columnName?: string;
};

export const enqueueWikiScan = (input: WikiScanRequest): JobRecord => {
  const jobs = input.metadataStore.configJobs;
  const existing = jobs.findActive({
    workspace_id: input.workspaceId,
    user_id: input.userId,
    type: WIKI_SCAN_JOB_TYPE,
    resource_id: input.datasourceId
  });
  if (existing) return existing;
  const job = jobs.create({
    workspace_id: input.workspaceId,
    user_id: input.userId,
    type: WIKI_SCAN_JOB_TYPE,
    resource_id: input.datasourceId
  });
  input.runner.enqueue(() => executeWikiScan(input, job.id));
  return job;
};

const executeWikiScan = async (input: WikiScanRequest, jobId: string): Promise<void> => {
  const jobs = input.metadataStore.configJobs;
  const scope = { id: jobId, workspace_id: input.workspaceId, user_id: input.userId };
  const checkpoint = input.tableName ? undefined : readCheckpoint(jobs.latestExcept({
    workspace_id: input.workspaceId,
    user_id: input.userId,
    type: WIKI_SCAN_JOB_TYPE,
    resource_id: input.datasourceId,
    exclude_id: jobId
  }));
  const state: WikiScanProgress = {
    stage: checkpoint?.factsDone ? "semantic" : "schema",
    message: checkpoint?.factsDone ? "编译 wiki 页面" : "读取表结构",
    ...(checkpoint?.completedTables ? { completedTables: [...checkpoint.completedTables] } : {}),
    ...(checkpoint?.factsDone ? { factsDone: true } : {}),
    ...(checkpoint?.relationsDone ? { relationsDone: true } : {})
  };
  let floor = checkpoint?.factsDone ? 96 : 1;
  const report = (status: "running" | "completed" | "failed", progress: number, patch?: Partial<WikiScanProgress>, error?: unknown) => {
    const current = jobs.get(scope);
    if (current.status === "canceled") return current;
    if (patch) Object.assign(state, patch);
    floor = Math.max(floor, progress);
    return jobs.update({
      ...scope,
      status,
      progress: floor,
      result: { ...state },
      ...(error !== undefined ? { error } : {})
    });
  };
  const throwIfCanceled = (): void => {
    if (jobs.get(scope).status === "canceled") throw new Error("WIKI_SCAN_CANCELED");
  };
  const progressOf = (progress: WikiScanProgress): number => {
    if (progress.stage === "relations") {
      const ratio = progress.relationCount ? (progress.relationIndex ?? 0) / progress.relationCount : 0;
      return 75 + Math.round(ratio * 13);
    }
    if (progress.stage === "compile") return 90;
    if (progress.stage === "semantic") return 96;
    const ratio = progress.tableCount ? (progress.tableIndex ?? 0) / progress.tableCount : 0;
    return Math.max(1, Math.min(74, Math.round(ratio * 74)));
  };
  try {
    if (checkpoint?.factsDone) {
      report("running", 96, { stage: "semantic", message: "编译 wiki 页面" });
    } else {
      const seed = seedTables(input.wiki.readRawSnapshot(input.workspaceId, input.datasourceId), checkpoint);
      if (seed.length > 0) {
        floor = Math.max(floor, 2);
        report("running", floor, {
          stage: "schema",
          message: `从已完成的 ${seed.length} 张表继续`,
          completedTables: seed.map((table) => table.name)
        });
      } else {
        report("running", 1, { stage: "schema", message: "读取表结构" });
      }
      const inspected = await input.gateway.inspectSchema({
        user_id: input.userId,
        workspace_id: input.workspaceId,
        datasource_id: input.datasourceId,
        ...(input.tableName ? { table_names: [input.tableName] } : {})
      });
      throwIfCanceled();
      const listed = inspected.tables.filter((table) => !input.tableName || table.name === input.tableName);
      const ready = new Set(seed.map((table) => table.name));
      const stored = input.wiki.readRawSnapshot(input.workspaceId, input.datasourceId);
      const storedNames = new Set((stored?.tables ?? []).map((table) => table.name));
      const snapshotComplete = listed.length > 0 && listed.every((table) => storedNames.has(table.name));
      if (!input.tableName && stored && snapshotComplete) {
        report("running", floor, { stage: "compile", message: "按新规则重编译已有提取" });
        await input.wiki.scan({
          workspaceId: input.workspaceId,
          sourceId: input.datasourceId,
          sourceKind: "database",
          mode: "facts_only",
          snapshot: stored
        });
        report("running", 94, { stage: "compile", factsDone: true, message: "结构、取值和关联已写入" });
        throwIfCanceled();
        report("running", 96, { stage: "semantic", factsDone: true, message: "编译 wiki 页面" });
        await input.wiki.scan(semanticScan(input));
        report("completed", 100, { stage: "semantic", factsDone: true, message: "扫描完成" });
        return;
      }
      const covered = listed.length > 0 && listed.every((table) => ready.has(table.name));
      let snapshot: DatabaseSnapshot;
      if (checkpoint?.relationsDone && covered) {
        snapshot = input.wiki.readRawSnapshot(input.workspaceId, input.datasourceId) ?? {
          ...(inspected.dialect ? { dialect: inspected.dialect } : {}),
          tables: seed
        };
        report("running", 88, { stage: "relations", relationsDone: true, message: "字段关联已完成，继续写入" });
      } else {
        let checkpointWrite = Promise.resolve();
        snapshot = await collectDatabaseSnapshot({
          ...(inspected.dialect ? { dialect: inspected.dialect } : {}),
          listTables: async () => listed.map((table) => ({
            name: table.name,
            columns: table.columns.map((column) => ({
              name: column.name,
              type: column.type,
              nullable: column.nullable === true,
              ...(column.comment ? { comment: column.comment } : {})
            }))
          })),
          query: async (sql: string) => {
            const result = await input.gateway.runSqlReadonly({
              user_id: input.userId,
              workspace_id: input.workspaceId,
              datasource_id: input.datasourceId,
              sql,
              purpose: "wiki-scan",
              limit: 5_000_000
            });
            return { columns: result.columns, rows: result.rows };
          }
        }, {
          ...(input.tableName ? { tableName: input.tableName } : {}),
          ...(input.columnName ? { columnName: input.columnName } : {}),
          ...(seed.length > 0 ? { seedTables: seed } : {}),
          onTable: (table) => {
            checkpointWrite = checkpointWrite.then(async () => {
              throwIfCanceled();
              const dialect = inspected.dialect;
              input.wiki.saveRawSnapshot(input.workspaceId, input.datasourceId, {
                ...(dialect ? { dialect } : {}),
                tables: [table]
              });
              const completed = new Set(state.completedTables ?? []);
              completed.add(table.name);
              const total = Math.max(listed.length, 1);
              report("running", Math.max(1, Math.min(74, Math.round((completed.size / total) * 74))), {
                stage: "table",
                table: table.name,
                tableIndex: completed.size,
                tableCount: listed.length,
                completedTables: [...completed],
                message: `画像 ${table.name} (${completed.size}/${listed.length})`
              });
            });
            return checkpointWrite;
          },
          onProgress: async (progress) => {
            throwIfCanceled();
            report("running", progressOf(progress), progress);
            await yieldEventLoop();
          }
        });
        input.wiki.saveRawSnapshot(input.workspaceId, input.datasourceId, {
          ...(snapshot.dialect ? { dialect: snapshot.dialect } : {}),
          tables: [],
          measuredRelations: snapshot.measuredRelations ?? []
        });
        report("running", 88, {
          stage: "relations",
          relationsDone: true,
          completedTables: snapshot.tables.map((table) => table.name),
          message: "字段关联已完成"
        });
      }
      throwIfCanceled();
      report("running", 90, { stage: "compile", message: "写入结构、取值和关联" });
      if (input.tableName) {
        const refreshed = input.wiki.refreshProfiles(
          input.workspaceId,
          input.datasourceId,
          snapshot,
          input.tableName,
          input.columnName
        );
        if (refreshed === "missing") {
          await input.wiki.scan({
            workspaceId: input.workspaceId,
            sourceId: input.datasourceId,
            sourceKind: "database",
            mode: "facts_only",
            snapshot
          });
        }
      } else {
        await input.wiki.scan({
          workspaceId: input.workspaceId,
          sourceId: input.datasourceId,
          sourceKind: "database",
          mode: "facts_only",
          snapshot
        });
      }
      report("running", 94, { stage: "compile", factsDone: true, message: "结构、取值和关联已写入" });
    }
    throwIfCanceled();
    report("running", 96, { stage: "semantic", factsDone: true, message: "编译 wiki 页面" });
    await input.wiki.scan(semanticScan(input));
    report("completed", 100, { stage: "semantic", factsDone: true, message: "扫描完成" });
  } catch (error) {
    if (error instanceof Error && error.message === "WIKI_SCAN_CANCELED") return;
    report("failed", floor, { message: state.message ?? "扫描失败" }, { message: error instanceof Error ? error.message : String(error) });
  }
};

const semanticScan = (input: WikiScanRequest) => {
  const resolved = createLlmClientForWorkspace(input.metadataStore, input.userId, input.workspaceId);
  return {
    workspaceId: input.workspaceId,
    sourceId: input.datasourceId,
    sourceKind: "database" as const,
    mode: "semantic" as const,
    modelKey: resolved.modelKey,
    ...(resolved.llm ? { llm: resolved.llm } : {})
  };
};

const readCheckpoint = (job: { status: string; result?: unknown } | undefined): WikiScanProgress | undefined => {
  if (!job || job.status !== "failed" || !job.result || typeof job.result !== "object") return undefined;
  const result = job.result as WikiScanProgress;
  if (result.factsDone) return result;
  if (!Array.isArray(result.completedTables) || result.completedTables.length === 0) return undefined;
  return result;
};

const seedTables = (raw: DatabaseSnapshot | undefined, checkpoint: WikiScanProgress | undefined): DatabaseTableSnapshot[] => {
  if (!raw || !checkpoint?.completedTables?.length) return [];
  const wanted = new Set(checkpoint.completedTables);
  return raw.tables.filter((table) => table.profiled === true && wanted.has(table.name));
};

const yieldEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const ingestWikiText = async (input: {
  wiki: LlmWiki;
  workspaceId: string;
  sourceId: string;
  filename: string;
  content: string;
  datasourceIds?: string[];
  metadataStore?: MetadataStore;
  userId?: string;
}): Promise<void> => {
  const envClient = createLlmClientFromEnv();
  const resolved = input.metadataStore && input.userId
    ? createLlmClientForWorkspace(input.metadataStore, input.userId, input.workspaceId)
    : { llm: envClient, modelKey: envClient ? `env:${process.env.LLM_MODEL?.trim() ?? ""}` : "none" };
  const sourceKind = codeFilename(input.filename) ? "code" as const : "document" as const;
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
    modelKey: resolved.modelKey,
    ...(datasourceIds.length > 0 ? { datasourceIds } : {}),
    ...(resolved.llm ? { llm: resolved.llm } : {})
  });
};

const codeFilename = (filename: string): boolean =>
  /\.(ts|tsx|js|py|sql|java|go)$/iu.test(filename);
