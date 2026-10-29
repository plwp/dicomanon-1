# Changelog

## Unreleased

### Changed (breaking for library users)

- **Encapsulated Pixel Data `Value` is now the fragment list.** For compressed
  transfer syntaxes, `dict["7FE00010"].Value` holds one `ArrayBuffer` per
  fragment item, in file order, and the Basic Offset Table read from the file
  is on the entry as `dict["7FE00010"].basicOffsetTable` (an array of byte
  offsets, `[]` for an empty table). Before, `Value` was in practice one
  oversized buffer with allocation slack. Code that read `Value[0]` as the
  whole image must now concatenate the fragments, using `basicOffsetTable` to
  split them into frames. `DicomDict.upsertTag` clears `basicOffsetTable`
  when it replaces `Value`. Native (uncompressed) Pixel Data is unchanged.
- Odd-length fragments are refused instead of padded (PS3.5 A.4 requires even
  item lengths, and padding moved every later fragment away from its offset).

### Fixed

- Multi-frame compressed files (JPEG, JPEG-LS, JPEG 2000, RLE) keep every
  frame byte-identical and locatable: fragments are written as read, never
  re-cut. Before, viewers could find frame 1 only.
- The Basic Offset Table is checked against the fragments being written: it
  must start at 0, increase strictly and name only fragment boundaries. A
  table that does not match, which would leave frames 2 onward undisplayable,
  is rebuilt when there is one fragment per frame and otherwise refused with
  `EncapsulationError` (exported; see its `code`).
- Malformed encapsulated Pixel Data is refused with `EncapsulationError`
  rather than a generic error: a table length that is not a multiple of 4,
  an item running past the data, an odd or undefined fragment length, a
  missing or non-zero-length Sequence Delimitation Item.
- Only Pixel Data (7FE0,0010) is encapsulated on write; other OB/OW elements
  in a compressed file, such as palette lookup tables, keep their defined
  length.
- Files carrying an Extended Offset Table (7FE0,0001)/(7FE0,0002), VR OV,
  are read (they failed with "Invalid vr type OV") and both attributes are
  kept: they are structural and not listed in PS3.15 Table E.1-1.
- Every multi-frame file keeps its Shared (5200,9229) and Per-frame
  (5200,9230) Functional Groups Sequences, which PS3.3 C.7.6.16 makes Type 1
  and Type 1C, and Enhanced CT, MR and XA files get a class policy. Their
  items are cleaned with a nested whitelist: frame geometry, pixel measures,
  window, rescale, Real World Value Mapping numbers and units, frame type,
  frame indices and coded anatomy are kept; Irradiation Event UID is hashed
  (Table E.1-1: U); Frame Acquisition and Frame Reference DateTime are
  replaced with 19700101000000.000000 (Table E.1-1: D); Derivation Image
  Sequence is kept empty (Type 2); Frame Comments (X), derivation references
  (X/Z/U*) and free-text labels are removed. The full reasoning,
  attribute by attribute, is in `src/Policies.ts` above
  `functionalGroupItemPolicy()`; the README lists every nested rule.
- `DicomDict.upsertTag` on Pixel Data also drops a stale Extended Offset
  Table and its Lengths; a Basic Offset Table entry beyond 32 bits is
  refused (`OFFSET_TOO_LARGE`).

### Not yet

- Enhanced CT, MR and XA are not listed in `supportedSOPClasses()`: full
  conformance for them needs their acquisition macros reviewed.
