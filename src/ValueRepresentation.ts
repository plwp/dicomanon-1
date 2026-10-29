import { ReadBufferStream, BufferStream } from "./BufferStream";
import DicomMessage, {
  NormalizedSyntax,
  TagDict,
  TagValueEntry,
} from "./Message";
import Tag from "./Tag";

function rtrim(str: string): string {
  return str.replace(/\s*$/g, "");
}

export function tagFromNumbers(group: number, element: number): Tag {
  return new Tag(((group << 16) | element) >>> 0);
}

function readTag(stream: BufferStream): Tag {
  var group = stream.readUint16(),
    element = stream.readUint16();

  var tag = tagFromNumbers(group, element);
  return tag;
}

const binaryVRs = ["FL", "FD", "SL", "SS", "UL", "US", "AT"];
const explicitVRList = ["OB", "OW", "OF", "SQ", "UC", "UR", "UT", "UN"];
const singleVRs = ["SQ", "OF", "OW", "OB", "UN"];
export type WriteType =
  | "Uint8"
  | "Int8"
  | "Uint16"
  | "Int16"
  | "Uint32"
  | "Int32"
  | "Float"
  | "Double"
  | "String"
  | "Hex";

export default abstract class ValueRepresentation<Value extends TagValueEntry> {
  type: string;
  multi: boolean;
  maxLength: number | undefined;
  noMultiple: boolean;
  fillWith: string;
  padByte: string;
  fixed?: boolean;
  defaultValue?: Value;
  valueLength?: number;
  maxCharLength?: number;
  checkLength?: (value: string) => boolean;

  constructor(type: string) {
    this.type = type;
    this.multi = false;
    this.maxLength = 0;
    this.fillWith = "";
    this.padByte = "";
    this.noMultiple = false;
  }

  isBinary(): boolean {
    return binaryVRs.indexOf(this.type) != -1;
  }

  allowMultiple() {
    return !this.isBinary() && singleVRs.indexOf(this.type) == -1;
  }

  isExplicit() {
    return explicitVRList.indexOf(this.type) != -1;
  }

  read(
    stream: BufferStream,
    length: number,
    syntax: NormalizedSyntax
  ): undefined | Value | Array<Value> {
    if (this.fixed && this.maxLength) {
      if (!length) return this.defaultValue;
      // if (this.maxLength != length)
      //   console.log("Invalid length for fixed length tag, vr " + this.type + ", length " + this.maxLength + " != " + length);
    }
    return this.readBytes(stream, length, syntax);
  }

