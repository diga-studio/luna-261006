# glb-furniture-metrics

家具 GLB 尺寸分析与落地归一化库，供上层资产导入流程在内存中调用。

## 能力

- `analyzeGlb(bytes)`：解析 glTF 2.0 GLB（内嵌 BIN、静态三角网格），按文件声明的默认场景
  （未声明时取第一个场景）遍历可达节点，对每个 mesh 实例应用完整节点变换链
  （matrix 或 TRS，支持负缩放与非均匀缩放），返回场景坐标系中的紧致轴对齐边界与三轴尺寸（米）。
  带索引的图元只统计实际引用的 POSITION 元素；支持 bufferView/accessor 双重字节偏移、
  交错存储与稀疏覆盖（无基础 bufferView 时未覆盖元素为零）。
- `normalizeGlb(bytes, [x, y, z])`：目标尺寸以厘米表示。保持比例、不旋转，
  取三轴均不超标的最大统一缩放，使最低点落在 y=0、xz 中心位于原点。
  返回附加在整个场景外侧的 4×4 矩阵（列主序、作用于列向量）与归一化后的边界，不改写原文件。

## 使用

```ts
import { analyzeGlb, normalizeGlb } from "glb-furniture-metrics";
import { readFileSync } from "node:fs";

const bytes = readFileSync("chair.glb");
const { bounds, dimensions } = analyzeGlb(bytes);
const { matrix, bounds: grounded } = normalizeGlb(bytes, [200, 150, 200]);
```

## 开发

```sh
npm install
npm test   # 构建并运行全部测试（仅需 Node.js）
```
