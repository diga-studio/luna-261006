# DoodleSpark SVG 图章导入库

将含 `<use>` 引用的受限 SVG 图章消解为可重复嵌入画布的独立 SVG。仅提供校验与归一化，不包含上传接口或渲染器。

## 环境要求

- Node.js >= 23.6（使用内置类型擦除直接运行 TypeScript，零依赖）
- `npm install` 后 `npm test` 即可运行全部测试

## API

```ts
import { validateStamp, normalizeStamp, StampError } from "./src/index.ts";

// 校验：返回根尺寸与逻辑展开节点数；非法输入抛出 StampError
const info: { width: number; height: number; nodeCount: number } = validateStamp(bytes);

// 归一化：返回不含 use / defs / id / 引用属性的独立 SVG 字符串
const svg: string = normalizeStamp(bytes);
```

两个操作共用同一条处理流水线，接受与拒绝判定完全一致。

## 输入约束

- 不超过 512 KiB 的 UTF-8 XML；允许 BOM、注释、预定义实体与数字实体
- 拒绝 DTD、自定义实体、CDATA 与处理指令（XML 声明除外）
- 仅支持 SVG 命名空间中的 `svg` / `g` / `defs` / `use` / `path` / `rect` / `circle`
- `svg` 只能为根；`defs` 只能是根的子元素；根 `width`/`height` 为 1–4096 的整数（可带 `px`）
- 属性白名单：几何属性、`id`、`transform`、`fill`、`stroke`、`stroke-width`、`opacity`、根尺寸与 `use` 的 `x`/`y`/`href`/`xlink:href`
- `fill`/`stroke` 仅支持 `none` 或六位十六进制颜色
- 引用只能是 `#id`，目标须为文档内 `g`/`use`/图形；允许前向引用；重复 id、悬空引用、外部引用均拒绝
- 逻辑展开不超过 10000 节点；归一化输出不超过 4 MiB

## 消解语义

- `use` 的 `fill`/`stroke`/`stroke-width` 向目标继承，目标自身声明优先；`opacity` 以分组透明度包裹实例
- 实例变换顺序：目标自身变换 → `use` 的 `x`/`y` 平移 → `use` 的 `transform` → 外层变换
- 只引入目标及其后代，不带目标原有祖先的样式或变换
- 从根可见内容可达的引用环拒绝；未被引用的 `defs` 中的环接受
