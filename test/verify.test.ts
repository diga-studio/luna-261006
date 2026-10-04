import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifyNegotiation } from "../src/index.js";

function sdp(lines: string[], newline = "\r\n"): string {
  return lines.join(newline) + newline;
}

const OFFER = [
  "v=0",
  "o=- 1 1 IN IP4 0.0.0.0",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE a1 v1",
  "m=audio 9 UDP/TLS/RTP/SAVPF 96 97",
  "a=mid:a1",
  "a=rtpmap:96 opus/48000/2",
  "a=rtpmap:97 PCMU/8000",
  "a=fmtp:96 maxaveragebitrate=20000",
  "m=video 9 UDP/TLS/RTP/SAVPF 96 97",
  "a=mid:v1",
  "a=rtpmap:96 VP8/90000",
  "a=rtpmap:97 rtx/90000",
  "a=fmtp:97 apt=96",
];

const ANSWER = [
  "v=0",
  "o=- 1 1 IN IP4 0.0.0.0",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE a1 v1",
  "m=audio 9 UDP/TLS/RTP/SAVPF 96",
  "a=mid:a1",
  "a=rtpmap:96 OPUS/48000/2",
  "a=fmtp:96 maxaveragebitrate=16000",
  "m=video 9 UDP/TLS/RTP/SAVPF 96 97",
  "a=mid:v1",
  "a=rtpmap:96 VP8/90000",
  "a=rtpmap:97 rtx/90000",
  "a=fmtp:97 apt=96",
];

function answerVideoRejected(maxBitrate = "16000"): string[] {
  return [
    "v=0",
    "o=- 1 1 IN IP4 0.0.0.0",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE a1",
    "m=audio 9 UDP/TLS/RTP/SAVPF 96",
    "a=mid:a1",
    "a=rtpmap:96 opus/48000/2",
    `a=fmtp:96 maxaveragebitrate=${maxBitrate}`,
    "m=video 0 UDP/TLS/RTP/SAVPF 96 97",
    "a=mid:v1",
  ];
}

