import sharp from 'sharp';

/** Pixels at or below this alpha are not really there, so they are skipped. */
const TRANSPARENT_CUTOFF = 8;

/**
 * The average color of an image's visible pixels, as a packed 0xRRGGBB integer,
 * or null when every pixel is transparent or the image cannot be read.
 *
 * Transparent pixels are skipped when averaging: a logo drawn on nothing would
 * otherwise average toward black, which is exactly the dark frame this avoids
 * for the instance icon. The same measurement gives a member a profile color
 * taken from their picture.
 */
export async function averageColor(source: Buffer): Promise<number | null> {
  try {
    // Small: only an average is wanted, and the answer is stored by the caller.
    const { data, info } = await sharp(source)
      .resize(48, 48, { fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let r = 0;
    let g = 0;
    let b = 0;
    let seen = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if ((data[i + 3] ?? 0) <= TRANSPARENT_CUTOFF) continue;
      r += data[i] ?? 0;
      g += data[i + 1] ?? 0;
      b += data[i + 2] ?? 0;
      seen += 1;
    }
    if (seen === 0) return null;
    return (Math.round(r / seen) << 16) | (Math.round(g / seen) << 8) | Math.round(b / seen);
  } catch {
    return null;
  }
}
