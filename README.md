# policy-eval

SaaS 配置策略判定库：策略编译与求值。缺失字段表示**未知**（不是假），
判定精确考虑所有合法补全；同一字段在不同表达式位置的引用是同一个未知量。

## 构建与测试

```sh
npm install
npm test        # tsc 编译 + node --test 运行
```

只依赖 Node.js 与 devDependency `typescript`，无需任何服务。

## 数据布局

### Schema

```jsonc
{
  "ssl_enabled": { "type": "boolean" },
  "max_conn":    { "type": "integer", "min": 1, "max": 65535 }
}
```

- `boolean` 字段：域为 `{false, true}`
- `integer` 字段：域为闭区间 `[min, max]` 内的整数

### Snapshot

字段到已知值的部分映射。未出现的字段为未知，可取其域内任意值。

```jsonc
{ "ssl_enabled": true }   // max_conn 未知
```

### Policy 表达式（JSON 语法树）

```jsonc
{
  "applicable": { "kind": "lt", "field": "max_conn", "value": 1024 },
  "required":   { "kind": "eq", "field": "ssl_enabled", "value": true }
}
```

| kind     | 字段                | 含义                              |
|----------|---------------------|-----------------------------------|
| `const`  | `value: boolean`    | 布尔常量                          |
| `and`    | `args: Expr[]`      | 合取（任意多个）                  |
| `or`     | `args: Expr[]`      | 析取（任意多个）                  |
| `not`    | `arg: Expr`         | 否定                              |
| `eq`     | `field`, `value`    | 字段等于同类型常量（bool 或 int） |
| `lt`     | `field`, `value`    | 整数字段 `<` 整数常量             |

不支持字段互比；表达式可任意嵌套、重复引用同一字段。

## API

```ts
import { compile, evaluate } from "policy-eval";

const compiled = compile(schema, { applicable, required }); // 可复用
const result = evaluate(compiled, snapshot);
```

### 结论

合法补全保留全部已知值，并给所有未知字段赋域内值；
只考察 `applicable` 为真的补全（适用补全）：

| 结论      | 含义                                             |
|-----------|--------------------------------------------------|
| `NA`      | 没有适用补全                                     |
| `Pass`    | 存在适用补全，且 `required` 在其中始终为真       |
| `Fail`    | 存在适用补全，且 `required` 在其中始终为假       |
| `Warning` | 存在 `required` 分别为真和假的适用补全           |

适用性尚不确定 ≠ `Warning`：例如 `applicable` 与 `required` 是同一可满足
表达式时，即使所有字段都未知，结论仍为 `Pass`。

### 见证

- `Pass` → `{ conclusion, witness }`：`applicable ∧ required` 为真的完整补全
- `Fail` → `{ conclusion, witness }`：`applicable ∧ ¬required` 为真的完整补全
- `Warning` → `{ conclusion, passWitness, failWitness }` 各一个
- `NA` → 不返回补全

见证是完整补全（所有字段有值、保留已知值、域内取值），可用普通布尔求值
`evalExpr` 独立核验。

## 实现要点

表达式对某字段的原子引用（`eq` / `lt` 常量）把该字段的域划分为若干等价
单元，同一单元内所有值对每个原子的真值完全相同。`compile` 预计算每个被
引用字段的单元代表值；`evaluate` 只对代表值做笛卡尔积枚举（已知值固定），
即可精确覆盖全部合法补全，且与整数域大小无关。