  abstract readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): Value | Array<Value>;

  readNullPaddedString(stream: BufferStream, length: number): string {
    if (!length) return "";

    var str = stream.readString(length - 1);
    if (stream.readUint8() != 0) {
      stream.increment(-1);
      str += stream.readString(1);
    }
    return str;
  }

  writeFilledString(stream: BufferStream, value: string, length: number) {
    if (this.maxLength && length < this.maxLength && length >= 0) {
      var written = 0;
      if (length > 0) written += stream.writeString(value);
      var zeroLength = this.maxLength - length;
      written += stream.writeHex(this.fillWith.repeat(zeroLength));
      return written;
    } else if (length == this.maxLength) {
      return stream.writeString(value);
    } else {
      throw "Length mismatch";
    }
  }

  write(
    stream: BufferStream,
    type: "Uint8",
    ...valueArgs: Array<number>
  ): Array<number>;
  write(
    stream: BufferStream,
    type: "Int8",
    ...valueArgs: Array<number>
  ): Array<number>;
  write(
    stream: BufferStream,
    type: "Uint16",
    ...valueArgs: Array<number>
  ): Array<number>;
  write(
    stream: BufferStream,
    type: "Int16",
    ...valueArgs: Array<number>
  ): Array<number>;
  write(
    stream: BufferStream,
    type: "Uint32",
    ...valueArgs: Array<number>
  ): Array<number>;
  write(
    stream: BufferStream,
    type: "Int32",
    ...valueArgs: Array<number>
  ): Array<number>;
  write(
    stream: BufferStream,
    type: "Float",
    ...valueArgs: Array<number>
  ): Array<number>;
  write(
    stream: BufferStream,
    type: "Double",
    ...valueArgs: Array<number>
  ): Array<number>;
  write(
    stream: BufferStream,
    type: "String",
    ...valueArgs: Array<string>
  ): Array<number>;
  write(
    stream: BufferStream,
    type: "Hex",
    ...valueArgs: Array<string>
  ): Array<number>;
  write(
    stream: BufferStream,
    type: WriteType,
    ...valueArgs: Array<number | string>
  ): Array<number> {
    let written: Array<number> = [];
    // Any of the 'WriteType's from BufferStream are accepted
    let func: BufferStream[`write${WriteType}`] = stream["write" + type as `write${WriteType}`];
    const firstValue = valueArgs[0];
    if (Array.isArray(firstValue)) {
      if (firstValue.length < 1) {
        written.push(0);
      } else {
        var self = this;
        firstValue.forEach(function (v: string|number, k) {
          if (self.allowMultiple() && k > 0) {
            stream.writeHex("5C");
          }
          // First value is an array, call the appropriate write() function
          // with each value from the first array & any other value args specified
          var singularArgs = [v].concat(valueArgs.slice(1));

          //@ts-ignore singularArgs: we don't actually have any write*() methods that take >1 args and [v] ensures we supplied at least one arg
          var byteCount = func.apply(stream, singularArgs);
          written.push(byteCount);
        });
      }
    } else if (valueArgs.length > 0) {
      //@ts-ignore valueArgs: we don't actually have any write*() methods that take >1 args and we make sure we pass a firstValue
      written.push(func.apply(stream, valueArgs));
    }
    return written;
  }

  abstract writeBytes(
    stream: BufferStream,
    value: Value | Array<Value>,
    syntax: NormalizedSyntax,
    isEncapsulated?: boolean,
    basicOffsetTable?: Array<number>
  ): number;

  writeByteLengths(
    stream: BufferStream,
    value: Value | Array<Value>,
    lengths: Array<number>,
    isEncapsulated = false
  ) {
    var valid = true,
      valarr = Array.isArray(value) ? value : [value],
      total = 0;
    for (var i = 0; i < valarr.length; i++) {
      let checkValue: Value = valarr[i];
      let checklen = lengths[i],
        isString = false,
        displaylen: string | number = checklen;
      if (this.checkLength && typeof checkValue == "string") {
        valid = this.checkLength(checkValue);
      } else if (this.maxCharLength && typeof checkValue == "string") {
        var check = this.maxCharLength; //, checklen = checkValue.length;
        valid = checkValue.length <= check;
        displaylen = checkValue.length;
        isString = true;
      } else if (this.maxLength) {
        valid = checklen <= this.maxLength;
      }
      var errmsg =
        "Value exceeds max length, VR: " +
        this.type +
        ", value: " +
        checkValue +
        ", length: " +
        displaylen;
      // Due to how liberally some input DICOMs treat maximum field lengths
      // prescribed by the standard we no longer crash while writing out
      // overlong values but log them to the console instead.
      // Note: the object doesn't have access to the offending tag's name
      if (!valid && !isString) {
        console.warn(errmsg)
      }
      total += checklen;
    }
    if (this.allowMultiple()) {
      total += valarr.length ? valarr.length - 1 : 0;
    }
    //check for odd
    var written = total;
    if (total & 1) {
      stream.writeHex(this.padByte);
      written++;
    }
    return written;
  }

  static createByTypeString(
    type: string
  ): ValueRepresentation<TagValueEntry> {
    let vr: ValueRepresentation<TagValueEntry>;
    if (type == "AE") vr = new ApplicationEntity();
    else if (type == "AS") vr = new AgeString();
    else if (type == "AT") vr = new AttributeTag();
    else if (type == "CS") vr = new CodeString();
    else if (type == "DA") vr = new DateValue();
    else if (type == "DS") vr = new DecimalString();
    else if (type == "DT") vr = new DateTime();
    else if (type == "FL") vr = new FloatingPointSingle();
    else if (type == "FD") vr = new FloatingPointDouble();
    else if (type == "IS") vr = new IntegerString();
    else if (type == "LO") vr = new LongString();
    else if (type == "LT") vr = new LongText();
    else if (type == "OB") vr = new OtherByteString();
    // else if (type == "OD") vr = new OtherDoubleString();
    // else if (type == "OF") vr = new OtherFloatString();
    else if (type == "OW") vr = new OtherWordString();
    else if (type == "PN") vr = new PersonName();
    else if (type == "SH") vr = new ShortString();
    else if (type == "SL") vr = new SignedLong();
    else if (type == "SQ") vr = new SequenceOfItems();
    else if (type == "SS") vr = new SignedShort();
    else if (type == "ST") vr = new ShortText();
    else if (type == "TM") vr = new TimeValue();
    else if (type == "UC") vr = new UnlimitedCharacters();
    else if (type == "UI") vr = new UniqueIdentifier();
    else if (type == "UL") vr = new UnsignedLong();
    else if (type == "UN") vr = new UnknownValue();
    else if (type == "UR") vr = new UniversalResource();
    else if (type == "US") vr = new UnsignedShort();
    else if (type == "UT") vr = new UnlimitedText();
    else throw "Invalid vr type " + type;

    return vr;
  }
}

