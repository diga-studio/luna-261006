# dem-cut-fill

本地 DEM 挖填量计算库（TypeScript / Node.js）。输入均使用同一米制平面坐标系，网格轴向一致。

## 使用

```bash
npm install
npm test
```

```ts
import { writeDEM, compareDEMs } from "dem-cut-fill";

// 写入 DEM：rows 为异步行流，每行是长度为 meta.width 的 Float64Array，
// 共 meta.height 行；行沿 y 增大方向，行内沿 x 增大方向；NaN 表示 NoData。
await writeDEM(directory, { width, height, x0, y0, step }, rows);

// 比较两份 DEM
const { commonArea, cutVolume, fillVolume } = await compareDEMs(oldDir, newDir);
// commonArea：共同有效面积，平方米
// cutVolume ：挖方量（旧-新 的正部积分），立方码
// fillVolume：填方量（新-旧 的正部积分），立方码
```

## DEM 格式

- `meta.json`：`width`、`height`（节点数）、`x0`、`y0`（左下角节点坐标）、`step`（仅允许 0.5 / 1 / 5 / 10 米）。
- `elevation.bin`：按行排列的小端 Float64 节点高程（米），NaN 表示 NoData。
- 节点不是像元中心；一个单元由相邻四节点围成，仅当四角均非 NoData 时有效，单元内部高程为四角值的双线性插值。
- 两份 DEM 的原点、尺寸、step 可以不同。

## 算法

比较域 D 是两份 DEM 有效单元覆盖区域的交集。实现把 D 分解为「旧有效单元 ×
新有效单元」的矩形交集（含仅半格的重叠部分，不向无效单元或网格外插值）。每个
交集矩形内两份 DEM 各自是双线性函数，其差仍是双线性函数
`f(x,y) = a + b·x + c·y + d·x·y`：

- `d ≠ 0` 时化为 `f = d·(x−xc)·(y−yc) + k`，按双曲线中心所在象限拆分后，归结为
  第一象限矩形上的核心积分 `∫∫(u·v + t)⁺`，它有闭式解（含对数项），精确求值。
- `d = 0`（线性）时用半平面裁剪 + 三角形扇精确积分。
- 挖方与填方分别对差值的正部、负部独立积分，任何位置互不抵消；同一单元内部
  可以同时存在挖方和填方。
- 体积按 1 码 = 0.9144 米严格换算（除以 0.9144³）。

## 数值误差控制

- 核心积分为闭式解析解，不做数值逼近，只剩浮点舍入误差（约 1e-15 相对量级）。
- 差值函数的系数在交集矩形的局部坐标下由四角值直接确定，避免了大坐标
  （如投影坐标 1e6 量级）带来的灾难性抵消。
- 鞍点项 `|d|·hx·hy` 相对函数尺度小于 1e-12 时按线性处理，引入误差不超过
  `1e-12 × 函数尺度 × 面积`，有界且可忽略。
- 各矩形贡献用 Kahan 补偿求和累加，避免大量小项累加的舍入漂移。
- 测试包含解析解验证（单位正方形上挖=填=(3+2ln4)/64 立方米）与独立手算的
  混合分辨率/原点错开/内部 NaN 用例，容差 1e-12。
