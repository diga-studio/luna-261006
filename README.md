# bom-versioning

进程内的 BOM 版本发布组件（TypeScript，全内存、调用串行、无持久化）。

- `publishBatch(revisions)`：整批加入若干版本；按批次加入后的最终时间表判定，
  任何一天生效边成环则拒绝整个批次（原时间表不变），并返回实际成环的整数日与
  当日成立的闭合物料路径。
- `bomAt(assemblyId, day)`：返回当天生效的直接 BOM 版本，没有则返回 `null`。

## 使用

```bash
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

```ts
import { BomService } from "./src";

const bom = new BomService();
bom.publishBatch([
  { assemblyId: "A", startDay: 10, components: ["B"] },
  { assemblyId: "A", startDay: 20, components: [] },
  { assemblyId: "B", startDay: 20, components: ["A"] },
]); // { ok: true } —— 分时反向，任何一天都不成环

bom.bomAt("A", 15); // { assemblyId: "A", startDay: 10, components: ["B"] }
```

设计思路与复杂度见 [DESIGN.md](DESIGN.md)。
