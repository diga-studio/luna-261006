import { computeResult } from './compute';
import {
  Attempts,
  CourseKey,
  GradebookRow,
  GradebookSnapshot,
  GradingRule,
  RecomputeHooks,
} from './types';

interface StudentInput {
  inputVersion: number;
  attempts: Attempts;
}

interface RecomputeJob {
  rule: GradingRule;
  ruleVersion: number;
  /** 仍需按新规则（重）计算的学生。 */
  dirty: Set<string>;
  /** 已按新规则算好、等待切换时整体发布的结果，标记了所基于的 inputVersion。 */
  pending: Map<string, GradebookRow>;
}

interface KeyState {
  rule: GradingRule;
  ruleVersion: number;
  inputs: Map<string, StudentInput>;
  /** 当前已发布规则下的完整成绩簿视图。 */
  view: Map<string, GradebookRow>;
  job: RecomputeJob | null;
}

/** 每批处理的学生数；批间让出事件循环，读写可穿插，且测试可通过钩子精确暂停。 */
const BATCH_SIZE = 128;

function keyId(key: CourseKey): string {
  return JSON.stringify([key.courseId, key.semester]);
}

function yieldControl(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class GradebookService {
  private readonly states = new Map<string, KeyState>();
  private readonly hooks?: RecomputeHooks;
  /** 纠错重算实际执行的学生计算次数（不含 putGrades 的即时视图更新）。 */
  public recomputeCount = 0;

  constructor(hooks?: RecomputeHooks) {
    this.hooks = hooks;
  }

  /**
   * 首次建立规则或更正规则；返回时新规则已生效，resolve 值为新的 ruleVersion。
   * 更正规则时增量重算：逐批处理 dirty 学生，期间写入与读取照常进行；
   * 只有输入变化过的学生会被追加计算，全部就绪后 O(1) 切换发布。
   */
  async publishRule(key: CourseKey, rule: GradingRule): Promise<number> {
    const id = keyId(key);
    const state = this.states.get(id);
    if (!state) {
      // 首次建立规则时还没有学生成绩，直接生效。
      this.states.set(id, {
        rule,
        ruleVersion: 1,
        inputs: new Map(),
        view: new Map(),
        job: null,
      });
      return 1;
    }
    if (state.job) {
      throw new Error('a rule publish is already in flight for this key');
    }

    const job: RecomputeJob = {
      rule,
      ruleVersion: state.ruleVersion + 1,
      dirty: new Set(state.inputs.keys()),
      pending: new Map(),
    };
    state.job = job;

    // 不变式：dirty 之外的学生，pending 中都有与其当前 inputVersion 匹配的新规则结果。
    // putGrades 会把对应学生重新放入 dirty，因此只有输入变化的学生会被追加计算。
    while (job.dirty.size > 0) {
      const batch: string[] = [];
      for (const studentId of job.dirty) {
        batch.push(studentId);
        if (batch.length >= BATCH_SIZE) break;
      }
      for (const studentId of batch) {
        job.dirty.delete(studentId);
        await this.computeOne(key, state, job, studentId);
      }
      await yieldControl();
    }

    // 切换临界区：只做 O(1) 的引用交换，不逐个学生计算。
    // 单线程下 dirty 为空到交换之间不会有 putGrades 插入。
    state.rule = job.rule;
    state.ruleVersion = job.ruleVersion;
    state.view = job.pending;
    state.job = null;
    return job.ruleVersion;
  }

  /** 按新规则计算单个学生并暂存；结果标记所基于的 inputVersion。 */
  private async computeOne(
    key: CourseKey,
    state: KeyState,
    job: RecomputeJob,
    studentId: string,
  ): Promise<void> {
    await this.hooks?.beforeCompute?.(key, studentId);
    const input = state.inputs.get(studentId);
    if (!input) return; // 学生不存在（当前实现不会删除学生，防御性返回）
    const basedOnVersion = input.inputVersion;
    const attempts = input.attempts;
    await this.hooks?.afterInputRead?.(key, studentId, basedOnVersion);
    const result = computeResult(job.rule, attempts);
    this.recomputeCount++;
    job.pending.set(studentId, {
      inputVersion: basedOnVersion,
      total: result.total,
      passed: result.passed,
    });
    await this.hooks?.afterCompute?.(key, studentId, basedOnVersion, this.recomputeCount);
  }

  /**
   * 新增或完整覆盖学生成绩；返回时写入已对读取可见。
   * 同步按当前已发布规则更新视图（O(1)，不触碰其他学生），
   * 若有纠错在途，则把该生标记为 dirty，由重算循环按新规则追加计算。
   */
  putGrades(key: CourseKey, studentId: string, attempts: Attempts): number {
    const state = this.requireState(key);
    const inputVersion = (state.inputs.get(studentId)?.inputVersion ?? 0) + 1;
    state.inputs.set(studentId, { inputVersion, attempts });
    const result = computeResult(state.rule, attempts);
    state.view.set(studentId, {
      inputVersion,
      total: result.total,
      passed: result.passed,
    });
    state.job?.dirty.add(studentId);
    return inputVersion;
  }

  /** 读取当前已发布成绩簿快照；重算期间仍返回旧规则下的完整视图。 */
  readGradebook(key: CourseKey): GradebookSnapshot {
    const state = this.requireState(key);
    const students: Record<string, GradebookRow> = {};
    for (const [studentId, row] of state.view) {
      students[studentId] = { ...row };
    }
    return { ruleVersion: state.ruleVersion, students };
  }

  private requireState(key: CourseKey): KeyState {
    const state = this.states.get(keyId(key));
    if (!state) {
      throw new Error(`no rule published for course=${key.courseId} semester=${key.semester}`);
    }
    return state;
  }
}
