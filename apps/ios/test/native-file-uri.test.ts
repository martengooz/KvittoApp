import { describe, expect, test } from '@jest/globals';

import { fileUriToPath } from '../modules/kvitto-native/src/file-uri';

describe('file URI to path', () => {
  test('strips the scheme from a scratch URI', () => {
    // The real shape: `makeScratchFileUri` returns a URL's `absoluteString`.
    expect(
      fileUriToPath(
        'file:///var/mobile/Containers/Data/Application/8CC07E9F/Library/Caches/kvitto-scratch/capture-32EE4A8A.jpg',
      ),
    ).toBe(
      '/var/mobile/Containers/Data/Application/8CC07E9F/Library/Caches/kvitto-scratch/capture-32EE4A8A.jpg',
    );
  });

  test('keeps the leading slash of an absolute path', () => {
    // `file://` plus an empty authority plus `/var/...`. Losing this slash
    // would produce a relative path, which is a different failure with the
    // same symptom.
    expect(fileUriToPath('file:///tmp/a.jpg').startsWith('/')).toBe(true);
  });

  test('decodes percent escapes', () => {
    expect(fileUriToPath('file:///var/My%20Folder/a%2Bb.jpg')).toBe('/var/My Folder/a+b.jpg');
  });

  test('leaves a plain path alone', () => {
    // Safe to apply to either, so a caller never has to know which it has.
    expect(fileUriToPath('/var/mobile/a.jpg')).toBe('/var/mobile/a.jpg');
  });

  test('survives a malformed escape rather than throwing', () => {
    // `decodeURIComponent` throws on a stray `%`. A capture must not fail
    // because of one, and the undecoded form is still closer to right.
    expect(fileUriToPath('file:///var/100%.jpg')).toBe('/var/100%.jpg');
  });

  test('does not rewrite a non-file scheme', () => {
    expect(fileUriToPath('https://example.com/a.jpg')).toBe('https://example.com/a.jpg');
  });

  test('the result is not what a naive URL-as-path would produce', () => {
    // This is the actual defect: Swift's `URL(fileURLWithPath:)` accepts the
    // URI and yields `/file:///var/...`, writes nowhere useful, and the error
    // only appears when something later tries to read it.
    const path = fileUriToPath('file:///var/mobile/capture.jpg');
    expect(path).not.toContain('file:');
  });
});
