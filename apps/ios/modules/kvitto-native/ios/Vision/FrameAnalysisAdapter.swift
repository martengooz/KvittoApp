import Foundation

struct FrameAnalysisResult: Codable {
  let status: String
  let pluginLinked: Bool
  let evidenceScore: Double
  let coverage: Double
  let normalizedQuad: NormalizedQuad?
  let source: String
  let timing: TimingMetadata
}

struct TimingMetadata: Codable {
  let startedAtMs: Int
  let endedAtMs: Int
  let durationMs: Int
}

final class VisionFrameAnalysisAdapter {
  // VisionCamera frame plugin integration is intentionally explicit and unresolved until
  // the VisionCamera dependency and frame processor bridge are linked in Packet 12.
  func analyzeCompactFrame(frameTimestampMs: Double) -> FrameAnalysisResult {
    let startedAt = Int(Date().timeIntervalSince1970 * 1000)
    let endedAt = Int(Date().timeIntervalSince1970 * 1000)
    return FrameAnalysisResult(
      status: "unsupported",
      pluginLinked: false,
      evidenceScore: 0,
      coverage: 0,
      normalizedQuad: nil,
      source: "stub",
      timing: TimingMetadata(startedAtMs: startedAt, endedAtMs: endedAt, durationMs: max(0, endedAt - startedAt))
    )
  }
}
