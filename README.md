# jpeg-privacy-export

供图片编辑器直接调用的 JPEG 隐私导出库（TypeScript）。输入输出均为图片字节，数据只在内存中处理，无任何外部依赖与服务。

## 能力

- **`previewMetadata(input)`**：预览净化导出后将保留的 EXIF 字段。
- **`exportSanitized(input)`**：净化导出，返回 `{ bytes, preview }`。`preview` 取自对导出结果的重新读取，与外部独立核对一致。

## 保留与删除

保留：
- EXIF 白名单：`Orientation`、`Make`、`Model`、`ExposureTime`、`FNumber`、`ISOSpeedRatings`、`FocalLength`，以及表达这些字段所需的目录指针（ExifIFD 指针）。字段缺失不补值；已有字段的类型、数量、值不变；保留方向信息，不旋转像素。
- 标准 JFIF 显示参数（版本、密度单位、X/Y 密度；JFIF 缩略图删除）。
- ICC 色彩配置（分段内容与顺序不变）与标准 Adobe APP14 颜色解释。
- 图像编码标记（SOF/DQT/DHT/SOS/DRI 等）与压缩扫描数据：逐字节保留，不重压缩。

删除：
- GPS、机主（Artist）、序列号、时间、版权、MakerNote、用户注释、嵌入缩略图（EXIF IFD1 与 JFIF）及其他非白名单 EXIF 字段。EXIF 整体重建，旧目录、填充区与不可达区域中的原始内容不会残留。
- XMP、IPTC、COM、JFXX 及其他 APP 段；首个 EOI 之后的尾随数据。

## 规则要点

- 仅支持 8 位 Huffman 基线（SOF0）与渐进式（SOF2）JPEG；其他编码方式直接失败。
- 支持经典 TIFF 两种字节序，目录内联与偏移引用的字段值。
- 同一保留字段在多个 EXIF 段中重复出现时，类型、数量及解码值全部一致才保留一份（有理数按分子/分母比较，ASCII 按字节比较），否则整体失败。
- JPEG 结构无法完整确定，或读取白名单字段所需的目录、指针、类型、值存在结构损坏时，预览与导出均抛 `JpegPrivacyError`，绝不返回原图或部分净化结果。
- 已净化结果再次导出逐字节不变（幂等）。

## 使用

```ts
import { previewMetadata, exportSanitized, JpegPrivacyError } from "jpeg-privacy-export";

try {
  const preview = previewMetadata(jpegBytes);      // { fields: [...] }
  const { bytes, preview: confirmed } = exportSanitized(jpegBytes);
  // bytes 即为可分享的净化 JPEG
} catch (err) {
  if (err instanceof JpegPrivacyError) {
    // 结构损坏 / 字段冲突 / 不支持的编码：整体失败，无候选图片产出
  }
}
```

## 构建与测试

```sh
npm install
npm test        # tsc 编译 + node --test
```

仅依赖 Node.js（>=18）与开发依赖 typescript、@types/node。
