import { createHash } from "node:crypto";

export const fingerprintOf = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

export const normalizeName = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "");

export const normalizeValue = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/gu, " ");

export const nameSimilarity = (left: string, right: string): number => {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    return 0.5 + 0.5 * (Math.min(a.length, b.length) / Math.max(a.length, b.length));
  }
  return lcsLength(a, b) / Math.max(a.length, b.length);
};

const lcsLength = (a: string, b: string): number => {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[] = new Array(cols).fill(0);
  for (let i = 1; i < rows; i += 1) {
    let previous = 0;
    for (let j = 1; j < cols; j += 1) {
      const current = dp[j] ?? 0;
      if (a[i - 1] === b[j - 1]) {
        dp[j] = previous + 1;
      } else {
        dp[j] = Math.max(current, dp[j - 1] ?? 0);
      }
      previous = current;
    }
  }
  return dp[cols - 1] ?? 0;
};

export const tokens = (value: string): string[] =>
  value.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/u).filter((token) => token.length >= 2);

export const commentAgreement = (left: string | undefined, right: string | undefined, leftName: string, rightName: string): number => {
  const a = left?.trim() ?? "";
  const b = right?.trim() ?? "";
  if (!a || !b) return 0;
  if (a.includes(rightName) || b.includes(leftName)) return 1;
  const leftTokens = new Set(tokens(a));
  const shared = tokens(b).filter((token) => leftTokens.has(token));
  return shared.length > 0 ? 1 : 0;
};

export const commentsContradict = (left: string | undefined, right: string | undefined): boolean => {
  const a = left?.trim() ?? "";
  const b = right?.trim() ?? "";
  if (!a || !b) return false;
  return /无关|unrelated|不同业务对象/u.test(`${a} ${b}`);
};

export const pageFileName = (id: string): string =>
  `${encodeURIComponent(id)}.md`;
