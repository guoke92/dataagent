import { estimatedContainment, serializeSketch, sketchFromValues, SKETCH_CONTAINMENT_THRESHOLD } from "./minhash.js";
import {
  columnLane,
  expandConcatCounts,
  FIELD_EXAMPLE_LIMIT,
  isEncryptedPreview,
  isLargeFieldType,
  isOpaqueValueSet,
  isParentKey,
  looksLikeAutoincrement,
  measureRelation,
  profileColumn,
  RELATION_GRAY_THRESHOLD,
  shouldSplitConcatColumn,
  skipRelationColumn,
  VALUE_PREVIEW_LIMIT,
  type ColumnProfile
} from "./relations.js";
import type {
  DatabaseColumnSnapshot,
  DatabaseForeignKey,
  DatabaseSnapshot,
  DatabaseTableSnapshot,
  SnapshotRelationMeasurement,
  WikiScanProgress
} from "./types.js";

export { AUTHORITY, authorityRank, selectAuthoritative, winningKind } from "./authority.js";
export { parseCodeFacts, parseDocumentFacts } from "./parsers.js";
export type { CodeFacts, DocumentFacts } from "./parsers.js";
export { admitColumn, columnLane, RELATION_PAGE_THRESHOLD } from "./relations.js";
export { estimatedContainment, sketchFromValues } from "./minhash.js";
export { ensureWikiSchema } from "./store.js";
export { LlmWiki } from "./wiki.js";
export type { KnowledgeRecall, ScanInput } from "./wiki.js";
export type {
  ClaimDomain,
  ColumnLane,
  DatabaseSnapshot,
  DatabaseTableSnapshot,
  GroundRecord,
  LlmClient,
  LookupHit,
  ScanMode,
  SchemaProjection,
  SourceKind,
  WikiPage,
  WikiScanProgress,
  WikiSearchHit
} from "./types.js";

export type DatabaseProbe = {
  dialect?: string;
  listTables(): Promise<DatabaseSnapshot["tables"]>;
  query(sql: string): Promise<{ columns: string[]; rows: unknown[][] }>;
};

export type CollectSnapshotOptions = {
  tableName?: string;
  columnName?: string;
  /** Tables already profiled by an interrupted scan. They are kept and not queried again. */
  seedTables?: DatabaseTableSnapshot[];
  onProgress?: (progress: WikiScanProgress) => void | Promise<void>;
  onTable?: (table: DatabaseTableSnapshot) => void | Promise<void>;
};

const SCAN_CONCURRENCY = 4;

const mapPool = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const run = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item, index);
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => run()));
  return results;
};

/** Read physical tables, profiles, business values, comments, keys, and foreign keys through a read-only probe. */
export const collectDatabaseSnapshot = async (
  probe: DatabaseProbe,
  options: CollectSnapshotOptions = {}
): Promise<DatabaseSnapshot> => {
  const listed = await probe.listTables();
  const selected = options.tableName
    ? listed.filter((table) => table.name === options.tableName)
    : listed;
  const seeds = new Map<string, DatabaseTableSnapshot>();
  if (!options.columnName) {
    for (const table of options.seedTables ?? []) {
      if (table.profiled) seeds.set(table.name, table);
    }
  }
  const already = selected.filter((table) => seeds.has(table.name)).length;
  await options.onProgress?.({
    stage: "schema",
    tableIndex: already,
    tableCount: selected.length,
    message: already > 0
      ? `继续未完成的扫描，已完成 ${already}/${selected.length} 张表`
      : `读取结构 ${selected.length} 张表`
  });
  const tables: Array<DatabaseTableSnapshot | undefined> = selected.map((table) => seeds.get(table.name));
  const profiles: ColumnProfile[] = [];
  for (const table of tables) {
    if (!table) continue;
    for (const column of table.columns) {
      profiles.push(profileFromSnapshot(table.name, column, probe.dialect));
    }
  }
  let completed = tables.filter((table) => table !== undefined).length;
  const pending = selected.flatMap((table, index) => tables[index] ? [] : [{ table, index }]);
  await mapPool(pending, SCAN_CONCURRENCY, async ({ table, index }) => {
    const columns = await enrichColumns(probe, table.columns, table.name);
    const foreignKeys = table.foreignKeys && table.foreignKeys.length > 0
      ? table.foreignKeys
      : await readForeignKeys(probe, table.name);
    const nextColumns = await mapPool(columns, SCAN_CONCURRENCY, async (column) => {
      if (options.columnName && column.name !== options.columnName) return column;
      return fillColumn(probe, table.name, column);
    });
    const next: DatabaseTableSnapshot = { name: table.name, columns: nextColumns, profiled: true };
    if (table.comment) next.comment = table.comment;
    if (foreignKeys.length > 0) next.foreignKeys = foreignKeys;
    tables[index] = next;
    for (const column of nextColumns) {
      profiles.push(profileFromSnapshot(table.name, column, probe.dialect));
    }
    completed += 1;
    await options.onProgress?.({
      stage: "table",
      table: table.name,
      tableIndex: completed,
      tableCount: selected.length,
      message: `画像 ${table.name} (${completed}/${selected.length})`
    });
    await options.onTable?.(next);
  });
  const measuredRelations = await measureSketchRelations(probe, profiles, async (relationIndex, relationCount) => {
    await options.onProgress?.({
      stage: "relations",
      tableCount: tables.length,
      relationIndex,
      relationCount,
      message: `测量字段关联 (${relationIndex}/${relationCount})`
    });
  });
  return {
    ...(probe.dialect ? { dialect: probe.dialect } : {}),
    tables: tables.filter((table): table is DatabaseTableSnapshot => table !== undefined),
    ...(measuredRelations.length > 0 ? { measuredRelations } : {})
  };
};

