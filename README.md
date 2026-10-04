# task26100653

进程内 BOM 版本发布组件（TypeScript）。保证任意生效时刻的有效 BOM 图
无环，同时允许不同时间段的装配关系互相反向。设计说明见 `DESIGN.md`。

```ts
import { BomService } from "./src/bomService";

const bom = new BomService();
const result = bom.publishBatch([
  { assemblyId: "A", startDay: 10, components: ["B"] },
]);
if (!result.ok) {
  console.log(result.witness.day, result.witness.path); // 闭环日与闭合物料路径
}
const version = bom.bomAt("A", 10); // { assemblyId, startDay, components } | null
```

## 构建与测试

```sh
npm install
npm test
```
