# wp-config-compliance

只读的 WordPress 配置合规分析库（TypeScript）。输入为 `wp-config.php` 在加载
WordPress 之前的受限 PHP 配置片段，**不读取真实环境变量、不运行 PHP、不调用
eval/Function**，用符号执行 + SAT 判定证明：对所有可能的环境赋值，执行结束后
`DISALLOW_FILE_EDIT` 与 `FORCE_SSL_ADMIN` 是否都已定义且值为 `true`。

## 使用

```ts
import { analyze, evaluate } from 'wp-config-compliance';

const result = analyze(source);
// result.result: 'PASS' | 'FAIL' | 'CONDITIONAL'
// result.compliantWitness / result.nonCompliantWitness:
//   存在的合规 / 不合规情形各一个见证，包含源码引用的全部环境键

const out = evaluate(source, { WP_ENV: true });
// out.values.DISALLOW_FILE_EDIT / out.values.FORCE_SSL_ADMIN:
//   boolean | undefined（未定义与 false 严格区分）
// out.compliant: 两个目标常量均已定义且为 true
```

- `PASS`：所有环境赋值都合规；`FAIL`：所有赋值都不合规；`CONDITIONAL`：两种情形都存在。
- `evaluate(source, env)` 的 `env` 必须是完整赋值：键为环境键，布尔值表示
  `getenv('KEY') === '1'` 是否成立；缺少被引用的键会抛出 `SubsetError`。

## 输入子集

- 以 `<?php` 开头，不含结束标签；支持 `//`、`#`、`/* */` 注释与空语句 `;`。
- 语句：`define(名称, 布尔表达式);`、可嵌套的 `if (条件) { ... } [else { ... }]`，
  分支必须带花括号。
- 布尔表达式：`true`、`false`、括号、`!`、`&&`、`||`、`defined(名称)`，
  以及环境判断 `getenv('KEY') === '1'`。优先级沿用 PHP（`!` > `&&` > `||`）。
- 名称与键：PHP 单引号字符串（仅 `\\`、`\'` 转义）及点号拼接。
- 变量、循环、函数声明、文件包含等其他语法一律抛出 `SubsetError`，绝不静默跳过。

## 语义

- 开始时所有常量未定义；常量名区分大小写；同一路径上第一次 `define` 生效。
- `defined()` 只检查是否已定义，与常量值无关。
- 环境在一次执行中保持不变：相同键的判断相关，不同键相互独立。
- 条件读取执行到该位置时的常量状态。

## 实现要点

- `src/lexer.ts` / `src/parser.ts`：受限子集的词法与递归下降语法分析，子集外内容明确拒绝。
- `src/symbolic.ts`：符号执行。每个常量的“已定义”与“值为真”分别表示为环境原子上的
  布尔公式（哈希共享 DAG，规模随程序多项式增长；不枚举环境、不展开路径）。
- `src/formula.ts`：公式 DAG 的 Tseitin 编码 + DPLL 完备判定，给出分类与见证模型。
  三种结论均为精确判定，不抽样、不截断、不用超时冒充结论。
- `src/evaluate.ts`：给定完整环境赋值的受限语义具体执行器。

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js 与 `devDependencies` 中的 `typescript` / `@types/node`；
`npm test` 先编译再运行 `node --test`。
