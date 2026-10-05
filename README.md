# DoodleSpark SVG 图章导入库

将含 `<use>` 引用的 SVG 图章消解为可重复嵌入画布的独立 SVG。不包含上传接口或渲染器。

## API

- `validateStamp(bytes: Uint8Array): { width, height, nodes }`
  校验图章，返回根尺寸（px）与逻辑展开节点数；拒绝时抛出 `StampError`。
- `normalizeStamp(bytes: Uint8Array): string`
  返回不含 `use`、`defs`、`id` 及引用属性的独立 SVG 字符串。
  两个操作的接受/拒绝判定完全一致（共用同一条处理管线）。

## 规则摘要

- 输入：≤512KiB 的 UTF-8 XML；允许 BOM、注释、预定义/数字实体、XML 声明；拒绝 DTD、自定义实体、处理指令、CDATA。
- 元素：`svg`（仅根）、`g`、`defs`（仅根的子元素）、`use`、`path`、`rect`、`circle`，必须属于 SVG 命名空间（按 URI 解析，不按前缀猜测）。
- 根 `width`/`height` 为 1–4096 的整数（可带 `px`），`viewBox` 可选。
- `use` 支持 `x`、`y`、`transform`、`href` 与 `xlink:href`（两者同时存在时解码后必须一致）；仅允许 `#id` 本地引用，允许前向引用。
- `use` 的 `fill`/`stroke`/`stroke-width` 向目标继承（目标自身声明优先），`opacity` 保留为分组透明度；实例变换顺序：目标自身变换 → `translate(x, y)` → `use` 的 `transform`。
- 逻辑展开 ≤10000 节点（提前中止计数，可达引用环因此被拒绝），输出 ≤4MiB（生成过程中增量检查）。

## 开发

```sh
npm install
npm test        # 编译 src/ 与 test/ 后运行 node:test 测试
npm run build   # 仅编译到 dist/
```
