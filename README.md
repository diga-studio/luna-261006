# mp3-probe

语音训练样本的流式 MP3 核验器。判断文件结构是否完整，并按有效样本数判断
时长是否落在闭区间 30–600 秒内。不做音频解码，也不包含上传、训练或账号功能。

## 使用

```ts
import { Mp3Probe } from "./src/mp3probe";

const probe = new Mp3Probe();
probe.push(chunk1); // Uint8Array，可为空，可在任意字节处分割
probe.push(chunk2); // 返回后调用方可立即复用该数组
const result = probe.finish();
// => { sampleRate, audioFrames, playableSamples, inRange }
```

结构错误抛出 `Mp3ProbeError`（携带稳定的 `code`，见 `src/errors.ts`），
不会返回部分扫描结果。

## 接受范围

- 仅 MPEG-1 Layer III、无 CRC、非自由码率；采样率与声道数全程一致，
  码率与 padding 可逐帧变化。
- 文件开头允许一个 ID3v2.3 / ID3v2.4 标签（按 synchsafe 长度跳过；
  v2.4 footer 会校验完整性与一致性）；文件末尾允许一个恰好 128 字节的
  ID3v1 标签。标签不得出现在音频帧之间，此外不允许任何杂字节。
- 首帧标准位置的 Xing/Info 只作为元数据载体：按标志位解析
  frames/bytes/TOC/quality（拒绝未知标志），并要求紧随的 36 字节 LAME
  扩展（第 21–23 字节给出 encoderDelay / endPadding）。
  `playableSamples = 音频帧数 × 1152 − encoderDelay − endPadding`，
  只扣减一次；声明的帧数 / 字节数会与实际扫描结果核对。
- `inRange` 按样本数精确比较 `30 × sampleRate ≤ playableSamples ≤ 600 ×
  sampleRate`，不做秒数四舍五入。

## 流式与内存

- 状态机逐帧推进，帧体与标签正文按长度跳过，不搜索同步字、不做重同步。
- 除当前 `push` 传入的数组外，额外保留的输入字节不超过 256 字节
  （远小于 64 KiB 上限）；可通过 `probe.bufferedBytes` 观测。
- 同样的字节流无论如何分块，结果完全一致。

## 开发

```sh
npm install   # 仅需 typescript（devDependency）
npm test      # tsc 编译 + node --test
```

测试不依赖任何音频文件，全部样本由 `test/helpers.ts` 程序化构造，
包括惰性生成的 128 MiB ID3 正文流式用例。