export class StringRepresentation extends ValueRepresentation<string> {
  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): string {
    return stream.readString(length);
  }

  writeBytes(
    stream: BufferStream,
    value: string,
    syntax: NormalizedSyntax,
    isEncapsulated: boolean
  ): number {
    var written = super.write(stream, "String", value);

    return this.writeByteLengths(stream, value, written);
  }
}

export class BinaryRepresentation extends ValueRepresentation<ArrayBuffer> {
  /**
   * Basic Offset Table read from encapsulated pixel data (PS3.5 A.4): one
   * byte offset per frame, or [] when the file carried an empty table.
   * Set by readBytes; DicomMessage.read copies it onto the TagValue.
   */
  basicOffsetTable: Array<number> | undefined;

  writeBytes(
    stream: BufferStream,
    value: Array<ArrayBuffer>,
    syntax: NormalizedSyntax,
    isEncapsulated: boolean,
    basicOffsetTable?: Array<number>
  ): number {
    if (isEncapsulated) {
      // Re-emit the fragments and the Basic Offset Table exactly as read.
      // Fragment boundaries carry meaning (one fragment per frame when the
      // table is empty; an RLE frame may not be split), so never re-fragment.
      const offsets = basicOffsetTable || [];
      stream.writeUint16(0xfffe);
      stream.writeUint16(0xe000);
      stream.writeUint32(offsets.length * 4);
      for (const offset of offsets) {
        stream.writeUint32(offset);
      }
      for (const fragment of value) {
        const fragStream = new ReadBufferStream(fragment);
        const padded =
          fragStream.size & 1 ? fragStream.size + 1 : fragStream.size;
        stream.writeUint16(0xfffe);
        stream.writeUint16(0xe000);
        stream.writeUint32(padded);
        stream.concat(fragStream);
        if (padded != fragStream.size) {
          stream.writeHex(this.padByte);
        }
      }
      stream.writeUint16(0xfffe);
      stream.writeUint16(0xe0dd);
      stream.writeUint32(0x0);
      return 0xffffffff;
    } else {
      var binaryData = value[0],
        binaryStream = new ReadBufferStream(binaryData);
      stream.concat(binaryStream);
      return this.writeByteLengths(stream, binaryData, [binaryStream.size]);
    }
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): Array<ArrayBuffer> {
    if (length == 0xffffffff) {
      // Encapsulated pixel data (PS3.5 A.4): a Basic Offset Table item, then
      // one item per fragment, then a Sequence Delimitation Item. Items are
      // always implicit VR little endian regardless of the transfer syntax.
      const itemTagValue = Tag.readTag(stream);
      if (!itemTagValue.is(0xfffee000)) {
        throw new Error("Item tag not found after undefined binary length");
      }
      const tableLength = stream.readUint32();
      const offsets: Array<number> = [];
      for (let i = 0; i < tableLength / 4; i++) {
        offsets.push(stream.readUint32());
      }
      // Keep every fragment as its own exact-length buffer. Frame boundaries
      // are a property of the table + fragment list, resolved by the caller
      // (see framesOf in src/Multiframe.test.ts), not of this reader.
      const fragments: Array<ArrayBuffer> = [];
      let nextTag = Tag.readTag(stream);
      while (nextTag.is(0xfffee000)) {
        const fragmentLength = stream.readUint32();
        fragments.push(stream.more(fragmentLength).buffer);
        nextTag = Tag.readTag(stream);
      }
      if (!nextTag.is(0xfffee0dd)) {
        throw new Error(
          "Sequence Delimitation Item not found after pixel data fragments"
        );
      }
      stream.readUint32(); // the delimiter's (zero) length
      this.basicOffsetTable = offsets;
      return fragments;
    } else {
      var bytes;
      /*if (this.type == 'OW') {
                bytes = stream.readUint16Array(length);
            } else if (this.type == 'OB') {
                bytes = stream.readUint8Array(length);
            }*/
      bytes = stream.more(length).buffer;
      return [bytes];
    }
  }
}

