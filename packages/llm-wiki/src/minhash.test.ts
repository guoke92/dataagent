import { describe, expect, it } from "vitest";

import { estimatedContainment, sketchFromValues } from "./minhash.js";

describe("minhash containment", () => {
  it("estimates a foreign key subset as high containment and a disjoint set as low", () => {
    const parent = sketchFromValues(Array.from({ length: 200 }, (_, index) => `id-${index}`));
    const child = sketchFromValues(Array.from({ length: 40 }, (_, index) => `id-${index}`));
    const other = sketchFromValues(Array.from({ length: 40 }, (_, index) => `other-${index}`));
    expect(estimatedContainment(child, parent)).toBeGreaterThan(0.8);
    expect(estimatedContainment(other, parent)).toBeLessThan(0.2);
  });

  it("reports high containment for two copies of a small enum", () => {
    const left = sketchFromValues(["Y", "N"]);
    const right = sketchFromValues(["Y", "N"]);
    expect(estimatedContainment(left, right)).toBeGreaterThan(0.8);
  });
});
