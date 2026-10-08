import type { DatabaseForeignKey, DatabaseSnapshot, DatabaseTableSnapshot } from "./types.js";

export { AUTHORITY, authorityRank, selectAuthoritative, winningKind } from "./authority.js";
export { parseCodeFacts, parseDocumentFacts } from "./parsers.js";
export type { CodeFacts, DocumentFacts } from "./parsers.js";
export { ensureWikiSchema } from "./store.js";
export { LlmWiki } from "./wiki.js";
export type { ScanInput } from "./wiki.js";
export type {
  ClaimDomain,
  DatabaseSnapshot,
  GroundRecord,
  LlmClient,
  LookupHit,
  ScanMode,
  SchemaProjection,
  SourceKind,
  WikiPage,
  WikiSearchHit
} from "./types.js";

export type DatabaseProbe = {
  dialect?: string;
  listTables(): Promise<DatabaseSnapshot["tables"]>;
  query(sql: string): Promise<{ columns: string[]; rows: unknown[][] }>;
};

/** Read physical tables, samples, comments, keys, and foreign keys through an injected read-only probe. */
export const collectDatabaseSnapshot = async (probe: DatabaseProbe): Promise<DatabaseSnapshot> => {
  const listed = await probe.listTables();
  const tables: DatabaseTableSnapshot[] = [];
  for (const table of listed.slice(0, 40)) {
    const sampleRows = await readSample(probe, table.name);
    const columns = await enrichColumns(probe, table.columns, table.name);
    const foreignKeys = table.foreignKeys && table.foreignKeys.length > 0
      ? table.foreignKeys
      : await readForeignKeys(probe, table.name);
    const next: DatabaseTableSnapshot = { name: table.name, columns };
    if (table.comment) next.comment = table.comment;
    if (sampleRows.length > 0) next.sampleRows = sampleRows;
    if (foreignKeys.length > 0) next.foreignKeys = foreignKeys;
    tables.push(next);
  }
  return {
    ...(probe.dialect ? { dialect: probe.dialect } : {}),
    tables
  };
};

const readSample = async (
  probe: DatabaseProbe,
  table: string
): Promise<Array<Record<string, unknown>>> => {
  try {
    const sampled = await probe.query(`SELECT * FROM ${quoteIdent(table, probe.dialect)} LIMIT 2000`);
    return sampled.rows.map((row) => {
      const record: Record<string, unknown> = {};
      sampled.columns.forEach((column, index) => {
        record[column] = row[index];
      });
      return record;
    });
  } catch {
    return [];
  }
};

const enrichColumns = async (
  probe: DatabaseProbe,
  columns: DatabaseSnapshot["tables"][number]["columns"],
  table: string
): Promise<DatabaseSnapshot["tables"][number]["columns"]> => {
  const dialect = family(probe.dialect);
  try {
    if (dialect === "mysql") {
      const rows = await probe.query(
        `SELECT column_name, column_comment, column_key FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ${sqlString(table)}`
      );
      return mergeColumns(columns, rows.columns, rows.rows, "column_name", "column_comment", "column_key");
    }
    if (dialect === "sqlite") {
      const rows = await probe.query(`PRAGMA table_info(${quoteIdent(table, probe.dialect)})`);
      return mergeColumns(columns, rows.columns, rows.rows, "name", "", "pk");
    }
    const described = await probe.query(
      `SELECT a.attname AS column_name, col_description(c.oid, a.attnum) AS column_comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE c.relname = ${sqlString(table)} AND n.nspname = current_schema()`
    );
    const keys = await probe.query(
      `SELECT kcu.column_name AS column_name, 'PRI' AS column_key
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = ${sqlString(table)} AND tc.table_schema = current_schema()`
    );
    const withComments = mergeColumns(columns, described.columns, described.rows, "column_name", "column_comment", "");
    return mergeColumns(withComments, keys.columns, keys.rows, "column_name", "", "column_key");
  } catch {
    return columns;
  }
};

