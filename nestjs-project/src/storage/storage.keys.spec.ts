import { uploadObjectExtension, videoThumbnailKey } from './storage.keys';

describe('videoThumbnailKey', () => {
  it('should produce the documented thumbnails/{videoId}/auto.webp layout', () => {
    expect(videoThumbnailKey('0f7c8f2e-1b3a-4d5e-9a01-2b3c4d5e6f70')).toBe(
      'thumbnails/0f7c8f2e-1b3a-4d5e-9a01-2b3c4d5e6f70/auto.webp',
    );
  });
});

describe('uploadObjectExtension', () => {
  it('should lowercase the extension and strip the leading dot', () => {
    expect(uploadObjectExtension('Holiday.MP4')).toBe('mp4');
  });

  it('should use only the last extension of a multi-dotted filename', () => {
    expect(uploadObjectExtension('my.holiday.clip.webm')).toBe('webm');
  });

  it('should ignore any directory component of the filename', () => {
    expect(uploadObjectExtension('C:\\Users\\me\\clip.MOV')).toBe('mov');
    expect(uploadObjectExtension('/home/me/clip.mkv')).toBe('mkv');
  });

  it('should reject a filename with no extension', () => {
    expect(() => uploadObjectExtension('holiday')).toThrow(/no extension/i);
  });

  it('should reject a dotfile, which has a name but no extension', () => {
    expect(() => uploadObjectExtension('.gitignore')).toThrow(/no extension/i);
  });

  it('should reject a filename ending in a dot', () => {
    expect(() => uploadObjectExtension('holiday.')).toThrow(/no extension/i);
  });
});
