# CartForge

跨店最优优惠计算库（纯 Python 标准库，无第三方依赖）。只处理一次结算内的优惠选择。

## 数据格式

金额均为整数分。`stores` 已按店汇总：

```python
stores = [{
    "id": "A",                      # 店铺唯一 id
    "subtotal": 1000,               # 商品原价合计（分）
    "shipping": 100,                # 基础运费（分）
    "free_shipping_threshold": 500, # 免运门槛（分，按优惠后商品金额判断）
    "promos": [{"id": "m1", "threshold": 900, "discount": 100}],  # 店内满减
}]

codes = [
    {"id": "P", "type": "percent", "percent": 50, "threshold": 0,
     "shop_ids": ["A", "B"]},       # percent 为 1..50 的整数
    {"id": "F", "type": "fixed", "value": 400, "threshold": 800,
     "shop_ids": ["A"]},
]
```

## API

```python
from cartforge import quote, evaluate, InvalidPlanError

result = quote(stores, codes)
# result["total"]   所有合法方案中的最低总实付
# result["plan"]    {店铺id: {"promo":…, "percent_code":…, "fixed_code":…}}
# result["stores"]  每店各阶段金额：original / after_promo / after_percent /
#                   after_fixed / shipping / total

check = evaluate(stores, codes, result["plan"])  # 从输入重算，不信 plan 金额
# 非法方案（重复用券、门槛不满足、券不适用该店、类型槽位错误等）
# 抛出 InvalidPlanError，绝不自动修正
```

## 计算规则

- 每店严格按 满减 → 百分比券 → 固定券 顺序；每步门槛按该步执行前的商品金额判断。
- 满减/固定券不把金额减到负数；百分比减免 = `amount * percent // 100`（向下取整）。
- 三步后商品金额达到免运门槛则运费为零，否则收基础运费。
- 每券整次结算最多用一次；同店最多一个满减、一张百分比券、一张固定券，均可不选。

## 最优性

`quote` 使用位掩码 DP 联合优化「券的全局分配」与「每店的满减/用券选择」：
不先固定局部最优、不截断候选、不做笛卡尔积全量遍历、不用浮点数。
规模 24 店 × 16 满减 × 12 券时单次 quote 实测约 0.1s CPU、峰值内存约 28MiB。

## 测试

```bash
python3 -m unittest discover -s tests -v
```

包含：两个规定场景、非法方案拒绝、整分舍入与门槛恰等、
固定种子小规模穷举对照（独立枚举全部合法方案）、最大规模性能测试。
