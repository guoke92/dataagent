/** MinHash sketch of a column's distinct values. Used to estimate containment without pairwise SQL. */
export const SKETCH_SIZE = 128;
export const SKETCH_CONTAINMENT_THRESHOLD = 0.8;

export type ValueSketch = {
  hashes: number[];
  cardinality: number;
};

const SEEDS = Array.from({ length: SKETCH_SIZE }, (_, index) => (index + 1) * 2654435761);

export const emptySketch = (): ValueSketch => ({
  hashes: Array.from({ length: SKETCH_SIZE }, () => 0xffffffff),
  cardinality: 0
});

export const addSketchValue = (sketch: ValueSketch, value: string): void => {
  const text = value.trim();
  if (!text) return;
  for (let index = 0; index < SKETCH_SIZE; index += 1) {
    const hashed = hashValue(text, SEEDS[index] ?? 1);
    const current = sketch.hashes[index] ?? 0xffffffff;
    if (hashed < current) sketch.hashes[index] = hashed;
  }
  sketch.cardinality += 1;
};

export const sketchFromValues = (values: Iterable<string>): ValueSketch => {
  const sketch = emptySketch();
  for (const value of values) addSketchValue(sketch, value);
  return sketch;
};

export const serializeSketch = (sketch: ValueSketch): number[] =>
  [...sketch.hashes, sketch.cardinality];

export const restoreSketch = (packed: number[] | undefined): ValueSketch | undefined => {
  if (!packed || packed.length !== SKETCH_SIZE + 1) return undefined;
  const cardinality = packed[SKETCH_SIZE];
  if (cardinality === undefined || cardinality < 0) return undefined;
  return { hashes: packed.slice(0, SKETCH_SIZE), cardinality };
};

/** Estimate |child ∩ parent| / |child| from MinHash Jaccard and the two cardinalities. */
export const estimatedContainment = (child: ValueSketch, parent: ValueSketch): number => {
  if (child.cardinality <= 0 || parent.cardinality <= 0) return 0;
  let matches = 0;
  for (let index = 0; index < SKETCH_SIZE; index += 1) {
    if (child.hashes[index] === parent.hashes[index]) matches += 1;
  }
  const jaccard = matches / SKETCH_SIZE;
  if (jaccard <= 0) return 0;
  const intersection = (jaccard * (child.cardinality + parent.cardinality)) / (1 + jaccard);
  return Math.min(1, intersection / child.cardinality);
};

const hashValue = (value: string, seed: number): number => {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};
