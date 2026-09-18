import CoreVideo
import Foundation
import NitroModules
import Vision

/**
 Runs Vision's rectangle detector against live camera frames.

 This exists as a Nitro hybrid object because `react-native-vision-camera@5`
 removed the frame-processor plugin API. `useFrameOutput`'s `onFrame` is a
 worklet on the camera's own thread, and a hybrid object is the only thing it
 can call synchronously - which it has to, because the pixel buffer is valid
 only for the duration of that call.

 Two threads touch this object: the camera thread calls `analyze`, the
 JavaScript thread reads `latest`. Everything mutable is behind one lock.
 */
public final class HybridFrameDocumentAnalyzer: HybridKvittoFrameDocumentAnalyzerSpec {
  /// Vision's normalized coordinate space, kept deliberately.
  ///
  /// The rest of this module speaks Vision's bottom-left origin: a quad from
  /// `detectRectangle` goes straight back in as `forcedQuad` for perspective
  /// correction. Flipping here would make a crop taken from a live frame mean
  /// something different from one taken from a still, which is the kind of
  /// difference that surfaces as a receipt cropped upside down.
  private let lock = NSLock()

  private var storedLatest: FrameDocumentReading?
  private var storedSkipped: Double = 0
  private var storedMinIntervalMs: Double = 200
  private var lastAnalyzedAtMs: Double = -.greatestFiniteMagnitude

  public override init() {
    super.init()
  }

  public var memorySize: Int { 0 }

  public var minIntervalMs: Double {
    get {
      lock.lock()
      defer { lock.unlock() }
      return storedMinIntervalMs
    }
    set {
      lock.lock()
      defer { lock.unlock() }
      storedMinIntervalMs = max(0, newValue)
    }
  }

  public var latest: FrameDocumentReading? {
    lock.lock()
    defer { lock.unlock() }
    return storedLatest
  }

  public var skippedFrames: Double {
    lock.lock()
    defer { lock.unlock() }
    return storedSkipped
  }

  public func reset() throws {
    lock.lock()
    defer { lock.unlock() }
    storedLatest = nil
    storedSkipped = 0
    lastAnalyzedAtMs = -.greatestFiniteMagnitude
  }

  public func analyze(
    pixelBufferPointer: UInt64,
    orientationDegrees: Double,
    isMirrored: Bool,
    timestampMs: Double
  ) throws {
    lock.lock()
    let interval = storedMinIntervalMs
    let due = timestampMs - lastAnalyzedAtMs >= interval
    if due { lastAnalyzedAtMs = timestampMs } else { storedSkipped += 1 }
    lock.unlock()

    // Detection costs more than a frame interval, and running it on every
    // frame buys nothing - a hand holding a phone does not move far in 16ms.
    // Skipped frames are dropped rather than queued: a backlog of stale frames
    // is worse than no reading at all.
    guard due else { return }

    guard let raw = UnsafeRawPointer(bitPattern: UInt(pixelBufferPointer)) else { return }
    // The frame output owns this buffer and releases it after `onFrame`
    // returns. Taking it unretained is deliberate: retaining it here would
    // hold a camera buffer past the callback and stall the pipeline.
    let pixelBuffer = Unmanaged<CVPixelBuffer>.fromOpaque(raw).takeUnretainedValue()

    let startedAt = Date().timeIntervalSince1970 * 1000
    let reading = Self.detect(
      in: pixelBuffer,
      orientation: FrameDocumentScoring.cgOrientation(degrees: orientationDegrees, isMirrored: isMirrored),
      timestampMs: timestampMs,
      startedAtMs: startedAt
    )

    lock.lock()
    storedLatest = reading
    lock.unlock()
  }

  // MARK: - Detection

  private static func detect(
    in pixelBuffer: CVPixelBuffer,
    orientation: CGImagePropertyOrientation,
    timestampMs: Double,
    startedAtMs: Double
  ) -> FrameDocumentReading {
    let request = VNDetectRectanglesRequest()
    // Wider than the still-image path allows. A receipt held at an angle can
    // project to a very tall, narrow quad, and rejecting it here would make
    // auto-capture refuse exactly the framing a user naturally adopts.
    request.minimumAspectRatio = 0.15
    request.maximumAspectRatio = 1.0
    request.minimumSize = 0.15
    request.minimumConfidence = 0.4
    // Receipts are held by hand, so the quad is rarely square to the sensor.
    request.quadratureTolerance = 35
    // More than one candidate, so a smaller true receipt is not hidden behind
    // a large false positive like a table edge.
    request.maximumObservations = 5

    let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:])

    do {
      try handler.perform([request])
    } catch {
      return reading(status: "unsupported", quad: nil, score: 0, coverage: 0, timestampMs: timestampMs, startedAtMs: startedAtMs)
    }

    let observations = (request.results as? [VNRectangleObservation]) ?? []
    guard
      let best = observations
        .map({ (observation: $0, score: FrameDocumentScoring.score(for: $0)) })
        .max(by: { $0.score.evidence < $1.score.evidence }),
      best.score.evidence > 0
    else {
      return reading(status: "no-document", quad: nil, score: 0, coverage: 0, timestampMs: timestampMs, startedAtMs: startedAtMs)
    }

    let quad = FrameDocumentQuad(
      topLeftX: Double(best.observation.topLeft.x),
      topLeftY: Double(best.observation.topLeft.y),
      topRightX: Double(best.observation.topRight.x),
      topRightY: Double(best.observation.topRight.y),
      bottomRightX: Double(best.observation.bottomRight.x),
      bottomRightY: Double(best.observation.bottomRight.y),
      bottomLeftX: Double(best.observation.bottomLeft.x),
      bottomLeftY: Double(best.observation.bottomLeft.y)
    )

    return reading(
      status: "ready",
      quad: quad,
      score: best.score.evidence,
      coverage: best.score.coverage,
      timestampMs: timestampMs,
      startedAtMs: startedAtMs
    )
  }

  private static func reading(
    status: String,
    quad: FrameDocumentQuad?,
    score: Double,
    coverage: Double,
    timestampMs: Double,
    startedAtMs: Double
  ) -> FrameDocumentReading {
    FrameDocumentReading(
      status: status,
      evidenceScore: score,
      coverage: coverage,
      durationMs: max(0, Date().timeIntervalSince1970 * 1000 - startedAtMs),
      timestampMs: timestampMs,
      quad: quad
    )
  }
}
