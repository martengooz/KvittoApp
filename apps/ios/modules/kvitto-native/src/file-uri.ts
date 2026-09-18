/**
 * Converts a `file://` URI to a plain filesystem path.
 *
 * This module vends `file://` URIs everywhere, and its own native functions
 * take them - `requireFileURL` parses them with `URL(string:)`. Third-party
 * native code often wants the other thing. VisionCamera's
 * `Photo.saveToFileAsync` is explicit about it: "This must be a filesystem
 * path, not a `file://` URL."
 *
 * Handing it a URI does not fail loudly. Swift's `URL(fileURLWithPath:)`
 * accepts the string and produces `/file:///var/mobile/...` - a path with the
 * scheme embedded in it - and the write lands nowhere useful. The error
 * surfaces later, from whatever tries to read the file that was never written,
 * naming a path nobody wrote.
 */
export function fileUriToPath(uri: string): string {
  if (!uri.startsWith('file://')) {
    // Already a path, or something this has no business rewriting. Returning
    // it unchanged keeps the function safe to apply to either.
    return uri;
  }

  const withoutScheme = uri.slice('file://'.length);
  // `file:///var/x` has an empty authority, leaving a leading `/` that is part
  // of the path. A `file://localhost/var/x` form would not, but nothing in
  // this app produces one.
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    // A stray `%` that is not a valid escape. The raw form is still closer to
    // right than throwing, and every path this app generates is a UUID.
    return withoutScheme;
  }
}
