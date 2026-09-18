import { describe, expect, test } from '@jest/globals';

import { saveCaptureToScratch, type CapturedPhoto } from '../src/features/scan/capture-file';

const SCRATCH_URI =
  'file:///var/mobile/Containers/Data/Application/8CC07E9F/Library/Caches/kvitto-scratch/capture-1.jpg';

function photo(overrides: Partial<CapturedPhoto> = {}) {
  const saved: string[] = [];
  let disposed = 0;
  const value: CapturedPhoto & { saved: string[]; disposedCount: () => number } = {
    width: 3024,
    height: 4032,
    saveToFileAsync: async (path: string) => {
      saved.push(path);
    },
    dispose: () => {
      disposed += 1;
    },
    saved,
    disposedCount: () => disposed,
    ...overrides,
  };
  return value;
}

const ports = { makeScratchFileUri: () => SCRATCH_URI };

describe('saving a capture to a scratch file', () => {
  test('hands VisionCamera a path, not a file:// URI', async () => {
    /*
     * This is the defect that got through to a real phone. VisionCamera's
     * `saveToFileAsync` documents that it takes a filesystem path, and passing
     * a URI does not throw - Swift's `URL(fileURLWithPath:)` accepts it and
     * produces `/file:///var/mobile/...`. The write goes nowhere and the error
     * appears much later, from the code that reads the file, naming a path
     * with the scheme embedded in it.
     */
    const subject = photo();

    await saveCaptureToScratch(subject, ports);

    expect(subject.saved).toHaveLength(1);
    expect(subject.saved[0]).toBe(
      '/var/mobile/Containers/Data/Application/8CC07E9F/Library/Caches/kvitto-scratch/capture-1.jpg',
    );
    expect(subject.saved[0]).not.toContain('file:');
  });

  test('reports the URI, because everything downstream speaks URIs', async () => {
    // The blob store, the image processor and the OCR job all take `file://`.
    const capture = await saveCaptureToScratch(photo(), ports);

    expect(capture.uri).toBe(SCRATCH_URI);
    expect(capture.width).toBe(3024);
    expect(capture.height).toBe(4032);
  });

  test('releases the native buffer even when the save fails', async () => {
    // A failed capture is exactly when someone tries again, so leaking a
    // buffer per failure is the worst time to leak one.
    const subject = photo({
      saveToFileAsync: async () => {
        throw new Error('disk full');
      },
    });

    await expect(saveCaptureToScratch(subject, ports)).rejects.toThrow('disk full');
    expect(subject.disposedCount()).toBe(1);
  });

  test('releases the native buffer on success too', async () => {
    const subject = photo();
    await saveCaptureToScratch(subject, ports);
    expect(subject.disposedCount()).toBe(1);
  });
});
