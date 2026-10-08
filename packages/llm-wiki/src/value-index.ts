import { normalizeValue } from "./text.js";
import type { LookupHit } from "./types.js";

export type IndexedValue = {
  table: string;
  column: string;
  value: string;
};

type Bucket = {
  table: string;
  column: string;
  value: string;
};

export type ValueIndex = {
  exact: IndexedValue[];
  buckets: Record<string, Bucket[]>;
};

export const buildValueIndex = (entries: IndexedValue[]): ValueIndex => {
  const buckets: Record<string, Bucket[]> = {};
  for (const entry of entries) {
    const normalized = normalizeValue(entry.value);
    if (normalized.length < 2) continue;
    for (const shingle of shingles(normalized)) {
      const list = buckets[shingle] ?? [];
      list.push({ table: entry.table, column: entry.column, value: entry.value });
      buckets[shingle] = list;
    }
  }
  return { exact: entries, buckets };
};

export const lookupValue = (index: ValueIndex, literal: string): LookupHit[] => {
  const normalized = normalizeValue(literal);
  if (normalized.length < 2) return [];
  const exact = index.exact.filter((entry) => {
    const value = normalizeValue(entry.value);
    return value === normalized || value.includes(normalized) || normalized.includes(value);
  });
  if (exact.length > 0) {
    return uniqueHits(exact.map((entry) => ({
      table: entry.table,
      column: entry.column,
      match: "exact" as const,
      sample: entry.value
    })));
  }
  const scores = new Map<string, { hit: LookupHit; score: number }>();
  for (const shingle of shingles(normalized)) {
    for (const bucket of index.buckets[shingle] ?? []) {
      const key = `${bucket.table}.${bucket.column}`;
      const current = scores.get(key);
      const hit = { table: bucket.table, column: bucket.column, match: "lsh" as const, sample: bucket.value };
      scores.set(key, { hit, score: (current?.score ?? 0) + 1 });
    }
  }
  return [...scores.values()]
    .filter((item) => item.score >= 2)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map((item) => item.hit);
};

const shingles = (value: string): string[] => {
  if (value.length < 3) return [value];
  const result: string[] = [];
  for (let index = 0; index <= value.length - 3; index += 1) {
    result.push(value.slice(index, index + 3));
  }
  return result;
};

const uniqueHits = (hits: LookupHit[]): LookupHit[] => {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.table}.${hit.column}.${hit.sample}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
