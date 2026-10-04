import { test } from "node:test";
import assert from "node:assert/strict";
import { checkNegotiation } from "../src/index.js";
import type { BandwidthPreset } from "../src/index.js";

const OFFER = [
  "v=0",
  "o=- 1 1 IN IP4 0.0.0.0",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE a1 v1",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 96",
  "a=mid:a1",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 maxaveragebitrate=20000",
  "a=rtpmap:96 PCMU/8000",
  "m=video 9 UDP/TLS/RTP/SAVPF 96 97",
  "a=mid:v1",
  "a=rtpmap:96 VP8/90000",
  "a=rtpmap:97 rtx/90000",
  "a=fmtp:97 apt=96",
].join("\r\n");

const ANSWER_FULL = [
  "v=0",
  "o=- 2 2 IN IP4 0.0.0.0",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE a1 v1",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=mid:a1",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 maxaveragebitrate=20000",
  "m=video 9 UDP/TLS/RTP/SAVPF 96 97",
  "a=mid:v1",
  "a=rtpmap:96 VP8/90000",
  "a=rtpmap:97 rtx/90000",
  "a=fmtp:97 apt=96",
].join("\r\n");

const ANSWER_AUDIO_ONLY = [
  "v=0",
  "o=- 2 2 IN IP4 0.0.0.0",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE a1",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=mid:a1",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 maxaveragebitrate=8000",
  "m=video 0 UDP/TLS/RTP/SAVPF 96 97",
  "a=mid:v1",
].join("\r\n");

function run(
  offer: string,
  answer: string,
  preset: BandwidthPreset = "high",
) {
  return checkNegotiation(offer, answer, preset);
}

test("同一载荷编号在音频(PCMU)和视频(VP8)中含义不同，仍能接通", () => {
  const result = run(OFFER, ANSWER_FULL);
  assert.equal(result.ok, true, result.reason);
});

test("编码名大小写变化不影响判定", () => {
  const answer = ANSWER_FULL.replace("opus/48000/2", "OPUS/48000/2").replace(
    "VP8/90000",
    "vp8/90000",
  );
  assert.equal(run(OFFER, answer).ok, true);
});

test("LF 与 CRLF 换行判定一致", () => {
  const lf = (s: string) => s.replace(/\r\n/g, "\n");
  assert.equal(run(lf(OFFER), lf(ANSWER_FULL)).ok, true);
  assert.equal(run(lf(OFFER), ANSWER_FULL).ok, true);
});

test("有效的属性重排不影响判定", () => {
  const offer = [
    "v=0",
    "o=- 1 1 IN IP4 0.0.0.0",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE a1 v1",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 96",
    "a=rtpmap:96 PCMU/8000",
    "a=fmtp:111 maxaveragebitrate=20000",
    "a=rtpmap:111 opus/48000/2",
    "a=mid:a1",
    "m=video 9 UDP/TLS/RTP/SAVPF 96 97",
    "a=fmtp:97 apt=96",
    "a=rtpmap:97 rtx/90000",
    "a=mid:v1",
    "a=rtpmap:96 VP8/90000",
  ].join("\r\n");
  assert.equal(run(offer, ANSWER_FULL).ok, true);
});

test("保留 RTX 却删除其 apt 指向的主载荷时必须拒绝", () => {
  const answer = [
    "v=0",
    "o=- 2 2 IN IP4 0.0.0.0",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE a1 v1",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "a=mid:a1",
    "a=rtpmap:111 opus/48000/2",
    "a=fmtp:111 maxaveragebitrate=20000",
    "m=video 9 UDP/TLS/RTP/SAVPF 97",
    "a=mid:v1",
    "a=rtpmap:97 rtx/90000",
    "a=fmtp:97 apt=96",
  ].join("\r\n");
  const result = run(OFFER, answer);
  assert.equal(result.ok, false);
});

test("改为拒绝整个视频后可保留语音接通", () => {
  assert.equal(run(OFFER, ANSWER_AUDIO_ONLY).ok, true);
  assert.equal(run(OFFER, ANSWER_AUDIO_ONLY, "standard").ok, true);
  assert.equal(run(OFFER, ANSWER_AUDIO_ONLY, "ultra-low").ok, true);
});

test("超低与标准预设必须拒绝全部视频", () => {
  assert.equal(run(OFFER, ANSWER_FULL, "standard").ok, false);
  assert.equal(run(OFFER, ANSWER_FULL, "ultra-low").ok, false);
});

