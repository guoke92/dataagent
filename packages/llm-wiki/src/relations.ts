import { restoreSketch, type ValueSketch } from "./minhash.js";
import { commentAgreement, commentsContradict, nameSimilarity } from "./text.js";
import type { ColumnLane } from "./types.js";

export type { ColumnLane };

export type ColumnProfile = {
  table: string;
  column: string;
  type: string;
  nullable: boolean;
  comment?: string;
  primaryKey: boolean;
  unique: boolean;
  autoIncrement: boolean;
  encrypted: boolean;
  lane: ColumnLane;
  sketch?: ValueSketch;
  samples: string[];
  top: string[];
  frequencies: Array<{ value: string; count: number; share: number }>;
  /** Every observed value. The page and value index use this; `frequencies` stays a short summary. */
  observed: Array<{ value: string; count: number; share: number }>;
  sentinels: string[];
  cardinality: number;
  nullRate: number;
  distinctRatio: number;
  min?: string;
  max?: string;
  maxLength?: number;
  charset?: string;
  prefix?: string;
};

export type RelationMeasurement = {
  left: string;
  right: string;
  score: number;
  overlap: number;
  name: number;
  comment: number;
  keyShape: number;
  parentIsKey: boolean;
  veto: boolean;
};

export type ColumnStats = {
  rowCount: number;
  cardinality: number;
  nullRate: number;
  min?: string;
  max?: string;
};

export const RELATION_PAGE_THRESHOLD = 0.95;
export const RELATION_GRAY_THRESHOLD = 0.8;
export const FIELD_EXAMPLE_LIMIT = 8;
export const VALUE_PREVIEW_LIMIT = 24;
export const DICTIONARY_CARDINALITY_LIMIT = 32;

const MYSQL_FAMILY = new Set(["mysql", "mariadb", "tidb", "doris", "starrocks", "oceanbase"]);