const fillColumn = async (
  probe: DatabaseProbe,
  table: string,
  column: DatabaseColumnSnapshot
): Promise<DatabaseColumnSnapshot> => {
  if (isLargeFieldType(column.type, probe.dialect)) {
    return { ...column, lane: "skip" };
  }
  const stats = await readColumnStats(probe, table, column.name);
  const next: DatabaseColumnSnapshot = {
    ...column,
    ...(stats ? {
      rowCount: stats.rowCount,
      cardinality: stats.cardinality,
      nullRate: stats.nullRate,
      ...(stats.min !== undefined ? { min: stats.min } : {}),
      ...(stats.max !== undefined ? { max: stats.max } : {})
    } : {})
  };
  if (!stats || stats.cardinality <= 0 || stats.nullRate >= 0.999) {
    return { ...next, lane: "skip" };
  }
  const preview = await readValuePreview(probe, table, column.name);
  if (isEncryptedPreview(preview)) {
    return {
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      ...(column.comment ? { comment: column.comment } : {}),
      ...(column.primaryKey ? { primaryKey: true } : {}),
      ...(column.unique ? { unique: true } : {}),
      ...(column.autoIncrement ? { autoIncrement: true } : {}),
      encrypted: true,
      lane: "skip",
      rowCount: stats.rowCount,
      cardinality: stats.cardinality,
      nullRate: stats.nullRate
    };
  }
  const distinctRatio = stats.rowCount === 0 ? 0 : stats.cardinality / Math.max(stats.rowCount, stats.cardinality);
  const rangeLane = columnLane({
    name: column.name,
    type: column.type,
    primaryKey: column.primaryKey === true,
    autoIncrement: column.autoIncrement === true,
    ...(probe.dialect ? { dialect: probe.dialect } : {})
  }) === "range"
    || isOpaqueValueSet(column.name, preview, stats.cardinality)
    || looksLikeAutoincrement({
      primaryKey: column.primaryKey === true,
      autoIncrement: column.autoIncrement === true,
      type: column.type,
      samples: preview,
      cardinality: stats.cardinality,
      distinctRatio
    });
  if (rangeLane) {
    const sketch = await readDistinctSketch(probe, table, column.name, preview);
    return { ...next, lane: "range", ...(sketch.length > 0 ? { sketch } : {}) };
  }
  const census = await readValueCensus(probe, table, column.name);
  const expanded = shouldSplitConcatColumn(census.map((item) => item.value))
    ? expandConcatCounts(census)
    : census;
  if (expanded.length === 0) return { ...next, lane: "skip" };
  const sketch = serializeSketch(sketchFromValues(expanded.map((item) => item.value)));
  const ranked = [...expanded].sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
  return {
    ...next,
    lane: "domain",
    samples: ranked.slice(0, FIELD_EXAMPLE_LIMIT).map((item) => item.value),
    valueCounts: expanded,
    sketch,
    cardinality: expanded.length
  };
};