test("已接受 Opus 缺少显式 maxaveragebitrate 时拒绝", () => {
  const answer = ANSWER_FULL.replace("a=fmtp:111 maxaveragebitrate=20000\r\n", "");
  assert.equal(run(OFFER, answer).ok, false);
});

test("maxaveragebitrate 超过预设上限时拒绝", () => {
  const answer = ANSWER_FULL.replace(
    "maxaveragebitrate=20000",
    "maxaveragebitrate=80000",
  );
  assert.equal(run(OFFER, answer).ok, false);
});

test("maxaveragebitrate 超过 offer 显式上限时拒绝", () => {
  const offer = OFFER.replace("maxaveragebitrate=20000", "maxaveragebitrate=16000");
  assert.equal(run(offer, ANSWER_FULL).ok, false);
});

test("offer 未给出上限时只受预设限制", () => {
  const offer = OFFER.replace("a=fmtp:111 maxaveragebitrate=20000\r\n", "");
  const answer = ANSWER_FULL.replace(
    "maxaveragebitrate=20000",
    "maxaveragebitrate=64000",
  );
  assert.equal(run(offer, answer).ok, true);
});

test("answer 媒体 mid 与 offer 不一致时拒绝", () => {
  const answer = ANSWER_FULL.replace("a=mid:v1", "a=mid:v2");
  assert.equal(run(OFFER, answer).ok, false);
});

test("offer 已拒绝的媒体不能复活", () => {
  const offer = OFFER.replace(
    "m=video 9 UDP/TLS/RTP/SAVPF 96 97",
    "m=video 0 UDP/TLS/RTP/SAVPF 96 97",
  ).replace("a=group:BUNDLE a1 v1", "a=group:BUNDLE a1");
  assert.equal(run(offer, ANSWER_FULL).ok, false);
  assert.equal(run(offer, ANSWER_AUDIO_ONLY).ok, true);
});

test("answer 接收未获 offer 发送许可时拒绝", () => {
  const offer = OFFER.replace("a=mid:a1", "a=mid:a1\r\na=recvonly");
  const answer = ANSWER_FULL.replace("a=mid:a1", "a=mid:a1\r\na=recvonly");
  assert.equal(run(offer, answer).ok, false);
});

test("方向互补时接通，媒体方向覆盖会话方向", () => {
  const offer = OFFER.replace("t=0 0", "t=0 0\r\na=recvonly");
  const answer = ANSWER_FULL.replace("a=mid:a1", "a=mid:a1\r\na=sendonly").replace(
    "a=mid:v1",
    "a=mid:v1\r\na=sendonly",
  );
  assert.equal(run(offer, answer).ok, true);
});

test("全部音频 inactive 时整通拒绝", () => {
  const answer = ANSWER_AUDIO_ONLY.replace("a=mid:a1", "a=mid:a1\r\na=inactive");
  assert.equal(run(OFFER, answer).ok, false);
});

test("同层方向定义冲突时拒绝", () => {
  const answer = ANSWER_FULL.replace("a=mid:a1", "a=mid:a1\r\na=sendonly\r\na=recvonly");
  assert.equal(run(OFFER, answer).ok, false);
});

test("BUNDLE 组成员必须恰为未拒绝媒体的 mid", () => {
  const answer = ANSWER_AUDIO_ONLY.replace(
    "a=group:BUNDLE a1".replace("a=group", "a=group"),
    "a=group:BUNDLE a1 v1",
  );
  assert.equal(run(OFFER, answer).ok, false);
});

test("answer 接受非允许编码时拒绝", () => {
  const answer = ANSWER_FULL.replace(
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 96",
  );
  assert.equal(run(OFFER, answer).ok, false);
});

test("同媒体同编号映射定义冲突时拒绝", () => {
  const answer = ANSWER_FULL.replace(
    "a=rtpmap:97 rtx/90000",
    "a=rtpmap:97 rtx/90000\r\na=rtpmap:97 VP8/90000",
  );
  assert.equal(run(OFFER, answer).ok, false);
});

test("answer 载荷编号必须来自对应 offer 媒体", () => {
  const answer = ANSWER_FULL.replace(
    "m=video 9 UDP/TLS/RTP/SAVPF 96 97",
    "m=video 9 UDP/TLS/RTP/SAVPF 96 120",
  ).replace("a=rtpmap:97 rtx/90000", "a=rtpmap:120 rtx/90000")
    .replace("a=fmtp:97 apt=96", "a=fmtp:120 apt=96");
  assert.equal(run(OFFER, answer).ok, false);
});
