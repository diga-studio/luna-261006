export interface BomRevision {
  assemblyId: string;
  startDay: number;
  components: string[];
}

export interface BomVersion {
  assemblyId: string;
  startDay: number;
  components: string[];
}

export interface CycleWitness {
  /** An integer day on which the reported cycle is actually closed. */
  day: number;
  /** Closed material path: path[0] === path[path.length - 1], each step is an edge effective on `day`. */
  path: string[];
}

export type PublishResult = { ok: true } | { ok: false; witness: CycleWitness };
