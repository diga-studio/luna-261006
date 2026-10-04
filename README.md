# mp4-release-verify

本地视频流水线的 MP4 成片核验库（TypeScript）。上层在任务登记完成前调用，
核实文件中的每一帧确实来自本次生成、播放时间轴准确，且各头声明的时长与
可信帧清单完全一致。只读核验，不修改输入文件，不生成或解码画面。

## 使用

```ts
import { verifyFile, VerifyError } from 'mp4-release-verify';

const manifest = {
  width: 320,
  height: 240,
  frameRate: 24,            // 12 | 24 | 30
  durationSeconds: 5,       // 5..30 的 5 秒倍数
  frameSha256: [/* 按展示顺序的每帧 SHA-256（小写 hex） */],
};

try {
  const { frameCount } = await verifyFile('/path/to/output.mp4', manifest);
  // 核验通过
} catch (err) {
  if (err instanceof VerifyError) {
    // err.code: BOX_STRUCTURE | UNSUPPORTED | TRACK_LAYOUT | SAMPLE_TABLE
    //           | TIMELINE | DURATION_MISMATCH | GEOMETRY_MISMATCH
    //           | FRAME_COUNT_MISMATCH | HASH_MISMATCH | BAD_MANIFEST | IO
  }
}
```

## 核验内容

- 结构：box 边界合法（普通/扩展长度、末尾长度 0），moov 可在 mdat 前后，
  允许多个 mdat；拒绝分片（moof/mvex）、加密（sinf/schm/tenc）、多轨。
- 样本落点：每帧一个 AVC 样本，完整位于某个 mdat 载荷内且互不重叠；
  stco/co64、stsc、stsz（定长/逐样本）计数一致；块可不按文件位置递增。
- 时间轴：stts 解码时刻 + ctts（v0/v1，可缺省）组合偏移得到展示时刻，
  按真实展示顺序核对清单；展示时刻不得重复；elst 缺省或单个速率 1、
  媒体起点非负的片段；第 i 帧恰在 i/fps 秒，每样本解码持续 1/fps 秒。
- 时长：mvhd/tkhd/mdhd/elst 声明的时长按各自时间尺度精确等于清单时长
  （BigInt 整数比较，无舍入容差）。
- 内容：avc1 宽高与全部样本 SHA-256（覆盖 MP4 中的完整样本字节）与清单一致。

## 资源约束

- 元数据（moov）超过 2 MiB 拒绝；样本按 ≤1 MiB 块流式哈希，常驻内存有界。
- 文件可达 8 GiB；有效样本 ≤1 MiB 时单文件核验在 2 秒内完成（有测试覆盖）。

## 开发

```sh
npm install
npm test        # 编译 + node:test 全量测试（含 >4 GiB 稀疏文件用例）
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js（>=18）与 devDependency typescript；不依赖本机其他服务。
