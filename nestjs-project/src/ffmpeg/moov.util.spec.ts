import { hasFaststartLayout } from './moov.util';

/** Builds a minimal top-level box: 4-byte size, 4-byte type, then padding. */
function box(type: string, payloadLength = 0): Buffer {
  const buffer = Buffer.alloc(8 + payloadLength);
  buffer.writeUInt32BE(8 + payloadLength, 0);
  buffer.write(type, 4, 4, 'ascii');
  return buffer;
}

const ftyp = () => box('ftyp', 16);

describe('hasFaststartLayout', () => {
  it('should report true when moov precedes mdat', () => {
    const head = Buffer.concat([ftyp(), box('moov', 64), box('mdat', 128)]);

    expect(hasFaststartLayout(head)).toBe(true);
  });

  it('should report false when mdat precedes moov', () => {
    const head = Buffer.concat([ftyp(), box('mdat', 128), box('moov', 64)]);

    expect(hasFaststartLayout(head)).toBe(false);
  });

  it('should skip intervening boxes before reaching moov', () => {
    const head = Buffer.concat([
      ftyp(),
      box('free', 32),
      box('wide', 8),
      box('moov', 64),
    ]);

    expect(hasFaststartLayout(head)).toBe(true);
  });

  it('should handle a 64-bit extended box size', () => {
    const extended = Buffer.alloc(16 + 32);
    extended.writeUInt32BE(1, 0);
    extended.write('free', 4, 4, 'ascii');
    extended.writeBigUInt64BE(BigInt(16 + 32), 8);

    const head = Buffer.concat([ftyp(), extended, box('moov', 16)]);

    expect(hasFaststartLayout(head)).toBe(true);
  });

  it('should reject a buffer that is not an MP4', () => {
    expect(
      hasFaststartLayout(Buffer.from('this is plain text, not media')),
    ).toBe(false);
  });

  it('should reject an empty or truncated buffer', () => {
    expect(hasFaststartLayout(Buffer.alloc(0))).toBe(false);
    expect(hasFaststartLayout(Buffer.alloc(4))).toBe(false);
  });

  it('should report false when neither atom appears in the supplied head', () => {
    const head = Buffer.concat([ftyp(), box('free', 32)]);

    expect(hasFaststartLayout(head)).toBe(false);
  });

  it('should stop rather than loop on a malformed zero-sized box', () => {
    const malformed = Buffer.alloc(8);
    malformed.writeUInt32BE(0, 0);
    malformed.write('junk', 4, 4, 'ascii');
    const head = Buffer.concat([ftyp(), malformed, box('moov', 16)]);

    expect(hasFaststartLayout(head)).toBe(false);
  });
});
