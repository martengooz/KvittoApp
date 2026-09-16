import Foundation
import Vision
import CoreImage

final class VisionTextRecognizer {
  func supportedLanguages() -> [String] {
    do {
      return try VNRecognizeTextRequest.supportedRecognitionLanguages(for: .accurate, revision: VNRecognizeTextRequestRevision3)
    } catch {
      return ["en-US"]
    }
  }

  func recognize(sourceURL: URL, preferredLanguages: [String]) throws -> (text: String, observations: [[String: Any]], usedLanguages: [String], durationMs: Int) {
    let startedAt = Int(Date().timeIntervalSince1970 * 1000)

    guard let source = CIImage(contentsOf: sourceURL, options: [.applyOrientationProperty: true]) else {
      throw NSError(domain: "KvittoNative", code: 3001, userInfo: [NSLocalizedDescriptionKey: "Unable to load source image for OCR"])
    }

    let available = supportedLanguages()
    let chosen = preferredLanguages.filter { available.contains($0) }
    let languages = chosen.isEmpty ? (["sv-SE", "en-US"].filter { available.contains($0) } + ["en-US"]).uniqued() : chosen

    var recognizedLines: [String] = []
    var observationPayload: [[String: Any]] = []

    let request = VNRecognizeTextRequest { request, error in
      if error != nil {
        return
      }

      let observations = request.results as? [VNRecognizedTextObservation] ?? []
      for observation in observations {
        guard let candidate = observation.topCandidates(1).first else {
          continue
        }

        recognizedLines.append(candidate.string)
        observationPayload.append([
          "text": candidate.string,
          "confidence": candidate.confidence,
          "boundingBox": [
            "x": observation.boundingBox.origin.x,
            "y": observation.boundingBox.origin.y,
            "width": observation.boundingBox.width,
            "height": observation.boundingBox.height,
          ],
        ])
      }
    }

    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = languages

    let handler = VNImageRequestHandler(ciImage: source, options: [:])
    try handler.perform([request])

    let endedAt = Int(Date().timeIntervalSince1970 * 1000)
    return (text: recognizedLines.joined(separator: "\n"), observations: observationPayload, usedLanguages: languages, durationMs: max(0, endedAt - startedAt))
  }
}

private extension Array where Element: Hashable {
  func uniqued() -> [Element] {
    var seen: Set<Element> = []
    return self.filter { element in
      let inserted = seen.insert(element).inserted
      return inserted
    }
  }
}
