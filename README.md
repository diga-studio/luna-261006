# shopping-pack-optimizer

购物清单配包优化库（TypeScript）。由上层直接调用；购物清单、自有数量和商品库存
全部通过调用方传入的内存快照提供，库本身不做任何持久化，也不占用/扣减库存。

## 构建与测试

只需要 Node.js（>= 22）：

```sh
npm install
npm test        # 编译 src 与 test，并用 node:test 运行全部测试
npm run build   # 仅编译库到 dist/
```

## 使用

```ts
import { buildShoppingPlan, type ShoppingSnapshot } from "shopping-pack-optimizer";

const snapshot: ShoppingSnapshot = {
  demands: [
    { ingredientId: "flour", quantity: { value: "1", unit: "lb" } },
    { ingredientId: "flour", quantity: { value: "8", unit: "oz" } }, // 同一原料重复出现
  ],
  owned: [{ ingredientId: "flour", quantity: { value: "200", unit: "g" } }],
  skus: [
    { skuId: "flour-500g", ingredientId: "flour",
      size: { value: "500", unit: "g" }, priceCents: 300, stock: 5 },
  ],
};

const plan = buildShoppingPlan(snapshot);
// plan.ingredients[*] 给出每种原料的 demanded / owned / required /
// purchased / purchasedTotal / shortage / excess / totalPriceCents，
// 全部数量统一换算成 g 的十进制字符串，可精确解释缺口与超额量。
```

## 规则

- 同一 `ingredientId` 的需求先相加，再一次性扣除该原料自有数量，小于 0 按 0 处理；
  不同原料互不替代；缺口为 0 时不购买。
- 每个 SKU 只属于一种原料，包装不可拆分，同一 SKU 可买多包但不超过 `stock`。
- 单位支持 `g`、`kg`、`oz`、`lb`，数量为十进制字符串；
  1 kg = 1000 g，1 lb = 16 oz，1 oz = 28.349523125 g（精确）。
  内部全部使用 bigint 有理数运算，换算、缺口判断与方案比较无浮点误差。
- 每种原料独立配包，目标按严格字典序：
  1. 未补足量（shortage）最小——库存足以补齐时必须补齐；
  2. 总价（分）最低；
  3. 超额量（excess）最少；
  4. 购买包数最少。
  库存不足时首先让缺口最小（即买空相关库存），再依次比较其余三项。
- 价格为正整数分；非法输入（非正价格、负库存、非法十进制串、未知单位、
  净含量为 0）会抛出异常。

## 实现说明

- `src/rational.ts`：bigint 精确有理数（加减、比较、十进制解析与格式化）。
- `src/units.ts`：单位换算到克。
- `src/optimize.ts`：单原料配包搜索（带剪枝的深度优先枚举，目标为上述字典序）。
- `src/plan.ts`：需求汇总、扣自有、逐原料优化并组装可解释结果。
- 测试位于 `test/`，包含混合单位精确性、价格/库存场景，以及与全部合法组合
  暴力枚举对照的随机化一致性测试。
