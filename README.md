# CartForge

跨店最优优惠计算库（纯 Python 标准库，无第三方依赖）。只处理一次结算内的
优惠选择：输入已按店汇总，优惠均在有效期内，计算期间输入不变。所有金额
均为整数分，全程整数运算，不使用浮点。

## 接口

- `quote(stores, codes)`：返回 `QuoteResult(plan, breakdowns, total)`，
  即最优优惠方案、每店各阶段金额（原价/满减后/百分比券后/固定券后）、
  运费与总实付。允许不使用任何优惠；最优解不唯一时任取一个。
- `evaluate(stores, codes, plan)`：不优化，只校验并核算指定方案；重复
  用券、门槛不满足、券不适用该店等非法方案抛出 `InvalidPlanError`，
  不会自动修正。金额一律从输入重算，不信任 plan 携带的数据。

## 计算规则

- 每店严格按 满减活动 → 百分比券 → 固定券 顺序计算；每步门槛用该步
  执行前的商品金额判断。满减与固定减免不会把金额减到负数。
- 百分比券比例为 1..50 的整数，减免额 = 当前金额 × 比例 // 100（向下
  取整到分）。
- 三步后商品金额达到免运门槛则运费为零，否则收基础运费；总实付为各店
  最终商品金额与运费之和。
- 每券整个方案最多用一次；同店最多一个满减活动、一张百分比券、一张
  固定券，各类均可不选。

## 算法

对共享券集合做精确子集 DP：每店枚举所有可用的本地组合（活动 × 百分比
券 × 固定券），按券使用掩码保留最低成本并做支配剪枝，再跨店合并。不
截断候选、不做局部贪心预提交、不枚举笛卡尔积。规模 24 店 × 16 活动 ×
12 券时实测 CPU < 0.3s，峰值内存 < 30 MiB。

## 用法

```python
from cartforge import Coupon, Store, quote, evaluate

stores = [
    Store(id="A", goods_amount=1000, base_shipping=0, free_shipping_threshold=0),
    Store(id="B", goods_amount=1000, base_shipping=0, free_shipping_threshold=0),
]
codes = [
    Coupon(id="P", store_ids=frozenset({"A", "B"}), min_amount=0, percent=50),
    Coupon(id="F", store_ids=frozenset({"A"}), min_amount=800, value=400),
]
result = quote(stores, codes)
assert result.total == 1100
checked = evaluate(stores, codes, result.plan)  # 校验并核算同一方案
```

## 测试

```sh
python3 -m unittest discover -s tests -v
```

包含：两个规定用例、固定随机种子的独立穷举对照（覆盖整分舍入、门槛
恰好相等、跨店竞争），以及 24 店 × 16 活动 × 12 券的最大规模性能测试
（断言 CPU < 10s、峰值内存 < 256 MiB）。
