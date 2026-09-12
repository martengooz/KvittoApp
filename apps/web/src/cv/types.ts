/** Messages exchanged with the OpenCV worker, and the pipeline's tuning knobs. */

/** A corner of the detected receipt, in source-image pixel coordinates. */
export interface Point {
  x: number;
  y: number;
}

/** The four corners of a detected document, ordered top-left → clockwise. */
export type Quad = [Point, Point, Point, Point];

/** How the deskewed image is finished before it goes to the model. */
export type EnhanceMode =
  /** Colour, shadow-flattened. Best when the receipt has coloured logos or highlighting. */
  | 'color'
  /** Grayscale, shadow-flattened, CLAHE + unsharp. The default and the best all-rounder. */
  | 'grayscale'
  /** Hard black-and-white via adaptive threshold. Smallest files, but drops faint thermal text. */
  | 'binarize'
  /** Deskew and crop only, no tonal work. Useful for debugging the detector. */
  | 'none';

export interface PipelineOptions {
  /** Run document detection. When false, the whole frame is used. */
  detectEdges: boolean;
  /** Corners to warp from. Supplied by the manual crop editor; overrides detection. */
  corners: Quad | null;
  enhance: EnhanceMode;
  /** Longest side of the output, in pixels. */
  maxDimension: number;
  /** JPEG quality, 0..1. */
  quality: number;
  /** Extra clockwise rotation in degrees; one of 0, 90, 180, 270. */
  rotate: 0 | 90 | 180 | 270;
}

export const DEFAULT_PIPELINE_OPTIONS: PipelineOptions = {
  detectEdges: true,
  corners: null,
  enhance: 'grayscale',
  // 1568 px on the long edge is the largest size Anthropic's vision models use
  // without downscaling server-side, and it comfortably resolves thermal print.
  // Going higher costs tokens and latency for no gain in legibility.
  maxDimension: 1568,
  quality: 0.9,
  rotate: 0,
};

/** How the document outline was arrived at. Surfaced in the review UI. */
export type DetectionSource =
  /** Segmented by paper's colour signature: bright and unsaturated. */
  | 'paper'
  /** Found as a closed edge contour. */
  | 'contour'
  /** Separated by brightness alone, as a last resort. */
  | 'threshold'
  /** Corners supplied by the user. */
  | 'manual'
  /** Nothing found; the whole frame was used. */
  | 'full-frame';

export interface PipelineResult {
  /** The processed scan, ready for the AI model. */
  blob: Blob;
  width: number;
  height: number;
  /** Corners used for the warp, in source-image coordinates. */
  corners: Quad | null;
  detection: DetectionSource;
  /** 0..1 estimate of how confident the detector is in the outline. */
  detectionConfidence: number;
  /** Which engine produced the result. */
  engine: 'opencv' | 'canvas';
  /** Milliseconds spent in the pipeline. */
  durationMs: number;
  /** Human-readable notes about what the pipeline did or could not do. */
  notes: string[];
}

// --- worker protocol ------------------------------------------------------

export interface DetectRequest {
  type: 'detect';
  id: number;
  image: ImageBitmap;
}

export interface ProcessRequest {
  type: 'process';
  id: number;
  image: ImageBitmap;
  options: PipelineOptions;
}

export interface WarmupRequest {
  type: 'warmup';
  id: number;
}

export type WorkerRequest = DetectRequest | ProcessRequest | WarmupRequest;

export interface DetectResponse {
  type: 'detect';
  id: number;
  corners: Quad | null;
  detection: DetectionSource;
  detectionConfidence: number;
}

export interface ProcessResponse {
  type: 'process';
  id: number;
  /** JPEG (or PNG for `binarize`) bytes, encoded inside the worker. */
  blob: Blob;
  width: number;
  height: number;
  corners: Quad | null;
  detection: DetectionSource;
  detectionConfidence: number;
  durationMs: number;
  notes: string[];
}

export interface WarmupResponse {
  type: 'warmup';
  id: number;
  ready: boolean;
  version: string | null;
}

export interface ErrorResponse {
  type: 'error';
  id: number;
  message: string;
}

export type WorkerResponse = DetectResponse | ProcessResponse | WarmupResponse | ErrorResponse;
