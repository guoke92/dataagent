import { forceSimulation, forceX, forceY, forceCollide, type SimulationNodeDatum } from "d3-force";

export type MassNode = SimulationNodeDatum & { mass: number };

const MASS_EPSILON = 1e-3;

/** Geometric mean of the two masses. The pair is symmetric. */
export function pairCouple(massA: number, massB: number): number {
  return Math.sqrt(Math.max(massA, MASS_EPSILON) * Math.max(massB, MASS_EPSILON));
}

export function massReference(masses: number[]): number {
  if (masses.length === 0) return 1;
  const sum = masses.reduce((total, mass) => total + Math.max(mass, 0), 0);
  return Math.max(sum / masses.length, MASS_EPSILON);
}

/** Relative mass of a pair against the graph average. Average pairs sit at 1. */
export function pairMassScale(massA: number, massB: number, massRef: number): number {
  return pairCouple(massA, massB) / Math.max(massRef, MASS_EPSILON);
}

/** Rest length at average mass is `base`. Distance grows with the square root of the relative mass, so a heavier pair sits farther out without leaving the slider's scale. */
export function pairRestLength(base: number, massA: number, massB: number, massRef: number): number {
  return base * Math.sqrt(pairMassScale(massA, massB, massRef));
}

/** Reach at average mass is `distanceMax`, with the same mass scaling as rest length. */
export function pairReach(distanceMax: number, massA: number, massB: number, massRef: number): number {
  return distanceMax * Math.sqrt(pairMassScale(massA, massB, massRef));
}

/**
 * Equal-and-opposite repulsion. `chargeScale` is the kick at contact for a pair
 * whose geometric mean mass is 1. The kick is `chargeScale * couple * (1 - (distance / reach)²)`
 * and is zero at the pair reach. A heavy–light pair is weaker than a heavy–heavy pair.
 */
export function repulsionMagnitude(
  chargeScale: number,
  massA: number,
  massB: number,
  distance: number,
  reach: number,
): number {
  if (!(reach > 0) || !(distance > 0) || distance >= reach) return 0;
  const t = distance / reach;
  return chargeScale * pairCouple(massA, massB) * (1 - t * t);
}

type MutualLink = { source: string; target: string; mutual: boolean };

type ResolvedLink<Node extends MassNode> = { source: Node; target: Node; mutual: boolean; rest: number; stiffness: number };

export function mutualChargeForce<Node extends MassNode>(input: {
  chargeScale: number;
  distanceMax: number;
}) {
  let nodes: Node[] = [];
  let massRef = 1;
  const force = (alpha: number) => {
    const count = nodes.length;
    if (count < 2) return;
    let maxMass = MASS_EPSILON;
    for (const node of nodes) if (node.mass > maxMass) maxMass = node.mass;
    const maxReach = pairReach(input.distanceMax, maxMass, maxMass, massRef);
    const cell = Math.max(maxReach, 1);
    const grid = new Map<string, number[]>();
    const bucketKey = (x: number, y: number) => `${Math.floor(x)}:${Math.floor(y)}`;
    for (let index = 0; index < count; index += 1) {
      const node = nodes[index];
      if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
      const key = bucketKey((node.x ?? 0) / cell, (node.y ?? 0) / cell);
      const bucket = grid.get(key);
      if (bucket) bucket.push(index);
      else grid.set(key, [index]);
    }
    for (let index = 0; index < count; index += 1) {
      const left = nodes[index];
      if (!left || !Number.isFinite(left.x) || !Number.isFinite(left.y)) continue;
      const gx = Math.floor((left.x ?? 0) / cell);
      const gy = Math.floor((left.y ?? 0) / cell);
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oy = -1; oy <= 1; oy += 1) {
          const bucket = grid.get(bucketKey(gx + ox, gy + oy));
          if (!bucket) continue;
          for (const other of bucket) {
            if (other <= index) continue;
            const right = nodes[other];
            if (!right || !Number.isFinite(right.x) || !Number.isFinite(right.y)) continue;
            const dx = (right.x ?? 0) - (left.x ?? 0);
            const dy = (right.y ?? 0) - (left.y ?? 0);
            const distance = Math.hypot(dx, dy);
            if (!(distance > 0)) continue;
            const magnitude = repulsionMagnitude(
              input.chargeScale,
              left.mass,
              right.mass,
              distance,
              pairReach(input.distanceMax, left.mass, right.mass, massRef),
            ) * alpha;
            if (magnitude === 0) continue;
            const ux = dx / distance;
            const uy = dy / distance;
            const leftVx = (left.vx ?? 0) - ux * magnitude;
            const leftVy = (left.vy ?? 0) - uy * magnitude;
            const rightVx = (right.vx ?? 0) + ux * magnitude;
            const rightVy = (right.vy ?? 0) + uy * magnitude;
            if (Number.isFinite(leftVx) && Number.isFinite(leftVy)) {
              left.vx = leftVx;
              left.vy = leftVy;
            }
            if (Number.isFinite(rightVx) && Number.isFinite(rightVy)) {
              right.vx = rightVx;
              right.vy = rightVy;
            }
          }
        }
      }
    }
  };
  force.initialize = (next: Node[]) => {
    nodes = next;
    massRef = massReference(next.map((node) => node.mass));
  };
  return force;
}

