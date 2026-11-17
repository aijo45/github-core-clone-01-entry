// Packfile parser: PACK v2/v3, zlib objects, OFS_DELTA / REF_DELTA with
// recursive resolution + memoization, trailer checksum validation
// (DESIGN.md §4, pack-read.ts). Throws on any corruption.

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { GitObject, Sha1 } from '../model.ts';
import { sha1Object } from './objects.ts';

const TYPE_CODE_TO_TYPE: Record<number, GitObject['type']> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};
const OFS_DELTA = 6;
const REF_DELTA = 7;

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer; // inflated bytes (delta instructions for delta entries)
  baseOffset?: number; // OFS_DELTA: absolute offset of the base entry
  baseOid?: string; // REF_DELTA: base object id
}

/** Read the type/size varint at `start`. Returns size, type code bits, next offset. */
function readSizeHeader(buf: Buffer, start: number): { size: number; typeCode: number; next: number } {
  if (start >= buf.length) throw new Error('pack entry has no size header');
  let byte = buf[start];
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('pack entry size varint is truncated');
    byte = buf[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, typeCode, next: offset };
}

/** Read an OFS_DELTA base offset (offset-from-entry encoding). */
function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buf.length) throw new Error('ofs-delta has no base offset');
  let byte = buf[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('ofs-delta base offset is truncated');
    byte = buf[offset++];
    value = ((value + 1) << 7) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/**
 * Inflate one zlib stream starting at `offset` (bounded by `end`).
 * Returns the inflated bytes and the offset just past the stream.
 * `engine.bytesWritten` is the number of input bytes the stream consumed.
 */
function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buf.subarray(offset, end), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset |= delta[offset++] << (bit * 8);
        }
      }
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize |= delta[offset++] << ((bit - 4) * 8);
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/**
 * Parse a packfile and resolve every object. Returns the decoded objects
 * in pack order (caller stores them via store.putObject). Throws on a bad
 * magic/version, a truncated or corrupt entry, a delta whose base is not
 * in the pack, a delta cycle, or a trailer checksum mismatch.
 */
export function parsePack(buf: Buffer): GitObject[] {
  if (buf.length < 32) throw new Error(`pack is ${buf.length} bytes, too short`);
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('pack does not start with PACK');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) {
    throw new Error(`pack trailer ${trailer} does not match its bytes ${computedTrailer}`);
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readSizeHeader(buf, offset);
    offset = header.next;
    const entry: RawEntry = { offset: entryOffset, typeCode: header.typeCode, size: header.size, data: Buffer.alloc(0) };
    if (header.typeCode === OFS_DELTA) {
      const base = readOfsBase(buf, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (header.typeCode === REF_DELTA) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!TYPE_CODE_TO_TYPE[header.typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${header.typeCode}`);
    }
    const inflated = inflateAt(buf, offset, trailerStart);
    if (inflated.data.length !== header.size) {
      throw new Error(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  // Recursive resolution with memoization; resolvedByOid lets a REF_DELTA
  // find its base in O(1) instead of scanning the pack.
  const resolved = new Map<number, { type: GitObject['type']; data: Buffer; oid: Sha1 }>();
  const resolvedByOid = new Map<string, { type: GitObject['type']; data: Buffer; oid: Sha1 }>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObject['type']; data: Buffer; oid: Sha1 } => {
    const memo = resolved.get(entry.offset);
    if (memo) return memo;
    if (resolving.has(entry.offset)) {
      throw new Error(`delta cycle at pack offset ${entry.offset}`);
    }
    resolving.add(entry.offset);
    let type: GitObject['type'];
    let data: Buffer;
    if (entry.typeCode === OFS_DELTA) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) {
        throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      }
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === REF_DELTA) {
      const wanted = entry.baseOid as string;
      let base = resolvedByOid.get(wanted);
      if (!base) {
        // The base may be a later entry in the pack: resolve candidates
        // until one yields the wanted id (memoized, so each entry is
        // resolved at most once overall).
        for (const candidate of raw) {
          if (candidate.offset === entry.offset) continue;
          if (resolved.has(candidate.offset) || resolving.has(candidate.offset)) continue;
          const solved = resolve(candidate);
          if (solved.oid === wanted) {
            base = solved;
            break;
          }
        }
      }
      if (!base) {
        throw new Error(`ref-delta base ${entry.baseOid} is not in the pack`);
      }
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = TYPE_CODE_TO_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = sha1Object(type, data);
    const solved = { type, data, oid };
    resolved.set(entry.offset, solved);
    resolvedByOid.set(oid, solved);
    resolving.delete(entry.offset);
    return solved;
  };

  const objects: GitObject[] = [];
  for (const entry of raw) {
    const solved = resolve(entry);
    objects.push({ type: solved.type, raw: solved.data });
  }
  return objects;
}
