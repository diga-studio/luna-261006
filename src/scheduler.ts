import { PipelineHandle, PipelineSpec } from "./types";
import { ProcessRunner, SpawnProcessRunner } from "./process";
import { Pipeline } from "./pipeline";

/** 调度库入口：提交流水线、查询状态、等待结果 */
export class CiScheduler {
  private readonly runner: ProcessRunner;
  private nextId = 1;
  private readonly pipelines = new Map<string, Pipeline>();

  constructor(runner?: ProcessRunner) {
    this.runner = runner ?? new SpawnProcessRunner();
  }

  /** 提交一条流水线，立即返回句柄；流水线从提交时刻起算总时限 */
  submit(spec: PipelineSpec): PipelineHandle {
    const id = `pl-${this.nextId++}`;
    const pipeline = new Pipeline(spec, this.runner, id);
    this.pipelines.set(id, pipeline);
    return pipeline;
  }

  /** 按 id 查询已提交的流水线 */
  get(id: string): PipelineHandle | undefined {
    return this.pipelines.get(id);
  }
}

export { SpawnProcessRunner };
