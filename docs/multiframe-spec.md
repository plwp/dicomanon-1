# Multi-frame DICOM: cause, failing tests, and fix spec

Status: spec, 2026-10-29. The failing tests are in `src/Multiframe.test.ts`,
the samples in `fixtures/multiframe/`, and a prototype of the parser/writer fix
(used only to prove the cause; not applied on this branch) in
`docs/multiframe-fix.patch`.

## 1. The reason, in one paragraph

The anonymiser does not fail on multi-frame files because of functional
groups, undefined lengths, `NumberOfFrames`, odd lengths or buffer limits. It
fails because the encapsulated Pixel Data reader in
`src/ValueRepresentation.ts` (`BinaryRepresentation.readBytes`) never finds a
frame boundary, so it concatenates every fragment of a compressed multi-frame
file into one "frame", and the matching writer (`BinaryRepresentation.writeBytes`)
then emits a Basic Offset Table with a single entry and re-cuts the bytes into
20 KB fragments. The output says `NumberOfFrames = 30` but describes one frame,
and its fragment boundaries no longer line up with the compressed frames. Every
reader (DCMTK, pydicom, OsiriX/Horos) then cannot locate frames 2..N. A second,
independent defect in the same reader appends buffer slack to the pixel data,
so any compressed image split over more than one fragment also grows by up to
2x with trailing zeros. Uncompressed multi-frame files (CT, MR, RT Dose) pass
through the parser intact; for Enhanced CT/MR they come out invalid for a
different reason: the policy removes the Shared and Per-frame Functional Groups
Sequences, which the Enhanced IODs require.

Nothing upstream has fixed this. `radiopaedia/dicom-anonymiser` `master` (v0.5.2,
tags to v20250624) contains the same `readBytes`/`writeBytes` byte for byte
(the diff from this fork to `upstream/master` touches `Message.ts` only for the
meta-length and transfer-syntax guards, and `ValueRepresentation.ts` only for
`write()` typing and the over-length warning). The abandoned 2020 branch
`upstream/parse-pixel-data` tried to bolt `dicom-parser` on and was never merged.
Upstream issues #8 (closed, the 20 KB "eaten" chunk, 2020) and #53 (open,
whitelist does not recurse into SQ) are adjacent; none covers this.

## 2. Evidence

Reproduced on real, openly licensed samples (pydicom test data; sources and
licence in `fixtures/multiframe/README.md`), running the fork's code, then
checking the output with pydicom 3.0.2 and DCMTK 3.7.1, neither of which shares
code with this library.

### 2.1 The reader never splits frames

Walking the encapsulation of `examples_ybr_color.dcm` (30 frames, Basic Offset
Table with 30 entries) and mirroring the reader's own variables:

```
BOT entries: 30, first 5: [0, 6130, 12224, 18312, 24374]
fragment 0: true offset 0,     code's 'start' = 4
fragment 1: true offset 6130,  code's 'start' = 6130
fragment 2: true offset 12224, code's 'start' = 12220
fragment 3: true offset 18312, code's 'start' = 18304
code result: frames = 1, bytes = [195904]
```

Three faults in `readBytes` (current `ValueRepresentation.ts` lines 387-456):

1. `start` is initialised to `4`, but Basic Offset Table offsets are measured
   from the first byte of the first fragment *item* (PS3.5 A.4), i.e. from `0`.
2. `start += 4 + frameItemLength` omits the 4-byte item tag; the correct
   advance is `8 + length`. After one fragment the two errors cancel; from the
   second fragment on they drift apart by 4 bytes per fragment.
3. The comparison `frameOffset == start` is only ever made against the *first*
   offset (`offsets.shift()` runs only on a match). Since the first offset is
   `0` and `start` starts at `4`, it never matches, so `frameOffset` stays `0`
   for the whole loop and no later match can happen either.

With an empty Basic Offset Table (`emri_small_jpeg_2k_lossless.dcm`, 10
fragments, 10 frames; `color3d_jpeg_baseline.dcm`, 121 fragments, 120 frames)
there is no fallback at all: the reader cannot see `NumberOfFrames`, so it
treats everything as one frame.

### 2.2 The reader inflates pixel data with buffer slack

