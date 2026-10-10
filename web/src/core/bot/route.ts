/**
 * Shortest paths over the explored graph (§4.2: route = min expected-deaths route; ties → fewer actions → faster).
 * GOAL is a virtual node (index nodes.length).
 */
import type { BEdge, Explorer } from './explore.ts';
import { GOAL } from './explore.ts';

/** Route cost: 100 per expected death, 0.05 per action (0.01 per walked cell), 1 per minute. */
export function routeCost(e: BEdge): number {
  return 100 * e.d + (e.kind === 'walk' ? 0.01 : 0.05) + e.frames / 3600;
}

export function frameCost(e: BEdge): number {
  return e.frames + 0.001;
}

class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size(): number {
    return this.k.length;
  }
  push(v: number, key: number): void {
    const K = this.k;
    const V = this.v;
    K.push(key);
    V.push(v);
    let i = K.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (K[i] < K[j] || (K[i] === K[j] && V[i] < V[j])) {
        [K[i], K[j]] = [K[j], K[i]];
        [V[i], V[j]] = [V[j], V[i]];
        i = j;
      } else break;
    }
  }
  pop(): [number, number] {
    const K = this.k;
    const V = this.v;
    const top: [number, number] = [V[0], K[0]];
    const lk = K.pop() as number;
    const lv = V.pop() as number;
    if (K.length) {
      K[0] = lk;
      V[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < K.length && (K[l] < K[m] || (K[l] === K[m] && V[l] < V[m]))) m = l;
        if (r < K.length && (K[r] < K[m] || (K[r] === K[m] && V[r] < V[m]))) m = r;
        if (m === i) break;
        [K[i], K[m]] = [K[m], K[i]];
        [V[i], V[m]] = [V[m], V[i]];
        i = m;
      }
    }
    return top;
  }
}

export interface Paths {
  dist: Float64Array; // per node (+ GOAL at index N)
  prev: Int32Array; // incoming edge index on the best path (−1)
}

/** Forward Dijkstra from `src` (node index). */
export function forward(ex: Explorer, src: number, cost: (e: BEdge) => number): Paths {
  const N = ex.nodes.length;
  const dist = new Float64Array(N + 1).fill(Infinity);
  const prev = new Int32Array(N + 1).fill(-1);
  if (src < 0) return { dist, prev };
  dist[src] = 0;
  const h = new MinHeap();
  h.push(src, 0);
  while (h.size) {
    const [u, du] = h.pop();
    if (du > dist[u]) continue;
    if (u === N) continue;
    for (const ei of ex.nodes[u].out) {
      const e = ex.edges[ei];
      const v = e.to === GOAL ? N : e.to;
      const nd = du + cost(e);
      if (nd < dist[v] - 1e-12) {
        dist[v] = nd;
        prev[v] = ei;
        h.push(v, nd);
      }
    }
  }
  return { dist, prev };
}

/** Reverse Dijkstra: cost-to-goal per node (Infinity when the goal is unreachable from it). */
export function toGoal(ex: Explorer, cost: (e: BEdge) => number): Float64Array {
  const N = ex.nodes.length;
  const dist = new Float64Array(N + 1).fill(Infinity);
  dist[N] = 0;
  const inc: number[][] = Array.from({ length: N + 1 }, () => []);
  for (const e of ex.edges) inc[e.to === GOAL ? N : e.to].push(e.i);
  const h = new MinHeap();
  h.push(N, 0);
  while (h.size) {
    const [v, dv] = h.pop();
    if (dv > dist[v]) continue;
    for (const ei of inc[v]) {
      const e = ex.edges[ei];
      const nd = dv + cost(e);
      if (nd < dist[e.from] - 1e-12) {
        dist[e.from] = nd;
        h.push(e.from, nd);
      }
    }
  }
  return dist;
}

/** Edge list of the best path from the source to `target` (GOAL by default). */
export function pathTo(ex: Explorer, p: Paths, target = -1): BEdge[] {
  const N = ex.nodes.length;
  let v = target === GOAL ? N : target;
  if (!Number.isFinite(p.dist[v])) return [];
  const out: BEdge[] = [];
  let guard = 0;
  while (p.prev[v] >= 0 && guard++ < 100000) {
    const e = ex.edges[p.prev[v]];
    out.push(e);
    v = e.from;
  }
  return out.reverse();
}

/** Nodes reachable from src (BFS over out-edges). */
export function reachableFrom(ex: Explorer, src: number): Uint8Array {
  const seen = new Uint8Array(ex.nodes.length);
  if (src < 0) return seen;
  const q = [src];
  seen[src] = 1;
  while (q.length) {
    const u = q.pop() as number;
    for (const ei of ex.nodes[u].out) {
      const t = ex.edges[ei].to;
      if (t >= 0 && !seen[t]) {
        seen[t] = 1;
        q.push(t);
      }
    }
  }
  return seen;
}