const profileFromSnapshot = (table: string, column: DatabaseColumnSnapshot, dialect?: string): ColumnProfile =>
  profileColumn(
    table,
    column.name,
    column.type,
    column.nullable,
    column.comment,
    column.primaryKey === true,
    column.samples ?? [],
    column.rowCount ?? column.samples?.length ?? 0,
    {
      ...(dialect ? { dialect } : {}),
      ...(column.valueCounts ? { valueCounts: column.valueCounts } : {}),
      ...(column.unique ? { unique: true } : {}),
      ...(column.autoIncrement ? { autoIncrement: true } : {}),
      ...(column.encrypted ? { encrypted: true } : {}),
      ...(column.lane ? { lane: column.lane } : {}),
      ...(column.sketch ? { sketch: column.sketch } : {}),
      ...(column.cardinality !== undefined || column.rowCount !== undefined
        ? {
          stats: {
            rowCount: column.rowCount ?? 0,
            cardinality: column.cardinality ?? column.samples?.length ?? 0,
            nullRate: column.nullRate ?? 0,
            ...(column.min !== undefined ? { min: column.min } : {}),
            ...(column.max !== undefined ? { max: column.max } : {})
          }
        }
        : {})
    }
  );

const MAX_EXACT_PAIRS = 400;

const measureSketchRelations = async (
  probe: DatabaseProbe,
  profiles: ColumnProfile[],
  onPair?: (index: number, total: number) => void | Promise<void>
): Promise<SnapshotRelationMeasurement[]> => {
  const usable = profiles.filter((profile) => !skipRelationColumn(profile) && profile.sketch);
  const estimated: Array<{ left: ColumnProfile; right: ColumnProfile; containment: number }> = [];
  for (let index = 0; index < usable.length; index += 1) {
    const left = usable[index];
    if (!left?.sketch) continue;
    for (const right of usable.slice(index + 1)) {
      if (!right.sketch || left.table === right.table) continue;
      const leftIntoRight = estimatedContainment(left.sketch, right.sketch);
      const rightIntoLeft = estimatedContainment(right.sketch, left.sketch);
      const containment = Math.max(leftIntoRight, rightIntoLeft);
      if (containment < SKETCH_CONTAINMENT_THRESHOLD) continue;
      const childIsLeft = leftIntoRight >= rightIntoLeft;
      estimated.push(childIsLeft
        ? { left, right, containment }
        : { left: right, right: left, containment });
    }
  }
  estimated.sort((left, right) => {
    const keyDelta = Number(isParentKey(right.right)) - Number(isParentKey(left.right));
    if (keyDelta !== 0) return keyDelta;
    return right.containment - left.containment;
  });
  const pairs = estimated.slice(0, MAX_EXACT_PAIRS);
  await onPair?.(0, pairs.length);
  const measured: SnapshotRelationMeasurement[] = [];
  let finished = 0;
  await mapPool(pairs, SCAN_CONCURRENCY, async (pair) => {
    const exact = pair.left.cardinality <= 32 && pair.right.cardinality <= 32
      ? pair.containment
      : await readOverlap(probe, pair.left.table, pair.left.column, pair.right.table, pair.right.column);
    const measurement = measureRelation(pair.left, pair.right, exact);
    if (measurement && measurement.overlap >= RELATION_GRAY_THRESHOLD) {
      measured.push(measurement);
    }
    finished += 1;
    await onPair?.(finished, pairs.length);
  });
  return measured;
};