`frames.push(fragmentStream.buffer)` pushes the *allocation*, not the bytes
written. `BufferStream.concat()` grows the backing `ArrayBuffer` by doubling
(`checkSize`), so once two or more fragments are joined the stored "frame"
carries trailing zeros up to the next power of two of the first fragment:

| file | bytes in fragments | bytes the reader returns |
|---|---:|---:|
| `US1_J2KR.dcm` (1 frame, 3 fragments) | 152,294 | 262,144 |
| `examples_ybr_color.dcm` (30 frames) | 189,474 | 195,904 |
| `emri_small_jpeg_2k_lossless.dcm` (10 frames) | 37,876 | 61,024 |
| `MR2_J2KR.dcm` (1 frame, 10 fragments) | 587,218 | 1,048,576 |

Single-fragment files are unaffected, which is why small single-frame tests
pass and the defect went unnoticed.

### 2.3 The writer destroys frame boundaries

`writeBytes(isEncapsulated)` builds the Basic Offset Table from
`value.length` (always 1 after 2.1) and re-fragments the concatenated bytes at
`fragmentSize = 20 KB`. pydicom on the output, before any fix:

```
examples_ybr_color.dcm         nf=30->30  BOT=30->1  frags=31->11  frames=30->1   out.pixel_array FAILED: StopIteration
emri_small_jpeg_2k_lossless    nf=10->10  BOT=0->1   frags=11->4   frames=10->1   out.pixel_array FAILED: StopIteration
emri_small_RLE.dcm             nf=10->10  BOT=10->1  frags=11->5   frames=10->1   out.pixel_array FAILED: StopIteration
SC_rgb_rle_2frame.dcm          nf=2->2    BOT=2->1   frags=3->2    frames=2->1    out.pixel_array FAILED: StopIteration
color3d_jpeg_baseline.dcm      nf=120->120 BOT=0->1  frags=121->308 frames=120->1 out.pixel_array FAILED: StopIteration
US1_J2KR.dcm (single frame)    pixelbytes=152326->262260 (zero padded)
```

DCMTK on the same output: `dcmj2pnm --frame 2` reports `F: Invalid DICOM image`
for `examples_ybr_color.dcm` and `SC_rgb_rle_2frame.dcm`.

RLE is worse than JPEG here: PS3.5 G.3 requires each RLE frame to be exactly
one fragment, so 20 KB re-fragmentation is invalid even for a single frame
larger than 20 KB.

### 2.4 Uncompressed multi-frame files

`emri_small.dcm`, `emri_small_big_endian.dcm`, `eCT_Supplemental.dcm`,
`liver.dcm`, `rtdose.dcm` (Implicit VR) all round-trip with byte-identical pixel
data and the right frame count. The nested SQ reader handles Shared/Per-frame
Functional Groups (tested: `PerFrameFunctionalGroupsSequence[1] >
PlanePositionSequence > ImagePositionPatient` is read correctly). But
`anonymize()` drops `(5200,9229)` and `(5200,9230)` because they are not in any
policy and the catch-all default is `remove`. Enhanced CT/MR/XA without them
are not valid instances (Type 1 in the Multi-frame Functional Groups Module,
PS3.3 C.7.6.16); viewers refuse them or lose geometry, window and rescale.

Enhanced CT (1.2.840.10008.5.1.4.1.1.2.1), Enhanced MR (...4.1) and Enhanced XA
(...12.1.1) are also commented out of `supportedSOPClasses()` in
`src/Validator.ts`, which is consistent with the policy never having been
written for them.

### 2.5 Suspects ruled out

- `NumberOfFrames` (0028,0008) is read and written correctly as an `IS` string
  in every sample.
- Undefined-length items and sequence delimiters are handled by the SQ reader;
  nested functional groups parse.
- Odd-length values: the samples include `SC_rgb_small_odd_jpeg.dcm`; it
  round-trips.
- Transfer syntaxes JPEG Baseline, JPEG Lossless P14 SV1, JPEG-LS, JPEG 2000
  (lossless and lossy), RLE, Explicit Big Endian, Implicit LE: the parser
  handles all; only encapsulation structure (2.1-2.3) breaks.
- The 32-bit length limit: not reached by any realistic single instance; the
  practical limit is memory. `BufferStream.checkSize` doubles and copies, and
  `writeBytes` used to allocate a fixed 20 MB scratch stream per Pixel Data
  element; see edge cases in section 4.

## 3. The failing tests

