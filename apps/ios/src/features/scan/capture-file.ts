import { fileUriToPath } from '../../../modules/kvitto-native/src';
import type { ScanCameraCapture } from './camera-bridge';

/** The part of a VisionCamera `Photo` that saving a capture needs. */
export interface CapturedPhoto {
  width: number;
  height: number;
  /**
   * Writes the photo to disk.
   *
   * **Takes a filesystem path, not a `file://` URI.** VisionCamera documents
   * this, and getting it wrong does not throw: Swift's `URL(fileURLWithPath:)`
   * accepts a URI string and produces `/file:///var/mobile/...`, so the write
   * lands nowhere and the failure surfaces later from whatever tries to read
   * the file that was never written.
   */
  saveToFileAsync(path: string): Promise<void>;
  /** Releases the native buffer. Must happen whether the save worked or not. */
  dispose(): void;
}

export interface CaptureFilePorts {
  /** Returns a writable `file://` URI inside the app's caches directory. */
  makeScratchFileUri(prefix: string, fileExtension: string): string;
}

/**
 * Writes a captured photo to a scratch file and describes where it went.
 *
 * Extracted from the preview component so this boundary can be tested at all.
 * The component itself cannot be rendered in a host test - VisionCamera needs
 * a camera - and this is the one place in the app where a `file://` URI has to
 * become a path, which is exactly the kind of conversion that is invisible
 * until someone taps the shutter on a real phone.
 */
export async function saveCaptureToScratch(
  photo: CapturedPhoto,
  ports: CaptureFilePorts,
): Promise<ScanCameraCapture> {
  const uri = ports.makeScratchFileUri('capture', 'jpg');
  try {
    await photo.saveToFileAsync(fileUriToPath(uri));
    return {
      // The URI, not the path: everything downstream - the blob store, the
      // image processor, the OCR job - speaks `file://`.
      uri,
      width: photo.width,
      height: photo.height,
      // The file was just written; its size is read when it is hashed.
      byteSize: 0,
    };
  } finally {
    // The photo holds a native buffer. Releasing it only on success would
    // leak one per failed capture, and a failed capture is exactly when the
    // user tries again.
    photo.dispose();
  }
}
