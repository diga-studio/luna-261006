# sdp-negotiation-check

供 MeshComm 信令流程直接调用的 SDP offer/answer 协商核验库（TypeScript，纯内存，无接口层）。

## 使用

```ts
import { checkNegotiation } from "sdp-negotiation-check";

const result = checkNegotiation(offerSdp, answerSdp, "high");
// result.ok === false 时 result.reason 给出拒绝原因，转发应答前据此拦截
```

带宽预设：`"ultra-low"`(8000) / `"standard"`(24000) / `"high"`(64000) bit/s。
前两档下 answer 必须拒绝全部视频，否则整通协商判为不可接通。

也可分别使用 `parseSdp` 与 `verifyNegotiation` 两步调用。

## 核验规则概要

- 每条媒体必须有唯一 mid；answer 保持 offer 的媒体数量、顺序与逐项 mid。
- 端口 0 表示拒绝：offer 已拒绝的不能复活；answer 拒绝的媒体不参与其余核验。
- 双方各恰有一个 BUNDLE 组，成员恰为各自未拒绝媒体的 mid（顺序不限）。
- 至少一条已接受且方向非 inactive 的音频，整通才可接通。
- 媒体方向覆盖会话方向，均省略为 sendrecv；answer 收发须获 offer 对应许可；同层方向冲突即拒绝。
- answer 载荷编号须来自对应 offer 媒体，编码名（大小写不敏感）/时钟率/声道数一致；
  音频仅允许 opus/48000/2，视频仅允许 VP8/90000 与 rtx/90000；同媒体同编号映射冲突即拒绝。
- RTX 的 apt 两侧相同，且指向各自同媒体中已接受的 VP8 载荷。
- 每个已接受 Opus 须在 answer 中显式给出 maxaveragebitrate，不超过预设及 offer 显式上限。
- LF/CRLF、属性重排、编码名大小写不影响判定。

## 构建与测试

```sh
npm install
npm test
```