export const isLargeFieldType = (type: string, dialect?: string): boolean => {
  const normalized = type.toLowerCase().replace(/\(.*/u, "").trim();
  if (/^(?:tiny|medium|long)text$|^clob$|^jsonb?$|^blob$|^longblob$|^mediumblob$|^bytea$|^binary$|^varbinary$|^array$/u.test(normalized)) {
    return true;
  }
  if (normalized === "text" && MYSQL_FAMILY.has((dialect ?? "").toLowerCase())) {
    return true;
  }
  return false;
};

export const isRemarkColumn = (column: string): boolean =>
  /^(?:remark|comment|description|memo|note|content|msg|message|log|payload|detail|details|extra|ext)$/iu.test(column)
  || /(?:^|_)(?:remark|comment|desc|memo|note|content|msg|message|log|payload|detail)s?$/iu.test(column);

export const isPathColumn = (column: string): boolean =>
  /(?:^|_)(?:path|url|uri|href|link|file|logo|icon|dir|folder)s?$/iu.test(column);

export const isTemporalColumn = (profile: Pick<ColumnProfile, "column" | "type">): boolean =>
  /date|time|timestamp|datetime/iu.test(profile.type) || /(?:^|_)(?:date|time|datetime|timestamp)s?$/iu.test(profile.column) || /(?:^|_)(?:at|on)$/iu.test(profile.column);

export const isIdentifierColumn = (profile: Pick<ColumnProfile, "column" | "primaryKey">): boolean =>
  profile.primaryKey === true || /(^|_)id$/iu.test(profile.column);

export const isAuditActorColumn = (column: string): boolean =>
  /^(?:create|update|created|updated|modify|modified|delete|deleted)_(?:by|user)$/iu.test(column)
  || /(?:^|_)(?:creator|updater|modifier)$/iu.test(column);

export const isMeasureColumn = (profile: Pick<ColumnProfile, "column" | "type">): boolean =>
  /amount|price|qty|quantity|rate|gmv|margin|cost|spend|revenue/iu.test(profile.column)
  || (/int|real|float|double|numeric|decimal|number/iu.test(profile.type) && !/status|channel|type|flag|category|city/iu.test(profile.column));

/** Lane from type and flags only. Probe may later move domain → range (opaque id) or skip (encrypted). */
export const columnLane = (input: {
  name: string;
  type: string;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  encrypted?: boolean;
  dialect?: string;
}): ColumnLane => {
  if (input.encrypted) return "skip";
  if (isLargeFieldType(input.type, input.dialect)) return "skip";
  if (input.autoIncrement) return "range";
  if (isTemporalColumn({ column: input.name, type: input.type })) return "range";
  return "domain";
};

/** @deprecated Use columnLane. Kept so older call sites compile during the cutover. */
export const admitColumn = (input: {
  name: string;
  type: string;
  primaryKey?: boolean;
  dialect?: string;
  autoIncrement?: boolean;
  encrypted?: boolean;
}): ColumnLane => columnLane(input);

export const profileColumn = (
  table: string,
  column: string,
  type: string,
  nullable: boolean,
  comment: string | undefined,
  primaryKey: boolean,
  samples: string[],
  rowCount: number,
  extras?: {
    dialect?: string;
    stats?: ColumnStats;
    valueCounts?: Array<{ value: string; count: number }>;
    unique?: boolean;
    autoIncrement?: boolean;
    encrypted?: boolean;
    lane?: ColumnLane;
    sketch?: number[];
  }
): ColumnProfile => {
  const counts = new Map<string, number>();
  if (extras?.valueCounts && extras.valueCounts.length > 0) {
    for (const item of extras.valueCounts) {
      const value = item.value.trim();
      if (!value || item.count <= 0) continue;
      counts.set(value, (counts.get(value) ?? 0) + item.count);
    }
  } else {
    for (const sample of samples) {
      const value = sample.trim();
      if (!value) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  const unique = [...counts.keys()];
  const stats = extras?.stats;
  const cardinality = stats?.cardinality ?? unique.length;
  const counted = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const total = counted || 1;
  const observed = allFrequencies(counts, total);
  const frequencies = observed.slice(0, FIELD_EXAMPLE_LIMIT);
  const top = frequencies.map((item) => item.value);
  const numeric = unique.length > 0 && unique.every((value) => /^-?\d+(?:\.\d+)?$/u.test(value));
  const bounds = valueBounds(unique, numeric);
  const charset = charsetOf(unique);
  const prefix = commonPrefix(unique);
  const minValue = stats?.min ?? bounds.min;
  const maxValue = stats?.max ?? bounds.max;
  const encrypted = extras?.encrypted === true;
  const autoIncrement = extras?.autoIncrement === true;
  const lane = extras?.lane ?? columnLane({
    name: column,
    type,
    primaryKey,
    autoIncrement,
    encrypted,
    ...(extras?.dialect ? { dialect: extras.dialect } : {})
  });
  const sketch = restoreSketch(extras?.sketch);
  const profile: ColumnProfile = {
    table,
    column,
    type,
    nullable,
    ...(comment ? { comment } : {}),
    primaryKey,
    unique: extras?.unique === true || primaryKey,
    autoIncrement,
    encrypted,
    lane,
    samples: unique,
    top,
    frequencies,
    observed,
    sentinels: top.filter((value) => SENTINEL.test(value)),
    cardinality,
    nullRate: stats?.nullRate ?? 0,
    distinctRatio: rowCount === 0 ? 0 : cardinality / Math.max(rowCount, cardinality)
  };
  if (sketch) profile.sketch = sketch;
  if (minValue !== undefined && !encrypted) profile.min = minValue;
  if (maxValue !== undefined && !encrypted) profile.max = maxValue;
  if (unique.length > 0) profile.maxLength = maxTextLength(unique);
  if (charset) profile.charset = charset;
  if (prefix) profile.prefix = prefix;
  return profile;
};

export const formatProfile = (profile: ColumnProfile): string => {
  const parts = [
    `lane=${profile.lane}`,
    profile.encrypted ? "encrypted=true" : "",
    `cardinality=${profile.cardinality}`,
    `nullRate=${profile.nullRate.toFixed(3)}`,
    profile.min !== undefined ? `min=${profile.min}` : "",
    profile.max !== undefined ? `max=${profile.max}` : "",
    profile.maxLength !== undefined ? `maxLength=${profile.maxLength}` : "",
    profile.charset ? `charset=${profile.charset}` : "",
    profile.prefix ? `prefix=${profile.prefix}` : "",
    profile.top.length > 0 ? `top=${profile.top.join("|")}` : "",
    profile.sentinels.length > 0 ? `sentinels=${profile.sentinels.join("|")}` : ""
  ].filter((part) => part.length > 0);
  return parts.join(" ");
};

const DICTIONARY_NAME = /(?:^|_)(?:enable|enabled|status|state|flag|mode|type|kind|category|level|gender|yn|switch)$/iu;
const DICTIONARY_COMMENT = /是否|状态|类型|枚举|开关|字典/u;

export const isClosedDictionary = (profile: ColumnProfile): boolean => {
  if (!shouldPublishValueDomain(profile)) return false;
  if (profile.cardinality > DICTIONARY_CARDINALITY_LIMIT) return false;
  if (DICTIONARY_NAME.test(profile.column) || /^(?:is|has|can)_[a-z0-9_]+$/iu.test(profile.column)) return true;
  if (DICTIONARY_COMMENT.test(profile.comment ?? "")) return true;
  if (parseCommentCodes(profile.comment ?? "").length >= 2) return true;
  if (profile.samples.every((value) => /^(?:y|n|yes|no|true|false|0|1|on|off)$/iu.test(value))) return true;
  return profile.cardinality <= 8 && profile.samples.every((value) => value.length <= 8 && /^[A-Za-z0-9_-]+$/u.test(value));
};

export const isDictionaryCandidate = (profile: ColumnProfile): boolean =>
  isClosedDictionary(profile);

export const shouldPublishValueDomain = (profile: ColumnProfile): boolean => {
  if (profile.encrypted || profile.lane !== "domain") return false;
  if (profile.samples.length === 0 || profile.cardinality <= 0) return false;
  if (profile.nullRate >= 0.999) return false;
  return true;
};

export const isOpaqueToken = (value: string): boolean => {
  const text = value.trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(text)) return true;
  if (/^[0-9a-f]{32,}$/iu.test(text)) return true;
  if (/^\d{15,20}$/u.test(text)) return true;
  return false;
};

export const isOpaqueValueSet = (column: string, values: string[], cardinality: number): boolean => {
  const present = values.map((value) => value.trim()).filter((value) => value.length > 0);
  if (present.length === 0) return false;
  const opaque = present.filter((value) => isOpaqueToken(value)).length / present.length;
  if (opaque >= 0.8) return true;
  return cardinality >= 50
    && /(?:^|_)(?:code|no|uuid|token|key|sn)$/iu.test(column)
    && opaque >= 0.5;
};

export const isEncryptedPreview = (values: string[]): boolean => {
  const present = values.map((value) => value.trim()).filter((value) => value.length > 0);
  if (present.length === 0) return false;
  if (present.some((value) => /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/u.test(value) || /^\$2[aby]\$/u.test(value))) {
    return true;
  }
  const avg = present.reduce((sum, value) => sum + value.length, 0) / present.length;
  if (avg < 24) return false;
  const entropy = charsetEntropy(present);
  const opaque = present.filter((value) => isOpaqueToken(value) || /^[A-Za-z0-9+/=]{32,}$/u.test(value)).length / present.length;
  return entropy >= 4.5 && (opaque >= 0.8 || avg >= 40);
};

export const looksLikeAutoincrement = (profile: {
  primaryKey: boolean;
  autoIncrement: boolean;
  type: string;
  samples: string[];
  cardinality: number;
  distinctRatio: number;
}): boolean => {
  if (profile.autoIncrement) return true;
  if (!profile.primaryKey || !/int|serial|number/iu.test(profile.type)) return false;
  if (profile.samples.length === 0) return profile.distinctRatio >= 0.98;
  return profile.samples.every((value) => /^\d{1,14}$/u.test(value)) && profile.distinctRatio >= 0.98;
};

export const splitConcatValue = (value: string): string[] | undefined => {
  const text = value.trim();
  if (!text) return undefined;
  const jsonish = text.startsWith("[") && text.endsWith("]");
  if (jsonish) {
    try {
      const parsed = JSON.parse(text.replace(/'/gu, "\"")) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string" && item.length <= 48)) {
        const parts = parsed.map((item) => String(item).trim()).filter((item) => item.length > 0);
        return parts.length > 0 ? parts : undefined;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
};

export const shouldSplitConcatColumn = (values: string[]): boolean => {
  const sample = values.slice(0, VALUE_PREVIEW_LIMIT);
  if (sample.length === 0) return false;
  const avg = sample.reduce((sum, value) => sum + value.length, 0) / sample.length;
  if (avg > 80) return false;
  const hits = sample.filter((value) => splitConcatValue(value)).length;
  return hits / sample.length >= 0.5;
};

export const expandConcatCounts = (
  counts: Array<{ value: string; count: number }>
): Array<{ value: string; count: number }> => {
  const merged = new Map<string, number>();
  for (const item of counts) {
    const parts = splitConcatValue(item.value) ?? [item.value];
    for (const part of parts) {
      merged.set(part, (merged.get(part) ?? 0) + item.count);
    }
  }
  return [...merged.entries()].map(([value, count]) => ({ value, count }));
};

export const parseCommentCodes = (comment: string): Array<{ value: string; label: string }> => {
  const text = comment.trim();
  if (!text) return [];
  const found: Array<{ value: string; label: string }> = [];
  const pair = /([A-Za-z0-9_-]{1,16})\s*[-:：=]\s*([^\s,;，；|/]+)/gu;
  for (const match of text.matchAll(pair)) {
    const value = match[1]?.trim();
    const label = match[2]?.trim();
    if (value && label && value !== label) found.push({ value, label });
  }
  const unique = new Map(found.map((item) => [item.value, item]));
  return [...unique.values()];
};

export const skipRelationColumn = (profile: ColumnProfile): boolean => {
  if (profile.lane === "skip" || profile.encrypted) return true;
  if (isTemporalColumn(profile)) return true;
  return false;
};

export const isParentKey = (profile: ColumnProfile): boolean =>
  profile.primaryKey
  || profile.unique
  || (profile.distinctRatio >= 0.98 && profile.nullRate <= 0.05 && profile.cardinality >= 8);

export const isClosedCodeDomain = (values: string[]): boolean => {
  if (values.length < 2 || values.length > DICTIONARY_CARDINALITY_LIMIT) return false;
  if (!values.every((value) => /^[A-Za-z0-9_.:-]{1,16}$/u.test(value.trim()))) return false;
  const allNumeric = values.every((value) => /^\d+$/u.test(value.trim()));
  return allNumeric ? values.length <= 12 : true;
};

export const isProseColumn = (name: string): boolean =>
  /name|title|remark|comment|desc|addr|address|memo|text|content/iu.test(name);

export const bothLowCardinality = (left: ColumnProfile, right: ColumnProfile): boolean =>
  left.cardinality <= DICTIONARY_CARDINALITY_LIMIT && right.cardinality <= DICTIONARY_CARDINALITY_LIMIT && !isParentKey(left) && !isParentKey(right);

export const measureRelation = (
  left: ColumnProfile,
  right: ColumnProfile,
  overlapOverride?: number
): RelationMeasurement | undefined => {
  if (left.table === right.table) return undefined;
  if (skipRelationColumn(left) || skipRelationColumn(right)) return undefined;
  const name = nameSimilarity(left.column, right.column);
  const rawOverlap = overlapOverride ?? directedOverlap(left, right);
  const overlap = Number.isFinite(rawOverlap) ? Math.min(1, Math.max(0, rawOverlap)) : 0;
  if (commentsContradict(left.comment, right.comment)) {
    return {
      left: `${left.table}.${left.column}`,
      right: `${right.table}.${right.column}`,
      score: 0,
      overlap,
      name,
      comment: 0,
      keyShape: 0,
      parentIsKey: false,
      veto: true
    };
  }
  const comment = commentAgreement(left.comment, right.comment, left.column, right.column);
  const keyShape = keyShapeScore(left, right);
  const parentIsKey = isParentKey(right) || isParentKey(left);
  const veto = bothLowCardinality(left, right);
  const score = overlap;
  return {
    left: `${left.table}.${left.column}`,
    right: `${right.table}.${right.column}`,
    score,
    overlap,
    name,
    comment,
    keyShape,
    parentIsKey,
    veto
  };
};

const directedOverlap = (left: ColumnProfile, right: ColumnProfile): number => {
  const intoRight = containment(left.samples, right.samples);
  const intoLeft = containment(right.samples, left.samples);
  const rightKey = keyWeight(right);
  const leftKey = keyWeight(left);
  return rightKey >= leftKey ? intoRight * rightKey : intoLeft * leftKey;
};

const containment = (child: string[], parent: string[]): number => {
  if (child.length === 0 || parent.length === 0) return 0;
  const parentSet = new Set(parent.map((value) => value.toLowerCase()));
  const hits = child.filter((value) => parentSet.has(value.toLowerCase())).length;
  return hits / child.length;
};

const keyWeight = (profile: ColumnProfile): number => {
  if (isParentKey(profile)) return 1;
  if (profile.distinctRatio >= 0.8 && profile.nullRate <= 0.05) return 0.7;
  return 0.35;
};

const keyShapeScore = (left: ColumnProfile, right: ColumnProfile): number => {
  const leftKey = isParentKey(left);
  const rightKey = isParentKey(right);
  if (leftKey !== rightKey) return 1;
  if (leftKey && rightKey) return 0.6;
  return 0.2;
};

const SENTINEL = /^(?:n\/?a|null|none|unknown|undefined|--?|0+|123-456-7890|1234567890)$/iu;

const allFrequencies = (
  counts: Map<string, number>,
  total: number
): Array<{ value: string; count: number; share: number }> =>
  [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([value, count]) => ({ value, count, share: count / total }));

const valueBounds = (values: string[], numeric: boolean): { min?: string; max?: string } => {
  let min: string | undefined;
  let max: string | undefined;
  for (const value of values) {
    if (min === undefined || compareValues(value, min, numeric) < 0) min = value;
    if (max === undefined || compareValues(value, max, numeric) > 0) max = value;
  }
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
};

const compareValues = (left: string, right: string, numeric: boolean): number =>
  numeric ? Number(left) - Number(right) : left.localeCompare(right);

const maxTextLength = (values: string[]): number => {
  let max = 0;
  for (const value of values) {
    if (value.length > max) max = value.length;
  }
  return max;
};

const charsetOf = (values: string[]): string | undefined => {
  if (values.length === 0) return undefined;
  if (values.every((value) => /^\d+$/u.test(value))) return "digit";
  if (values.some((value) => /[\u4e00-\u9fff]/u.test(value))) return "cjk";
  if (values.every((value) => /^[\u0000-\u007f]+$/u.test(value))) return "ascii";
  return "mixed";
};

const charsetEntropy = (values: string[]): number => {
  const counts = new Map<string, number>();
  let total = 0;
  for (const value of values) {
    for (const char of value) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
      total += 1;
    }
  }
  if (total === 0) return 0;
  let entropy = 0;
  for (const count of counts.values()) {
    const share = count / total;
    entropy -= share * Math.log2(share);
  }
  return entropy;
};

const commonPrefix = (values: string[]): string | undefined => {
  const first = values[0];
  if (!first || values.length < 2) return undefined;
  let prefix = first;
  for (const value of values.slice(1)) {
    while (prefix && !value.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix.length >= 2 ? prefix : undefined;
};

export const columnSamples = (
  column: string,
  explicit: string[] | undefined,
  rows: Array<Record<string, unknown>> | undefined
): string[] => {
  const raw = explicit && explicit.length > 0
    ? explicit.map(String)
    : (rows ?? [])
      .map((row) => row[column])
      .filter((value) => value !== undefined && value !== null)
      .map(String);
  return raw;
};