export class ApplicationEntity extends StringRepresentation {
  constructor() {
    super("AE");
    this.maxLength = 16;
    this.padByte = "20";
    this.fillWith = "20";
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): string {
    return stream.readString(length).trim();
  }
}

export class CodeString extends StringRepresentation {
  constructor() {
    super("CS");
    this.maxLength = 16;
    this.padByte = "20";
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): string {
    return stream.readString(length).trim();
  }
}

export class AgeString extends StringRepresentation {
  constructor() {
    super("AS");
    this.maxLength = 4;
    this.padByte = "20";
    this.fixed = true;
    this.defaultValue = "";
  }
}

export class AttributeTag extends ValueRepresentation<number> {
  maxLength: number;
  valueLength: number;
  padByte: string;
  fixed: boolean;
  constructor() {
    super("AT");
    this.maxLength = 4;
    this.valueLength = 4;
    this.padByte = "00";
    this.fixed = true;
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): number {
    var group = stream.readUint16(),
      element = stream.readUint16();
    return tagFromNumbers(group, element).value;
  }

  writeBytes(stream: BufferStream, value: number) {
    return this.writeByteLengths(
      stream,
      value,
      super.write(stream, "Uint32", value)
    );
  }
}

export class DateValue extends StringRepresentation {
  constructor() {
    super("DA");
    this.maxLength = 18;
    this.padByte = "20";
    this.defaultValue = "";
  }
}

export class DecimalString extends StringRepresentation {
  constructor() {
    super("DS");
    this.maxLength = 16;
    this.padByte = "20";
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): string {
    return stream.readString(length).trim();
  }
}

export class DateTime extends StringRepresentation {
  constructor() {
    super("DT");
    this.maxLength = 26;
    this.padByte = "20";
  }
}

export class FloatingPointSingle extends ValueRepresentation<number> {
  maxLength: number;
  padByte: string;
  fixed: boolean;
  defaultValue: number;
  constructor() {
    super("FL");
    this.maxLength = 4;
    this.padByte = "00";
    this.fixed = true;
    this.defaultValue = 0.0;
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): number {
    return stream.readFloat();
  }

  writeBytes(stream: BufferStream, value: number) {
    return this.writeByteLengths(
      stream,
      value,
      super.write(stream, "Float", value)
    );
  }
}

export class FloatingPointDouble extends ValueRepresentation<number> {
  maxLength: number;
  padByte: string;
  fixed: boolean;
  defaultValue: number;
  constructor() {
    super("FD");
    this.maxLength = 8;
    this.padByte = "00";
    this.fixed = true;
    this.defaultValue = 0.0;
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): number {
    return stream.readDouble();
  }

  writeBytes(stream: BufferStream, value: number) {
    return this.writeByteLengths(
      stream,
      value,
      super.write(stream, "Double", value)
    );
  }
}