export function mutualLinkForce<Node extends MassNode>(
  links: MutualLink[],
  input: { linkDistance: number; mutualDistance: number; mutualBoost: number; degreeOf: Map<string, number> },
) {
  let resolved: Array<ResolvedLink<Node>> = [];
  const force = (alpha: number) => {
    for (const link of resolved) {
      const dx = (link.target.x ?? 0) - (link.source.x ?? 0);
      const dy = (link.target.y ?? 0) - (link.source.y ?? 0);
      const distance = Math.hypot(dx, dy) || MASS_EPSILON;
      const magnitude = link.stiffness * (distance - link.rest) * alpha;
      const ux = dx / distance;
      const uy = dy / distance;
      const sourceVx = (link.source.vx ?? 0) + ux * magnitude;
      const sourceVy = (link.source.vy ?? 0) + uy * magnitude;
      const targetVx = (link.target.vx ?? 0) - ux * magnitude;
      const targetVy = (link.target.vy ?? 0) - uy * magnitude;
      if (Number.isFinite(sourceVx) && Number.isFinite(sourceVy)) {
        link.source.vx = sourceVx;
        link.source.vy = sourceVy;
      }
      if (Number.isFinite(targetVx) && Number.isFinite(targetVy)) {
        link.target.vx = targetVx;
        link.target.vy = targetVy;
      }
    }
  };
  force.initialize = (nodes: Node[]) => {
    const idOf = new Map<string, Node>();
    for (const node of nodes) {
      const id = (node as Node & { id?: string }).id;
      if (id) idOf.set(id, node);
    }
    const massRef = massReference(nodes.map((node) => node.mass));
    resolved = links.flatMap((link) => {
      const source = idOf.get(link.source);
      const target = idOf.get(link.target);
      if (!source || !target) return [];
      const degree = Math.max(input.degreeOf.get(link.source) || 1, input.degreeOf.get(link.target) || 1);
      const base = link.mutual ? input.mutualDistance : input.linkDistance;
      return [{
        source,
        target,
        mutual: link.mutual,
        rest: pairRestLength(base, source.mass, target.mass, massRef),
        stiffness: (link.mutual ? input.mutualBoost : 1) / degree,
      }];
    });
  };
  return force;
}

export function attachMutualForces<Node extends MassNode>(
  nodes: Node[],
  links: MutualLink[],
  input: {
    chargeScale: number;
    chargeDistanceMax: number;
    linkDistance: number;
    mutualDistance: number;
    mutualBoost: number;
    centerPull: number;
    collideRadius: (node: Node) => number;
    collideStrength: number;
    collideIterations: number;
    ticks: number;
    degreeOf: Map<string, number>;
  },
) {
  const simulation = forceSimulation(nodes)
    .force("charge", mutualChargeForce({ chargeScale: input.chargeScale, distanceMax: input.chargeDistanceMax }))
    .force("link", mutualLinkForce(links, input))
    .force("x", forceX<Node>(0).strength(input.centerPull))
    .force("y", forceY<Node>(0).strength(input.centerPull))
    .force("collide", forceCollide<Node>().radius(input.collideRadius).strength(input.collideStrength).iterations(input.collideIterations))
    .stop();
  const alphaMin = simulation.alphaMin();
  simulation.alphaDecay(1 - Math.pow(alphaMin, 1 / Math.max(input.ticks, 1)));
  return simulation;
}
