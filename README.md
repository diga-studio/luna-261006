# jpeg-privacy-export

供图片编辑器直接调用的 JPEG 隐私导出库（TypeScript）。输入输出均为内存中的图片字节（`Uint8Array`），不读写磁盘、不启动任何服务。

## 能力

- `sanitizeJpeg(input)`：净化导出。删除 GPS、机主、序列号、时间、版权、MakerNote、用户注释、嵌入缩略图、XMP/IPTC/COM 及其他 APP 段、首个 EOI 之后的尾随数据；保留白名单 EXIF 字段、JFIF 显示参数、ICC 色彩配置（分段内容与顺序不变）和 Adobe 颜色解释。
- `previewKeptFields(input)`：预览将被保留的 EXIF 字段。与导出共用同一条解析路径，预览结果与导出后重新读取的结果一致。

## 保证

- 仅支持 8 位 Huffman 编码的基线（SOF0）与渐进式（SOF2）JPEG；其他编码方式整体失败。
- 图像编码标记（DQT/DHT/SOF/SOS/DRI 等）与压缩扫描数据逐字节不变，绝不重新压缩；扫描数据中的字节填充（0xFF）与重启标记（RSTn）不会被误认成元数据边界。
- EXIF 白名单：Orientation、Make、Model、ExposureTime、FNumber、ISOSpeedRatings、FocalLength，以及表达这些字段所需的 ExifIFD 目录指针。字段缺失不补值；已有字段的类型、数量、值不变；保留方向信息，不旋转像素。
- 支持经典 TIFF 两种字节序（II/MM）、目录内联值与偏移引用值。多个 EXIF 段中的同一保留字段，类型、数量、解码值全部一致才合并保留一份（有理数按分子/分母分别比较，ASCII 按字节比较），否则整个导出失败。
- 净化后的 TIFF 从白名单字段整体重建：旧目录、填充区、不可达区域中的原始内容（GPS IFD、MakerNote、缩略图 IFD1 等）不会残留。
- 已净化的结果再次导出逐字节不变（幂等）。
- JPEG 结构无法完整确定，或白名单字段所需的目录、指针、类型、值存在结构损坏时，预览与导出均抛出 `JpegPrivacyError`，绝不返回原图或部分净化结果。

## 使用

```ts
import { sanitizeJpeg, previewKeptFields, JpegPrivacyError } from "jpeg-privacy-export";

const kept = previewKeptFields(inputBytes); // KeptFieldPreview[]
const outputBytes = sanitizeJpeg(inputBytes); // Uint8Array
```

错误码：`INVALID_JPEG`（结构无法确定）、`UNSUPPORTED_JPEG`（超出支持范围）、`INVALID_EXIF`（EXIF 结构损坏）、`CONFLICTING_EXIF`（多段白名单字段冲突）。

## 构建与测试

只需要 Node.js（>= 22.18，利用原生 TypeScript 类型擦除运行测试）：

```sh
npm install   # 安装 devDependency typescript（仅构建需要）
npm test      # node --test，无需任何额外服务
npm run build # 输出 dist/（ESM + .d.ts）
```
