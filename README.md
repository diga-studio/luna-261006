# task26100640

SDP offer/answer 协商核验库（TypeScript，纯内存，无接口层），供 MeshComm 信令流程直接调用。

## 使用

```ts
import { verifyNegotiation } from "./src/index.js";

const result = verifyNegotiation(offerSdp, answerSdp, "high");
// result.ok === false 时，result.errors 列出全部不通过原因
```

带宽预设：`"ultra-low"`（8000 bit/s）、`"standard"`（24000 bit/s）、`"high"`（64000 bit/s）。
前两档要求全部视频被拒绝；每个已接受的 Opus 必须在 answer 中显式给出不超过预设、
也不超过 offer 上限的 `maxaveragebitrate`。

## 构建与测试

```sh
npm install
npm test
```
