import { DatabaseSync } from "node:sqlite";

import { selectAuthoritative } from "./authority.js";
import { parseCodeFacts, parseDocumentFacts } from "./parsers.js";
import { columnSamples, formatProfile, isDictionaryCandidate, measureRelation, profileColumn, type ColumnProfile, type RelationMeasurement } from "./relations.js";
import { ensureWikiSchema, WikiStore } from "./store.js";
import { fingerprintOf, tokens } from "./text.js";
import type { CodeFacts } from "./parsers.js";
import type {
  ClaimDomain,
  DatabaseSnapshot,
  GroundRecord,
  LlmClient,
  LookupHit,
  PageStatus,
  ScanMode,
  SchemaProjection,
  SourceKind,
  WikiField,
  WikiPage,
  WikiSearchHit,
  WikiEmbedder
} from "./types.js";
import {
  columnFieldFromProfile,
  columnInfoText,
  knowledgeExcerpt,
  parseDictionaryLabels,
  readColumnFields,
  recallForSchema,
  stripStructuralLinkLines,
  unifyColumnFields
} from "./recall.js";
import { buildValueIndex, lookupValue, type ValueIndex } from "./value-index.js";

export type ScanInput = {
  workspaceId?: string;
  sourceId: string;
  sourceKind: SourceKind;
  mode: ScanMode;
  snapshot?: DatabaseSnapshot;
  text?: string;
  sql?: string;
  question?: string;
  datasourceIds?: string[];
  llm?: LlmClient;
};

export class LlmWiki {
  private readonly db: DatabaseSync;
  private readonly stores = new Map<string, WikiStore>();
  private readonly foldedWorkspaces = new Set<string>();
  private embedder: WikiEmbedder | undefined;

  constructor(db: DatabaseSync, options?: { embedder?: WikiEmbedder }) {
    ensureWikiSchema(db);
    this.db = db;
    this.embedder = options?.embedder;
  }

  close(): void {
    this.stores.clear();
  }

  sourceFingerprint(workspaceId: string, sourceKind: SourceKind, sourceId: string): string | undefined {
    return this.store(workspaceId).readGroundFingerprint(sourceKind, sourceId);
  }

  async scan(input: ScanInput & { workspaceId: string }): Promise<{ skipped: boolean; llmCalls: number }> {
    const store = this.store(input.workspaceId);
    const llm = input.llm ?? { complete: async () => "" };
    let llmCalls = 0;
    const countingLlm: LlmClient = {
      complete: async (prompt) => {
        llmCalls += 1;
        return llm.complete(prompt);
      }
    };
    if (input.mode === "facts_only") {
      const skipped = this.writeFacts(store, input);
      return { skipped, llmCalls };
    }
    if (!store.readGroundFingerprint(input.sourceKind, input.sourceId)) {
      throw new Error("GROUND_REQUIRED_BEFORE_SEMANTIC");
    }
    const groundFingerprint = store.readGroundFingerprint(input.sourceKind, input.sourceId) ?? "";
    const marker = store.readPage(`semantic:${input.sourceKind}:${input.sourceId}`);
    if (marker?.fingerprint === groundFingerprint) {
      return { skipped: true, llmCalls: 0 };
    }
    await this.compileWiki(store, countingLlm);
    if (input.sourceKind === "document" || input.sourceKind === "code") {
      await this.publishBoundClaims(store, input, countingLlm);
    }
    if (input.sourceKind === "dialogue" && input.datasourceIds && input.datasourceIds.length > 0) {
      this.bindPages(store, input.sourceId, input.datasourceIds);
    }
    if (input.sourceKind === "database") this.writeOutline(store, input.sourceId);
    await this.embedSemanticPages(store);
    this.upsert(store, {
      id: `semantic:${input.sourceKind}:${input.sourceId}`,
      type: "source",
      status: "pending",
      title: `semantic ${input.sourceKind} ${input.sourceId}`,
      body: "semantic compile marker",
      source_ids: [input.sourceId],
      fingerprint: groundFingerprint,
      confidence: 1
    });
    store.markSemantic(input.sourceKind, input.sourceId);
    this.finish(store, `## [${new Date().toISOString()}] semantic | ${input.sourceKind} ${input.sourceId}`);
    return { skipped: false, llmCalls };
  }

  projectSchema(workspaceId: string, datasourceId: string, tableNames?: string[]): SchemaProjection | undefined {
    const store = this.store(workspaceId);
    this.foldColumns(workspaceId, store);
    const tables = store.listPages().filter((page) => page.type === "table" && page.source_ids.includes(datasourceId));
    if (tables.length === 0) return undefined;
    const wanted = tableNames ? new Set(tableNames) : undefined;
    const extras = store.readExtras("database", datasourceId);
    const dialect = typeof extras.dialect === "string" ? extras.dialect : undefined;
    const pages = store.listPages();
    const projectedTables = tables
      .filter((table) => !wanted || wanted.has(table.title))
      .map((table) => ({
        name: table.title,
        columns: columnsFromTable(table, pages)
      }));
    const projectedNames = new Set(projectedTables.map((table) => table.name));
    return {
      datasource_id: datasourceId,
      ...(dialect ? { dialect } : {}),
      revision: store.revision(),
      tables: projectedTables,
      relations: pages
        .filter((page) => page.type === "relation" && (page.status === "auto" || page.status === "human") && mentionsTable(page, projectedNames))
        .map((page) => ({
          statement: page.fields?.find((field) => field.key === "relation")?.text
            ?? stripStructuralLinkLines(page.body).split("\n").find((line) => line.trim().length > 0)
            ?? page.title,
          confidence: page.confidence
        }))
    };
  }

  lookupValues(workspaceId: string, datasourceId: string, literal: string): LookupHit[] {
    const extras = this.store(workspaceId).readExtras("database", datasourceId);
    const index = extras.valueIndex as ValueIndex | undefined;
    if (!index?.exact) return [];
    return lookupValue(index, literal);
  }

  catalogPages(workspaceId: string): WikiPage[] {
    const store = this.store(workspaceId);
    this.foldColumns(workspaceId, store);
    return store.listPages().filter((page) => page.type !== "source" && page.type !== "column");
  }

  catalogPage(workspaceId: string, pageId: string): WikiPage | undefined {
    const page = this.store(workspaceId).readPage(pageId);
    if (!page || page.type === "source") return undefined;
    return page;
  }

  search(workspaceId: string, query: string): WikiSearchHit[] {
    const store = this.store(workspaceId);
    this.foldColumns(workspaceId, store);
    return store.search(query).map((page) => ({
      page_id: page.id,
      title: page.title,
      excerpt: page.type === "table"
        ? knowledgeExcerpt(readColumnFields(page.fields), query, (record) => labelsFor(page.title, record.name, store.listPages()))
        : page.body.slice(0, 280),
      type: page.type
    }));
  }

