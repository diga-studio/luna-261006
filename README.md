# task26100643

语音训练样本的流式 MP3 核验器（TypeScript）。只核验文件结构并按有效样本数判断
时长是否落在闭区间 [30s, 600s]，不做音频解码。

## 用法

```ts
import { Mp3Probe } from './src/mp3Probe';

const probe = new Mp3Probe();
probe.push(chunk); // Uint8Array，可为空、可在任意字节处分割，返回后调用方可复用
const { sampleRate, audioFrames, playableSamples, inRange } = probe.finish();
```

结构错误抛出 `Mp3ProbeError`（`src/errors.ts`，含 `code` 字段），不返回部分扫描结果。

## 接受范围

- 仅无 CRC、非自由码率的 MPEG-1 Layer III；采样率与声道数全程一致，码率/padding 可逐帧变化。
- 文件开头允许一个 ID3v2.3 / ID3v2.4 标签（v2.4 footer 会核验一致性）；末尾允许一个
  恰好 128 字节的 ID3v1 标签；此外不允许帧间或尾部杂字节。
- 首帧标准位置的 Xing/Info 仅作元数据载体：核验声明帧数/字节数，按 LAME 扩展中的
  encoderDelay / endPadding 扣减有效样本数。

## 约束实现

- 逐帧顺序扫描，不搜索同步字、不跳过损坏区域；标签与帧体中的伪同步字不产生音频帧。
- 除当前 `push` 传入的数组外，保留的输入字节不超过 64 KiB（实际 < 2 KiB）。
- 帧识别、标签边界核验与计时均为自行实现，无音频探测库依赖。

## 构建与测试

```sh
npm install
npm test   # tsc 编译 + node --test
```
