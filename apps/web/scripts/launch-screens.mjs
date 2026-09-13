/**
 * iOS launch-screen geometry, shared by the image generator and the build.
 *
 * Safari shows a white flash when opening a Home Screen app unless an
 * `apple-touch-startup-image` matches the device *exactly* — there is no
 * scaling fallback and no wildcard, so every screen needs its own image and its
 * own media query. Keeping the table in one place is what stops the generated
 * files and the `<link>` tags from drifting apart.
 *
 * Entries are `[logical width, logical height, device pixel ratio]` for the
 * iPhones and iPads still receiving iOS updates.
 */
export const LAUNCH_SCREENS = [
  [320, 568, 2], // iPhone SE (1st gen), iPod touch
  [375, 667, 2], // iPhone SE (2nd/3rd gen), 8
  [390, 844, 3], // iPhone 12/13/14, 16e
  [393, 852, 3], // iPhone 14 Pro, 15, 16
  [402, 874, 3], // iPhone 16 Pro
  [414, 736, 3], // iPhone 8 Plus
  [414, 896, 2], // iPhone XR, 11
  [428, 926, 3], // iPhone 12/13/14 Pro Max
  [430, 932, 3], // iPhone 14 Pro Max, 15/16 Plus
  [440, 956, 3], // iPhone 16 Pro Max
  [744, 1133, 2], // iPad mini
  [768, 1024, 2], // iPad
  [820, 1180, 2], // iPad Air
  [834, 1194, 2], // iPad Pro 11"
  [1024, 1366, 2], // iPad Pro 12.9"
];

/** Every launch image to generate: pixel size plus its media query. */
export function launchScreenVariants() {
  const variants = [];
  for (const [logicalWidth, logicalHeight, ratio] of LAUNCH_SCREENS) {
    for (const portrait of [true, false]) {
      const width = (portrait ? logicalWidth : logicalHeight) * ratio;
      const height = (portrait ? logicalHeight : logicalWidth) * ratio;
      variants.push({
        width,
        height,
        file: `launch/${width}x${height}.png`,
        media:
          `(device-width: ${logicalWidth}px) and (device-height: ${logicalHeight}px) ` +
          `and (-webkit-device-pixel-ratio: ${ratio}) ` +
          `and (orientation: ${portrait ? 'portrait' : 'landscape'})`,
      });
    }
  }
  return variants;
}

/** The `<link rel="apple-touch-startup-image">` tags, resolved against `base`. */
export function launchScreenLinks(base = '/') {
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return launchScreenVariants()
    .map(
      (variant) =>
        `<link rel="apple-touch-startup-image" href="${prefix}${variant.file}" media="${variant.media}" />`,
    )
    .join('\n    ');
}
