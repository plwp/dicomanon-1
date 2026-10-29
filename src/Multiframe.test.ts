/**
 * Multi-frame round-trip tests.
 *
 * Each test parses a real, openly licensed multi-frame sample (see
 * fixtures/multiframe/README.md), anonymises it, writes it, and then checks
 * the written bytes with a small encapsulation walker that is independent of
 * the library's own parser. The checks are the ones a viewer needs:
 *
 *   - Pixel Data survives byte-for-byte (per frame for encapsulated data),
 *   - the number of frames a reader can locate equals (0028,0008),
 *   - the parser does not inflate pixel data with buffer slack,
 *   - Enhanced IODs keep their functional-group sequences.
 *
 * Encapsulated pixel data layout is PS3.5 Annex A.4: a Basic Offset Table
 * item, one item per fragment, then a Sequence Delimitation Item.
 */
import DicomMessage, { TagDict } from "./Message";
import anonymize from "./Anon";
import * as fs from "fs";
import * as path from "path";

const FIXTURES = path.join(__dirname, "..", "fixtures", "multiframe");

function readFixture(name: string): ArrayBuffer {
  const b = fs.readFileSync(path.join(FIXTURES, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/** Raw (7FE0,0010) as found on disk, located without using the library. */
type RawPixelData = {
  vr: string;
  undefinedLength: boolean;
  /** Native: the value bytes. Encapsulated: unused. */
  value: Uint8Array;
  /** Encapsulated: Basic Offset Table entries. */
  offsets: number[];
  /** Encapsulated: fragment payloads in order. */
  fragments: Uint8Array[];
};

/**
 * Locate the Pixel Data element header in an Explicit VR Little Endian file
 * and walk its value. Encapsulated layout (PS3.5 A.4):
 *   (FFFE,E000) len  [Basic Offset Table]
 *   (FFFE,E000) len  fragment ...
 *   (FFFE,E0DD) 0
 */
function pixelDataHeaderAt(u8: Uint8Array): number {
  let at = -1;
  for (let i = 132; i < u8.length - 8; i++) {
    if (
      u8[i] == 0xe0 && u8[i + 1] == 0x7f && u8[i + 2] == 0x10 && u8[i + 3] == 0x00 &&
      u8[i + 4] == 0x4f /* O */ && (u8[i + 5] == 0x42 /* B */ || u8[i + 5] == 0x57 /* W */) &&
      u8[i + 6] == 0 && u8[i + 7] == 0
    ) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new Error("Pixel Data (7FE0,0010) not found");
  return at;
}

function rawPixelData(buf: ArrayBuffer): RawPixelData {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const at = pixelDataHeaderAt(u8);
  const vr = String.fromCharCode(u8[at + 4], u8[at + 5]);
  const length = dv.getUint32(at + 8, true);
  let pos = at + 12;
  if (length != 0xffffffff) {
    return {
      vr,
      undefinedLength: false,
      value: u8.subarray(pos, pos + length),
      offsets: [],
      fragments: [],
    };
  }
  const itemTag = (p: number) => dv.getUint16(p, true) == 0xfffe ? dv.getUint16(p + 2, true) : 0;
  if (itemTag(pos) != 0xe000) throw new Error("Basic Offset Table item missing");
  const botLength = dv.getUint32(pos + 4, true);
  const offsets: number[] = [];
  for (let k = 0; k < botLength / 4; k++) offsets.push(dv.getUint32(pos + 8 + 4 * k, true));
  pos += 8 + botLength;
  const fragments: Uint8Array[] = [];
  while (itemTag(pos) == 0xe000) {
    const len = dv.getUint32(pos + 4, true);
    fragments.push(u8.subarray(pos + 8, pos + 8 + len));
    pos += 8 + len;
  }
  if (itemTag(pos) != 0xe0dd) throw new Error("Sequence Delimitation Item missing after fragments");
  return { vr, undefinedLength: true, value: new Uint8Array(0), offsets, fragments };
}

/**
 * Split fragments into frames the way a reader must (PS3.5 A.4 and 8.2):
 * by the Basic Offset Table when present; otherwise one fragment per frame
 * when the counts agree; otherwise, for a single frame, all fragments.
 * Returns null when the layout is ambiguous (a reader could not do better).
 */
function framesOf(raw: RawPixelData, numberOfFrames: number): Uint8Array[] | null {
  const concat = (parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  if (raw.offsets.length > 0) {
    const frames: Uint8Array[][] = [];
    let offset = 0;
    for (const frag of raw.fragments) {
      if (raw.offsets.indexOf(offset) != -1) frames.push([]);
      if (frames.length == 0) return null;
      frames[frames.length - 1].push(frag);
      offset += 8 + frag.length;
    }
    return frames.map(concat);
  }
  if (numberOfFrames == 1) return [concat(raw.fragments)];
  if (raw.fragments.length == numberOfFrames) return raw.fragments.slice();
  return null;
}

function sumBytes(fragments: Uint8Array[]): number {
  return fragments.reduce((n, f) => n + f.length, 0);
}

function parsedPixelBytes(dict: TagDict): number {
  const values = dict["7FE00010"].Value as Array<ArrayBuffer>;
  return values.reduce((n, v) => n + v.byteLength, 0);
}

function numberOfFrames(dict: TagDict): number {
  const nf = dict["00280008"];
  return nf ? parseInt(String(nf.Value[0]), 10) : 1;
}

/**
 * Replace the encapsulated Pixel Data value of a fixture with synthetic
 * fragments of the given (even) lengths, one fragment per frame, and either
 * a full Basic Offset Table or an empty one. The payload is a deterministic
 * byte pattern: the anonymiser never decodes pixel data, so only the
 * encapsulation is under test. Everything before and after Pixel Data is
 * kept as is.
 */
function withSyntheticFrames(name: string, frameLengths: number[], withTable: boolean): ArrayBuffer {
  const input = readFixture(name);
  const u8 = new Uint8Array(input);
  const dv = new DataView(input);
  const at = pixelDataHeaderAt(u8);
  if (dv.getUint32(at + 8, true) != 0xffffffff) throw new Error("fixture pixel data is not encapsulated");
  let end = at + 12;
  while (dv.getUint16(end + 2, true) == 0xe000) end += 8 + dv.getUint32(end + 4, true);
  end += 8; // the Sequence Delimitation Item
  const parts: number[] = [];
  const u32 = (v: number) => parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const item = (tag: number, length: number) => { u32(0xfffe | (tag << 16)); u32(length); };
  const offsets: number[] = [];
  let offset = 0;
  for (const len of frameLengths) { offsets.push(offset); offset += 8 + len; }
  item(0xe000, withTable ? 4 * offsets.length : 0);
  if (withTable) offsets.forEach(u32);
  let seed = 12345;
  for (const len of frameLengths) {
    item(0xe000, len);
    for (let k = 0; k < len; k++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      parts.push(seed >>> 24);
    }
  }
  item(0xe0dd, 0);
  const out = new Uint8Array(at + 12 + parts.length + (u8.length - end));
  out.set(u8.subarray(0, at + 12), 0);
  out.set(parts, at + 12);
  out.set(u8.subarray(end), at + 12 + parts.length);
  return out.buffer;
}

function roundTrip(name: string) {
  return roundTripBuffer(readFixture(name));
}

function roundTripBuffer(input: ArrayBuffer) {
  const dcm = DicomMessage.readFile(input);
  const anon = anonymize(dcm.dict);
  const output = dcm.write(anon);
  const reread = DicomMessage.readFile(output);
  return { input, dcm, anon, output, reread };
}

function expectFramesIdentical(name: string) {
  expectFramesIdenticalIn(readFixture(name));
}

function expectFramesIdenticalIn(file: ArrayBuffer) {
  const { input, dcm, output, reread } = roundTripBuffer(file);
  const nf = numberOfFrames(dcm.dict);
  const inRaw = rawPixelData(input);
  const outRaw = rawPixelData(output);
  const inFrames = framesOf(inRaw, nf);
  expect(inFrames).not.toBeNull();
  expect(inFrames!.length).toBe(nf);

  expect(numberOfFrames(reread.dict)).toBe(nf);
  const outFrames = framesOf(outRaw, nf);
  expect(outFrames).not.toBeNull();
  expect(outFrames!.length).toBe(nf);
  for (let i = 0; i < nf; i++) {
    expect(outFrames![i].length).toBe(inFrames![i].length);
    expect(Buffer.compare(outFrames![i], inFrames![i])).toBe(0);
  }
}

describe("Multi-frame DICOM round trip (parse → anonymise → write → re-parse)", () => {
  describe("examples_ybr_color.dcm: Ultrasound Multi-frame, JPEG Baseline, 30 frames, Basic Offset Table with 30 entries", () => {
    const name = "examples_ybr_color.dcm";

    it("parses pixel data without inflating it (bytes read == bytes in the fragments)", () => {
      const raw = rawPixelData(readFixture(name));
      expect(raw.offsets.length).toBe(30);
      const dcm = DicomMessage.readFile(readFixture(name));
      expect(parsedPixelBytes(dcm.dict)).toBe(sumBytes(raw.fragments));
    });

    it("writes a Basic Offset Table with one entry per frame", () => {
      const { output } = roundTrip(name);
      expect(rawPixelData(output).offsets.length).toBe(30);
    });

    it("keeps all 30 frames byte-identical and locatable", () => {
      expectFramesIdentical(name);
    });
  });

  describe("emri_small_jpeg_2k_lossless.dcm: Enhanced MR, JPEG 2000 Lossless, 10 frames, empty Basic Offset Table (one fragment per frame)", () => {
    const name = "emri_small_jpeg_2k_lossless.dcm";

    it("parses pixel data without inflating it", () => {
      const raw = rawPixelData(readFixture(name));
      expect(raw.offsets.length).toBe(0);
      expect(raw.fragments.length).toBe(10);
      const dcm = DicomMessage.readFile(readFixture(name));
      expect(parsedPixelBytes(dcm.dict)).toBe(sumBytes(raw.fragments));
    });

    it("keeps one fragment per frame so frames stay locatable without an offset table", () => {
      const { output } = roundTrip(name);
      const outRaw = rawPixelData(output);
      // Either a full offset table or exactly one fragment per frame is acceptable.
      const locatable = outRaw.offsets.length == 10 || outRaw.fragments.length == 10;
      expect(locatable).toBe(true);
    });

    it("keeps all 10 frames byte-identical", () => {
      expectFramesIdentical(name);
    });
  });

  describe("SC_rgb_rle_2frame.dcm: RLE Lossless, 2 frames, Basic Offset Table with 2 entries", () => {
    const name = "SC_rgb_rle_2frame.dcm";

    it("keeps both frames byte-identical and locatable", () => {
      expectFramesIdentical(name);
    });

    it("keeps each RLE frame in a single fragment (RLE forbids splitting a frame across fragments)", () => {
      const { output } = roundTrip(name);
      const outRaw = rawPixelData(output);
      expect(outRaw.fragments.length).toBe(2);
    });
  });

  describe("US1_J2KR.dcm: single frame, JPEG 2000 Lossless, 3 fragments, empty Basic Offset Table", () => {
    const name = "US1_J2KR.dcm";

    it("parses pixel data without inflating it (the frame is the fragments joined, nothing more)", () => {
      const raw = rawPixelData(readFixture(name));
      expect(raw.fragments.length).toBe(3);
      const dcm = DicomMessage.readFile(readFixture(name));
      expect(parsedPixelBytes(dcm.dict)).toBe(sumBytes(raw.fragments));
    });

    it("keeps the frame byte-identical", () => {
      expectFramesIdentical(name);
    });
  });

  describe("Frames larger than 20 KB: SC_rgb_rle_2frame.dcm with 2 synthetic fragments of 24,000 and 30,002 bytes", () => {
    const name = "SC_rgb_rle_2frame.dcm";
    const lengths = [24000, 30002];

    it("with a 2-entry Basic Offset Table: keeps one fragment per frame, the table verbatim and the frames byte-identical", () => {
      const input = withSyntheticFrames(name, lengths, true);
      expect(rawPixelData(input).offsets).toEqual([0, 24008]);
      expectFramesIdenticalIn(input);
      const outRaw = rawPixelData(roundTripBuffer(input).output);
      expect(outRaw.offsets).toEqual([0, 24008]);
      expect(outRaw.fragments.map((f) => f.length)).toEqual(lengths);
    });

    it("with an empty Basic Offset Table: keeps one fragment per frame and the frames byte-identical", () => {
      const input = withSyntheticFrames(name, lengths, false);
      expect(rawPixelData(input).offsets).toEqual([]);
      expectFramesIdenticalIn(input);
      const outRaw = rawPixelData(roundTripBuffer(input).output);
      expect(outRaw.fragments.map((f) => f.length)).toEqual(lengths);
    });
  });

  describe("eCT_Supplemental.dcm: Enhanced CT, native (Explicit VR LE), 2 frames, Shared and Per-frame Functional Groups", () => {
    const name = "eCT_Supplemental.dcm";

    it("parses nested functional-group sequences", () => {
      const dcm = DicomMessage.readFile(readFixture(name));
      const perFrame = dcm.dict["52009230"].Value as Array<TagDict>;
      expect(perFrame.length).toBe(2);
      const position = (perFrame[1]["00209113"].Value[0] as TagDict)["00200032"].Value;
      expect(position).toEqual(["99.5000", "-301.500", "-149.000"]);
    });

    it("keeps native multi-frame pixel data byte-identical with the frame count preserved", () => {
      const { input, dcm, output, reread } = roundTrip(name);
      expect(numberOfFrames(dcm.dict)).toBe(2);
      expect(numberOfFrames(reread.dict)).toBe(2);
      const inRaw = rawPixelData(input);
      const outRaw = rawPixelData(output);
      expect(outRaw.value.length).toBe(inRaw.value.length);
      expect(Buffer.compare(outRaw.value, inRaw.value)).toBe(0);
    });

    it("keeps the Shared and Per-frame Functional Groups Sequences the Enhanced CT IOD requires (Type 1)", () => {
      const { anon, reread } = roundTrip(name);
      expect(anon["52009229"]).toBeDefined();
      expect(anon["52009230"]).toBeDefined();
      expect((reread.dict["52009229"].Value as Array<TagDict>).length).toBe(1);
      const perFrame = reread.dict["52009230"].Value as Array<TagDict>;
      expect(perFrame.length).toBe(2);
      // Geometry needed to display the frames must survive; identifiers inside must not.
      expect((perFrame[0]["00209113"].Value[0] as TagDict)["00200032"]).toBeDefined();
    });
  });
});