`src/Multiframe.test.ts`. Each test locates `(7FE0,0010)` in the written bytes
with its own small walker (`rawPixelData`, `framesOf`), so the assertions do not
depend on the library's parser being right.

| Test | Asserts | Fails today because |
|---|---|---|
| examples_ybr_color › parses pixel data without inflating it | sum of parsed Pixel Data bytes == sum of fragment bytes (189,474) | reader returns 195,904 (2.2) |
| examples_ybr_color › writes a Basic Offset Table with one entry per frame | output BOT has 30 entries | has 1 (2.1 + 2.3) |
| examples_ybr_color › keeps all 30 frames byte-identical and locatable | output frames located via BOT == 30, each `Buffer.compare == 0` with input, `NumberOfFrames` re-read == 30 | 1 frame located |
| emri_small_jpeg_2k_lossless › parses pixel data without inflating it | 37,876 bytes | 61,024 |
| emri_small_jpeg_2k_lossless › keeps one fragment per frame ... | output has a 10-entry BOT or exactly 10 fragments | 1-entry BOT, 4 fragments |
| emri_small_jpeg_2k_lossless › keeps all 10 frames byte-identical | as above, 10 frames | 1 frame |
| SC_rgb_rle_2frame › keeps both frames byte-identical and locatable | 2 frames identical | 1 frame |
| SC_rgb_rle_2frame › keeps each RLE frame in a single fragment | output fragment count == 2 | 1 |
| US1_J2KR › parses pixel data without inflating it | 152,294 bytes | 262,144 |
| US1_J2KR › keeps the frame byte-identical | single frame identical | zero-padded to 262,144 |
| eCT_Supplemental › keeps the Shared and Per-frame Functional Groups Sequences | `(5200,9229)` 1 item and `(5200,9230)` 2 items survive, with `PlanePositionSequence > ImagePositionPatient` | policy removes both (2.4) |

Two guards pass today and must keep passing: eCT_Supplemental › parses nested
functional-group sequences; eCT_Supplemental › keeps native multi-frame pixel
data byte-identical.

Run: `npx jest src/Multiframe.test.ts`. Current result: 11 failed, 2 passed.
(`src/Message.test.ts` also fails, pre-existing: it needs a `test.dcm` in the
repo root that is not checked in.)

`tsconfig.json` gained `"esModuleInterop": true` on this branch so that
`import sjcl from "./sjcl.sha512"` (a CommonJS module) resolves under ts-jest;
without it `anonymize()` throws `Cannot read properties of undefined (reading
'hash')` before reaching the writer. Upstream solved the same problem by
converting `sjcl.sha512.js` to an ES module.

## 4. The fix

Principle: the anonymiser never changes pixel bytes, so it must not reinterpret
them either. Read the encapsulation as a *list of fragments plus the Basic
Offset Table*, carry both through unchanged, and write them back verbatim.
Frame splitting is a viewer's concern; the anonymiser's job is to not lose the
information a viewer needs.

### 4.1 Data structure (`src/Message.ts`)

```ts
export type TagValue = {
  vr: string;
  Value: Array<TagValueEntry>;
  // Encapsulated Pixel Data only: the Basic Offset Table as read (one byte
  // offset per frame, [] for an empty table). Value then holds one
  // ArrayBuffer per fragment, in file order.
  basicOffsetTable?: Array<number>;
};
```

For native Pixel Data nothing changes: `Value = [ArrayBuffer]`, no table.

### 4.2 Reader (`BinaryRepresentation.readBytes`, `src/ValueRepresentation.ts`)

Replace the body of the `length == 0xffffffff` branch:

1. Read item tag; if not `(FFFE,E000)` throw (as now).
2. `tableLength = readUint32()`; read `tableLength / 4` offsets into `offsets`.
   Do not substitute `[0]` for an empty table: an empty table is information
   (it means "one fragment per frame, or a single frame").
3. Loop while the next tag is `(FFFE,E000)`: `len = readUint32()`;
   `fragments.push(stream.more(len).buffer)`. `more()` slices exactly `len`
   bytes, which removes defect 2.2 by construction. Never `concat`.
4. Require `(FFFE,E0DD)` after the loop; read its 4-byte length. Throw on
   anything else rather than silently returning a partial element.
5. Set `this.basicOffsetTable = offsets`; return `fragments`.

