import { DatabaseSync } from "node:sqlite";

import { normalizeValue } from "./text.js";
import type { ClaimDomain, GroundRecord, LookupHit, PageStatus, SourceKind, WikiField, WikiPage } from "./types.js";
import type { IndexedValue } from "./value-index.js";

export type GroundFile = {
  source_kind: SourceKind;
  source_id: string;
  fingerprint: string;
  records: GroundRecord[];
};

export const ensureWikiSchema = (db: DatabaseSync): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_sources (
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      external_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      scan_status TEXT NOT NULL,
      facts_at TEXT,
      semantic_at TEXT,
      PRIMARY KEY (workspace_id, kind, external_id)
    );
    CREATE TABLE IF NOT EXISTS wiki_raw (
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      external_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (workspace_id, kind, external_id)
    );
    CREATE TABLE IF NOT EXISTS wiki_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      claim_domain TEXT NOT NULL,
      statement TEXT NOT NULL,
      locator TEXT NOT NULL,
      evidence_class TEXT NOT NULL,
      confidence REAL NOT NULL,
      subject TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_claims_source
      ON wiki_claims (workspace_id, source_kind, source_id);
    CREATE TABLE IF NOT EXISTS wiki_pages (
      workspace_id TEXT NOT NULL,
      id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      source_ids TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      claim_domain TEXT,
      authority TEXT,
      confidence REAL NOT NULL,
      updated_at TEXT NOT NULL,
      fields_json TEXT,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE TABLE IF NOT EXISTS wiki_values (
      workspace_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      value TEXT NOT NULL,
      normalized TEXT NOT NULL,
      shingle TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_values_exact
      ON wiki_values (workspace_id, source_id, normalized);
    CREATE INDEX IF NOT EXISTS idx_wiki_values_column
      ON wiki_values (workspace_id, source_id, table_name, column_name);
  `);
  const pageColumns = db.prepare("PRAGMA table_info(wiki_pages)").all() as Array<{ name: string }>;
  if (!pageColumns.some((column) => column.name === "fields_json")) {
    db.exec("ALTER TABLE wiki_pages ADD COLUMN fields_json TEXT");
  }
  for (const column of ["datasource_ids", "evidence_ids", "anchor"]) {
    if (!pageColumns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE wiki_pages ADD COLUMN ${column} TEXT`);
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_page_embeddings (
      workspace_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      vector TEXT NOT NULL,
      PRIMARY KEY (workspace_id, page_id)
    );
    CREATE TABLE IF NOT EXISTS wiki_rejections (
      workspace_id TEXT NOT NULL,
      key TEXT NOT NULL,
      evidence_class TEXT NOT NULL,
      page_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, key)
    );
    CREATE TABLE IF NOT EXISTS wiki_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      at TEXT NOT NULL,
      line TEXT NOT NULL
    );
  `);
};

export class WikiStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly workspaceId: string
  ) {}

  readRaw<T>(kind: SourceKind, sourceId: string): T | undefined {
    const row = this.db.prepare(
      "SELECT payload FROM wiki_raw WHERE workspace_id = ? AND kind = ? AND external_id = ?"
    ).get(this.workspaceId, kind, sourceId) as { payload: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.payload) as T;
  }

  writeRaw(kind: SourceKind, sourceId: string, payload: unknown, fingerprint: string): void {
    this.db.prepare(`
      INSERT INTO wiki_raw (workspace_id, kind, external_id, fingerprint, payload)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, kind, external_id) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        payload = excluded.payload
    `).run(this.workspaceId, kind, sourceId, fingerprint, JSON.stringify(payload));
  }

  readGroundFingerprint(kind: SourceKind, sourceId: string): string | undefined {
    const row = this.db.prepare(
      "SELECT fingerprint FROM wiki_sources WHERE workspace_id = ? AND kind = ? AND external_id = ?"
    ).get(this.workspaceId, kind, sourceId) as { fingerprint: string } | undefined;
    return row?.fingerprint;
  }

  writeGround(kind: SourceKind, sourceId: string, fingerprint: string, records: GroundRecord[], extras: Record<string, unknown> = {}): void {
    const now = new Date().toISOString();
    this.db.prepare("DELETE FROM wiki_claims WHERE workspace_id = ? AND source_kind = ? AND source_id = ?")
      .run(this.workspaceId, kind, sourceId);
    const insert = this.db.prepare(`
      INSERT INTO wiki_claims (
        workspace_id, source_kind, source_id, fingerprint, claim_domain, statement, locator, evidence_class, confidence, subject
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const record of records) {
      insert.run(
        this.workspaceId,
        kind,
        sourceId,
        fingerprint,
        record.claim_domain,
        record.statement,
        record.locator,
        record.evidence_class,
        record.confidence,
        record.subject ?? null
      );
    }
    this.db.prepare(`
      INSERT INTO wiki_sources (workspace_id, kind, external_id, fingerprint, scan_status, facts_at, semantic_at)
      VALUES (?, ?, ?, ?, 'facts', ?, NULL)
      ON CONFLICT (workspace_id, kind, external_id) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        scan_status = 'facts',
        facts_at = excluded.facts_at
    `).run(this.workspaceId, kind, sourceId, fingerprint, now);
    if (Array.isArray(extras.exactValues)) this.writeExactValues(sourceId, extras.exactValues as IndexedValue[]);
  }

  readExtras(kind: SourceKind, sourceId: string): Record<string, unknown> {
    const raw = this.db.prepare(
      "SELECT payload FROM wiki_raw WHERE workspace_id = ? AND kind = ? AND external_id = ?"
    ).get(this.workspaceId, kind, sourceId) as { payload: string } | undefined;
    const payload = raw ? JSON.parse(raw.payload) as Record<string, unknown> : {};
    const dialect = typeof payload.dialect === "string" ? payload.dialect : undefined;
    return dialect ? { dialect } : {};
  }

  lookupValues(sourceId: string, literal: string): LookupHit[] {
    const normalized = normalizeValue(literal);
    if (normalized.length === 0) return [];
    const exact = this.db.prepare(`
      SELECT table_name, column_name, value
      FROM wiki_values
      WHERE workspace_id = ? AND source_id = ? AND shingle = '' AND normalized = ?
      LIMIT 32
    `).all(this.workspaceId, sourceId, normalized) as Array<{ table_name: string; column_name: string; value: string }>;
    if (exact.length > 0) {
      return uniqueHits(exact.map((row) => ({
        table: row.table_name,
        column: row.column_name,
        match: "exact" as const,
        sample: row.value
      })));
    }
    const needle = `%${escapeLike(normalized)}%`;
    const fuzzy = this.db.prepare(`
      SELECT table_name, column_name, value
      FROM wiki_values
      WHERE workspace_id = ? AND source_id = ? AND shingle = '' AND normalized LIKE ? ESCAPE '\\'
      LIMIT 32
    `).all(this.workspaceId, sourceId, needle) as Array<{ table_name: string; column_name: string; value: string }>;
    return uniqueHits(fuzzy.map((row) => ({
      table: row.table_name,
      column: row.column_name,
      match: "lsh" as const,
      sample: row.value
    }))).slice(0, 8);
  }

  listGrounds(): GroundFile[] {
    const sources = this.db.prepare(
      "SELECT kind, external_id, fingerprint FROM wiki_sources WHERE workspace_id = ?"
    ).all(this.workspaceId) as Array<{ kind: SourceKind; external_id: string; fingerprint: string }>;
    return sources.map((source) => ({
      source_kind: source.kind,
      source_id: source.external_id,
      fingerprint: source.fingerprint,
      records: this.claimsFor(source.kind, source.external_id)
    }));
  }

  deleteGround(kind: SourceKind, sourceId: string): void {
    this.db.prepare("DELETE FROM wiki_claims WHERE workspace_id = ? AND source_kind = ? AND source_id = ?")
      .run(this.workspaceId, kind, sourceId);
    this.db.prepare("DELETE FROM wiki_raw WHERE workspace_id = ? AND kind = ? AND external_id = ?")
      .run(this.workspaceId, kind, sourceId);
    this.db.prepare("DELETE FROM wiki_sources WHERE workspace_id = ? AND kind = ? AND external_id = ?")
      .run(this.workspaceId, kind, sourceId);
    if (kind === "database") {
      this.db.prepare("DELETE FROM wiki_values WHERE workspace_id = ? AND source_id = ?")
        .run(this.workspaceId, sourceId);
    }
  }

  markSemantic(kind: SourceKind, sourceId: string): void {
    this.db.prepare(`
      UPDATE wiki_sources
      SET scan_status = 'ready', semantic_at = ?
      WHERE workspace_id = ? AND kind = ? AND external_id = ?
    `).run(new Date().toISOString(), this.workspaceId, kind, sourceId);
  }

  revision(): string {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM wiki_log WHERE workspace_id = ?"
    ).get(this.workspaceId) as { n: number };
    return String(row.n);
  }

  bumpRevision(): string {
    return this.revision();
  }

  deletePages(idPrefix: string): void {
    this.db.prepare("DELETE FROM wiki_pages WHERE workspace_id = ? AND id LIKE ?")
      .run(this.workspaceId, `${idPrefix}%`);
  }

  deletePage(id: string): void {
    this.db.prepare("DELETE FROM wiki_pages WHERE workspace_id = ? AND id = ?")
      .run(this.workspaceId, id);
    this.deleteEmbedding(id);
  }

  writePage(page: WikiPage): void {
    this.db.prepare(`
      INSERT INTO wiki_pages (
        workspace_id, id, type, status, title, body, source_ids, fingerprint, claim_domain, authority, confidence, updated_at, fields_json,
        datasource_ids, evidence_ids, anchor
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, id) DO UPDATE SET
        type = excluded.type,
        status = excluded.status,
        title = excluded.title,
        body = excluded.body,
        source_ids = excluded.source_ids,
        fingerprint = excluded.fingerprint,
        claim_domain = excluded.claim_domain,
        authority = excluded.authority,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at,
        fields_json = excluded.fields_json,
        datasource_ids = excluded.datasource_ids,
        evidence_ids = excluded.evidence_ids,
        anchor = excluded.anchor
    `).run(
      this.workspaceId,
      page.id,
      page.type,
      page.status,
      page.title,
      page.body,
      JSON.stringify(page.datasource_ids.length > 0 ? page.datasource_ids : page.source_ids),
      page.fingerprint,
      page.claim_domain ?? null,
      page.authority ?? null,
      page.confidence,
      page.updated_at,
      page.fields ? JSON.stringify(page.fields) : null,
      JSON.stringify(page.datasource_ids),
      JSON.stringify(page.evidence_ids),
      page.anchor ?? null
    );
  }

  readPage(id: string): WikiPage | undefined {
    const row = this.db.prepare(
      "SELECT * FROM wiki_pages WHERE workspace_id = ? AND id = ?"
    ).get(this.workspaceId, id) as Record<string, unknown> | undefined;
    return row ? rowToPage(row) : undefined;
  }

  listPages(): WikiPage[] {
    const rows = this.db.prepare(
      "SELECT * FROM wiki_pages WHERE workspace_id = ? ORDER BY id"
    ).all(this.workspaceId) as Array<Record<string, unknown>>;
    return rows.map(rowToPage);
  }

  search(query: string): WikiPage[] {
    const needle = `%${escapeLike(query.toLowerCase())}%`;
    const rows = this.db.prepare(`
      SELECT * FROM wiki_pages
      WHERE workspace_id = ? AND (lower(title) LIKE ? ESCAPE '\\' OR lower(body) LIKE ? ESCAPE '\\')
      ORDER BY confidence DESC
      LIMIT 20
    `).all(this.workspaceId, needle, needle) as Array<Record<string, unknown>>;
    return rows.map(rowToPage);
  }

  reject(key: string, evidenceClass: string, pageId: string): void {
    this.db.prepare(`
      INSERT INTO wiki_rejections (workspace_id, key, evidence_class, page_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (workspace_id, key) DO UPDATE SET
        evidence_class = excluded.evidence_class,
        page_id = excluded.page_id
    `).run(this.workspaceId, key, evidenceClass, pageId);
  }

  isRejected(key: string, evidenceClass: string): boolean {
    const row = this.db.prepare(
      "SELECT evidence_class FROM wiki_rejections WHERE workspace_id = ? AND key = ?"
    ).get(this.workspaceId, key) as { evidence_class: string } | undefined;
    return row?.evidence_class === evidenceClass;
  }

  appendLog(line: string): void {
    this.db.prepare(
      "INSERT INTO wiki_log (workspace_id, at, line) VALUES (?, ?, ?)"
    ).run(this.workspaceId, new Date().toISOString(), line);
  }

  writeIndex(_pages: WikiPage[]): void {
    // Compiled pages live in wiki_pages. The log is wiki_log.
  }

  private claimsFor(kind: SourceKind, sourceId: string): GroundRecord[] {
    const rows = this.db.prepare(`
      SELECT source_id, source_kind, fingerprint, claim_domain, statement, locator, evidence_class, confidence, subject
      FROM wiki_claims
      WHERE workspace_id = ? AND source_kind = ? AND source_id = ?
    `).all(this.workspaceId, kind, sourceId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      source_id: String(row.source_id),
      source_kind: row.source_kind as SourceKind,
      fingerprint: String(row.fingerprint),
      claim_domain: row.claim_domain as ClaimDomain,
      statement: String(row.statement),
      locator: String(row.locator),
      evidence_class: String(row.evidence_class),
      confidence: Number(row.confidence),
      ...(typeof row.subject === "string" ? { subject: row.subject } : {})
    }));
  }

  readEmbedding(pageId: string): { fingerprint: string; vector: number[] } | undefined {
    const row = this.db.prepare(
      "SELECT fingerprint, vector FROM wiki_page_embeddings WHERE workspace_id = ? AND page_id = ?"
    ).get(this.workspaceId, pageId) as { fingerprint: string; vector: string } | undefined;
    if (!row) return undefined;
    const vector = JSON.parse(row.vector) as number[];
    return Array.isArray(vector) ? { fingerprint: row.fingerprint, vector } : undefined;
  }

  writeEmbedding(pageId: string, fingerprint: string, vector: number[]): void {
    this.db.prepare(`
      INSERT INTO wiki_page_embeddings (workspace_id, page_id, fingerprint, vector)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (workspace_id, page_id) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        vector = excluded.vector
    `).run(this.workspaceId, pageId, fingerprint, JSON.stringify(vector));
  }

  deleteEmbedding(pageId: string): void {
    this.db.prepare("DELETE FROM wiki_page_embeddings WHERE workspace_id = ? AND page_id = ?")
      .run(this.workspaceId, pageId);
  }

  deleteExactValues(sourceId: string, table: string, column: string): void {
    this.db.prepare(
      "DELETE FROM wiki_values WHERE workspace_id = ? AND source_id = ? AND table_name = ? AND column_name = ?"
    ).run(this.workspaceId, sourceId, table, column);
  }

  private writeExactValues(sourceId: string, entries: IndexedValue[]): void {
    this.db.prepare("DELETE FROM wiki_values WHERE workspace_id = ? AND source_id = ?")
      .run(this.workspaceId, sourceId);
    const insert = this.db.prepare(`
      INSERT INTO wiki_values (workspace_id, source_id, table_name, column_name, value, normalized, shingle)
      VALUES (?, ?, ?, ?, ?, ?, '')
    `);
    this.db.exec("BEGIN");
    try {
      let count = 0;
      for (const entry of entries) {
        insert.run(this.workspaceId, sourceId, entry.table, entry.column, entry.value, normalizeValue(entry.value));
        count += 1;
        if (count % 500 === 0) {
          this.db.exec("COMMIT");
          this.db.exec("BEGIN");
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const uniqueHits = (hits: LookupHit[]): LookupHit[] => {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.table}.${hit.column}.${hit.sample}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const escapeLike = (value: string): string => value.replace(/[\\%_]/gu, (char) => `\\${char}`);

const rowToPage = (row: Record<string, unknown>): WikiPage => {
  const sourceIds = JSON.parse(String(row.source_ids)) as string[];
  const storedDatasources = parseIdList(row.datasource_ids);
  const page: WikiPage = {
    id: String(row.id),
    type: row.type as WikiPage["type"],
    status: row.status as WikiPage["status"],
    title: String(row.title),
    body: String(row.body),
    source_ids: sourceIds,
    datasource_ids: storedDatasources ?? sourceIds,
    evidence_ids: parseIdList(row.evidence_ids) ?? [],
    fingerprint: String(row.fingerprint),
    confidence: Number(row.confidence),
    updated_at: String(row.updated_at)
  };
  if (typeof row.anchor === "string" && row.anchor.length > 0) page.anchor = row.anchor;
  if (typeof row.claim_domain === "string") page.claim_domain = row.claim_domain as ClaimDomain;
  if (typeof row.authority === "string") page.authority = row.authority as SourceKind;
  if (typeof row.fields_json === "string") {
    const fields = JSON.parse(row.fields_json) as WikiField[];
    if (fields.length > 0) page.fields = fields.map((field) => ({ ...field, status: normalizeStatus(field.status) }));
  }
  page.status = normalizeStatus(page.status);
  return page;
};

const parseIdList = (value: unknown): string[] | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : undefined;
};

const normalizeStatus = (status: string): PageStatus => {
  if (status === "compiled") return "pending";
  if (status === "confirmed") return "auto";
  if (status === "pinned") return "human";
  if (status === "auto" || status === "human" || status === "rejected" || status === "auto-rejected" || status === "pending") return status;
  return "pending";
};
