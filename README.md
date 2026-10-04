# MindForge Canvas Outline

把 MindForge 画布中的概念关系图导出为带层级的 Markdown 大纲，供咨询团队撰写分析报告。
输入图与导出结果全部保存在内存中，库直接被上层调用。

## 使用

```bash
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

```ts
import { exportOutline } from "mindforge-canvas-outline";

const result = exportOutline({
  nodes: [{ id: 1, title: "Root Cause", x: 0, y: 0 }, /* ... */],
  edges: [{ from: 1, to: 2 }, /* ... */],
});

result.entries;   // 顶层完整条目（含 children / references）
result.parents;   // 每个节点的父节点 ID（0 = 顶层），按节点 ID 升序
result.totalCost; // 父子边空间代价总和
result.markdown;  // Markdown 大纲文本
```

## 导出规则

- 每个节点作为**完整条目**恰好出现一次：或位于顶层，或挂在唯一父节点下；
  父子关系必须使用原图中父→子的边，层级不成环。
- 未被选为父子关系的边（含自环）保留为源节点下的**引用条目**
  （`- → 标题 (ID: n)`），不展开目标、不计入层级；每条边恰好对应一条父子关系或一条引用。
- 层级方案按以下顺序择优：
  1. 顶层完整条目数量最少；
  2. 父子边空间代价（曼哈顿距离）总和最小；
  3. 节点按 ID 升序的父节点 ID 序列（顶层记 0）逐项比较最小。
- 结果确定：仅改变输入节点/边的排列顺序，层级结果相同，Markdown 逐字节相同。

## 实现要点

- `src/optimize.ts`：以虚拟超级根（权重 = 全部边代价和 + 1，保证先最少顶层数）
  将三级目标归约为最小树形图问题；再用逐节点可行性检查求字典序最小方案。
- `src/edmonds.ts`：Chu-Liu/Edmonds 最小树形图算法。
- `src/outline.ts` / `src/markdown.ts`：构建层级与引用，确定性渲染。
- `test/helpers/bruteForce.ts`：独立穷举求解器，用于在小图上交叉核对全局最优。