  query(workspaceId: string, question: string, datasourceIds?: string[]): WikiSearchHit[] {
    const store = this.store(workspaceId);
    this.foldColumns(workspaceId, store);
    const selected = datasourceIds?.filter((id) => id.length > 0);
    const parts = tokens(question).slice(0, 8);
    const needles = parts.length > 0 ? parts : [question.trim().toLowerCase()].filter((part) => part.length > 0);
    const pages = store.listPages().filter((page) =>
      RECALL_PAGE_TYPES.has(page.type)
      && page.status !== "rejected"
      && page.status !== "auto-rejected"
      && inScope(page, selected)
    );
    const lexical = pages
      .map((page) => ({ page, score: recallScore(page, needles) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.page.confidence - left.page.confidence);
    const seen = new Set(lexical.map((item) => item.page.id));
    const ordered: WikiPage[] = [];
    for (const item of lexical) {
      ordered.push(item.page);
      if (!LOGICAL_PAGE_TYPES.has(item.page.type)) continue;
      const keys = anchorKeys(item.page);
      for (const page of pages) {
        if (!SEMANTIC_PAGE_TYPES.has(page.type) || !page.anchor || seen.has(page.id)) continue;
        if (!keys.has(page.anchor)) continue;
        ordered.push(page);
        seen.add(page.id);
      }
    }
    return ordered.slice(0, 8).map((page) => ({
        page_id: page.id,
        title: page.title,
        type: page.type,
        ...(page.anchor ? { anchor: page.anchor } : {}),
        excerpt: page.type === "table"
          ? knowledgeExcerpt(readColumnFields(page.fields), question, (record) => labelsFor(page.title, record.name, store.listPages()))
          : stripStructuralLinkLines(page.body).slice(0, 280)
    }));
  }

  async recall(workspaceId: string, question: string, datasourceIds?: string[]): Promise<WikiSearchHit[]> {
    const lexical = this.query(workspaceId, question, datasourceIds);
    if (!this.embedder) return lexical;
    let vector: number[] | undefined;
    try {
      vector = (await this.embedder.embed([question]))[0];
    } catch {
      return lexical;
    }
    if (!vector || vector.length === 0) return lexical;
    const store = this.store(workspaceId);
    const selected = datasourceIds?.filter((id) => id.length > 0);
    const ranked = store.listPages().flatMap((page) => {
      if (!SEMANTIC_PAGE_TYPES.has(page.type) || !inScope(page, selected)) return [];
      const embedding = store.readEmbedding(page.id);
      if (!embedding) return [];
      const score = cosine(vector ?? [], embedding.vector);
      return score > 0.2 ? [{ id: page.id, score }] : [];
    }).sort((left, right) => right.score - left.score).map((item) => item.id);
    const fused = fuseRanks([lexical.map((hit) => hit.page_id), ranked]);
    const byId = new Map(lexical.map((hit) => [hit.page_id, hit]));
    for (const id of ranked) {
      if (byId.has(id)) continue;
      const page = store.readPage(id);
      if (!page) continue;
      byId.set(id, {
        page_id: page.id,
        title: page.title,
        type: page.type,
        ...(page.anchor ? { anchor: page.anchor } : {}),
        excerpt: stripStructuralLinkLines(page.body).slice(0, 280)
      });
    }
    return fused.flatMap((id) => {
      const hit = byId.get(id);
      return hit ? [hit] : [];
    }).slice(0, 8);
  }

  outlineText(workspaceId: string, datasourceIds: string[]): string {
    const store = this.store(workspaceId);
    this.foldColumns(workspaceId, store);
    const selected = datasourceIds.filter((id) => id.length > 0);
    for (const datasourceId of selected) {
      if (!store.readPage(`outline:${datasourceId}`)) this.writeOutline(store, datasourceId);
    }
    const pages = store.listPages().filter((page) => page.type === "outline" && inScope(page, selected));
    const bridges = store.listPages().filter((page) =>
      page.datasource_ids.length > 1
      && page.type !== "outline"
      && page.type !== "source"
      && inScope(page, selected)
    );
    return [
      ...pages.map((page) => page.body),
      ...bridges.map((page) => `${page.title}\n${stripStructuralLinkLines(page.body).slice(0, 280)}`)
    ].join("\n\n");
  }

  forgetEvidence(workspaceId: string, evidenceId: string): void {
    const store = this.store(workspaceId);
    for (const page of store.listPages()) {
      if (!page.evidence_ids.includes(evidenceId) && !page.source_ids.includes(evidenceId)) continue;
      if (page.status === "human") {
        const evidence = page.evidence_ids.filter((id) => id !== evidenceId);
        this.upsert(store, { ...page, evidence_ids: evidence });
        continue;
      }
      store.deletePage(page.id);
    }
    store.deleteGround("document", evidenceId);
    store.deleteGround("code", evidenceId);
  }

  evidenceCompiled(workspaceId: string, evidenceId: string): boolean {
    return this.store(workspaceId).listPages().some((page) =>
      page.evidence_ids.includes(evidenceId)
      && page.type !== "source"
      && page.status !== "rejected"
      && page.status !== "auto-rejected"
    );
  }

  sourceText(workspaceId: string, evidenceId: string): { text: string; datasourceIds: string[] } | undefined {
    const store = this.store(workspaceId);
    const document = store.readRaw<{ text?: string; datasourceIds?: string[] }>("document", evidenceId);
    const code = store.readRaw<{ text?: string; datasourceIds?: string[] }>("code", evidenceId);
    const raw = document ?? code;
    if (!raw?.text) return undefined;
    return { text: raw.text, datasourceIds: raw.datasourceIds ?? [] };
  }

  async lint(workspaceId: string, llm?: LlmClient): Promise<string[]> {
    const store = this.store(workspaceId);
    const pages = store.listPages().filter((page) => page.type !== "source");
    const findings: string[] = [];
    const titles = new Set(pages.map((page) => page.title));
    for (const page of pages) {
      if (page.type !== "index" && page.type !== "log" && !pages.some((other) => other.id !== page.id && other.body.includes(page.title))) {
        findings.push(`orphan:${page.id}`);
      }
    }
    for (const ground of store.listGrounds()) {
      for (const record of ground.records) {
        if (record.claim_domain === "physical_identity" && record.subject && !titles.has(record.subject) && !record.subject.includes(".")) {
          findings.push(`missing:${record.subject}`);
        }
      }
    }
    const terms = pages.filter((page) => page.claim_domain === "terminology");
    for (let index = 0; index < terms.length; index += 1) {
      for (const other of terms.slice(index + 1)) {
        if (terms[index]?.title === other.title && terms[index]?.body !== other.body) {
          findings.push(`contradiction:${other.title}`);
        }
      }
    }
    if (!llm || findings.length === 0) return findings;
    const summary = (await llm.complete(`用一两句中文归纳这些 wiki lint 发现，不要发明新事实：\n${findings.join("\n")}`)).trim();
    return summary ? [...findings, `summary:${summary}`] : findings;
  }

  refreshProfiles(workspaceId: string, sourceId: string, patch: DatabaseSnapshot, tableName: string, columnName?: string): "updated" | "unchanged" | "missing" {
    const store = this.store(workspaceId);
    const current = store.readRaw<DatabaseSnapshot>("database", sourceId);
    if (!current) return "missing";
    const skipped = this.writeDatabaseFacts(store, sourceId, mergeSnapshot(current, patch, tableName, columnName));
    return skipped ? "unchanged" : "updated";
  }

  pin(workspaceId: string, pageId: string, body: string, fieldKey = "short"): void {
    const store = this.store(workspaceId);
    const page = store.readPage(pageId);
    if (!page) throw new Error(`WIKI_PAGE_NOT_FOUND:${pageId}`);
    const existingField = page.fields?.find((field) => field.key === fieldKey);
    const fields = page.type === "table"
      ? mergeColumnFields(
        (page.fields ?? []).filter((field) => field.key !== fieldKey),
        [{ key: fieldKey, text: body, status: "human", ...(existingField?.meta ? { meta: existingField.meta } : {}) }]
      )
      : mergeFields(page.fields ?? [], [{ key: fieldKey, text: body, status: "human" }]);
    const nextBody = page.type === "table" ? renderTableBody(page.title, fields) : renderPageBody(page, fields);
    this.upsert(store, { ...page, status: "human", fields, body: nextBody });
    this.finish(store, `## [${new Date().toISOString()}] human | ${pageId} | ${fieldKey}`);
  }

  reject(workspaceId: string, pageId: string): void {
    const store = this.store(workspaceId);
    const page = store.readPage(pageId);
    if (!page) throw new Error(`WIKI_PAGE_NOT_FOUND:${pageId}`);
    const evidenceClass = page.claim_domain ?? page.type;
    store.reject(rejectionKey(page), evidenceClass, pageId);
    const key = page.type === "relation" ? "relation" : "body";
    const fields = mergeFields(page.fields ?? [], [{ key, text: page.body, status: "rejected" }]);
    this.upsert(store, { ...page, status: "rejected", fields });
    this.finish(store, `## [${new Date().toISOString()}] reject | ${pageId}`);
  }

  async fileBackAcceptedSql(input: {
    workspaceId: string;
    sourceId: string;
    sql: string;
    question: string;
    datasourceIds?: string[];
    llm?: LlmClient;
  }): Promise<void> {
    await this.scan({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      sourceKind: "dialogue",
      mode: "facts_only",
      sql: input.sql,
      question: input.question,
      ...(input.datasourceIds ? { datasourceIds: input.datasourceIds } : {})
    });
    await this.scan({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      sourceKind: "dialogue",
      mode: "semantic",
      ...(input.datasourceIds ? { datasourceIds: input.datasourceIds } : {}),
      ...(input.llm ? { llm: input.llm } : {})
    });
  }

  private writeFacts(store: WikiStore, input: ScanInput): boolean {
    if (input.sourceKind === "database") {
      return this.writeDatabaseFacts(store, input.sourceId, requireSnapshot(input.snapshot));
    }
    if (input.sourceKind === "document") {
      return this.writeDocumentFacts(store, input);
    }
    if (input.sourceKind === "code") {
      return this.writeCodeFacts(store, input.sourceId, input.text ?? "");
    }
    return this.writeDialogueFacts(store, input.sourceId, input.sql ?? "", input.question ?? "");
  }

  private writeDatabaseFacts(store: WikiStore, sourceId: string, snapshot: DatabaseSnapshot): boolean {
    const evidence = snapshot.tables.map((table) => ({
      name: table.name,
      columns: table.columns.map((column) => {
        const samples = columnSamples(column.name, column.samples, table.sampleRows);
        return {
          name: column.name,
          type: column.type,
          nullable: column.nullable,
          primaryKey: column.primaryKey === true,
          comment: column.comment ?? "",
          samples: [...new Set(samples)].sort()
        };
      }),
      foreignKeys: table.foreignKeys ?? []
    }));
    const fingerprint = fingerprintOf({ compiler: "wiki-quality-4", evidence });
    if (store.readGroundFingerprint("database", sourceId) === fingerprint) return true;
    store.writeRaw("database", sourceId, snapshot, fingerprint);
    const records: GroundRecord[] = [];
    const profiles: ColumnProfile[] = [];
    const exact = [];
    for (const table of snapshot.tables) {
      records.push(record(sourceId, "database", fingerprint, "physical_identity", table.name, `table ${table.name}`, "snapshot", 1, table.name));
      for (const column of table.columns) {
        const samples = columnSamples(column.name, column.samples, table.sampleRows);
        const profile = profileColumn(table.name, column.name, column.type, column.nullable, column.comment, column.primaryKey === true, samples, table.sampleRows?.length ?? samples.length);
        profiles.push(profile);
        const subject = `${table.name}.${column.name}`;
        records.push(record(sourceId, "database", fingerprint, "physical_identity", `${subject} ${column.type} nullable=${column.nullable}`, `column ${subject}`, "snapshot", 1, subject));
        records.push(record(
          sourceId,
          "database",
          fingerprint,
          "physical_identity",
          `profile ${subject} ${formatProfile(profile)}`,
          `profile ${subject}`,
          "profile",
          1,
          subject
        ));
        if (column.comment?.trim()) {
          records.push(record(
            sourceId,
            "database",
            fingerprint,
            "terminology",
            `${subject}: ${column.comment.trim()}`,
            `comment ${subject}`,
            "comment",
            0.55,
            subject
          ));
        }
        if (isDictionaryCandidate(profile)) {
          const lines = profile.frequencies.map((item) => `${item.value}\t${item.count}\t${item.share.toFixed(3)}`).join("\n");
          records.push(record(sourceId, "database", fingerprint, "enum_dictionary", lines, `dict ${subject}`, "dictionary_candidate", 0.5, subject));
        }
        for (const sample of profile.samples) {
          if (sample.length >= 2) exact.push({ table: table.name, column: column.name, value: sample });
        }
      }
      for (const foreignKey of table.foreignKeys ?? []) {
        const statement = `${table.name}.${foreignKey.column} = ${foreignKey.refTable}.${foreignKey.refColumn}`;
        records.push(record(
          sourceId,
          "database",
          fingerprint,
          "declared_fk",
          statement,
          `fk ${table.name}.${foreignKey.column}`,
          "ddl",
          1,
          `${table.name}.${foreignKey.column}`
        ));
        this.writeIfAllowed(store, {
          id: `relation:database:fk ${table.name}.${foreignKey.column}`,
          type: "relation",
          status: "auto",
          title: statement,
          body: statement,
          fields: [{ key: "relation", text: statement, status: "auto" }],
          source_ids: [sourceId],
          fingerprint,
          claim_domain: "declared_fk",
          authority: "database",
          confidence: 1
        }, "ddl");
      }
    }
    for (let index = 0; index < profiles.length; index += 1) {
      for (const other of profiles.slice(index + 1)) {
        const left = profiles[index];
        if (!left) continue;
        const measurement = measureRelation(left, other);
        if (!measurement || measurement.veto) continue;
        records.push(record(
          sourceId,
          "database",
          fingerprint,
          "field_relation",
          measurementStatement(measurement),
          `${measurement.left}~${measurement.right}`,
          "measurement",
          measurement.score,
          pairKey(measurement.left, measurement.right)
        ));
      }
    }
    store.writeGround("database", sourceId, fingerprint, records, {
      ...(snapshot.dialect ? { dialect: snapshot.dialect } : {}),
      valueIndex: buildValueIndex(exact),
      profiles
    });
    this.projectPhysical(store, sourceId, snapshot, fingerprint);
    this.writeOutline(store, sourceId);
    this.finish(store, `## [${new Date().toISOString()}] facts_only | database ${sourceId}`);
    return false;
  }

  private projectPhysical(store: WikiStore, sourceId: string, snapshot: DatabaseSnapshot, fingerprint: string): void {
    store.deletePages(`column:${sourceId}:`);
    for (const table of snapshot.tables) {
      const fields = table.columns.flatMap((column) => columnFields(table.name, column, snapshot));
      this.writeIfAllowed(store, {
        id: `table:${sourceId}:${table.name}`,
        type: "table",
        status: "pending",
        title: table.name,
        body: renderTableBody(table.name, fields),
        fields,
        source_ids: [sourceId],
        fingerprint,
        claim_domain: "physical_identity",
        authority: "database",
        confidence: 1
      });
    }
  }

  private writeDocumentFacts(store: WikiStore, input: ScanInput): boolean {
    const sourceId = input.sourceId;
    const text = input.text ?? "";
    const facts = parseDocumentFacts(text);
    const datasourceIds = input.datasourceIds ?? [];
    const fingerprint = fingerprintOf({ facts, text, datasourceIds });
    if (store.readGroundFingerprint("document", sourceId) === fingerprint) return true;
    store.writeRaw("document", sourceId, { text, datasourceIds }, fingerprint);
    const records = [
      ...facts.terms.map((term) => record(sourceId, "document", fingerprint, "terminology", `${term.name}: ${term.definition}`, `term ${term.name}`, "document", 0.9, term.name)),
      ...facts.rules.map((rule) => record(sourceId, "document", fingerprint, "business_rule", `${rule.name}: ${rule.formula}`, `rule ${rule.name}`, "document", 0.8, rule.name)),
      ...facts.relations.map((relation) => record(sourceId, "document", fingerprint, "field_relation", `${relation.source} = ${relation.target} ${relation.statement}`, `${relation.source}=${relation.target}`, "document", 0.7, pairKey(relation.source, relation.target))),
      ...facts.enums.map((item) => record(sourceId, "document", fingerprint, "enum_dictionary", `${item.column} ${item.code} = ${item.label}`, `enum ${item.column} ${item.code}`, "document", 0.7, item.column))
    ];
    store.writeGround("document", sourceId, fingerprint, records);
    this.finish(store, `## [${new Date().toISOString()}] facts_only | document ${sourceId}`);
    return false;
  }

  private writeCodeFacts(store: WikiStore, sourceId: string, text: string): boolean {
    const facts: CodeFacts = parseCodeFacts(text);
    const fingerprint = fingerprintOf(facts);
    if (store.readGroundFingerprint("code", sourceId) === fingerprint) return true;
    store.writeRaw("code", sourceId, { text }, fingerprint);
    const records = [
      ...facts.relations.map((relation) => record(sourceId, "code", fingerprint, "field_relation", `${relation.source} = ${relation.target} ${relation.statement}`, `${relation.source}=${relation.target}`, "code", 0.95, pairKey(relation.source, relation.target))),
      ...facts.enums.map((item) => record(sourceId, "code", fingerprint, "enum_dictionary", `${item.column} ${item.code} = ${item.label}`, `enum ${item.column} ${item.code}`, "code", 0.95, item.column)),
      ...facts.rules.map((rule) => record(sourceId, "code", fingerprint, "business_rule", `${rule.name}: ${rule.formula}`, `rule ${rule.name}`, "code", 0.95, rule.name)),
      ...facts.bridges.map((bridge) => record(sourceId, "code", fingerprint, "term_bridge", `${bridge.term} -> ${bridge.column}`, `bridge ${bridge.term}`, "code", 0.95, bridge.term))
    ];
    store.writeGround("code", sourceId, fingerprint, records);
    this.finish(store, `## [${new Date().toISOString()}] facts_only | code ${sourceId}`);
    return false;
  }

  private writeDialogueFacts(store: WikiStore, sourceId: string, sql: string, question: string): boolean {
    const fingerprint = fingerprintOf({ sql, question });
    if (store.readGroundFingerprint("dialogue", sourceId) === fingerprint) return true;
    store.writeRaw("dialogue", sourceId, { sql, question }, fingerprint);
    store.writeGround("dialogue", sourceId, fingerprint, [
      record(sourceId, "dialogue", fingerprint, "query_pattern", `${question}\n${sql}`, "accepted sql", "dialogue", 0.7, sourceId)
    ]);
    this.finish(store, `## [${new Date().toISOString()}] facts_only | dialogue ${sourceId}`);
    return false;
  }

  private async compileWiki(store: WikiStore, llm: LlmClient): Promise<void> {
    const grounds = store.listGrounds();
    const records = grounds.flatMap((ground) => ground.records);
    this.writeDomainPages(store, "declared_fk", "relation", records, "auto");
    this.writeDomainPages(store, "field_relation", "relation", records, "pending");
    this.writeDomainPages(store, "terminology", "concept", records, "pending");
    this.writeDomainPages(store, "business_rule", "metric", records, "pending");
    this.writeDomainPages(store, "enum_dictionary", "value-domain", records, "auto");
    this.writeDomainPages(store, "term_bridge", "concept", records, "auto");
    this.writeDomainPages(store, "query_pattern", "query-pattern", records, "auto");
    await this.writeDescriptions(store, records, llm);
    await this.confirmDictionaries(store, records, llm);
    await this.adjudicateGrayRelations(store, records, llm);
  }

  private writeDomainPages(
    store: WikiStore,
    domain: ClaimDomain,
    type: WikiPage["type"],
    records: GroundRecord[],
    forcedStatus: PageStatus | undefined
  ): void {
    const selected = selectAuthoritative(domain, records);
    const declared = domain === "field_relation"
      ? records.filter((record) => record.claim_domain === "declared_fk")
      : [];
    const declaredPairs = new Set(declared.map((record) => record.subject).filter((subject): subject is string => Boolean(subject)));
    for (const record of [...selected, ...declared]) {
      if (domain === "field_relation" && record.source_kind === "document" && record.subject && declaredPairs.has(record.subject)) continue;
      if (domain === "field_relation" && record.evidence_class === "measurement" && record.confidence < 0.85) continue;
      if (domain === "enum_dictionary" && record.evidence_class === "dictionary_candidate") continue;
      if (isBoundFeedstock(store, record) && SEMANTIC_PAGE_TYPES.has(type)) continue;
      const status: PageStatus = record.claim_domain === "declared_fk" || record.evidence_class === "code"
        ? "auto"
        : forcedStatus ?? "pending";
      const body = type !== "relation"
        ? record.statement
        : record.evidence_class === "measurement"
          ? equalityBody(record.statement)
          : record.statement.replace(" -> ", " = ");
      const fields: WikiField[] | undefined = type === "relation"
        ? [{ key: "relation", text: body, status, ...(record.evidence_class === "measurement" ? { meta: record.statement } : {}) }]
        : undefined;
      this.writeIfAllowed(store, {
        id: `${type}:${record.source_kind}:${record.locator}`,
        type,
        status,
        title: type === "relation" ? body : (record.subject ?? record.locator),
        body,
        ...(fields ? { fields } : {}),
        source_ids: [record.source_id],
        fingerprint: record.fingerprint,
        claim_domain: record.claim_domain,
        authority: record.source_kind,
        confidence: record.confidence
      }, record.evidence_class);
    }
  }

  private async writeDescriptions(store: WikiStore, records: GroundRecord[], llm: LlmClient): Promise<void> {
    const columns = records.filter((record) => record.claim_domain === "physical_identity" && record.locator.startsWith("column "));
    for (const column of columns) {
      const tableName = column.subject?.split(".")[0];
      const columnName = column.subject?.split(".").slice(1).join(".");
      if (!tableName || !columnName) continue;
      const page = store.readPage(`table:${column.source_id}:${tableName}`);
      const current = page?.fields?.find((field) => field.key === columnName);
      if (!page || (current && (current.status === "human" || (current.text.trim().length > 0 && !looksLikeTypeRestatement(current.text))))) continue;
      const profile = records.find((item) => item.locator === `profile ${column.subject}`);
      const prompt = `只写字段的业务叫法，返回 JSON {"short":""}。不要复述类型或是否可空。没有把握就返回 {"short":""}。画像：${profile?.statement ?? column.statement}`;
      const raw = await llm.complete(prompt);
      const short = parseShort(raw);
      if (!short || looksLikeTypeRestatement(short)) continue;
      const fields = mergeColumnFields(page.fields ?? [], [{ key: columnName, text: short, status: "auto", ...(current?.meta ? { meta: current.meta } : {}) }]);
      this.writeIfAllowed(store, { ...page, fields, body: renderTableBody(page.title, fields) });
    }
  }

  private async confirmDictionaries(store: WikiStore, records: GroundRecord[], llm: LlmClient): Promise<void> {
    const candidates = records.filter((record) => record.evidence_class === "dictionary_candidate");
    for (const candidate of candidates) {
      const raw = await llm.complete(`只回答 JSON {"decision":"dictionary|not|unsure","labels":[{"value":"","label":""}]}。判断这列是不是字典。候选：${candidate.subject}\n${candidate.statement}`);
      const decision = parseDictionary(raw);
      if (decision?.decision !== "dictionary" || !candidate.subject) continue;
      const lines = candidate.statement.split("\n").map((line) => {
        const [value, count, share] = line.split("\t");
        if (!value) return "";
        const label = decision.labels.find((item) => item.value === value)?.label;
        return `${value}${label ? ` = ${label}` : ""} × ${count ?? "0"} (${share ?? "0"})`;
      }).filter((line) => line.length > 0);
      const text = lines.join("\n");
      this.writeIfAllowed(store, {
        id: `value-domain:${candidate.source_id}:${candidate.subject}`,
        type: "value-domain",
        status: "auto",
        title: `${candidate.subject} 值域`,
        body: text,
        source_ids: [candidate.source_id],
        fingerprint: candidate.fingerprint,
        claim_domain: "enum_dictionary",
        authority: "database",
        confidence: 0.8,
        fields: [{ key: "dictionary", text, status: "auto" }]
      }, "dictionary_candidate");
    }
  }

  private async adjudicateGrayRelations(store: WikiStore, records: GroundRecord[], llm: LlmClient): Promise<void> {
    const covered = new Set(store.listPages().filter((page) => page.type === "relation").flatMap((page) => [page.title, page.body]));
    const gray = records.filter((record) =>
      record.claim_domain === "field_relation"
      && record.evidence_class === "measurement"
      && record.confidence >= 0.6
      && (record.confidence < 0.85 || !record.statement.includes("parentKey=true"))
      && record.subject
      && !covered.has(record.subject)
      && !covered.has(equalityBody(record.statement))
    );
    for (const record of gray) {
      if (record.subject && store.isRejected(`field_relation:${record.subject}`, record.evidence_class)) continue;
      const raw = await llm.complete(`只回答 JSON {"decision":"accept|reject|candidate","reason":""}。关联测量：${record.statement}`);
      const decision = parseDecision(raw);
      if (!decision || !record.subject) continue;
      if (decision === "reject") {
        store.reject(`field_relation:${record.subject}`, record.evidence_class, `relation:${record.source_kind}:${record.locator}`);
        const text = equalityBody(record.statement);
        const existing = store.listPages().find((page) => page.type === "relation" && (page.title === text || page.title === record.statement));
        if (existing && existing.status !== "human" && existing.status !== "rejected") {
          this.upsert(store, { ...existing, status: "auto-rejected" });
        }
        continue;
      }
      if (decision !== "accept") continue;
      const text = equalityBody(record.statement);
      this.writeIfAllowed(store, {
        id: `relation:${record.source_kind}:${record.locator}`,
        type: "relation",
        status: "pending",
        title: text,
        body: text,
        source_ids: [record.source_id],
        fingerprint: record.fingerprint,
        claim_domain: "field_relation",
        authority: "database",
        confidence: record.confidence,
        fields: [{ key: "relation", text, status: "pending", meta: record.statement }]
      }, record.evidence_class);
    }
  }

  private linkPages(store: WikiStore): void {
    const pages = store.listPages().filter((page) => page.type !== "source");
    const ordered = [...pages.filter((page) => page.type === "relation"), ...pages.filter((page) => page.type !== "relation")];
    const current = new Map(ordered.map((page) => [page.id, page]));
    for (const page of ordered) {
      const latest = current.get(page.id) ?? page;
      const body = withStructuralLinks(latest, [...current.values()]);
      if (body !== latest.body) {
        const next = { ...latest, body };
        current.set(page.id, next);
        this.upsert(store, next);
      }
    }
  }

  private writeIfAllowed(store: WikiStore, page: Omit<WikiPage, "updated_at" | "datasource_ids" | "evidence_ids"> & Partial<Pick<WikiPage, "datasource_ids" | "evidence_ids">>, evidenceClass?: string): void {
    const key = rejectionKey(page);
    if (store.isRejected(key, evidenceClass ?? page.claim_domain ?? page.type)) return;
    const existing = store.readPage(page.id);
    const fields = page.type === "table"
      ? mergeColumnFields(existing?.fields ?? [], page.fields ?? [])
      : mergeFields(existing?.fields ?? [], page.fields ?? []);
    const next = { ...page, ...(fields.length > 0 ? { fields } : {}) };
    if (next.type === "table" && fields.length > 0) {
      next.body = renderTableBody(next.title, fields);
    }
    if (existing && (next.type === "column" || next.type === "relation" || next.type === "value-domain")) {
      const rendered = renderPageBody(next, fields.length > 0 ? fields : undefined);
      const prefix = (existing.body || page.body).split("\n").filter((line) => line.startsWith("type:") || line.startsWith("nullable:")).join("\n");
      next.body = [prefix, rendered].filter((line) => line.length > 0).join("\n");
    }
    if (existing?.status === "rejected" || existing?.status === "auto-rejected") return;
    this.upsert(store, next);
  }

  private upsert(store: WikiStore, page: Omit<WikiPage, "updated_at" | "datasource_ids" | "evidence_ids"> & Partial<Pick<WikiPage, "datasource_ids" | "evidence_ids">>): void {
    const datasourceIds = page.datasource_ids ?? page.source_ids;
    store.writePage({
      ...page,
      source_ids: datasourceIds,
      datasource_ids: datasourceIds,
      evidence_ids: page.evidence_ids ?? [],
      updated_at: new Date().toISOString()
    });
  }

  private foldColumns(workspaceId: string, store: WikiStore): void {
    if (this.foldedWorkspaces.has(workspaceId)) return;
    this.foldedWorkspaces.add(workspaceId);
    const columns = store.listPages().filter((page) => page.type === "column");
    if (columns.length === 0) {
      this.normalizeColumnRecords(store);
      this.healStructuralLinks(store);
      return;
    }
    const grouped = new Map<string, WikiPage[]>();
    for (const column of columns) {
      const sourceId = column.source_ids[0];
      const tableName = column.title.split(".")[0];
      if (!sourceId || !tableName || !column.title.includes(".")) continue;
      const tableId = `table:${sourceId}:${tableName}`;
      const group = grouped.get(tableId) ?? [];
      group.push(column);
      grouped.set(tableId, group);
    }
    for (const [tableId, group] of grouped) {
      const sourceId = group[0]?.source_ids[0] ?? "";
      const tableName = tableId.slice(`table:${sourceId}:`.length);
      const existing = store.readPage(tableId);
      const incoming = group.flatMap((column) => columnFieldsFromPage(tableName, column));
      const fields = mergeFields(existing?.fields ?? [], incoming);
      this.upsert(store, {
        id: tableId,
        type: "table",
        status: existing?.status ?? "pending",
        title: tableName,
        body: renderTableBody(tableName, fields),
        fields,
        source_ids: existing?.source_ids ?? [sourceId],
        fingerprint: existing?.fingerprint ?? group[0]?.fingerprint ?? "",
        ...(existing?.claim_domain ? { claim_domain: existing.claim_domain } : { claim_domain: "physical_identity" as const }),
        ...(existing?.authority ? { authority: existing.authority } : { authority: "database" as const }),
        confidence: existing?.confidence ?? 1
      });
    }
    store.deletePages("column:");
    this.normalizeColumnRecords(store);
    this.healStructuralLinks(store);
  }

  /** Rewrite pages once so structural wikilinks are unique (heals historically duplicated bodies). */
  private healStructuralLinks(store: WikiStore): void {
    const polluted = store.listPages().some((page) => {
      const links = page.body.split("\n").filter((line) => /^(所属列|所属表|列|表|关联|相关)\s+\[\[/u.test(line.trim()));
      return links.length !== new Set(links).size;
    });
    if (polluted) this.linkPages(store);
  }

  private normalizeColumnRecords(store: WikiStore): void {
    let changed = false;
    for (const page of store.listPages().filter((item) => item.type === "table")) {
      const fields = unifyColumnFields(page.fields ?? []);
      const body = renderTableBody(page.title, fields);
      const sameFields = JSON.stringify(fields) === JSON.stringify(page.fields ?? []);
      if (sameFields && body === page.body.split("\n").filter((line) => !line.startsWith("关联 [[")).join("\n").trim()) continue;
      changed = true;
      this.upsert(store, { ...page, fields, body });
    }
    if (changed || store.listPages().some((page) => page.type === "column")) this.linkPages(store);
  }

  private finish(store: WikiStore, logLine: string): void {
    this.linkPages(store);
    store.bumpRevision();
    store.appendLog(logLine);
    store.writeIndex(store.listPages());
  }

  private async publishBoundClaims(store: WikiStore, input: ScanInput, llm: LlmClient): Promise<void> {
    const raw = store.readRaw<{ text?: string; datasourceIds?: string[] }>(input.sourceKind, input.sourceId);
    const datasourceIds = input.datasourceIds ?? raw?.datasourceIds ?? [];
    if (datasourceIds.length === 0) return;
    const anchors = logicalAnchors(store.listPages(), datasourceIds);
    const text = raw?.text ?? input.text ?? "";
    const grounded = store.listGrounds()
      .filter((ground) => ground.source_kind === input.sourceKind && ground.source_id === input.sourceId)
      .flatMap((ground) => ground.records)
      .flatMap((record) => claimFromRecord(record, anchors));
    const extracted = await extractAnchoredClaims(llm, text, [...anchors]);
    for (const claim of [...grounded, ...extracted]) {
      if (!anchors.has(claim.anchor)) continue;
      const conflict = store.listPages().find((page) =>
        page.anchor === claim.anchor
        && page.type === claim.type
        && !page.evidence_ids.includes(input.sourceId)
        && page.body !== claim.statement
        && page.status !== "rejected"
        && page.status !== "auto-rejected"
      );
      const type = conflict ? "contradiction" as const : claim.type;
      this.writeIfAllowed(store, {
        id: `${type}:${input.sourceKind}:${claim.anchor}:${claim.title}`,
        type,
        status: "pending",
        title: claim.title,
        body: claim.statement,
        source_ids: datasourceIds,
        datasource_ids: datasourceIds,
        evidence_ids: [input.sourceId],
        anchor: claim.anchor,
        fingerprint: fingerprintOf(claim),
        authority: input.sourceKind,
        confidence: 0.6
      }, "document");
    }
    for (const datasourceId of datasourceIds) this.writeOutline(store, datasourceId);
  }

  private writeOutline(store: WikiStore, datasourceId: string): void {
    const pages = store.listPages().filter((page) => inScope(page, [datasourceId]));
    const tables = pages.filter((page) => page.type === "table").map((page) => page.title);
    const relations = pages
      .filter((page) => page.type === "relation" && (page.status === "auto" || page.status === "human"))
      .map((page) => page.title);
    const enums = pages
      .filter((page) => page.type === "value-domain")
      .slice(0, 12)
      .map((page) => page.title);
    const semantics = pages
      .filter((page) => SEMANTIC_PAGE_TYPES.has(page.type))
      .slice(0, 8)
      .map((page) => `- ${page.title}${page.anchor ? ` → ${page.anchor}` : ""}`);
    const body = [
      `# ${datasourceId}`,
      tables.length > 0 ? `表\n${tables.map((name) => `- ${name}`).join("\n")}` : "",
      relations.length > 0 ? `关联\n${relations.map((name) => `- ${name}`).join("\n")}` : "",
      enums.length > 0 ? `值域\n${enums.map((name) => `- ${name}`).join("\n")}` : "",
      semantics.length > 0 ? `解释\n${semantics.join("\n")}` : ""
    ].filter((part) => part.length > 0).join("\n\n");
    this.upsert(store, {
      id: `outline:${datasourceId}`,
      type: "outline",
      status: "auto",
      title: datasourceId,
      body,
      source_ids: [datasourceId],
      datasource_ids: [datasourceId],
      evidence_ids: [],
      fingerprint: fingerprintOf(body),
      authority: "database",
      confidence: 1
    });
  }

  private async embedSemanticPages(store: WikiStore): Promise<void> {
    if (!this.embedder) return;
    const pending = store.listPages().filter((page) => SEMANTIC_PAGE_TYPES.has(page.type));
    const stale = pending.filter((page) => store.readEmbedding(page.id)?.fingerprint !== page.fingerprint);
    for (const batch of chunksOf(stale, 16)) {
      const vectors = await this.embedder.embed(batch.map((page) => `${page.title}\n${stripStructuralLinkLines(page.body)}`.slice(0, 2000)));
      batch.forEach((page, index) => {
        const vector = vectors[index];
        if (vector && vector.length > 0) store.writeEmbedding(page.id, page.fingerprint, vector);
      });
    }
  }

  private bindPages(store: WikiStore, evidenceId: string, datasourceIds: string[]): void {
    const anchors = logicalAnchors(store.listPages(), datasourceIds);
    for (const page of store.listPages()) {
      if (!page.source_ids.includes(evidenceId) && !page.evidence_ids.includes(evidenceId)) continue;
      if (page.type === "source" || page.status === "human") continue;
      const anchor = page.anchor ?? longestAnchor(page.body, anchors);
      this.upsert(store, {
        ...page,
        source_ids: datasourceIds,
        datasource_ids: datasourceIds,
        evidence_ids: [evidenceId],
        ...(anchor ? { anchor } : {})
      });
    }
  }

  private store(workspaceId: string): WikiStore {
    const existing = this.stores.get(workspaceId);
    if (existing) return existing;
    const created = new WikiStore(this.db, workspaceId);
    this.stores.set(workspaceId, created);
    return created;
  }
}

const mergeSnapshot = (
  base: DatabaseSnapshot,
  patch: DatabaseSnapshot,
  tableName: string,
  columnName?: string
): DatabaseSnapshot => {
  const incoming = patch.tables.find((table) => table.name === tableName);
  if (!incoming) return base;
  const tables = base.tables.some((table) => table.name === tableName)
    ? base.tables.map((table) => {
      if (table.name !== tableName) return table;
      if (!columnName) {
        const next = { ...incoming };
        const foreignKeys = incoming.foreignKeys ?? table.foreignKeys;
        if (foreignKeys) next.foreignKeys = foreignKeys;
        return next;
      }
      const fresh = incoming.columns.find((column) => column.name === columnName);
      if (!fresh) return table;
      const sampled = fresh.samples && fresh.samples.length > 0
        ? fresh.samples
        : (incoming.sampleRows ?? []).flatMap((row) => {
          const value = row[columnName];
          return value === undefined || value === null ? [] : [String(value)];
        });
      return {
        ...table,
        columns: table.columns.map((column) => column.name === columnName ? { ...column, ...fresh, samples: sampled } : column)
      };
    })
    : [...base.tables, incoming];
  return { ...(base.dialect ? { dialect: base.dialect } : {}), tables };
};

const requireSnapshot = (snapshot: DatabaseSnapshot | undefined): DatabaseSnapshot => {
  if (!snapshot) throw new Error("DATABASE_SNAPSHOT_REQUIRED");
  return snapshot;
};

const record = (
  sourceId: string,
  sourceKind: SourceKind,
  fingerprint: string,
  claimDomain: ClaimDomain,
  statement: string,
  locator: string,
  evidenceClass: string,
  confidence: number,
  subject?: string
): GroundRecord => ({
  source_id: sourceId,
  source_kind: sourceKind,
  fingerprint,
  claim_domain: claimDomain,
  statement,
  locator,
  evidence_class: evidenceClass,
  confidence,
  ...(subject ? { subject } : {})
});

const measurementStatement = (measurement: RelationMeasurement): string =>
  `${measurement.left} ~ ${measurement.right} score=${measurement.score.toFixed(3)} overlap=${measurement.overlap.toFixed(3)} name=${measurement.name.toFixed(3)} parentKey=${measurement.parentIsKey}`;

const equalityBody = (statement: string): string => {
  const match = /^(\S+)\s+~\s+(\S+)/u.exec(statement);
  if (match?.[1] && match[2]) return `${match[1]} = ${match[2]}`;
  return statement.replace(" -> ", " = ");
};

const columnFields = (
  tableName: string,
  column: DatabaseSnapshot["tables"][number]["columns"][number],
  snapshot: DatabaseSnapshot
): WikiField[] => {
  const table = snapshot.tables.find((item) => item.name === tableName);
  const samples = columnSamples(column.name, column.samples, table?.sampleRows);
  const profile = profileColumn(tableName, column.name, column.type, column.nullable, column.comment, column.primaryKey === true, samples, table?.sampleRows?.length ?? samples.length);
  const label = column.comment?.trim() && !looksLikeTypeRestatement(column.comment) ? column.comment.trim() : "";
  return [columnFieldFromProfile(profile, label, label ? "auto" : "pending")];
};

const renderTableBody = (tableName: string, fields: WikiField[]): string => {
  void tableName;
  return readColumnFields(fields).map((record) => columnInfoText(record)).join("\n\n");
};

const columnsFromTable = (
  table: WikiPage,
  pages: WikiPage[]
): SchemaProjection["tables"][number]["columns"] => readColumnFields(table.fields).map((record) => {
  const labels = labelsFor(table.title, record.name, pages);
  const recalled = recallForSchema(record, labels);
  return {
    name: record.name,
    type: record.type,
    nullable: record.nullable,
    ...(recalled.label ? { label: recalled.label } : {}),
    ...(recalled.examples ? { examples: recalled.examples } : {}),
    ...(recalled.labels ? { labels: recalled.labels } : {}),
    ...(recalled.range ? { range: recalled.range } : {})
  };
});

const columnFieldsFromPage = (tableName: string, column: WikiPage): WikiField[] => {
  const name = column.title.startsWith(`${tableName}.`) ? column.title.slice(tableName.length + 1) : column.title;
  const type = /^type:\s*(.+)$/mu.exec(column.body)?.[1]?.trim();
  const nullable = /nullable:\s*true/u.test(column.body);
  const source = column.fields?.length
    ? column.fields
    : [{ key: "long", text: column.body, status: column.status }];
  return source.map((field) => {
    const key = field.key.includes(":") ? field.key : `${name}:${field.key}`;
    const profile = key.endsWith(":profile");
    return {
      ...field,
      key,
      ...(profile ? { meta: field.meta ?? JSON.stringify({ ...(type ? { type } : {}), nullable }) } : {})
    };
  });
};

const mergeColumnFields = (current: WikiField[], incoming: WikiField[]): WikiField[] => {
  const merged = new Map(unifyColumnFields(incoming).map((field) => [field.key, field]));
  for (const field of unifyColumnFields(current)) {
    if ((field.status === "human" || field.status === "rejected" || field.status === "auto-rejected") && merged.has(field.key)) {
      const next = merged.get(field.key);
      merged.set(field.key, next?.meta ? { ...next, text: field.text, status: field.status } : field);
      continue;
    }
    if (!merged.has(field.key)) merged.set(field.key, field);
  }
  return [...merged.values()];
};

const mergeFields = (current: WikiField[], incoming: WikiField[]): WikiField[] => {
  const merged = new Map(incoming.map((field) => [field.key, field]));
  for (const field of current) {
    if (field.status === "human" || field.status === "rejected" || field.status === "auto-rejected") merged.set(field.key, field);
  }
  for (const field of current) {
    if (!merged.has(field.key)) merged.set(field.key, field);
  }
  return [...merged.values()];
};

const relationEndpoints = (text: string): Array<{ table: string; column: string }> =>
  [...text.matchAll(/([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)/gu)].flatMap((match) =>
    match[1] && match[2] ? [{ table: match[1], column: match[2] }] : []
  );

const uniqueLinks = (lines: string[]): string[] => [...new Set(lines.filter((line) => line.length > 0))];

const withStructuralLinks = (page: WikiPage, pages: WikiPage[]): string => {
  const titles = new Set(pages.map((item) => item.title));
  const link = (title: string, label: string): string => {
    const base = title.split("#")[0] ?? title;
    if (!titles.has(base) || title === page.title) return "";
    return `${label} [[${title}]]`;
  };
  const fields = page.fields ?? [];
  const core = stripStructuralLinkLines(renderPageBody(page, fields));
  if (page.type === "relation") {
    const text = fields.find((field) => field.key === "relation")?.text ?? stripStructuralLinkLines(page.body).split("\n")[0] ?? page.title;
    const ends = relationEndpoints(text);
    return [text, ...uniqueLinks(ends.flatMap((end) => [
      link(`${end.table}#${end.column}`, "列"),
      link(end.table, "表")
    ]))].filter((line) => line.length > 0).join("\n");
  }
  if (page.type === "value-domain") {
    const column = page.title.replace(/ 值域$/u, "");
    const table = column.split(".")[0] ?? "";
    const name = column.split(".").slice(1).join(".");
    return [core, ...uniqueLinks([link(`${table}#${name}`, "所属列"), link(table, "所属表")])].filter((line) => line.length > 0).join("\n");
  }
  if (page.type === "table") {
    const base = stripStructuralLinkLines(page.body.split("\n").filter((line) => !line.startsWith("关联 [[")).join("\n"));
    const relations = pages.filter((item) => item.type === "relation" && relationEndpoints(item.title).some((end) => end.table === page.title));
    return [base, ...uniqueLinks(relations.map((item) => link(item.title, "关联")))].filter((line) => line.length > 0).join("\n");
  }
  const mentioned = pages.filter((item) => item.id !== page.id && item.title.length > 1 && page.body.includes(item.title));
  return [
    stripStructuralLinkLines(page.body.split("\n").filter((line) => !line.startsWith("相关 [[")).join("\n")),
    ...uniqueLinks(mentioned.map((item) => link(item.title, "相关")))
  ]
    .filter((line) => line.length > 0)
    .join("\n");
};

const renderPageBody = (page: Pick<WikiPage, "type" | "title" | "body">, fields?: WikiField[], links: string[] = []): string => {
  const short = fields?.find((field) => field.key === "short");
  const long = fields?.find((field) => field.key === "long");
  const relation = fields?.find((field) => field.key === "relation");
  const dictionary = fields?.find((field) => field.key === "dictionary");
  if (page.type === "relation") return relation?.text ?? page.body;
  if (page.type === "value-domain") return dictionary?.text ?? page.body;
  if (page.type !== "column") return page.body;
  return [
    ...links,
    short?.text ? `## 短描述\n${short.text}` : "",
    long?.text ? `## 长描述\n${long.text}` : ""
  ].filter((line) => line.length > 0).join("\n\n");
};

const looksLikeTypeRestatement = (text: string): boolean =>
  /nullable|非空|TEXT|INTEGER|REAL|类型/u.test(text);

const pairKey = (left: string, right: string): string => [left, right].sort().join("~");

const rejectionKey = (page: Pick<WikiPage, "id" | "claim_domain" | "title">): string =>
  `${page.claim_domain ?? "page"}:${page.title}`;

const columnFactBody = (
  tableName: string,
  column: DatabaseSnapshot["tables"][number]["columns"][number],
  snapshot: DatabaseSnapshot
): string => {
  const table = snapshot.tables.find((item) => item.name === tableName);
  const samples = columnSamples(column.name, column.samples, table?.sampleRows);
  const profile = profileColumn(tableName, column.name, column.type, column.nullable, column.comment, column.primaryKey === true, samples, table?.sampleRows?.length ?? samples.length);
  return [
    `type: ${column.type}`,
    `nullable: ${column.nullable}`,
    column.primaryKey ? "primary_key: true" : "",
    formatProfile(profile),
    profile.top.length > 0 ? `top: ${profile.top.join(", ")}` : ""
  ].filter((line) => line.length > 0).join("\n");
};

const SEMANTIC_PAGE_TYPES = new Set<WikiPage["type"]>(["concept", "metric", "query-pattern", "contradiction"]);
const LOGICAL_PAGE_TYPES = new Set<WikiPage["type"]>(["table", "relation", "value-domain", "outline"]);

const anchorKeys = (page: WikiPage): Set<string> => {
  const keys = new Set<string>([page.title]);
  if (page.type === "table") {
    for (const field of page.fields ?? []) {
      if (!field.key.includes(":")) keys.add(`${page.title}.${field.key}`);
    }
  }
  return keys;
};

const isBoundFeedstock = (store: WikiStore, record: GroundRecord): boolean => {
  if (record.source_kind !== "document" && record.source_kind !== "code") return false;
  const raw = store.readRaw<{ datasourceIds?: string[] }>(record.source_kind, record.source_id);
  return (raw?.datasourceIds?.length ?? 0) > 0;
};

const claimFromRecord = (
  record: GroundRecord,
  anchors: Set<string>
): Array<{ type: WikiPage["type"]; title: string; statement: string; anchor: string }> => {
  const type: WikiPage["type"] | undefined = record.claim_domain === "business_rule"
    ? "metric"
    : record.claim_domain === "terminology" || record.claim_domain === "term_bridge"
      ? "concept"
      : record.claim_domain === "query_pattern"
        ? "query-pattern"
        : undefined;
  if (!type) return [];
  const anchor = longestAnchor(`${record.subject ?? ""}\n${record.statement}`, anchors);
  if (!anchor) return [];
  return [{ type, title: record.subject ?? anchor, statement: record.statement, anchor }];
};

const inScope = (page: WikiPage, selected?: string[]): boolean => {
  if (!selected || selected.length === 0) return true;
  const ids = page.datasource_ids.length > 0 ? page.datasource_ids : page.source_ids;
  if (ids.length === 0) return false;
  const chosen = new Set(selected);
  return ids.every((id) => chosen.has(id));
};

const logicalAnchors = (pages: WikiPage[], datasourceIds: string[]): Set<string> => {
  const chosen = new Set(datasourceIds);
  const anchors = new Set<string>();
  for (const page of pages) {
    const ids = page.datasource_ids.length > 0 ? page.datasource_ids : page.source_ids;
    if (!ids.some((id) => chosen.has(id))) continue;
    if (page.type === "table") {
      anchors.add(page.title);
      for (const field of page.fields ?? []) {
        if (!field.key.includes(":")) anchors.add(`${page.title}.${field.key}`);
      }
    }
    if (page.type === "relation") anchors.add(page.title);
  }
  return anchors;
};

const longestAnchor = (text: string, anchors: Set<string>): string | undefined => {
  let best: string | undefined;
  for (const anchor of anchors) {
    if (text.includes(anchor) && (!best || anchor.length > best.length)) best = anchor;
  }
  return best;
};

const extractAnchoredClaims = async (
  llm: LlmClient,
  text: string,
  anchors: string[]
): Promise<Array<{ type: WikiPage["type"]; title: string; statement: string; anchor: string }>> => {
  if (!text.trim() || anchors.length === 0) return [];
  const raw = await llm.complete(
    "只返回 JSON {\"claims\":[{\"kind\":\"concept|metric|contradiction\",\"title\":\"\",\"statement\":\"\",\"anchor\":\"\"}]}。最多 8 条。\n"
    + "kind=concept：某个已有字段或表的业务叫法，statement 只写定义。\n"
    + "kind=metric：某个已有字段怎么汇总或计算，statement 写口径，不写 SQL。\n"
    + "kind=contradiction：与已有主张冲突，statement 写冲突点。\n"
    + "anchor 必须与给出的落点完全一致，优先使用 表.字段。对不上就不要返回该条。\n"
    + "不要粘贴原文，不要发明落点里没有的表或字段，不要输出解释。\n"
    + `落点：${anchors.slice(0, 80).join(", ")}\n正文：\n${text.slice(0, 6000)}`
  );
  const match = /\{[\s\S]*\}/u.exec(raw);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as { claims?: Array<{ kind?: string; title?: string; statement?: string; anchor?: string }> };
    return (parsed.claims ?? []).slice(0, 8).flatMap((claim) => {
      const type = claim.kind === "metric" || claim.kind === "contradiction" || claim.kind === "concept"
        ? claim.kind
        : undefined;
      if (!type || !claim.title || !claim.statement || !claim.anchor) return [];
      if (claim.statement.length > 400 || claim.title.length > 40) return [];
      if (!anchors.includes(claim.anchor)) return [];
      return [{ type, title: claim.title, statement: claim.statement, anchor: claim.anchor }];
    });
  } catch {
    return [];
  }
};

const chunksOf = <T>(items: T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
};

const fuseRanks = (lists: string[][]): string[] => {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + index + 1));
    });
  }
  return [...scores.entries()].sort((left, right) => right[1] - left[1]).map(([id]) => id);
};

