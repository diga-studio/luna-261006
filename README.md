# pdf-watermark

证据 PDF 下载水印库。`watermark(input, label)` 接收 PDF 的 `Uint8Array`
和已拼好的水印文字（用户名 + UTC 时间，可打印 ASCII，可含圆括号和反斜杠），
通过**追加增量修订**为每一页添加居中的 Helvetica 水印，返回新的 `Uint8Array`。

## 特性

- 输出以输入的全部字节作为完全相同的前缀，输入缓冲区不被修改。
- 独立 PDF 读取器打开输出时，每页都有新增水印；页面顺序、内容、批注、
  元数据语义不变；对输出再次加水印会保留之前的水印。
- 支持 PDF 1.4–1.7 传统 xref 表、`Prev` 串联的多轮修订、非零对象代次、
  对象重定义（以最新有效对象为准）。不支持 xref 流、对象流、加密、
  数字签名与线性化结构。
- 页面树允许多层嵌套；`Resources`/`MediaBox`/`CropBox`/`Rotate` 可继承；
  `Contents` 支持单流、流数组、间接数组；流长度可为间接对象。
- 水印：Helvetica 18pt、50% 灰、不透明，在旋转后的可见页坐标中水平绘制，
  文字基线中点落在 CropBox 中心；超出可见页宽 80% 时仅缩小字号。
- 原内容遗留的变换、裁剪、透明度状态通过包裹 `q`/`Q` 流隔离；
  字体等资源以新字典合并（复制引用），绝不修改共享资源对象。

## 用法

```ts
import { watermark } from "pdf-watermark";

const output: Uint8Array = watermark(inputBytes, "ivan(1)\\2026-10-04T00:00:00Z");
```

## 实现结构

- `src/pdf/parser.ts` — PDF 对象语法解析（字典/数组/字符串/流，间接长度）
- `src/pdf/xref.ts` — startxref/Prev 链与传统 xref 表合并
- `src/pdf/document.ts` — 对象解析访问、页面树遍历与属性继承
- `src/pdf/serialize.ts` — 对象再序列化（未改动叶子保留原始字节）
- `src/pdf/helvetica.ts` — 标准 Helvetica 字宽表
- `src/watermark.ts` — 增量修订组装与每页水印流生成

## 构建与测试

```sh
npm install   # 全部依赖为 vendor/ 内的本地 tarball，无需网络
npm test      # 类型检查 + node:test（Node >= 22.18）
npm run build # 产出 dist/
```

测试使用独立的 PDF 读取器/渲染器（pdf.js + @napi-rs/canvas）验证输出：

- `test/incremental.test.ts` — 两轮既有修订（后一次替换页面内容与资源、
  间接流长度、非零代次）；验证最新内容生效、前缀逐字节相同、
  水印转义字符、批注与元数据保留、重复加水印。
- `test/render.test.ts` — 共享资源的多层页面树、四种旋转、非零 CropBox
  原点、既有字体资源名；原内容遗留变换/裁剪/透明度；实际渲染逐像素
  对比验证水印位置、外观与原始内容不变。
