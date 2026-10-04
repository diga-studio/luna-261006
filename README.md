# wp-config-compliance

只读的 WordPress `wp-config.php` 配置合规分析库（TypeScript）。
输入为加载 WordPress 之前的受限 PHP 配置片段；不读取真实环境变量、
不运行 PHP、不使用 `eval`/`Function`。

对所有可能的环境赋值证明：执行结束后 `DISALLOW_FILE_EDIT` 与
`FORCE_SSL_ADMIN` 是否都已定义且值为 `true`。

## API

```ts
import { analyze, evaluate } from "wp-config-compliance";

const result = analyze(source);
// result.verdict: "PASS" | "FAIL" | "CONDITIONAL"
//   PASS         全部环境赋值都合规
//   FAIL         全部环境赋值都不合规
//   CONDITIONAL  两种情形都存在
// result.compliantWitness / result.nonCompliantWitness:
//   存在的合规 / 不合规情形各返回一个见证，
//   见证 env 覆盖源码引用的全部环境键。

const out = evaluate(source, { SOME_KEY: true });
// out.constants.DISALLOW_FILE_EDIT / FORCE_SSL_ADMIN:
//   { defined: boolean, value: boolean }（未定义与 false 严格区分）
// out.compliant: boolean
// env 中的布尔值表示对应 getenv('KEY') === '1' 判断是否成立。
```

## 支持的输入子集

- 以 `<?php` 开始标签开头，不含结束标签。
- PHP 注释（`//`、`#`、`/* */`）、空语句、`define(name, boolExpr)`，
  以及必须带花括号、可嵌套、可选 `else` 的 `if`。
- 布尔表达式：`true`、`false`、括号、`!`、`&&`、`||`、
  `defined('NAME')`、`getenv('KEY') === '1'`（PHP 优先级）。
- `define`/`defined`/`getenv` 的名称为 PHP 单引号字符串，支持 `.` 拼接。
- 其他一切语法（变量、循环、函数、包含、双引号字符串等）明确拒绝。

## 语义

- 开始时所有常量未定义；常量名区分大小写。
- 同一路径上第一次 `define` 生效，后续同名 `define` 不改变值。
- `defined()` 只检查是否已定义，与值是否为 `false` 无关。
- 环境在一次执行中保持不变；相同键的判断相关，不同键独立。
- 条件读取执行到该位置时的常量状态。

## 实现

- `analyze` 使用 ROBDD（简约有序二叉决策图）做符号执行：
  每个常量的"已定义性"和"值"都是环境键上的 BDD，
  不枚举环境组合、不展开执行路径，支持 64 个环境键、5000 条语句。
- `evaluate` 是按给定完整环境赋值的具体解释器。

## 构建与测试

```sh
npm install
npm test        # 编译后运行 node:test 测试套件
```

仅依赖 `typescript`（devDependency），运行时使用 Node.js 内置
`node:test`，无其他外部服务。