const cosine = (left: number[], right: number[]): number => {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
    leftNorm += (left[index] ?? 0) ** 2;
    rightNorm += (right[index] ?? 0) ** 2;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
};

const RECALL_PAGE_TYPES = new Set<WikiPage["type"]>([
  "table",
  "relation",
  "value-domain",
  "concept",
  "metric",
  "query-pattern",
  "contradiction"
]);

const RECALL_TYPE_WEIGHT: Partial<Record<WikiPage["type"], number>> = {
  metric: 8,
  concept: 7,
  contradiction: 6,
  "query-pattern": 6,
  table: 5,
  relation: 4,
  "value-domain": 3
};

const recallScore = (page: WikiPage, needles: string[]): number => {
  const title = page.title.toLowerCase();
  const body = stripStructuralLinkLines(page.body).toLowerCase();
  let matched = 0;
  for (const needle of needles) {
    const exact = title === needle || bounded(title, needle) || bounded(body, needle);
    if (exact) matched += needle.length >= 4 || /[\u4e00-\u9fff]/u.test(needle) ? 12 : 8;
    else if (/[\u4e00-\u9fff]/u.test(needle) && (title.includes(needle) || body.includes(needle))) matched += 4;
  }
  if (matched === 0) return 0;
  if (page.type === "table" && needles.some((needle) => needle === title)) matched += 40;
  const pending = page.status === "pending" ? 2 : 0;
  return matched + (RECALL_TYPE_WEIGHT[page.type] ?? 0) - pending;
};