`DicomMessage.read` copies `vr.basicOffsetTable` onto the `TagValue` when the
VR is a `BinaryRepresentation` and the table was set.

Remove the `frames`/`fragmentStream`/`start`/`frameOffset` machinery entirely.

### 4.3 Writer (`BinaryRepresentation.writeBytes`, `Tag.write`, `DicomMessage.write`)

Thread `basicOffsetTable` from `TagValue` through `DicomMessage.write` ->
`Tag.write(stream, vr, values, syntax, basicOffsetTable)` ->
`vr.writeBytes(stream, values, syntax, isEncapsulated, basicOffsetTable)`.

In the encapsulated branch:

1. Write `(FFFE,E000)` + `offsets.length * 4` + each offset as Uint32.
2. For each fragment: write `(FFFE,E000)` + length + bytes. If a fragment's
   length is odd (should not happen in a valid file), write the length rounded
   up and append one `0x00` pad byte, so the item stays even and the offsets
   that follow remain valid.
3. Write `(FFFE,E0DD)` + `0`. Return `0xffffffff`.

Delete the 20 KB re-fragmentation, the `startOffset` recomputation and the
fixed 20 MB `WriteBufferStream` scratch buffer. The element is now written in
one pass with no intermediate copy.

If `basicOffsetTable` is absent (a caller built the value by hand), write an
empty table and one fragment per `Value` entry. That is valid for a single
frame and for one-fragment-per-frame multi-frame data, which is the only shape
a caller can mean without supplying a table.

### 4.4 Anonymiser (`src/Anon.ts`)

- `cloneTag` must copy `basicOffsetTable` when present. Today Pixel Data is
  `keep`, which passes the same object through, so this only matters if a
  policy ever `regenerate`s or `replace`s `7FE00010`.
- Add a policy for the Multi-frame Functional Groups Module so Enhanced IODs
  stay valid: `keep` `(5200,9229)` Shared Functional Groups Sequence and
  `(5200,9230)` Per-frame Functional Groups Sequence, then **apply the policy
  recursively inside each item** (this is upstream issue #53: kept sequences
  are not scrubbed). Functional group items carry geometry
  (`PlanePositionSequence`, `PlaneOrientationSequence`, `PixelMeasuresSequence`,
  `FrameVOILUTSequence`, `PixelValueTransformationSequence`, `FrameContentSequence`)
  that must survive, and can carry UIDs (`IrradiationEventUID (0008,3010)`,
  `ReferencedImageSequence`, `SourceImageSequence`) and dates/times
  (`FrameAcquisitionDateTime (0018,9074)`, `FrameReferenceDateTime (0018,9151)`)
  that must be hashed or removed like their top-level counterparts. Implement as
  `applyPolicy(item, policy)` on each `TagDict` in a kept SQ's `Value`, with
  the catch-all default inside items set to `remove` and the geometry tags
  above whitelisted. Remove the per-frame `(0008,9123)`
  Creator-Version UID and anything under odd (private) groups as today.
- Add Enhanced CT (`1.2.840.10008.5.1.4.1.1.2.1`), Enhanced MR (`...4.1`),
  Enhanced MR Color (`...4.3`), Enhanced XA (`...12.1.1`), Enhanced PET
  (`...130`) and Legacy Converted Enhanced CT/MR/PET (`...2.2`, `...4.4`,
  `...128.1`) to `supportedSOPClasses()` once the module policy exists, and
  write `policydict` entries for them that include the module policies the
  existing CT/MR entries use plus the functional-groups policy above.

### 4.5 Edge cases the fix must respect

- Empty Basic Offset Table with more fragments than frames (JPEG allows a
  frame to span fragments; `US1_J2KR.dcm` is a single frame in 3 fragments).
  The verbatim approach handles it; any approach that "splits into frames" on
  read cannot without a JPEG/J2K marker scanner and must not be attempted.
- Basic Offset Table present but with fewer entries than `NumberOfFrames`
  (some vendors write a partial table). Carry it through unchanged; do not
  "repair" it in the anonymiser.
- Extended Offset Table `(7FE0,0001)` / `(7FE0,0002)` (DICOM 2019+). `OV` is
  not in `createByTypeString`; a file carrying it currently throws
  `Invalid vr type OV`. Add `OV` (8-byte binary, written through the native
  branch) so such files parse; keep both elements under `keep`.