describe("verifyNegotiation", () => {
  it("accepts a valid negotiation where payload 96 means opus in audio and VP8 in video", () => {
    const result = verifyNegotiation(sdp(OFFER), sdp(ANSWER), "high");
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });

  it("treats LF and CRLF line endings identically", () => {
    const crlf = verifyNegotiation(sdp(OFFER, "\r\n"), sdp(ANSWER, "\r\n"), "high");
    const lf = verifyNegotiation(sdp(OFFER, "\n"), sdp(ANSWER, "\n"), "high");
    assert.equal(crlf.ok, true);
    assert.equal(lf.ok, true);
  });

  it("is unaffected by valid attribute reordering", () => {
    const reordered = [
      "v=0",
      "o=- 1 1 IN IP4 0.0.0.0",
      "s=-",
      "t=0 0",
      "a=group:BUNDLE a1 v1",
      "m=audio 9 UDP/TLS/RTP/SAVPF 96",
      "a=fmtp:96 maxaveragebitrate=16000",
      "a=rtpmap:96 opus/48000/2",
      "a=mid:a1",
      "m=video 9 UDP/TLS/RTP/SAVPF 96 97",
      "a=fmtp:97 apt=96",
      "a=rtpmap:97 rtx/90000",
      "a=rtpmap:96 VP8/90000",
      "a=mid:v1",
    ];
    const result = verifyNegotiation(sdp(OFFER), sdp(reordered), "high");
    assert.equal(result.ok, true);
  });

  it("rejects when rtx is kept but its apt target VP8 payload is removed", () => {
    const answer = [
      "v=0",
      "o=- 1 1 IN IP4 0.0.0.0",
      "s=-",
      "t=0 0",
      "a=group:BUNDLE a1 v1",
      "m=audio 9 UDP/TLS/RTP/SAVPF 96",
      "a=mid:a1",
      "a=rtpmap:96 opus/48000/2",
      "a=fmtp:96 maxaveragebitrate=16000",
      "m=video 9 UDP/TLS/RTP/SAVPF 97",
      "a=mid:v1",
      "a=rtpmap:97 rtx/90000",
      "a=fmtp:97 apt=96",
    ];
    const result = verifyNegotiation(sdp(OFFER), sdp(answer), "high");
    assert.equal(result.ok, false);
  });

  it("keeps audio alive when the whole video media is rejected instead", () => {
    const result = verifyNegotiation(sdp(OFFER), sdp(answerVideoRejected()), "high");
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });

  it("rejects accepted video under ultra-low and standard presets", () => {
    for (const preset of ["ultra-low", "standard"] as const) {
      const result = verifyNegotiation(sdp(OFFER), sdp(ANSWER), preset);
      assert.equal(result.ok, false, preset);
    }
  });

  it("allows video rejection to satisfy ultra-low preset when bitrate fits", () => {
    const result = verifyNegotiation(
      sdp(OFFER),
      sdp(answerVideoRejected("8000")),
      "ultra-low",
    );
    assert.equal(result.ok, true);
  });

  it("rejects opus bitrate above the preset", () => {
    const result = verifyNegotiation(
      sdp(OFFER),
      sdp(answerVideoRejected("24000")),
      "standard",
    );
    assert.equal(result.ok, false);
  });

  it("rejects opus bitrate above the offer's explicit limit", () => {
    const answer = answerVideoRejected("24000");
    const result = verifyNegotiation(sdp(OFFER), sdp(answer), "high");
    assert.equal(result.ok, false);
  });

  it("rejects accepted opus without maxaveragebitrate in answer", () => {
    const answer = answerVideoRejected().filter(
      (l) => !l.startsWith("a=fmtp:96"),
    );
    const result = verifyNegotiation(sdp(OFFER), sdp(answer), "high");
    assert.equal(result.ok, false);
  });

  it("rejects answer reviving a media rejected in offer", () => {
    const offer = OFFER.map((l) =>
      l === "m=video 9 UDP/TLS/RTP/SAVPF 96 97"
        ? "m=video 0 UDP/TLS/RTP/SAVPF 96 97"
        : l,
    ).filter((l) => l !== "a=group:BUNDLE a1 v1");
    offer.splice(4, 0, "a=group:BUNDLE a1");
    const result = verifyNegotiation(sdp(offer), sdp(ANSWER), "high");
    assert.equal(result.ok, false);
  });

  it("rejects mid mismatch between offer and answer", () => {
    const answer = ANSWER.map((l) => (l === "a=mid:v1" ? "a=mid:v2" : l));
    const result = verifyNegotiation(sdp(OFFER), sdp(answer), "high");
    assert.equal(result.ok, false);
  });

  it("rejects a BUNDLE group that does not match non-rejected media", () => {
    const answer = ANSWER.map((l) =>
      l === "a=group:BUNDLE a1 v1" ? "a=group:BUNDLE a1" : l,
    );
    const result = verifyNegotiation(sdp(OFFER), sdp(answer), "high");
    assert.equal(result.ok, false);
  });

  it("rejects answer direction not permitted by offer", () => {
    const offer = OFFER.slice();
    offer.splice(6, 0, "a=sendonly");
    const result = verifyNegotiation(sdp(offer), sdp(ANSWER), "high");
    assert.equal(result.ok, false);
  });

  it("rejects conflicting direction attributes at the same level", () => {
    const answer = ANSWER.slice();
    answer.splice(5, 0, "a=sendonly", "a=recvonly");
    const result = verifyNegotiation(sdp(OFFER), sdp(answer), "high");
    assert.equal(result.ok, false);
  });

  it("rejects when no accepted non-inactive audio remains", () => {
    const answer = answerVideoRejected().map((l) =>
      l === "m=audio 9 UDP/TLS/RTP/SAVPF 96"
        ? "m=audio 0 UDP/TLS/RTP/SAVPF 96"
        : l,
    );
    const offer = OFFER.filter((l) => l !== "a=group:BUNDLE a1 v1");
    offer.splice(4, 0, "a=group:BUNDLE a1 v1");
    const ans = answer.filter((l) => l !== "a=group:BUNDLE a1");
    const result = verifyNegotiation(sdp(offer), sdp(ans), "high");
    assert.equal(result.ok, false);
  });

  it("rejects conflicting rtpmap definitions for one payload in a media", () => {
    const answer = ANSWER.slice();
    answer.splice(8, 0, "a=rtpmap:96 PCMU/8000");
    const result = verifyNegotiation(sdp(OFFER), sdp(answer), "high");
    assert.equal(result.ok, false);
  });

  it("rejects answer payload numbers absent from the offer media", () => {
    const answer = ANSWER.map((l) =>
      l === "m=audio 9 UDP/TLS/RTP/SAVPF 96"
        ? "m=audio 9 UDP/TLS/RTP/SAVPF 96 100"
        : l,
    );
    const result = verifyNegotiation(sdp(OFFER), sdp(answer), "high");
    assert.equal(result.ok, false);
  });

  it("rejects answer accepting a codec outside the whitelist", () => {
    const answer = ANSWER.map((l) =>
      l === "m=audio 9 UDP/TLS/RTP/SAVPF 96"
        ? "m=audio 9 UDP/TLS/RTP/SAVPF 96 97"
        : l,
    );
    answer.splice(8, 0, "a=rtpmap:97 PCMU/8000");
    const result = verifyNegotiation(sdp(OFFER), sdp(answer), "high");
    assert.equal(result.ok, false);
  });

  it("rejects rtx when apt values differ between offer and answer", () => {
    const answer = ANSWER.map((l) =>
      l === "a=fmtp:97 apt=96" ? "a=fmtp:97 apt=98" : l,
    );
    const result = verifyNegotiation(sdp(OFFER), sdp(answer), "high");
    assert.equal(result.ok, false);
  });

  it("rejects duplicate mids within one SDP", () => {
    const answer = ANSWER.map((l) => (l === "a=mid:v1" ? "a=mid:a1" : l));
    const result = verifyNegotiation(sdp(OFFER), sdp(answer), "high");
    assert.equal(result.ok, false);
  });
});
