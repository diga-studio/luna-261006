/** Shared pdf.js (independent reader/renderer) setup for tests. */
import { fileURLToPath } from "node:url";
import {
  createCanvas,
  DOMMatrix,
  ImageData,
  Path2D,
  type Canvas,
} from "@napi-rs/canvas";

(globalThis as Record<string, unknown>).DOMMatrix ??= DOMMatrix;
(globalThis as Record<string, unknown>).ImageData ??= ImageData;
(globalThis as Record<string, unknown>).Path2D ??= Path2D;

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

// pdf.js reads this with fs.readFile in Node, so pass a plain path.
const standardFontDataUrl = fileURLToPath(
  new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url),
);

export async function loadPdf(data: Uint8Array) {
  const copy = data.slice();
  return pdfjs.getDocument({
    data: copy,
    isEvalSupported: false,
    standardFontDataUrl,
  }).promise;
}

export interface RenderedPage {
  readonly width: number;
  readonly height: number;
  /** RGBA pixels, row-major. */
  readonly data: Uint8ClampedArray;
}

class NodeCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(pair: { canvas: Canvas }, width: number, height: number) {
    pair.canvas.width = width;
    pair.canvas.height = height;
  }
  destroy(pair: { canvas: Canvas }) {
    pair.canvas.width = 0;
    pair.canvas.height = 0;
  }
}

export async function renderPage(
  page: unknown,
  scale = 2,
): Promise<RenderedPage> {
  const pdfPage = page as {
    getViewport: (opts: { scale: number }) => {
      width: number;
      height: number;
    };
    render: (opts: unknown) => { promise: Promise<void> };
  };
  const viewport = pdfPage.getViewport({ scale });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  await pdfPage.render({
    canvasContext: context,
    viewport,
    canvasFactory: new NodeCanvasFactory(),
    background: "#ffffff",
  }).promise;
  const image = context.getImageData(0, 0, width, height);
  return { width, height, data: image.data };
}

export async function pageText(page: unknown): Promise<string[]> {
  const pdfPage = page as {
    getTextContent: () => Promise<{ items: { str: string }[] }>;
  };
  const content = await pdfPage.getTextContent();
  return content.items.map((item) => item.str);
}
