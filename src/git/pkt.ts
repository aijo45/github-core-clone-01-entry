// pkt-line framing for the git smart-HTTP protocol (DESIGN.md §4, pkt.ts).
//
// A pkt-line is 4 lowercase-hex length bytes (length includes the 4 header
// bytes) followed by the payload. Length 0 is a flush, 1 a delim, 2 a
// response-end. The largest legal pkt-line is 65520 bytes total. Binary
// bodies are never converted to strings: every operation here is Buffer-based.

export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export type PktLine =
  | { kind: 'pkt'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

function headerFor(payloadLength: number): Buffer {
  const header = Buffer.allocUnsafe(4);
  header.write((payloadLength + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return header;
}

export class PktWriter {
  /** 4-hex length + payload. Throws when the payload exceeds the pkt-line maximum. */
  static pkt(payload: Buffer | string): Buffer {
    const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
    if (data.length > PKT_LINE_MAX_PAYLOAD) {
      throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
    }
    return Buffer.concat([headerFor(data.length), data]);
  }

  /** "0000" */
  static flush(): Buffer {
    return Buffer.from('0000', 'ascii');
  }

  /** "0001" */
  static delim(): Buffer {
    return Buffer.from('0001', 'ascii');
  }

  /** "0002" */
  static responseEnd(): Buffer {
    return Buffer.from('0002', 'ascii');
  }

  /**
   * Side-band frame(s): one pkt-line per chunk, each payload a channel byte
   * (1 = pack data, 2 = progress, 3 = fatal error) followed by data. Large
   * data is split across several pkt-lines so no frame exceeds the maximum.
   */
  static sideband(channel: 1 | 2 | 3, data: Buffer): Buffer {
    const parts: Buffer[] = [];
    const maxChunk = PKT_LINE_MAX_PAYLOAD - 1; // one byte is the channel
    if (data.length === 0) {
      parts.push(PktWriter.pkt(Buffer.from([channel])));
      return Buffer.concat(parts);
    }
    for (let offset = 0; offset < data.length; offset += maxChunk) {
      const chunk = data.subarray(offset, Math.min(data.length, offset + maxChunk));
      parts.push(PktWriter.pkt(Buffer.concat([Buffer.from([channel]), chunk])));
    }
    return Buffer.concat(parts);
  }
}

export class PktReader {
  private offset = 0;
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  /** Bytes not yet consumed (e.g. the packfile after the pkt section). */
  rest(): Buffer {
    return this.buf.subarray(this.offset);
  }

  /** Bytes consumed so far. */
  get consumed(): number {
    return this.offset;
  }

  /** True when every byte has been consumed. */
  get done(): boolean {
    return this.offset >= this.buf.length;
  }

  /**
   * The next pkt-line. Throws on truncation, a non-hex length, length 3, or
   * a length over the maximum. Returns null only at end of buffer.
   */
  next(): PktLine | null {
    if (this.offset >= this.buf.length) return null;
    if (this.buf.length - this.offset < 4) {
      throw new Error(`truncated pkt-line: ${this.buf.length - this.offset} trailing byte(s)`);
    }
    const header = this.buf.subarray(this.offset, this.offset + 4).toString('ascii');
    if (!HEX4.test(header)) {
      throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      this.offset += 4;
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.offset += 4;
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.offset += 4;
      return { kind: 'response-end' };
    }
    if (length === 3) {
      throw new Error('invalid pkt-line length 0003');
    }
    if (length > PKT_LINE_MAX) {
      throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    }
    if (this.buf.length - this.offset < length) {
      throw new Error(`truncated pkt-line: ${length} announced, ${this.buf.length - this.offset} available`);
    }
    const data = this.buf.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return { kind: 'pkt', data };
  }

  /**
   * All data-packet payloads up to (and consuming) the first flush/delim/
   * response-end control packet, or up to end of buffer. Control packets
   * stop the scan; the stopping packet is consumed and returned.
   */
  readUntilControl(): { payloads: Buffer[]; control: PktLine | null } {
    const payloads: Buffer[] = [];
    for (;;) {
      const packet = this.next();
      if (packet === null) return { payloads, control: null };
      if (packet.kind === 'pkt') {
        payloads.push(packet.data);
        continue;
      }
      return { payloads, control: packet };
    }
  }
}
