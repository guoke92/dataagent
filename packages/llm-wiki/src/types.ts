export type SourceKind = "database" | "document" | "code" | "dialogue";

export type ClaimDomain =
  | "physical_identity"
  | "declared_fk"
  | "terminology"
  | "business_rule"
  | "field_relation"
  | "enum_dictionary"
  | "term_bridge"
  | "query_pattern";

export type ScanMode = "facts_only" | "semantic";

export type PageStatus = "pending" | "auto" | "human" | "rejected" | "auto-rejected";

export type WikiField = {
  key: string;
  text: string;
  status: PageStatus;
  meta?: string;
};

export type PageType =
  | "index"
  | "log"
  | "table"
  | "column"
  | "relation"
  | "value-domain"
  | "metric"
  | "concept"
  | "contradiction"
  | "query-pattern"
  | "outline"
  | "source";

export type GroundRecord = {
  source_id: string;
  source_kind: SourceKind;
  fingerprint: string;
  claim_domain: ClaimDomain;
  statement: string;
  locator: string;
  confidence: number;
  evidence_class: string;
  subject?: string;
};

export type LlmClient = {
  complete(prompt: string): Promise<string>;
};

export type DatabaseColumnSnapshot = {
  name: string;
  type: string;
  nullable: boolean;
  comment?: string;
  primaryKey?: boolean;
  samples?: string[];
};

export type DatabaseForeignKey = {
  column: string;
  refTable: string;
  refColumn: string;
};

export type DatabaseTableSnapshot = {
  name: string;
  comment?: string;
  columns: DatabaseColumnSnapshot[];
  foreignKeys?: DatabaseForeignKey[];
  sampleRows?: Array<Record<string, unknown>>;
};

export type DatabaseSnapshot = {
  dialect?: string;
  tables: DatabaseTableSnapshot[];
};

export type WikiPage = {
  id: string;
  type: PageType;
  status: PageStatus;
  title: string;
  body: string;
  source_ids: string[];
  datasource_ids: string[];
  evidence_ids: string[];
  anchor?: string;
  fingerprint: string;
  claim_domain?: ClaimDomain;
  authority?: SourceKind;
  confidence: number;
  updated_at: string;
  fields?: WikiField[];
};

export type SchemaColumnProjection = {
  name: string;
  type: string;
  nullable?: boolean;
  label?: string;
  examples?: string[];
  labels?: string[];
  range?: string;
};

export type SchemaTableProjection = {
  name: string;
  columns: SchemaColumnProjection[];
};

export type SchemaRelationProjection = {
  statement: string;
  confidence: number;
};

export type SchemaProjection = {
  datasource_id: string;
  dialect?: string;
  revision: string;
  tables: SchemaTableProjection[];
  relations: SchemaRelationProjection[];
};

export type LookupHit = {
  table: string;
  column: string;
  match: "exact" | "lsh";
  sample: string;
};

export type WikiEmbedder = {
  embed(texts: string[]): Promise<number[][]>;
};

export type WikiSearchHit = {
  page_id: string;
  title: string;
  excerpt: string;
  type: PageType;
  anchor?: string;
};
