/**
 * Whether an MP4/MOV file already has its `moov` atom before `mdat` —
 * "faststart" layout, which is what lets a player start rendering before the
 * whole file has arrived.
 *
 * Box parsing, not an FFmpeg invocation, so it lives outside `FfmpegService`.
 * The caller supplies the first N bytes via a range read: `moov` at the head is
 * visible within the first few hundred KiB, and a trailing one is detected as
 * soon as `mdat` is seen, so a 10 GB file never has to be downloaded.
 */
export function hasFaststartLayout(headBytes: Buffer): boolean {
  if (headBytes.length < 8 || !looksLikeMp4(headBytes)) {
    return false;
  }

  let offset = 0;

  while (offset + 8 <= headBytes.length) {
    const declaredSize = headBytes.readUInt32BE(offset);
    const type = headBytes.toString('ascii', offset + 4, offset + 8);

    if (type === 'moov') return true;
    if (type === 'mdat') return false;

    const size = boxSize(headBytes, offset, declaredSize);
    // A zero size means "to end of file", and anything under the 8-byte header
    // is malformed — either way there is no further box to walk.
    if (size === null) return false;

    offset += size;
  }

  // The head ran out before either atom appeared: not provably faststart.
  return false;
}

/** The `ftyp` box is the first thing in every well-formed MP4/MOV. */
function looksLikeMp4(headBytes: Buffer): boolean {
  return headBytes.toString('ascii', 4, 8) === 'ftyp';
}

function boxSize(
  headBytes: Buffer,
  offset: number,
  declaredSize: number,
): number | null {
  if (declaredSize === 1) {
    // 64-bit extended size follows the 8-byte header.
    if (offset + 16 > headBytes.length) return null;
    const large = headBytes.readBigUInt64BE(offset + 8);
    return large >= 16n && large <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(large)
      : null;
  }

  return declaredSize >= 8 ? declaredSize : null;
}
