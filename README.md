# flow-readiness-check

工作流发布前的数据就绪检查库（TypeScript，纯内存，无外部服务）。由设计器直接调用：
流程定义与分析结果都只保存在内存中，不做任何持久化。

## 能力

- `analyzeFlow(flow)`：发布检查。返回所有可能**首次失败**的 `(动作节点, 缺失字段)`
  组合（按节点、字段去重），每条报告附一组真实触发该首次失败的完整开关输入。
  没有报告表示所有开关输入都能走到结束。
- `replayFlow(flow, switches)`：按给定开关输入复现一次执行，返回经过的节点及
  首次失败的全部缺失字段；没有失败则返回成功。

## 流程模型

- 不超过 200 个节点的有向无环图：入口（唯一）、条件、动作、结束。
- 最多 40 个布尔开关，执行前一次性给定，执行期间不变；条件节点只检查一个开关。
- 最多 40 个业务字段，执行开始时全部不存在；动作声明 `requires` / `produces`，
  任一必需字段缺失则流程立即失败（该动作不产出、不再执行后继），
  否则产出字段从此存在。

## 精确性

分析不枚举路径：对每个节点与字段，用 BDD 精确维护"无更早失败地到达该节点"
与"到达时字段已存在"两个开关赋值集合，因此：

- 不会把来自不同执行路径的字段状态拼成一次不存在的执行（无误报）；
- 一个组合出现，当且仅当存在某组开关输入使执行首次失败于该节点且该字段缺失（无漏报）；
- 只能在更早失败之后发生的缺失不会被报告（遮蔽语义精确）。

40 开关 / 160–200 节点的常见流程完整检查约毫秒级完成，堆内存增量约数 MiB，
远低于 10 秒 / 256 MiB 的限制。

## 用法

```ts
import { analyzeFlow, replayFlow, type FlowDefinition } from 'flow-readiness-check';

const flow: FlowDefinition = {
  switches: ['useFastTrack'],
  fields: ['material'],
  nodes: [
    { id: 'entry', kind: 'entry', next: 'c' },
    { id: 'c', kind: 'condition', switch: 'useFastTrack', onTrue: 'gen', onFalse: 'use' },
    { id: 'gen', kind: 'action', requires: [], produces: ['material'], next: 'use' },
    { id: 'use', kind: 'action', requires: ['material'], produces: [], next: 'end' },
    { id: 'end', kind: 'end' },
  ],
};

const { reports } = analyzeFlow(flow);
// reports: [{ nodeId: 'use', field: 'material', witness: [false] }]

const result = replayFlow(flow, reports[0].witness);
// result: { ok: false, path: ['entry', 'c', 'use'], failedAt: 'use', missingFields: ['material'] }
```

## 构建与测试

```sh
npm install
npm test        # 编译并运行全部测试（node:test）
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js（>=18）与开发依赖 `typescript` / `@types/node`，无运行时依赖。
