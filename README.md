# pdf-watermark

Append-only PDF watermarking library (TypeScript, no runtime dependencies).

## API

```ts
import { watermark } from "pdf-watermark";

const output: Uint8Array = watermark(inputPdfBytes, "alice 2026-10-04T08:00:00Z");
```

`watermark(input, label)` takes the bytes of an unencrypted PDF 1.4–1.7 file
(classic cross-reference tables, any number of incremental revisions) and a
printable-ASCII label, and returns new bytes: the input bytes verbatim plus an
appended incremental revision that draws the label as a watermark on every
page (Helvetica, centered on the CropBox, horizontal in the rotated view,
50% gray, shrunk below 18pt only when it would exceed 80% of the visible
page width). The input buffer is never modified, and re-watermarking the
output stacks further revisions without disturbing earlier ones.

## Develop

```sh
npm install
npm test
```

Tests parse and render the output with pdf.js (pdfjs-dist) as an independent
reader, verifying byte-prefix identity, revision handling, watermark
placement/appearance, and that original content, annotations and metadata
are preserved.
