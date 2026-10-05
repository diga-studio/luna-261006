import { computeScore } from "./compute";
import {
  Attempts,
  GradebookOptions,
  GradebookSnapshot,
  GradeRow,
  Key,
  keyId,
  Rule,
} from "./types";

interface PublishedGrade {
  total: number;
  pass: boolean;
}

interface StudentRecord {
  inputVersion: number;
  attempts: Attempts;
  published: PublishedGrade;
}

interface PendingGrade extends PublishedGrade {
  inputVersion: number;
}

interface KeyState {
  rule: Rule | null;
  ruleVersion: number;
  students: Map<string, StudentRecord>;
  publishing: boolean;
  computeCount: number;
}

const YIELD_EVERY = 64;

export class GradebookService {
  private readonly states = new Map<string, KeyState>();
  private readonly options: GradebookOptions;

  constructor(options?: GradebookOptions) {
    this.options = options ?? {};
  }

  async publishRule(key: Key, rule: Rule): Promise<number> {
    const state = this.stateFor(key);
    if (state.publishing) {
      throw new Error("another rule publish is already in flight for this key");
    }
    if (state.rule === null) {
      state.rule = rule;
      state.ruleVersion = 1;
      return 1;
    }

    state.publishing = true;
    try {
      const snapshotIds = Array.from(state.students.keys());
      const pending = new Map<string, PendingGrade>();
      let processed = 0;
      for (const studentId of snapshotIds) {
        const record = state.students.get(studentId);
        if (record) {
          const grade = this.compute(state, rule, record.attempts);
          pending.set(studentId, {
            inputVersion: record.inputVersion,
            total: grade.total,
            pass: grade.pass,
          });
        }
        processed++;
        if (this.options.hooks?.betweenStudents) {
          await this.options.hooks.betweenStudents(key, studentId, processed);
        } else if (processed % YIELD_EVERY === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }

      // Synchronous commit: no awaits below, so reads/writes cannot interleave.
      // Students whose input changed during the async pass (or who were added
      // after the snapshot) are recomputed here individually; everyone else
      // gets their precomputed pending grade installed as-is.
      for (const [studentId, record] of state.students) {
        const pre = pending.get(studentId);
        if (pre && pre.inputVersion === record.inputVersion) {
          record.published = { total: pre.total, pass: pre.pass };
        } else {
          record.published = this.compute(state, rule, record.attempts);
        }
      }
      state.rule = rule;
      state.ruleVersion += 1;
      return state.ruleVersion;
    } finally {
      state.publishing = false;
    }
  }

  putGrades(key: Key, studentId: string, attempts: Attempts): number {
    const state = this.stateFor(key);
    if (state.rule === null) {
      throw new Error("cannot write grades before the first rule is published");
    }
    const existing = state.students.get(studentId);
    const inputVersion = (existing?.inputVersion ?? 0) + 1;
    const published = this.compute(state, state.rule, attempts);
    state.students.set(studentId, { inputVersion, attempts, published });
    return inputVersion;
  }

  readGradebook(key: Key): GradebookSnapshot {
    const state = this.states.get(keyId(key));
    if (!state || state.rule === null) {
      return { ruleVersion: 0, rows: [] };
    }
    const rows: GradeRow[] = [];
    for (const [studentId, record] of state.students) {
      rows.push({
        studentId,
        inputVersion: record.inputVersion,
        total: record.published.total,
        pass: record.published.pass,
      });
    }
    return { ruleVersion: state.ruleVersion, rows };
  }

  computeCount(key: Key): number {
    return this.states.get(keyId(key))?.computeCount ?? 0;
  }

  private compute(
    state: KeyState,
    rule: Rule,
    attempts: Attempts
  ): PublishedGrade {
    state.computeCount++;
    return computeScore(rule, attempts);
  }

  private stateFor(key: Key): KeyState {
    const id = keyId(key);
    let state = this.states.get(id);
    if (!state) {
      state = {
        rule: null,
        ruleVersion: 0,
        students: new Map(),
        publishing: false,
        computeCount: 0,
      };
      this.states.set(id, state);
    }
    return state;
  }
}