export class IntegerString extends StringRepresentation {
  constructor() {
    super("IS");
    this.maxLength = 12;
    this.padByte = "20";
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): string {
    return stream.readString(length).trim();
  }
}

export class LongString extends StringRepresentation {
  constructor() {
    super("LO");
    this.maxCharLength = 64;
    this.padByte = "20";
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): string {
    return stream.readString(length).trim();
  }
}

export class LongText extends StringRepresentation {
  constructor() {
    super("LT");
    this.maxCharLength = 10240;
    this.padByte = "20";
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): string {
    return rtrim(stream.readString(length));
  }
}

export class PersonName extends StringRepresentation {
  constructor() {
    super("PN");
    this.maxLength = undefined;
    this.padByte = "20";
    this.checkLength = (value) => {
      var cmps = value.split(/\^/);
      for (var i in cmps) {
        var cmp = cmps[i];
        if (cmp.length > 64) return false;
      }
      return true;
    };
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): string {
    return rtrim(stream.readString(length));
  }
}

export class ShortString extends StringRepresentation {
  constructor() {
    super("SH");
    this.maxCharLength = 16;
    this.padByte = "20";
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): string {
    return stream.readString(length).trim();
  }
}

export class SignedLong extends ValueRepresentation<number> {
  maxLength: number;
  padByte: string;
  fixed: boolean;
  defaultValue: number;
  constructor() {
    super("SL");
    this.maxLength = 4;
    this.padByte = "00";
    this.fixed = true;
    this.defaultValue = 0;
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): number {
    return stream.readInt32();
  }

  writeBytes(stream: BufferStream, value: number) {
    return this.writeByteLengths(
      stream,
      value,
      super.write(stream, "Int32", value)
    );
  }
}

export class SequenceOfItems extends ValueRepresentation<TagDict> {
  maxLength: undefined | number;
  padByte: string;
  noMultiple: boolean;
  defaultValue: undefined;
  constructor() {
    super("SQ");
    this.maxLength = undefined;
    this.padByte = "00";
    this.noMultiple = true;
  }

  readBytes(
    stream: BufferStream,
    sqlength: number,
    syntax: NormalizedSyntax
  ): Array<TagDict> {
    if (sqlength == 0x0) {
      return []; //contains no dataset
    } else {
      var undefLength = sqlength == 0xffffffff,
        elements: Array<TagDict> = [],
        read = 0;

      while (true) {
        var tag = readTag(stream);
        read += 4;

        if (tag.is(0xfffee0dd)) {
          stream.readUint32();
          break;
        } else if (!undefLength && read == sqlength) {
          break;
        } else if (tag.is(0xfffee000)) {
          let length = stream.readUint32();
          read += 4;
          var itemStream = null,
            toRead = 0,
            undef = length == 0xffffffff;

          if (undef) {
            var stack = 0;
            while (1) {
              var g = stream.readUint16();
              if (g == 0xfffe) {
                var ge = stream.readUint16();
                if (ge == 0xe00d) {
                  stack--;
                  if (stack < 0) {
                    stream.increment(4);
                    read += 8;
                    break;
                  } else {
                    toRead += 4;
                  }
                } else if (ge == 0xe000) {
                  stack++;
                  toRead += 4;
                } else {
                  toRead += 2;
                  stream.increment(-2);
                }
              } else {
                toRead += 2;
              }
            }
          } else {
            toRead = length;
          }

          if (toRead) {
            stream.increment(undef ? -toRead - 8 : 0);
            itemStream = stream.more(toRead); //parseElements
            read += toRead;
            if (undef) stream.increment(8);

            var items = DicomMessage.read(itemStream, syntax);
            elements.push(items);
          }
          if (!undefLength && read == sqlength) {
            break;
          }
        }
      }
      return elements;
    }
  }

