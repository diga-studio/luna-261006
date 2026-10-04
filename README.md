# saas-policy-eval

SaaS 配置策略判定库：策略编译（compile）与求值（evaluate）。TypeScript 实现，无运行时依赖。

## 数据布局

### Schema

```json
{
  "fields": {
    "flag":  { "kind": "bool" },
    "level": { "kind": "int", "min": 1, "max": 5 }
  }
}
```

整数字段为闭区间 `[min, max]`。

### 表达式（JSON 语法树）

| 形态 | 含义 |
| --- | --- |
| `{ "op": "const", "value": true|false }` | 布尔常量 |
| `{ "op": "and", "args": [Expr...] }` | 合取 |
| `{ "op": "or",  "args": [Expr...] }` | 析取 |
| `{ "op": "not", "arg": Expr }` | 否定 |
| `{ "op": "eq", "field": "f", "value": v }` | 字段与同类型常量相等（bool 或 int） |
| `{ "op": "lt", "field": "f", "value": n }` | 整数字段小于常量 |

表达式可任意嵌套、重复引用字段；同一字段的所有引用是同一个未知量。不支持字段互比。

### Policy / Snapshot

```json
{ "applicable": Expr, "required": Expr }
```

snapshot 是字段到已知值的部分映射；未出现的字段为未知，可取其域内任意值（未知不是假）。

## API

```ts
import { compile, evaluate } from "saas-policy-eval";

const compiled = compile(schema, policy);   // 可复用
const result = evaluate(compiled, snapshot);
// result.conclusion: "NA" | "Pass" | "Fail" | "Warning"
// result.witnesses: { pass?: Assignment, fail?: Assignment }
```

## 语义

合法补全：保留 snapshot 全部已知值，并给所有未知字段赋域内值的完整赋值。
适用补全：使 `applicable` 为真的合法补全。

- `NA`：没有适用补全（不返回补全）。
- `Pass`：存在适用补全，且 `required` 在其中始终为真（返回一个 required 为真的适用完整补全 `pass`）。
- `Fail`：存在适用补全，且 `required` 在其中始终为假（返回一个 required 为假的适用完整补全 `fail`）。
- `Warning`：required 为真、为假的适用补全各存在一个（`pass`、`fail` 各返回一个）。

适用性尚不确定不等于 `Warning`：例如 `applicable` 与 `required` 是同一可满足表达式时，即使所有字段都未知，结论也是 `Pass`。

判定是精确的：对 `applicable`、`applicable AND required`、`applicable AND (NOT required)`
分别做可满足性求解（三态求值 + DPLL 分支），由三个解的存在性组合出结论；
见证可直接用普通布尔求值独立核验。

## 构建与测试

```sh
npm install
npm test
```

测试对小字段域穷举全部合法补全作为独立判据核对四种结论，并用独立实现的
普通布尔求值核验全部返回见证；包含有重复引用、否定与不可满足适用条件的用例，
以及随机策略/快照的交叉核对。