const readForeignKeys = async (
  probe: DatabaseProbe,
  table: string
): Promise<DatabaseForeignKey[]> => {
  const dialect = family(probe.dialect);
  try {
    if (dialect === "mysql") {
      const rows = await probe.query(
        `SELECT column_name, referenced_table_name, referenced_column_name
         FROM information_schema.key_column_usage
         WHERE table_schema = DATABASE() AND table_name = ${sqlString(table)} AND referenced_table_name IS NOT NULL`
      );
      return mapForeignKeys(rows.columns, rows.rows, "column_name", "referenced_table_name", "referenced_column_name");
    }
    if (dialect === "sqlite") {
      const rows = await probe.query(`PRAGMA foreign_key_list(${quoteIdent(table, probe.dialect)})`);
      return mapForeignKeys(rows.columns, rows.rows, "from", "table", "to");
    }
    const rows = await probe.query(
      `SELECT kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = ${sqlString(table)}`
    );
    return mapForeignKeys(rows.columns, rows.rows, "column_name", "ref_table", "ref_column");
  } catch {
    return [];
  }
};

const mergeColumns = (
  columns: DatabaseSnapshot["tables"][number]["columns"],
  names: string[],
  rows: unknown[][],
  nameKey: string,
  commentKey: string,
  keyKey: string
): DatabaseSnapshot["tables"][number]["columns"] => {
  const extras = new Map<string, { comment?: string; primaryKey?: boolean }>();
  const nameIndex = columnIndex(names, nameKey);
  const commentIndex = commentKey ? columnIndex(names, commentKey) : -1;
  const keyIndex = keyKey ? columnIndex(names, keyKey) : -1;
  if (nameIndex < 0) return columns;
  for (const row of rows) {
    const name = String(row[nameIndex] ?? "");
    if (!name) continue;
    const comment = commentIndex >= 0 ? String(row[commentIndex] ?? "").trim() : "";
    const key = keyIndex >= 0 ? String(row[keyIndex] ?? "") : "";
    const current = extras.get(name.toLowerCase()) ?? {};
    extras.set(name.toLowerCase(), {
      ...(current.comment || comment ? { comment: current.comment || comment } : {}),
      ...(current.primaryKey || key === "PRI" || key === "1" ? { primaryKey: true } : {})
    });
  }
  return columns.map((column) => {
    const extra = extras.get(column.name.toLowerCase());
    if (!extra) return column;
    return {
      ...column,
      ...(extra.comment ? { comment: extra.comment } : {}),
      ...(extra.primaryKey ? { primaryKey: true } : {})
    };
  });
};

const mapForeignKeys = (
  names: string[],
  rows: unknown[][],
  columnKey: string,
  tableKey: string,
  refKey: string
): NonNullable<DatabaseSnapshot["tables"][number]["foreignKeys"]> => {
  const columnIndexValue = columnIndex(names, columnKey);
  const tableIndex = columnIndex(names, tableKey);
  const refIndex = columnIndex(names, refKey);
  if (columnIndexValue < 0 || tableIndex < 0 || refIndex < 0) return [];
  return rows.flatMap((row) => {
    const column = String(row[columnIndexValue] ?? "");
    const refTable = String(row[tableIndex] ?? "");
    const refColumn = String(row[refIndex] ?? "");
    return column && refTable && refColumn ? [{ column, refTable, refColumn }] : [];
  });
};

const columnIndex = (names: string[], key: string): number =>
  names.findIndex((name) => name.toLowerCase() === key.toLowerCase());

const family = (dialect: string | undefined): "mysql" | "sqlite" | "postgres" => {
  const kind = (dialect ?? "").toLowerCase();
  if (["mysql", "mariadb", "tidb", "doris", "starrocks", "oceanbase"].includes(kind)) return "mysql";
  if (kind === "sqlite") return "sqlite";
  return "postgres";
};

const quoteIdent = (name: string, dialect: string | undefined): string => {
  if (family(dialect) === "mysql") return `\`${name.replace(/`/gu, "``")}\``;
  if ((dialect ?? "").toLowerCase() === "sqlserver") return `[${name.replace(/\]/gu, "]]")}]`;
  return `"${name.replace(/"/gu, "\"\"")}"`;
};

const sqlString = (value: string): string => `'${value.replace(/'/gu, "''")}'`;
