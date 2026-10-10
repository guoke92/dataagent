import { describe, expect, it } from "vitest";

import { attachMutualForces, massReference, pairCouple, pairMassScale, pairReach, pairRestLength, repulsionMagnitude, type MassNode } from "../components/wiki-force";

const charge = 16;
const reachAt = 1600;
const linkDistance = 340;

describe("mutual mass forces", () => {
  const heavy = 4;
  const light = 0.25;
  const massRef = massReference([heavy, light, heavy]);

  it("uses both masses symmetrically", () => {
    expect(pairCouple(heavy, light)).toBeCloseTo(pairCouple(light, heavy));
    expect(pairCouple(heavy, light)).toBeLessThan(pairCouple(heavy, heavy));
    expect(pairMassScale(heavy, light, massRef)).toBeCloseTo(pairMassScale(light, heavy, massRef));
  });

  it("treats charge as the contact kick for unit mass", () => {
    expect(repulsionMagnitude(charge, 1, 1, 0.001, 1000)).toBeCloseTo(charge, 2);
  });

  it("makes a heavy-light repulsion weaker than a heavy-heavy repulsion at the same distance", () => {
    const onLight = repulsionMagnitude(charge, heavy, light, 120, 2000);
    const onHeavy = repulsionMagnitude(charge, heavy, heavy, 120, 2000);
    expect(onLight).toBeGreaterThan(0);
    expect(onLight).toBeLessThan(onHeavy);
    expect(onLight).toBeCloseTo(repulsionMagnitude(charge, light, heavy, 120, 2000));
  });

  it("decays with distance and drops to zero at the reach", () => {
    const reach = 2000;
    const near = repulsionMagnitude(charge, heavy, light, 80, reach);
    const mid = repulsionMagnitude(charge, heavy, light, 700, reach);
    const far = repulsionMagnitude(charge, heavy, light, 1500, reach);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
    expect(repulsionMagnitude(charge, heavy, light, reach, reach)).toBe(0);
  });

  it("scales rest length and reach with both masses", () => {
    expect(pairRestLength(linkDistance, heavy, light, massRef)).toBeLessThan(pairRestLength(linkDistance, heavy, heavy, massRef));
    expect(pairReach(reachAt, heavy, light, massRef)).toBeLessThan(pairReach(reachAt, heavy, heavy, massRef));
    expect(pairRestLength(linkDistance, heavy, heavy, heavy)).toBeCloseTo(linkDistance);
    expect(pairReach(reachAt, heavy, heavy, heavy)).toBeCloseTo(reachAt);
    expect(pairRestLength(linkDistance, 4, 4, 1)).toBeCloseTo(linkDistance * 2);
  });

  it("keeps a seeded graph finite", () => {
    const count = 180;
    const spread = 175 * Math.sqrt(count / Math.PI);
    const nodes: Array<MassNode & { id: string; degree: number }> = [];
    for (let index = 0; index < count; index += 1) {
      const angle = index * 2.399963;
      const radius = spread * Math.sqrt((index + 0.5) / count);
      nodes.push({
        id: `n${index}`,
        mass: index % 12 === 0 ? 4 : 0.6,
        degree: index % 12 === 0 ? 11 : 1,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
      });
    }
    const links = [];
    for (let index = 0; index < count; index += 1) {
      if (index % 12 === 0) continue;
      links.push({ source: `n${Math.floor(index / 12) * 12}`, target: `n${index}`, mutual: false });
    }
    const degreeOf = new Map(nodes.map((node) => [node.id, node.degree]));
    const simulation = attachMutualForces(nodes, links, {
      chargeScale: charge,
      chargeDistanceMax: reachAt,
      linkDistance,
      mutualDistance: 300,
      mutualBoost: 1.8,
      centerPull: 0.005,
      collideRadius: () => 28,
      collideStrength: 0.65,
      collideIterations: 1,
      ticks: 300,
      degreeOf,
    });
    for (let tick = 0; tick < 40; tick += 1) simulation.tick();
    expect(nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
    const maxAbs = Math.max(...nodes.map((node) => Math.max(Math.abs(node.x ?? 0), Math.abs(node.y ?? 0))));
    expect(maxAbs).toBeLessThan(reachAt * 20);
  });

  it("pushes each linked hub's leaves toward the outer side", () => {
    type Node = MassNode & { id: string; degree: number };
    const nodes: Node[] = [
      { id: "a", mass: 5, degree: 7, x: -180, y: 0, vx: 0, vy: 0 },
      { id: "b", mass: 5, degree: 7, x: 180, y: 0, vx: 0, vy: 0 },
    ];
    const links: Array<{ source: string; target: string; mutual: boolean }> = [
      { source: "a", target: "b", mutual: true },
    ];
    const angles = [0.15, 0.55, 1.2, 2.2, 3.6, 5.4];
    for (const hub of ["a", "b"] as const) {
      const origin = hub === "a" ? -180 : 180;
      angles.forEach((angle, index) => {
        nodes.push({
          id: `${hub}${index}`,
          mass: 0.45,
          degree: 1,
          x: origin + Math.cos(angle) * 80,
          y: Math.sin(angle) * 80,
          vx: 0,
          vy: 0,
        });
        links.push({ source: hub, target: `${hub}${index}`, mutual: false });
      });
    }
    const degreeOf = new Map(nodes.map((node) => [node.id, node.degree]));
    const simulation = attachMutualForces(nodes, links, {
      chargeScale: charge,
      chargeDistanceMax: reachAt,
      linkDistance,
      mutualDistance: 300,
      mutualBoost: 1.8,
      centerPull: 0.005,
      collideRadius: () => 28,
      collideStrength: 0.65,
      collideIterations: 1,
      ticks: 300,
      degreeOf,
    });
    for (let tick = 0; tick < 280; tick += 1) simulation.tick();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const hubA = byId.get("a");
    const hubB = byId.get("b");
    const along = (hub: Node, other: Node, leaves: Node[]) => {
      const cx = leaves.reduce((sum, node) => sum + (node.x ?? 0), 0) / leaves.length;
      const cy = leaves.reduce((sum, node) => sum + (node.y ?? 0), 0) / leaves.length;
      return (cx - (hub.x ?? 0)) * ((other.x ?? 0) - (hub.x ?? 0)) + (cy - (hub.y ?? 0)) * ((other.y ?? 0) - (hub.y ?? 0));
    };
    const leavesOf = (prefix: string) => nodes.filter((node) => node.id.startsWith(prefix) && node.id !== prefix);
    expect(hubA && hubB).toBeTruthy();
    expect(along(hubA!, hubB!, leavesOf("a"))).toBeLessThan(0);
    expect(along(hubB!, hubA!, leavesOf("b"))).toBeLessThan(0);
    expect(nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });
});
