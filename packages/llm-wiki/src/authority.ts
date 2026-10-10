import type { ClaimDomain, GroundRecord, SourceKind } from "./types.js";

/** Highest authority first. Absent ranks cannot write that domain. */
export const AUTHORITY: Record<ClaimDomain, readonly SourceKind[]> = {
  physical_identity: ["database"],
  declared_fk: ["database"],
  terminology: ["document", "database", "dialogue"],
  business_rule: ["code", "document"],
  field_relation: ["code", "database", "document"],
  enum_dictionary: ["code", "document", "database"],
  term_bridge: ["code"],
  query_pattern: ["dialogue"]
};

export const authorityRank = (domain: ClaimDomain, kind: SourceKind): number => {
  const index = AUTHORITY[domain].indexOf(kind);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
};

export const winningKind = (
  domain: ClaimDomain,
  present: Iterable<SourceKind>
): SourceKind | undefined => {
  const available = new Set(present);
  return AUTHORITY[domain].find((kind) => available.has(kind));
};

/** Per subject, the highest present rank wins. Other subjects keep their own winner. */
export const selectAuthoritative = (
  domain: ClaimDomain,
  records: GroundRecord[]
): GroundRecord[] => {
  const grouped = new Map<string, GroundRecord[]>();
  for (const record of records) {
    if (record.claim_domain !== domain) continue;
    const key = record.subject ?? record.locator;
    const group = grouped.get(key) ?? [];
    group.push(record);
    grouped.set(key, group);
  }
  const selected: GroundRecord[] = [];
  for (const group of grouped.values()) {
    const winner = winningKind(domain, group.map((record) => record.source_kind));
    if (!winner) continue;
    selected.push(...group.filter((record) => record.source_kind === winner));
  }
  return selected;
};