const readColumnStats = async (
  probe: DatabaseProbe,
  table: string,
  column: string
): Promise<{ rowCount: number; cardinality: number; nullRate: number; min?: string; max?: string } | undefined> => {
  const ident = quoteIdent(table, probe.dialect);
  const col = quoteIdent(column, probe.dialect);
  try {
    const result = await probe.query(
      `SELECT COUNT(*) AS n, COUNT(${col}) AS filled, COUNT(DISTINCT ${col}) AS card, MIN(${col}) AS minv, MAX(${col}) AS maxv FROM ${ident}`
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const rowCount = Number(row[columnIndex(result.columns, "n")] ?? 0);
    const filled = Number(row[columnIndex(result.columns, "filled")] ?? 0);
    const cardinality = Number(row[columnIndex(result.columns, "card")] ?? 0);
    const minIndex = columnIndex(result.columns, "minv");
    const maxIndex = columnIndex(result.columns, "maxv");
    const minValue = minIndex >= 0 && row[minIndex] !== null && row[minIndex] !== undefined ? String(row[minIndex]) : undefined;
    const maxValue = maxIndex >= 0 && row[maxIndex] !== null && row[maxIndex] !== undefined ? String(row[maxIndex]) : undefined;
    return {
      rowCount,
      cardinality,
      nullRate: rowCount === 0 ? 0 : (rowCount - filled) / rowCount,
      ...(minValue !== undefined ? { min: minValue } : {}),
      ...(maxValue !== undefined ? { max: maxValue } : {})
    };
  } catch {
    return undefined;
  }
};

const readValuePreview = async (probe: DatabaseProbe, table: string, column: string): Promise<string[]> => {
  const census = await readValueCensus(probe, table, column, VALUE_PREVIEW_LIMIT);
  return census.map((item) => item.value);
};

const readDistinctSketch = async (
  probe: DatabaseProbe,
  table: string,
  column: string,
  fallback: string[]
): Promise<number[]> => {
  const ident = quoteIdent(table, probe.dialect);
  const col = quoteIdent(column, probe.dialect);
  try {
    const result = await probe.query(`SELECT DISTINCT ${col} AS v FROM ${ident} WHERE ${col} IS NOT NULL`);
    const valueIndex = columnIndex(result.columns, "v");
    if (valueIndex < 0) return serializeSketch(sketchFromValues(fallback));
    const sketch = sketchFromValues(result.rows.flatMap((row) => {
      const value = row[valueIndex];
      if (value === null || value === undefined) return [];
      const text = String(value).trim();
      return text ? [text] : [];
    }));
    return serializeSketch(sketch);
  } catch {
    return serializeSketch(sketchFromValues(fallback));
  }
};

const readValueCensus = async (
  probe: DatabaseProbe,
  table: string,
  column: string,
  limit?: number
): Promise<Array<{ value: string; count: number }>> => {
  const ident = quoteIdent(table, probe.dialect);
  const col = quoteIdent(column, probe.dialect);
  const capped = limit ? ` LIMIT ${limit}` : "";
  try {
    const result = await probe.query(
      `SELECT ${col} AS v, COUNT(*) AS n FROM ${ident} WHERE ${col} IS NOT NULL GROUP BY ${col}${capped}`
    );
    const valueIndex = columnIndex(result.columns, "v");
    const countIndex = columnIndex(result.columns, "n");
    if (valueIndex < 0) return [];
    return result.rows.flatMap((row) => {
      const value = row[valueIndex];
      if (value === null || value === undefined) return [];
      const text = String(value).trim();
      if (!text) return [];
      const count = Number(countIndex >= 0 ? row[countIndex] : 1);
      return [{ value: text, count: Number.isFinite(count) && count > 0 ? count : 1 }];
    });
  } catch {
    return [];
  }
};

const asText = (expression: string, dialect: string | undefined): string =>
  family(dialect) === "mysql" ? `CAST(${expression} AS CHAR)` : `CAST(${expression} AS TEXT)`;

const readOverlap = async (
  probe: DatabaseProbe,
  leftTable: string,
  leftColumn: string,
  rightTable: string,
  rightColumn: string
): Promise<number> => {
  const leftIdent = quoteIdent(leftTable, probe.dialect);
  const rightIdent = quoteIdent(rightTable, probe.dialect);
  const leftCol = quoteIdent(leftColumn, probe.dialect);
  const rightCol = quoteIdent(rightColumn, probe.dialect);
  try {
    const child = await probe.query(`SELECT COUNT(DISTINCT ${asText(leftCol, probe.dialect)}) AS n FROM ${leftIdent} WHERE ${leftCol} IS NOT NULL`);
    const childCount = Number(child.rows[0]?.[columnIndex(child.columns, "n")] ?? 0);
    if (childCount === 0) return 0;
    const hits = await probe.query(
      `SELECT COUNT(*) AS n FROM (
         SELECT DISTINCT ${asText(leftCol, probe.dialect)} AS v FROM ${leftIdent} WHERE ${leftCol} IS NOT NULL
       ) a WHERE EXISTS (
         SELECT 1 FROM ${rightIdent} b
         WHERE b.${rightCol} IS NOT NULL AND ${asText(`b.${rightCol}`, probe.dialect)} = a.v
       )`
    );
    const hitCount = Number(hits.rows[0]?.[columnIndex(hits.columns, "n")] ?? 0);
    if (!Number.isFinite(hitCount) || hitCount < 0) return 0;
    return Math.min(1, hitCount / childCount);
  } catch {
    return 0;
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
        `SELECT column_name, column_comment, column_key, extra FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ${sqlString(table)}`
      );
      return mergeColumns(columns, rows.columns, rows.rows, "column_name", "column_comment", "column_key", "extra");
    }
    if (dialect === "sqlite") {
      const rows = await probe.query(`PRAGMA table_info(${quoteIdent(table, probe.dialect)})`);
      const merged = mergeColumns(columns, rows.columns, rows.rows, "name", "", "pk");
      return mergeSqliteUniques(probe, table, merged);
    }
    const described = await probe.query(
      `SELECT a.attname AS column_name, col_description(c.oid, a.attnum) AS column_comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE c.relname = ${sqlString(table)} AND n.nspname = current_schema()`
    );
    const keys = await probe.query(
      `SELECT kcu.column_name AS column_name, tc.constraint_type AS column_key
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE') AND tc.table_name = ${sqlString(table)} AND tc.table_schema = current_schema()`
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
  keyKey: string,
  extraKey = ""
): DatabaseSnapshot["tables"][number]["columns"] => {
  const extras = new Map<string, { comment?: string; primaryKey?: boolean; unique?: boolean; autoIncrement?: boolean }>();
  const nameIndex = columnIndex(names, nameKey);
  const commentIndex = commentKey ? columnIndex(names, commentKey) : -1;
  const keyIndex = keyKey ? columnIndex(names, keyKey) : -1;
  const extraIndex = extraKey ? columnIndex(names, extraKey) : -1;
  if (nameIndex < 0) return columns;
  for (const row of rows) {
    const name = String(row[nameIndex] ?? "");
    if (!name) continue;
    const comment = commentIndex >= 0 ? String(row[commentIndex] ?? "").trim() : "";
    const key = keyIndex >= 0 ? String(row[keyIndex] ?? "") : "";
    const extra = extraIndex >= 0 ? String(row[extraIndex] ?? "") : "";
    const current = extras.get(name.toLowerCase()) ?? {};
    extras.set(name.toLowerCase(), {
      ...(current.comment || comment ? { comment: current.comment || comment } : {}),
      ...(current.primaryKey || key === "PRI" || key === "PRIMARY KEY" || key === "1" ? { primaryKey: true } : {}),
      ...(current.unique || key === "UNI" || key === "UNIQUE" || key === "PRI" || key === "PRIMARY KEY" ? { unique: true } : {}),
      ...(current.autoIncrement || /auto_increment/iu.test(extra) ? { autoIncrement: true } : {})
    });
  }
  return columns.map((column) => {
    const extra = extras.get(column.name.toLowerCase());
    if (!extra) return column;
    return {
      ...column,
      ...(extra.comment ? { comment: extra.comment } : {}),
      ...(extra.primaryKey ? { primaryKey: true } : {}),
      ...(extra.unique ? { unique: true } : {}),
      ...(extra.autoIncrement ? { autoIncrement: true } : {})
    };
  });
};

const mergeSqliteUniques = async (
  probe: DatabaseProbe,
  table: string,
  columns: DatabaseSnapshot["tables"][number]["columns"]
): Promise<DatabaseSnapshot["tables"][number]["columns"]> => {
  try {
    const listed = await probe.query(`PRAGMA index_list(${quoteIdent(table, probe.dialect)})`);
    const uniqueNames = listed.rows.flatMap((row) => {
      const nameIndex = columnIndex(listed.columns, "name");
      const uniqueIndex = columnIndex(listed.columns, "unique");
      if (nameIndex < 0) return [];
      const unique = uniqueIndex >= 0 ? String(row[uniqueIndex] ?? "") : "";
      return unique === "1" || unique === "true" ? [String(row[nameIndex] ?? "")] : [];
    });
    const uniqueColumns = new Set<string>();
    for (const indexName of uniqueNames) {
      if (!indexName) continue;
      const info = await probe.query(`PRAGMA index_info(${quoteIdent(indexName, probe.dialect)})`);
      if (info.rows.length !== 1) continue;
      const nameIndex = columnIndex(info.columns, "name");
      if (nameIndex < 0) continue;
      const column = String(info.rows[0]?.[nameIndex] ?? "");
      if (column) uniqueColumns.add(column.toLowerCase());
    }
    if (uniqueColumns.size === 0) return columns;
    return columns.map((column) => uniqueColumns.has(column.name.toLowerCase()) ? { ...column, unique: true } : column);
  } catch {
    return columns;
  }
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
