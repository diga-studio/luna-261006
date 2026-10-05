# gravwell-contact

GravWell 三维凸刚体接触查询库（TypeScript）。只做几何查询：不做时间积分、碰撞响应或世界管理。

## API

```ts
import { createHull, contact } from "gravwell-contact";

// 由局部坐标点定义凸包（点无需有序，可含重复点、内部点、共面点；
// 输入需保证凸包具有三维体积）。返回的 Hull 可反复查询。
const hull = createHull([
  { x: -1, y: -1, z: -1 }, { x: 1, y: -1, z: -1 },
  { x: -1, y: 1, z: -1 }, { x: 1, y: 1, z: -1 },
  { x: -1, y: -1, z: 1 }, { x: 1, y: -1, z: 1 },
  { x: -1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 },
]);

const result = contact(hullA, poseA, hullB, poseB);
// result = { distance, normal, pointA, pointB }，均为世界坐标。
```

- `Pose = { translation: Vec3, rotation: Quat }`，`Quat = { w, x, y, z }` 为单位四元数。
- 分离时：`distance` 为最短欧氏距离，`normal` 从 `pointA` 指向 `pointB`。
- 穿透时：`distance` 为负，绝对值是保持 A 不动、只平移 B 即可使两者内部不再相交的最小平移长度（含完全包含情形）。将 B 沿 `normal` 移动 `-distance` 恰好消除内部相交。
- `pointA`、`pointB` 分别位于两个凸体表面，且 `pointB - pointA === distance * normal`。
- 最优解不唯一时返回任意有效解。

## 实现概要

- **支撑函数**：`Hull` 只保存去重后的顶点集，支撑查询在顶点上取最大投影（内部点不影响结果）。
- **分离/恰接触**：GJK 距离算法（Johnson 单子形最近点子算法），直接给出距离与两侧见证点。
- **穿透**：EPA（扩展多面体算法）在 Minkowski 差上求穿透深度与分离法向；初始四面体由 GJK 终止单子形扩张得到，失败时回退到多种子构造；面片朝向以多面体内部参考点统一定向，原点位于面平面上的退化情形也能正确处理。
- **穿透见证点**：取两凸体在分离法向及其反向上的支撑面，对两个支撑面再跑一次 GJK 求最近点对，保证见证点严格位于各自表面上。

## 构建与测试

```sh
npm install
npm test        # 编译 TypeScript 并运行 node:test 测试
npm run build   # 仅构建库到 dist/
```

仅开发期依赖 `typescript` 与 `@types/node`，运行时零依赖。