  writeBytes(
    stream: BufferStream,
    value: Array<TagDict>,
    syntax: NormalizedSyntax
  ) {
    let written = 0;
    if (value) {
      for (var i = 0; i < value.length; i++) {
        var item = value[i];
        super.write(stream, "Uint16", 0xfffe);
        super.write(stream, "Uint16", 0xe000);
        super.write(stream, "Uint32", 0xffffffff);

        written += DicomMessage.write(item, stream, syntax);

        super.write(stream, "Uint16", 0xfffe);
        super.write(stream, "Uint16", 0xe00d);
        super.write(stream, "Uint32", 0x00000000);
        written += 16;
      }
    }
    super.write(stream, "Uint16", 0xfffe);
    super.write(stream, "Uint16", 0xe0dd);
    super.write(stream, "Uint32", 0x00000000);
    written += 8;

    return this.writeByteLengths(stream, value, [written]);
  }
}

export class SignedShort extends ValueRepresentation<number> {
  constructor() {
    super("SS");
    this.maxLength = 2;
    this.valueLength = 2;
    this.padByte = "00";
    this.fixed = true;
    this.defaultValue = 0;
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): number {
    return stream.readInt16();
  }

  writeBytes(stream: BufferStream, value: number) {
    return this.writeByteLengths(
      stream,
      value,
      super.write(stream, "Int16", value)
    );
  }
}

export class ShortText extends StringRepresentation {
  constructor() {
    super("ST");
    this.maxCharLength = 1024;
    this.padByte = "20";
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): string {
    return rtrim(stream.readString(length));
  }
}

export class TimeValue extends StringRepresentation {
  constructor() {
    super("TM");
    this.maxLength = 14;
    this.padByte = "20";
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): string {
    return rtrim(stream.readString(length));
  }
}

export class UnlimitedCharacters extends StringRepresentation {
  constructor() {
    super("UC");
    this.maxLength = undefined;
    this.multi = true;
    this.padByte = "20";
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): string {
    return rtrim(stream.readString(length));
  }
}

export class UnlimitedText extends StringRepresentation {
  constructor() {
    super("UT");
    this.maxLength = undefined;
    this.padByte = "20";
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): string {
    return rtrim(stream.readString(length));
  }
}

export class UnsignedShort extends ValueRepresentation<number> {
  constructor() {
    super("US");
    this.maxLength = 2;
    this.padByte = "00";
    this.fixed = true;
    this.defaultValue = 0;
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): number {
    return stream.readUint16();
  }

  writeBytes(stream: BufferStream, value: number) {
    return this.writeByteLengths(
      stream,
      value,
      super.write(stream, "Uint16", value)
    );
  }
}

export class UnsignedLong extends ValueRepresentation<number> {
  constructor() {
    super("UL");
    this.maxLength = 4;
    this.padByte = "00";
    this.fixed = true;
    this.defaultValue = 0;
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): number {
    return stream.readUint32();
  }

  writeBytes(stream: BufferStream, value: number) {
    return this.writeByteLengths(
      stream,
      value,
      super.write(stream, "Uint32", value)
    );
  }
}

export class UniqueIdentifier extends StringRepresentation {
  constructor() {
    super("UI");
    this.maxLength = 64;
    this.padByte = "00";
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): string {
    return this.readNullPaddedString(stream, length);
  }
}

export class UniversalResource extends StringRepresentation {
  constructor() {
    super("UR");
    this.maxLength = undefined;
    this.padByte = "20";
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): string {
    return stream.readString(length);
  }
}

export class UnknownValue extends StringRepresentation {
  constructor() {
    super("UN");
    this.maxLength = undefined;
    this.padByte = "00";
    this.noMultiple = true;
  }

  readBytes(
    stream: BufferStream,
    length: number,
    _syntax: NormalizedSyntax
  ): string {
    return stream.readString(length);
  }
}

export class OtherWordString extends BinaryRepresentation {
  constructor() {
    super("OW");
    this.maxLength = undefined;
    this.padByte = "00";
    this.noMultiple = true;
  }
}

export class OtherByteString extends BinaryRepresentation {
  constructor() {
    super("OB");
    this.maxLength = undefined;
    this.padByte = "00";
    this.noMultiple = true;
  }

  /*writeBytes(stream, value) {
        var written = super.write(stream, 'Hex', value);
        return this.writeByteLengths(stream, value, written);
    } */
}
