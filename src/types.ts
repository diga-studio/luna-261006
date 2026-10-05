export interface Rational {
  numerator: number;
  denominator: number;
}

export type PreviewValue =
  | { kind: "ascii"; text: string }
  | { kind: "integers"; values: number[] }
  | { kind: "rationals"; values: Rational[] }
  | { kind: "floats"; values: number[] }
  | { kind: "bytes"; bytes: Uint8Array };

export interface KeptFieldPreview {
  ifd: "IFD0" | "ExifIFD";
  tag: number;
  name: string;
  type: number;
  count: number;
  value: PreviewValue;
}
