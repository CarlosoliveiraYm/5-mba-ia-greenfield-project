/**
 * Object key helpers.
 *
 * Note what is deliberately absent: the video object's own key. That key is the
 * tus upload id produced by the `namingFunction` in the tus server wiring, so it
 * is decided by the upload layer and merely stored on the video row.
 */

/** Where the worker writes the auto-generated thumbnail for a video. */
export function videoThumbnailKey(videoId: string): string {
  return `thumbnails/${videoId}/auto.webp`;
}

/**
 * The normalized, lowercased extension of an uploaded filename, with no leading
 * dot. Throws when the filename carries no extension — the caller decides which
 * protocol error that becomes.
 */
export function uploadObjectExtension(filename: string): string {
  const base = filename.trim().split(/[\\/]/).pop() ?? '';
  const dotIndex = base.lastIndexOf('.');

  if (dotIndex <= 0 || dotIndex === base.length - 1) {
    throw new Error(`Filename has no extension: "${filename}"`);
  }

  return base.slice(dotIndex + 1).toLowerCase();
}
