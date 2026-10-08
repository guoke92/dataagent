export type DocumentFacts = {
  terms: Array<{ name: string; definition: string }>;
  rules: Array<{ name: string; formula: string }>;
  relations: Array<{ source: string; target: string; statement: string }>;
  enums: Array<{ column: string; code: string; label: string }>;
};

export type CodeFacts = {
  relations: Array<{ source: string; target: string; statement: string }>;
  enums: Array<{ column: string; code: string; label: string }>;
  rules: Array<{ name: string; formula: string }>;
  bridges: Array<{ term: string; column: string }>;
};

export const parseDocumentFacts = (text: string): DocumentFacts => {
  const terms: DocumentFacts["terms"] = [];
  const rules: DocumentFacts["rules"] = [];
  const relations: DocumentFacts["relations"] = [];
  const enums: DocumentFacts["enums"] = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const relation = /^(?:关联|join)\s+([A-Za-z0-9_.]+)\s*=\s*([A-Za-z0-9_.]+)\s*(.*)$/iu.exec(trimmed);
    if (relation?.[1] && relation[2]) {
      relations.push({
        source: relation[1],
        target: relation[2],
        statement: relation[3]?.trim() || `${relation[1]} = ${relation[2]}`
      });
      continue;
    }
    const enumLine = /^枚举\s+([A-Za-z0-9_.]+)\s+([A-Za-z0-9_-]+)\s+(.+)$/iu.exec(trimmed);
    if (enumLine?.[1] && enumLine[2] && enumLine[3]) {
      enums.push({ column: enumLine[1], code: enumLine[2], label: enumLine[3].trim() });
      continue;
    }
    const term = /^([^:#\n]{1,40})\s*[:：]\s*(.{4,})$/u.exec(trimmed);
    if (!term?.[1] || !term[2]) continue;
    if (/^(type|nullable|primary_key|comment|https?|日期|范围|说明)\b/iu.test(term[1].trim())) continue;
    if (/规则|公式|rule/iu.test(term[1])) {
      rules.push({ name: term[1].trim(), formula: term[2].trim() });
    } else {
      terms.push({ name: term[1].trim(), definition: term[2].trim() });
    }
  }
  return { terms, rules, relations, enums };
};

export const parseCodeFacts = (text: string): CodeFacts => {
  const relations: CodeFacts["relations"] = [];
  const enums: CodeFacts["enums"] = [];
  const rules: CodeFacts["rules"] = [];
  const bridges: CodeFacts["bridges"] = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const relation = /^join\s+([A-Za-z0-9_.]+)\s*=\s*([A-Za-z0-9_.]+)\s*(.*)$/iu.exec(trimmed);
    if (relation?.[1] && relation[2]) {
      relations.push({
        source: relation[1],
        target: relation[2],
        statement: relation[3]?.trim() || `${relation[1]} = ${relation[2]}`
      });
    }
    const enumLine = /^enum\s+([A-Za-z0-9_.]+)\s+([A-Za-z0-9_-]+)\s+(.+)$/iu.exec(trimmed);
    if (enumLine?.[1] && enumLine[2] && enumLine[3]) {
      enums.push({ column: enumLine[1], code: enumLine[2], label: enumLine[3].trim() });
    }
    const rule = /^rule\s+([A-Za-z0-9_.-]+)\s+(.+)$/iu.exec(trimmed);
    if (rule?.[1] && rule[2]) {
      rules.push({ name: rule[1], formula: rule[2].trim() });
    }
    const bridge = /^bridge\s+(.+?)\s*->\s*([A-Za-z0-9_.]+)$/iu.exec(trimmed);
    if (bridge?.[1] && bridge[2]) {
      bridges.push({ term: bridge[1].trim(), column: bridge[2] });
    }
  }
  return { relations, enums, rules, bridges };
};