const bounded = (text: string, needle: string): boolean => {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, "iu").test(text);
};

const labelsFor = (table: string, column: string, pages: WikiPage[]): string[] | undefined => {
  const subject = `${table}.${column}`;
  const domain = pages.find((page) =>
    page.type === "value-domain"
    && (page.title === `${subject} 值域` || page.title === subject)
  );
  if (domain) {
    const fromField = domain.fields?.find((field) => field.key === "dictionary")?.text;
    return parseDictionaryLabels(fromField ?? domain.body);
  }
  const enums = pages.filter((page) =>
    page.claim_domain === "enum_dictionary"
    && page.type !== "value-domain"
    && (page.title === subject || page.body.startsWith(`${subject} `) || page.body.startsWith(`${column} `))
  );
  if (enums.length === 0) return undefined;
  const labels = enums.flatMap((page) => parseDictionaryLabels(page.body) ?? []);
  return labels.length > 0 ? [...new Set(labels)].slice(0, 50) : undefined;
};

const mentionsTable = (page: WikiPage, tables: Set<string>): boolean => {
  const text = `${page.title} ${page.body}`;
  for (const table of tables) {
    if (text.includes(`${table}.`)) return true;
  }
  return false;
};

const parseShort = (raw: string): string | undefined => {
  const match = /\{[\s\S]*\}/u.exec(raw);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as { short?: string };
    return parsed.short?.trim() || undefined;
  } catch {
    return undefined;
  }
};

const parseDescription = (raw: string): { short: string; long: string } | undefined => {
  const match = /\{[\s\S]*\}/u.exec(raw);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as { short?: string; long?: string };
    if (!parsed.short || !parsed.long) return undefined;
    return { short: parsed.short, long: parsed.long };
  } catch {
    return undefined;
  }
};

const parseDictionary = (raw: string): { decision: string; labels: Array<{ value: string; label: string }> } | undefined => {
  const match = /\{[\s\S]*\}/u.exec(raw);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as { decision?: string; labels?: Array<{ value?: string; label?: string }> };
    if (!parsed.decision) return undefined;
    return {
      decision: parsed.decision,
      labels: (parsed.labels ?? []).flatMap((item) => item.value ? [{ value: item.value, label: item.label ?? "" }] : [])
    };
  } catch {
    return undefined;
  }
};

const parseDecision = (raw: string): "accept" | "reject" | "candidate" | undefined => {
  const match = /\{[\s\S]*\}/u.exec(raw);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as { decision?: string };
    if (parsed.decision === "accept" || parsed.decision === "reject" || parsed.decision === "candidate") {
      return parsed.decision;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

