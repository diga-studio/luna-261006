/** Independent PDF reader/renderer used to verify the library output. */
import { createRequire } from "node:module";
import path from "node:path";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import type { Canvas } from "@napi-rs/canvas";

const g = globalThis as Record<string, unknown>;
g.DOMMatrix ??= DOMMatrix;
g.ImageData ??= ImageData;
g.Path2D ??= Path2D;

const require = createRequire(import.meta.url);
const standardFonts = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep;

type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<PdfjsModule> | undefined;

function pdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

export interface LoadedPdf {
  numPages: number;
  pageText(pageNumber: number): Promise<string>;
  pageAnnotations(pageNumber: number): Promise<Array<Record<string, unknown>>>;
  metadataInfo(): Promise<Record<string, unknown>>;
  renderPage(pageNumber: number, scale: number): Promise<RenderedPage>;
  close(): Promise<void>;
}

export interface RenderedPage {
  width: number;
  height: number;
  /** RGBA pixels, row-major. */
  pixels: Uint8Array;
}

export async function loadPdf(data: Uint8Array): Promise<LoadedPdf> {
  const mod = await pdfjs();
  const doc = await mod.getDocument({
    // pdf.js transfers the buffer to its worker; hand it a copy so the
    // caller's Uint8Array is never neutered.
    data: data.slice(),
    standardFontDataUrl: standardFonts,
    verbosity: 0,
  }).promise;

  return {
    numPages: doc.numPages,
    async pageText(pageNumber: number): Promise<string> {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      return content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join("");
    },
    async pageAnnotations(pageNumber: number): Promise<Array<Record<string, unknown>>> {
      const page = await doc.getPage(pageNumber);
      return (await page.getAnnotations()) as unknown as Array<Record<string, unknown>>;
    },
    async metadataInfo(): Promise<Record<string, unknown>> {
      const meta = await doc.getMetadata();
      return meta.info as Record<string, unknown>;
    },
    async renderPage(pageNumber: number, scale: number): Promise<RenderedPage> {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const canvas: Canvas = createCanvas(width, height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      const image = ctx.getImageData(0, 0, width, height);
      return { width, height, pixels: new Uint8Array(image.data.buffer.slice(0)) };
    },
    async close(): Promise<void> {
      await doc.destroy();
    },
  };
}
