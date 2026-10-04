# glb-furniture-metrics

家具 GLB 尺寸分析与落地归一化库（TypeScript），供上层资产导入流程在内存中调用。

## 能力

- `analyzeGlb(bytes)`：解析 glTF 2.0 的 GLB（几何位于内嵌 BIN），按默认（或第一个）场景
  可达节点累计全部网格实例经完整变换后的 POSITION 顶点，返回场景坐标系中的紧致
  轴对齐边界与三轴尺寸（米）。
- `normalizeGlb(bytes, targetXCm, targetYCm, targetZCm)`：以三轴均不超过目标尺寸（厘米）
  的最大统一缩放，使最低点位于 y=0、xz 中心位于原点；返回附加在整个场景外侧的
  列主序 4×4 矩阵（作用于列向量）及归一化后的边界。不改写原文件。

## 支持范围

- 节点 `matrix` 或 TRS 变换、任意层级、负缩放与非均匀缩放；同一 mesh 多实例独立计入。
- POSITION 为 FLOAT VEC3；索引可选，支持无符号 8/16/32 位。
- bufferView 与 accessor 双重字节偏移、交错存储（byteStride）、稀疏覆盖；
  无基础 bufferView 的稀疏 accessor 未覆盖元素按零处理。
- 不处理蒙皮、变形目标与动画；仅统计所选场景可达的节点。

## 使用

```ts
import { analyzeGlb, normalizeGlb } from 'glb-furniture-metrics';
import { readFileSync } from 'node:fs';

const bytes = readFileSync('chair.glb');
const { bounds, size } = analyzeGlb(bytes);
const { matrix, bounds: normalizedBounds } = normalizeGlb(bytes, 200, 150, 200);
```

## 开发

```sh
npm install
npm test   # 编译 src 与 test 后运行 node:test 用例
```
