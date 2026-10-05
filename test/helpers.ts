import { deflateSync } from 'node:zlib';

function encode(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Minimal PDF assembler for tests: classic xref table, optional FlateDecode. */
export class PdfBuilder {
  private bodies: Uint8Array[] = [];

  /** Add a non-stream indirect object, returns its object number. */
  add(body: string): number {
    this.bodies.push(encode(body));
    return this.bodies.length;
  }

  /** Add a stream indirect object, returns its object number. */
  addStream(dictEntries: string, content: string, compress = false): number {
    const raw = encode(content);
    const data = compress ? new Uint8Array(deflateSync(raw)) : raw;
    const filter = compress ? ' /Filter /FlateDecode' : '';
    const head = encode(`<< /Length ${data.length}${filter}${dictEntries ? ' ' + dictEntries : ''} >>\nstream\n`);
    const tail = encode('\nendstream');
    const body = new Uint8Array(head.length + data.length + tail.length);
    body.set(head, 0);
    body.set(data, head.length);
    body.set(tail, head.length + data.length);
    this.bodies.push(body);
    return this.bodies.length;
  }

  build(rootId: number): Uint8Array {
    const chunks: Uint8Array[] = [];
    const offsets: number[] = [];
    let length = 0;
    const push = (data: Uint8Array) => {
      chunks.push(data);
      length += data.length;
    };
    push(encode('%PDF-1.7\n'));
    this.bodies.forEach((body, i) => {
      offsets.push(length);
      push(encode(`${i + 1} 0 obj\n`));
      push(body);
      push(encode('\nendobj\n'));
    });
    const xrefStart = length;
    const count = this.bodies.length + 1;
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (const off of offsets) xref += off.toString().padStart(10, '0') + ' 00000 n \n';
    xref += `trailer\n<< /Size ${count} /Root ${rootId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    push(encode(xref));
    const out = new Uint8Array(length);
    let pos = 0;
    for (const chunk of chunks) {
      out.set(chunk, pos);
      pos += chunk.length;
    }
    return out;
  }
}

export const COURIER_FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