- RLE: one fragment per frame is mandatory (PS3.5 G.3). Verbatim round-trip
  preserves it; the current 20 KB cut breaks any RLE frame over 20 KB.
- Pixel Data VR: keep whatever was read. `emri_small_jpeg_2k_lossless.dcm`
  carries `OW` on encapsulated data (non-conformant, DCMTK warns); the
  anonymiser must not be the component that changes it.
- Trailing pad byte after a fragment (odd JPEG stream padded to even): it is
  inside the fragment's declared length and is preserved by `more(len)`.
- Memory: the element is written in one pass; peak memory is roughly the file
  plus one copy of Pixel Data. For a 1-2 GB Enhanced CT in a browser, that is
  the real limit; `checkSize` doubling the output buffer makes the peak about
  3x the file. If that matters later, pre-size `DicomDict.write`'s
  `WriteBufferStream` from the sum of Pixel Data fragment lengths. Not part of
  this fix.
- `Validator` level-1 warnings cause `PatientIdentityRemoved = NO` but the
  file is still written; that is unchanged and orthogonal.

### 4.6 What not to do

- Do not try to compute frame boundaries from `NumberOfFrames` inside
  `BinaryRepresentation`: the VR reader does not and should not see the rest
  of the dataset.
- Do not re-fragment on write. There is no reason to; fragment boundaries are
  part of what a conformant file means.
- Do not pull in `dicom-parser` (the 2020 branch): the fork's reader is a few
  lines from correct and the writer must stay symmetrical with it.

## 5. Verification

1. `npx jest src/Multiframe.test.ts`: all 13 pass. The prototype in
   `docs/multiframe-fix.patch` (reader + writer + type thread-through, about
   100 changed lines) takes the suite from 11 failed / 2 passed to 1 failed
   (the functional-groups policy test, section 4.4) / 12 passed. The remaining
   test passes once 4.4 is done.
2. Existing suites still pass with the patch applied: `BufferStream.test.ts`,
   `ValueRepresentation.test.ts` (18 of 18 other tests green; `Message.test.ts`
   needs the uncommitted `test.dcm`).
3. Independent re-read. With the prototype applied, for all 23 pydicom
   multi-frame and compressed samples (not only the five checked in),
   pydicom 3.0.2 reports the output's Pixel Data element byte-identical to the
   input, the same Basic Offset Table and fragment count, the same
   `NumberOfFrames`, and `pixel_array` decodes to the same shape
   (e.g. `(30, 240, 320, 3)`, `(120, 480, 640, 3)`, `(10, 64, 64)`,
   `(2, 100, 100, 3)`). Script: parse -> anonymise -> write each sample, then
   `pydicom.dcmread` both and compare `PixelData`, `parse_basic_offsets`,
   `parse_fragments`, `generate_frames`, `pixel_array.shape`.
4. DCMTK 3.7.1 (`brew install dcmtk`): `dcmj2pnm --frame N --write-png out.dcm`
   extracts frame 2 and the last frame of `examples_ybr_color.dcm` and
   `SC_rgb_rle_2frame.dcm` from the fixed output; on the current output it
   reports `F: Invalid DICOM image`. `dcmdump` reports no errors on any fixed
   output.
5. `dciodvfy` (dicom3tools, not in Homebrew; build from
   https://www.dclunie.com/dicom3tools.html) on an anonymised Enhanced CT
   should report no `Error - Missing attribute Type 1 Required Element`
   for `SharedFunctionalGroupsSequence` / `PerFrameFunctionalGroupsSequence`
   once 4.4 is implemented. Today it would.
6. A re-anonymise pass (anonymise the anonymised file) must be byte-identical
   on Pixel Data, which 2.2 made impossible before: the second parse used to
   see the writer's 20 KB fragments and inflate them again.

## 6. Scope note on "mh cad"

The report came from a Melbourne Health workstation in 2019-2021. Which
"cad" (CAD software, a CAD-* study, or a cardiology lab) is not known and
nothing here depends on it: the defect is in the encapsulated pixel-data
reader and writer and reproduces on any compressed multi-frame instance
(ultrasound cine, XA/RF runs, Enhanced CT/MR under JPEG 2000 or JPEG-LS),
which is what a hospital PACS exports by default.
