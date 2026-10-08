import { commentAgreement, commentsContradict, nameSimilarity } from "./text.js";

export type ColumnProfile = {
  table: string;
  column: string;
  type: string;
  nullable: boolean;
  comment?: string;
  primaryKey: boolean;
  samples: string[];
  top: string[];
  frequencies: Array<{ value: string; count: number; share: number }>;
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

const LOW_CARDINALITY = 50;

export const profileColumn = (
  table: string,
  column: string,
  type: string,
  nullable: boolean,
  comment: string | undefined,
  primaryKey: boolean,
  samples: string[],
  rowCount: number
): ColumnProfile => {
  const values = samples.map((sample) => sample.trim()).filter((sample) => sample.length > 0);
  const counts = new Map<string, number>();
  for (const value of values) {
    if (counts.size >= 10000 && !counts.has(value)) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const unique = [...counts.keys()];
  const cardinality = unique.length;
  const empty = samples.length - values.length;
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  const total = values.length || 1;
  const frequencies = ranked.slice(0, 8).map(([value, count]) => ({ value, count, share: count / total }));
  const top = frequencies.map((item) => item.value);
  const numeric = unique.every((value) => /^-?\d+(?:\.\d+)?$/u.test(value));
  const ordered = numeric
    ? [...unique].sort((left, right) => Number(left) - Number(right))
    : [...unique].sort((left, right) => left.localeCompare(right));
  const charset = charsetOf(unique);
  const prefix = commonPrefix(unique);
  const minValue = ordered[0];
  const maxValue = ordered.length > 0 ? ordered[ordered.length - 1] : undefined;
  const profile: ColumnProfile = {
    table,
    column,
    type,
    nullable,
    ...(comment ? { comment } : {}),
    primaryKey,
    samples: unique.slice(0, 2000),
    top,
    frequencies,
    sentinels: top.filter((value) => SENTINEL.test(value)),
    cardinality,
    nullRate: samples.length === 0 ? 0 : empty / samples.length,
    distinctRatio: rowCount === 0 ? 0 : cardinality / Math.max(rowCount, cardinality)
  };
  if (minValue !== undefined) profile.min = minValue;
  if (maxValue !== undefined) profile.max = maxValue;
  if (unique.length > 0) profile.maxLength = Math.max(...unique.map((value) => value.length));
  if (charset) profile.charset = charset;
  if (prefix) profile.prefix = prefix;
  return profile;
};

export const formatProfile = (profile: ColumnProfile): string => {
  const parts = [
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

export const isClosedEnum = (profile: ColumnProfile): boolean =>
  profile.cardinality > 0 && profile.cardinality <= LOW_CARDINALITY && profile.distinctRatio <= 0.2;

export const isTemporalColumn = (profile: ColumnProfile): boolean =>
  /date|time|timestamp/iu.test(profile.type) || /date|time|(^|_)at$/iu.test(profile.column);

export const isIdentifierColumn = (profile: ColumnProfile): boolean =>
  profile.primaryKey || /(^|_)id$/iu.test(profile.column);

export const isMeasureColumn = (profile: ColumnProfile): boolean =>
  /amount|price|qty|quantity|rate|gmv|margin|cost|spend|revenue/iu.test(profile.column)
  || (/int|real|float|double|numeric|decimal|number/iu.test(profile.type) && !/status|channel|type|flag|category|city/iu.test(profile.column));

export const isDictionaryCandidate = (profile: ColumnProfile): boolean =>
  profile.cardinality >= 2
  && profile.cardinality <= 30
  && !isTemporalColumn(profile)
  && !isIdentifierColumn(profile)
  && !isMeasureColumn(profile)
  && !profile.type.toLowerCase().includes("bool");

export const skipRelationColumn = (profile: ColumnProfile): boolean => {
  const name = profile.column.toLowerCase();
  const values = new Set(profile.samples);
  if (isTemporalColumn(profile) || isDictionaryCandidate(profile)) return true;
  if (profile.type.toLowerCase().includes("bool")) return true;
  if (values.size > 0 && values.size <= 3 && [...values].every((value) => /^(0|1|2|true|false|y|n)$/iu.test(value))) {
    return true;
  }
  if (/year|status|flag|bool/u.test(name) && profile.cardinality <= 12) return true;
  return false;
};

export const measureRelation = (left: ColumnProfile, right: ColumnProfile): RelationMeasurement | undefined => {
  if (left.table === right.table) return undefined;
  if (skipRelationColumn(left) || skipRelationColumn(right)) return undefined;
  const name = nameSimilarity(left.column, right.column);
  const overlap = directedOverlap(left, right);
  if (name < 0.72 && overlap < 0.6) return undefined;
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
  const parentIsKey = keyLike(right) || keyLike(left);
  const score = overlap * 0.45 + name * 0.25 + comment * 0.15 + keyShape * 0.15;
  return {
    left: `${left.table}.${left.column}`,
    right: `${right.table}.${right.column}`,
    score,
    overlap,
    name,
    comment,
    keyShape,
    parentIsKey,
    veto: false
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

const keyLike = (profile: ColumnProfile): boolean =>
  profile.primaryKey || (profile.distinctRatio >= 0.8 && profile.nullRate <= 0.05);

const keyWeight = (profile: ColumnProfile): number => {
  if (profile.primaryKey || (profile.distinctRatio >= 0.95 && profile.nullRate <= 0.01)) return 1;
  if (profile.distinctRatio >= 0.8 && profile.nullRate <= 0.05) return 0.7;
  return 0.35;
};

const keyShapeScore = (left: ColumnProfile, right: ColumnProfile): number => {
  const leftKey = keyLike(left);
  const rightKey = keyLike(right);
  if (leftKey !== rightKey) return 1;
  if (leftKey && rightKey) return 0.6;
  return 0.2;
};

const SENTINEL = /^(?:n\/?a|null|none|unknown|undefined|--?|0+|123-456-7890|1234567890)$/iu;

const charsetOf = (values: string[]): string | undefined => {
  if (values.length === 0) return undefined;
  if (values.every((value) => /^\d+$/u.test(value))) return "digit";
  if (values.some((value) => /[\u4e00-\u9fff]/u.test(value))) return "cjk";
  if (values.every((value) => /^[\u0000-\u007f]+$/u.test(value))) return "ascii";
  return "mixed";
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
  return raw.slice(0, 10000);
};
