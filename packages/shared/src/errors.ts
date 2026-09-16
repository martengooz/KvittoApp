/**
 * Turning a caught value into something a human can read.
 *
 * `catch` hands you `unknown`, and the narrowing dance that follows was written
 * out thirty times across the three workspaces — often as a local helper with a
 * different name in each file. One version of it lives here.
 */

/**
 * The message from a caught value, whatever it turned out to be.
 *
 * A thrown non-`Error` (a string from a library, a rejected fetch value, a
 * `DOMException`-like object) still has to say something, so anything without a
 * `message` is stringified rather than reported as "unknown error" — a bad
 * message beats no message when someone is reading a debug log.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
