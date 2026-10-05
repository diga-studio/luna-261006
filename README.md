# pdf-region-redact

一个 TypeScript 的 PDF 区域脱敏库：先 `preview` 预览命中字形，再 `burnIn` 把命中字形从内容流中**真正删除**（不是遮盖）。重点支持同一个 Form XObject 被多处复用时，只脱敏指定绘制实例，其余实例原样保留。

## 构建与测试

```sh
npm install
npm test        # 编译 src/ 与 test/ 并运行 node:test 测试
npm run build   # 仅编译到 dist/
```

只依赖 Node.js（>=18）与 npm 包 `@cantoo/pdf-lib`（pdf-lib 的维护分支）、`typescript`。

## API

```ts
import { preview, burnIn, Region, GlyphHit } from 'pdf-region-redact';

const hits: GlyphHit[] = await preview(pdfBytes, regions);
const outBytes: Uint8Array = await burnIn(pdfBytes, regions);
```

- `preview(pdfBytes, regions)`：返回所有命中字形的页码与四边形坐标；同一字形被同一 Form 在不同位置绘制时，每个绘制实例独立列出。
- `burnIn(pdfBytes, regions)`：返回删除命中字形后的新 PDF 字节。与 `preview` 使用同一份几何分析代码，命中集合完全一致。输入字节数组不会被修改。

```ts
interface Region { page: number; x: number; y: number; width: number; height: number; }
interface GlyphHit { page: number; quad: [Point, Point, Point, Point]; }
```

## 坐标约定

- `page` 为 **0 基**页码。
- Region 与输出四边形使用同一坐标系：**页面按 Rotate 旋转后的可见区域（CropBox）左上角为原点，x 向右、y 向下，单位 pt**。库内部把 PDF 用户空间坐标经 CropBox 偏移与 0/90/180/270 度旋转映射到该坐标系。
- 字形命中框固定为 Courier 字形空间中横向 `[0, 600]`、纵向 `[-200, 800]` 的矩形，经当前文字矩阵（Tm）、图形状态矩阵（CTM，含所有祖先 Form 的 Matrix 与 cm）以及页面视图变换后得到四边形。
- 命中判定：四边形与任一 Region 的**相交面积 > 0** 即命中整个字形；仅边界接触（面积为 0）不命中。多个 Region 重复命中同一字形只计一次、只删一次。

## 真正删除的实现方式与保证

- **删除而非隐藏**：命中字形从内容流的 `Tj`/`TJ` 操作数中移除；不使用黑框覆盖、透明文字、栅格化或轮廓化。
- **位置保持**：删除 `TJ` 中的字形时插入补偿位移数（每个被删字形 −600，即 600/1000 em 的前进量），被删字形原本占据的前进距离与原有位移继续作用于后续文字；未命中字形的字符、字体、绘制顺序与显示位置不变（测试验证位置误差 ≤ 0.01 pt）。
- **共享 Form 按实例克隆**：命中位于被多处复用的 Form 内时，库沿 Do 调用路径向上克隆该实例的 Form 流（含嵌套、跨页共享、同名资源遮蔽的情形），仅在命中实例的 Do 处改指向克隆体；其余实例继续引用原始流，合法文字完整保留。
- **无残留**：被替换的旧内容流与一切失去引用的对象在保存前经可达性垃圾回收删除；输出为整体重写，不含增量保存历史。测试会遍历输出的全部对象（解码所有流、检查所有字符串对象、校验无不可达对象）确认被删文字不存在于任何角落。其他未脱敏实例合法保留的相同文本不属于泄漏。

## 输入范围（保证边界）

库仅保证对以下输入成立：未加密的文本型 PDF；唯一字体为未嵌入的标准 Courier（WinAnsiEncoding，可打印 ASCII）；每页一条内容流；页面与 Form 内容流只含 `q Q cm BT ET Tf Tm Td Tj TJ Do`，字符串为字面或十六进制形式；流不压缩或 FlateDecode；无图片、注释、附件、元数据与增量历史。Form 可嵌套、跨页共享、同名资源遮蔽；矩阵可含旋转、错切、非等比缩放；每条流图形状态与文本块自平衡，`Do` 只出现在文本块外；页面允许非零 CropBox 与 0/90/180/270 度旋转；字形完整位于 CropBox 及祖先 Form 的 BBox 内（不处理裁剪）。

超出上述范围（如其他字体、编码、操作符、图片型 PDF）不在保证之内。

## 目录结构

- `src/content.ts` — 受限内容流语法的 tokenizer/parser 与序列化
- `src/walker.ts` — 页面/嵌套 Form 几何遍历，计算每个字形实例的视图坐标四边形
- `src/analyze.ts` — 四边形与 Region 的相交面积命中判定
- `src/rewrite.ts` — 按实例克隆并重写内容流，删除命中字形并补偿位移
- `src/pdfdoc.ts` — pdf-lib 辅助：页面盒子/旋转、资源继承、流替换、垃圾回收
- `test/redact.test.ts` — 端到端测试（生成真实 PDF、脱敏、重新解析验证）
