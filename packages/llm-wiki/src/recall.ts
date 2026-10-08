import {
  isDictionaryCandidate,
  isIdentifierColumn,
  isMeasureColumn,
  isTemporalColumn,
  type ColumnProfile
} from "./relations.js";
import type { PageStatus, WikiField } from "./types.js";

export type ColumnRole = "identifier" | "temporal" | "measure" | "dictionary" | "attribute";

export type ColumnRecord = {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  comment?: string;
  label: string;
  labelStatus: PageStatus;
  role: ColumnRole;
  cardinality: number;
  nullRate: number;
  min?: string;
  max?: string;
  maxLength?: number;
  charset?: string;
  frequencies: Array<{ value: string; count: number; share: number }>;
  sentinels: string[];
};

export type SchemaRecall = {
  label?: string;
  examples?: string[];
  labels?: string[];
  range?: string;
};

/** Drop Wiki navigation lines so they are not treated as dictionary values. */
export const stripStructuralLinkLines = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !/^(所属列|所属表|列|表|关联|相关)\s+\[\[/u.test(line.trim()))
    .join("\n")
    .trim();

/**
 * Parse clean dictionary labels from a value-domain body or dictionary field.
 * Accepts `values: a, b`, frequency rows, and `value = label × n` lines.
 * Never returns wikilink / navigation noise.
 */
export const parseDictionaryLabels = (raw: string): string[] | undefined => {
  const clean = stripStructuralLinkLines(raw);
  if (!clean) return undefined;
  const valuesLine = clean.split("\n").find((line) => /^\s*values:/iu.test(line));
  if (valuesLine) {
    const labels = valuesLine
      .replace(/^\s*values:\s*/iu, "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0 && !item.includes("[["));
    return labels.length > 0 ? labels.slice(0, 50) : undefined;
  }
  const labels: string[] = [];
  for (const line of clean.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.includes("[[")) continue;
    if (trimmed.includes("\t")) {
      const value = trimmed.split("\t")[0]?.trim();
      if (value) labels.push(value);
      continue;
    }
    const freq = /^([^=×\n]+?)(?:\s*=\s*([^×\n]+?))?\s*×/u.exec(trimmed);
    if (freq?.[1]) {
      const value = freq[1].trim();
      const label = freq[2]?.trim();
      labels.push(label && label !== value ? `${value} = ${label}` : value);
      continue;
    }
    const eq = /^([^=\n]+?)\s*=\s*(.+)$/u.exec(trimmed);
    if (eq?.[1] && eq[2] && !eq[2].includes("×")) {
      const value = eq[1].trim();
      const label = eq[2].trim();
      labels.push(label && label !== value ? `${value} = ${label}` : value);
    }
  }
  return labels.length > 0 ? [...new Set(labels)].slice(0, 50) : undefined;
};

type ColumnMeta = Partial<ColumnRecord> & {
  frequencies?: ColumnRecord["frequencies"];
  sentinels?: string[];
};

export const columnRole = (profile: ColumnProfile): ColumnRole => {
  if (isIdentifierColumn(profile)) return "identifier";
  if (isTemporalColumn(profile)) return "temporal";
  if (isMeasureColumn(profile)) return "measure";
  if (isDictionaryCandidate(profile)) return "dictionary";
  return "attribute";
};

export const columnFieldFromProfile = (profile: ColumnProfile, label: string, status: PageStatus): WikiField => ({
  key: profile.column,
  text: label,
  status,
  meta: JSON.stringify(metaOf(profile, label, status))
});

export const readColumnFields = (fields: WikiField[] | undefined): ColumnRecord[] =>
  unifyColumnFields(fields ?? []).flatMap((field) => {
    const record = readColumnField(field);
    return record ? [record] : [];
  });

export const unifyColumnFields = (fields: WikiField[]): WikiField[] => {
  if (!fields.some((field) => field.key.includes(":"))) return fields.filter((field) => !field.key.includes(":"));
  const names = [...new Set(fields.flatMap((field) => {
    const name = field.key.split(":")[0];
    return name ? [name] : [];
  }))];
  return names.flatMap((name) => {
    const related = fields.filter((field) => field.key === name || field.key.startsWith(`${name}:`));
    const record = recordFromLegacy(name, related);
    return record ? [fieldFromRecord(record)] : [];
  });
};

export const columnInfoText = (record: ColumnRecord): string => {
  const frequent = record.frequencies
    .map((item) => `${item.value} ${item.count}（${Math.round(item.share * 100)}%）`)
    .join("、");
  return [
    `## ${record.name}`,
    `type: ${record.type}`,
    `nullable: ${record.nullable}`,
    record.primaryKey ? "primary_key: true" : "",
    record.comment ? `comment: ${record.comment}` : "",
    record.label && record.label !== record.comment ? `label: ${record.label}` : "",
    `基数 ${record.cardinality}`,
    `空值率 ${(record.nullRate * 100).toFixed(1)}%`,
    record.min !== undefined && record.max !== undefined ? `范围 ${record.min} 到 ${record.max}` : "",
    record.maxLength !== undefined ? `最长 ${record.maxLength}` : "",
    record.charset ? `字符集 ${record.charset}` : "",
    frequent ? `高频值 ${frequent}` : "",
    record.sentinels.length > 0 ? `占位值 ${record.sentinels.join("、")}` : ""
  ].filter((line) => line.length > 0).join("\n");
};

export const recallForSchema = (record: ColumnRecord, dictionaryLabels?: string[]): SchemaRecall => {
  const label = record.label || record.comment;
  const range = record.min !== undefined && record.max !== undefined ? `${record.min} 到 ${record.max}` : undefined;
  const recalled: SchemaRecall = {};
  if (label) recalled.label = label;
  if (record.role === "dictionary") {
    if (dictionaryLabels && dictionaryLabels.length > 0) recalled.labels = dictionaryLabels;
    return recalled;
  }
  if (record.role === "measure" || record.role === "temporal") {
    if (range) recalled.range = range;
    return recalled;
  }
  if (record.role === "attribute") {
    const examples = record.frequencies.slice(0, 3).map((item) => item.value);
    if (examples.length > 0) recalled.examples = examples;
  }
  return recalled;
};

export const recallForKnowledge = (record: ColumnRecord, dictionaryLabels?: string[]): string => {
  const label = record.label || record.comment || "";
  const range = record.min !== undefined && record.max !== undefined ? `范围 ${record.min} 到 ${record.max}` : "";
  if (record.role === "identifier") return [record.name, record.type, label].filter(Boolean).join(" ");
  if (record.role === "temporal") return [record.name, record.type, range].filter(Boolean).join(" ");
  if (record.role === "measure") {
    return [record.name, label, range, `空值率 ${(record.nullRate * 100).toFixed(1)}%`].filter(Boolean).join(" ");
  }
  if (record.role === "dictionary") {
    const values = dictionaryLabels && dictionaryLabels.length > 0
      ? dictionaryLabels.slice(0, 12).join("；")
      : record.frequencies.map((item) => item.value).join("、");
    return [record.name, label, values].filter(Boolean).join(" ");
  }
  const frequent = record.frequencies.slice(0, 5).map((item) => item.value).join("、");
  return [record.name, label, `基数 ${record.cardinality}`, frequent ? `高频值 ${frequent}` : ""].filter(Boolean).join(" ");
};

export const knowledgeExcerpt = (records: ColumnRecord[], query: string, dictionaryLabels: (record: ColumnRecord) => string[] | undefined): string => {
  const needle = query.trim().toLowerCase();
  const matched = records.filter((record) => columnInfoText(record).toLowerCase().includes(needle));
  const chosen = matched.length > 0 ? matched : records.slice(0, 4);
  return chosen.map((record) => {
    const knowledge = recallForKnowledge(record, dictionaryLabels(record));
    if (needle && knowledge.toLowerCase().includes(needle)) return knowledge;
    const facts = columnInfoText(record).split("\n").filter((line) => line.toLowerCase().includes(needle));
    return [knowledge, ...facts].filter(Boolean).join(" ");
  }).join("\n").slice(0, 280);
};

const fieldFromRecord = (record: ColumnRecord): WikiField => ({
  key: record.name,
  text: record.label,
  status: record.labelStatus,
  meta: JSON.stringify({
    type: record.type,
    nullable: record.nullable,
    primaryKey: record.primaryKey,
    ...(record.comment ? { comment: record.comment } : {}),
    role: record.role,
    cardinality: record.cardinality,
    nullRate: record.nullRate,
    ...(record.min !== undefined ? { min: record.min } : {}),
    ...(record.max !== undefined ? { max: record.max } : {}),
    ...(record.maxLength !== undefined ? { maxLength: record.maxLength } : {}),
    ...(record.charset ? { charset: record.charset } : {}),
    frequencies: record.frequencies,
    sentinels: record.sentinels
  })
});

const metaOf = (profile: ColumnProfile, label: string, status: PageStatus): ColumnMeta => ({
  type: profile.type,
  nullable: profile.nullable,
  primaryKey: profile.primaryKey,
  ...(profile.comment ? { comment: profile.comment } : {}),
  label,
  labelStatus: status,
  role: columnRole(profile),
  cardinality: profile.cardinality,
  nullRate: profile.nullRate,
  ...(profile.min !== undefined ? { min: profile.min } : {}),
  ...(profile.max !== undefined ? { max: profile.max } : {}),
  ...(profile.maxLength !== undefined ? { maxLength: profile.maxLength } : {}),
  ...(profile.charset ? { charset: profile.charset } : {}),
  frequencies: profile.frequencies,
  sentinels: profile.sentinels
});

const readColumnField = (field: WikiField): ColumnRecord | undefined => {
  if (field.key.includes(":")) return undefined;
  const meta = parseMeta(field.meta);
  const type = typeof meta.type === "string" ? meta.type : "unknown";
  const record: ColumnRecord = {
    name: field.key,
    type,
    nullable: meta.nullable === true,
    primaryKey: meta.primaryKey === true,
    label: field.text.trim(),
    labelStatus: field.status,
    role: isRole(meta.role) ? meta.role : "attribute",
    cardinality: typeof meta.cardinality === "number" ? meta.cardinality : 0,
    nullRate: typeof meta.nullRate === "number" ? meta.nullRate : 0,
    frequencies: Array.isArray(meta.frequencies) ? meta.frequencies : [],
    sentinels: Array.isArray(meta.sentinels) ? meta.sentinels : []
  };
  if (typeof meta.comment === "string" && meta.comment.length > 0) record.comment = meta.comment;
  if (typeof meta.min === "string") record.min = meta.min;
  if (typeof meta.max === "string") record.max = meta.max;
  if (typeof meta.maxLength === "number") record.maxLength = meta.maxLength;
  if (typeof meta.charset === "string") record.charset = meta.charset;
  if (!isRole(meta.role)) record.role = roleFromRecord(record);
  return record;
};

const recordFromLegacy = (name: string, fields: WikiField[]): ColumnRecord | undefined => {
  const direct = fields.find((field) => field.key === name);
  if (direct && !fields.some((field) => field.key.startsWith(`${name}:`))) return readColumnField(direct);
  const short = fields.find((field) => field.key === `${name}:short`);
  const profileField = fields.find((field) => field.key === `${name}:profile`);
  const profileMeta = parseMeta(profileField?.meta);
  const parsed = parseFormatProfile(profileField?.text ?? "");
  const type = typeof profileMeta.type === "string" ? profileMeta.type : "unknown";
  const nullable = profileMeta.nullable === true;
  const label = short?.text.trim() && !/nullable|非空|TEXT|INTEGER|REAL|类型/u.test(short.text) ? short.text.trim() : "";
  const record: ColumnRecord = {
    name,
    type,
    nullable,
    primaryKey: false,
    label,
    labelStatus: short?.status ?? profileField?.status ?? "pending",
    role: "attribute",
    cardinality: parsed.cardinality ?? 0,
    nullRate: parsed.nullRate ?? 0,
    frequencies: [],
    sentinels: parsed.sentinels ?? []
  };
  if (label) record.comment = label;
  if (parsed.min) record.min = parsed.min;
  if (parsed.max) record.max = parsed.max;
  if (parsed.maxLength !== undefined) record.maxLength = parsed.maxLength;
  if (parsed.charset) record.charset = parsed.charset;
  record.role = roleFromRecord(record);
  return record;
};

const roleFromRecord = (record: ColumnRecord): ColumnRole => columnRole({
  table: "",
  column: record.name,
  type: record.type,
  nullable: record.nullable,
  primaryKey: record.primaryKey,
  samples: record.frequencies.map((item) => item.value),
  top: record.frequencies.map((item) => item.value),
  frequencies: record.frequencies,
  sentinels: record.sentinels,
  cardinality: record.cardinality,
  nullRate: record.nullRate,
  distinctRatio: record.cardinality > 0 && record.cardinality <= 30 ? 0.1 : 1
});

const parseFormatProfile = (text: string): Partial<ColumnRecord> => {
  const read = (key: string) => new RegExp(`${key}=([^\\s]+)`, "u").exec(text)?.[1];
  const parsed: Partial<ColumnRecord> = {};
  const cardinality = read("cardinality");
  const nullRate = read("nullRate");
  const maxLength = read("maxLength");
  const min = read("min");
  const max = read("max");
  const charset = read("charset");
  const sentinels = read("sentinels");
  if (cardinality) parsed.cardinality = Number(cardinality);
  if (nullRate) parsed.nullRate = Number(nullRate);
  if (min) parsed.min = min;
  if (max) parsed.max = max;
  if (maxLength) parsed.maxLength = Number(maxLength);
  if (charset) parsed.charset = charset;
  if (sentinels) parsed.sentinels = sentinels.split("|").filter(Boolean);
  return parsed;
};

const parseMeta = (raw: string | undefined): ColumnMeta => {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ColumnMeta;
  } catch {
    return {};
  }
};

const isRole = (value: unknown): value is ColumnRole =>
  value === "identifier" || value === "temporal" || value === "measure" || value === "dictionary" || value === "attribute";
