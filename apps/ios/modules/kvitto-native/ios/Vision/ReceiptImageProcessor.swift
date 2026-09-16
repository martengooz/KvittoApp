import Foundation
import CoreImage
import Vision

struct ProcessedImageResult {
  let outputWidth: Int
  let outputHeight: Int
  let outputBytes: Int
  let thumbnailWidth: Int
  let thumbnailHeight: Int
  let thumbnailBytes: Int
  let rectangle: NormalizedQuad?
  let detectionSource: String
  let fallbackUsed: Bool
  let timing: TimingMetadata
}

final class ReceiptImageProcessor {
  private let context = CIContext()

  func detectRectangle(sourceURL: URL) throws -> NormalizedQuad? {
    guard let source = CIImage(contentsOf: sourceURL, options: [.applyOrientationProperty: true]) else {
      return nil
    }

    let request = VNDetectRectanglesRequest()
    request.maximumObservations = 1
    request.minimumConfidence = 0.2
    request.minimumAspectRatio = 0.2

    let handler = VNImageRequestHandler(ciImage: source, options: [:])
    try handler.perform([request])
    guard let observation = request.results?.first as? VNRectangleObservation else {
      return nil
    }

    return NormalizedQuad(
      topLeft: NormalizedPoint(x: observation.topLeft.x, y: observation.topLeft.y),
      topRight: NormalizedPoint(x: observation.topRight.x, y: observation.topRight.y),
      bottomRight: NormalizedPoint(x: observation.bottomRight.x, y: observation.bottomRight.y),
      bottomLeft: NormalizedPoint(x: observation.bottomLeft.x, y: observation.bottomLeft.y)
    )
  }

  func process(
    sourceURL: URL,
    outputURL: URL,
    thumbnailURL: URL,
    maxLongEdge: Int,
    jpegQuality: Double,
    enhancement: String,
    forcedQuad: NormalizedQuad?
  ) throws -> ProcessedImageResult {
    let startedAt = Int(Date().timeIntervalSince1970 * 1000)

    guard let source = CIImage(contentsOf: sourceURL, options: [.applyOrientationProperty: true])?.oriented(.up) else {
      throw NSError(domain: "KvittoNative", code: 2001, userInfo: [NSLocalizedDescriptionKey: "Unable to load image for processing"])
    }

    let detectedQuad = try detectRectangle(sourceURL: sourceURL)
    let quadToUse = forcedQuad ?? detectedQuad
    let detectionSource = forcedQuad != nil ? "forced-quad" : (detectedQuad != nil ? "vision-rectangle" : "fallback-full-frame")

    var image = source
    if let quadToUse {
      let denormalized = quadToUse.denormalized(extent: source.extent)
      if let corrected = image
        .applyingFilter("CIPerspectiveCorrection", parameters: [
          "inputTopLeft": CIVector(cgPoint: denormalized.topLeft),
          "inputTopRight": CIVector(cgPoint: denormalized.topRight),
          "inputBottomRight": CIVector(cgPoint: denormalized.bottomRight),
          "inputBottomLeft": CIVector(cgPoint: denormalized.bottomLeft),
        ]) as CIImage? {
        image = corrected
      }
    }

    image = applyEnhancement(mode: enhancement, image: image)
    image = resizeIfNeeded(image: image, maxLongEdge: maxLongEdge)

    guard let jpegData = context.jpegRepresentation(of: image, colorSpace: CGColorSpaceCreateDeviceRGB(), options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: jpegQuality]) else {
      throw NSError(domain: "KvittoNative", code: 2002, userInfo: [NSLocalizedDescriptionKey: "Unable to encode processed JPEG"])
    }
    try jpegData.write(to: outputURL, options: .atomic)

    let thumbnailImage = resizeIfNeeded(image: image, maxLongEdge: 320)
    guard let thumbData = context.jpegRepresentation(of: thumbnailImage, colorSpace: CGColorSpaceCreateDeviceRGB(), options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.72]) else {
      throw NSError(domain: "KvittoNative", code: 2003, userInfo: [NSLocalizedDescriptionKey: "Unable to encode thumbnail JPEG"])
    }
    try thumbData.write(to: thumbnailURL, options: .atomic)

    let outputExtent = image.extent.integral
    let thumbExtent = thumbnailImage.extent.integral
    let endedAt = Int(Date().timeIntervalSince1970 * 1000)

    return ProcessedImageResult(
      outputWidth: Int(outputExtent.width),
      outputHeight: Int(outputExtent.height),
      outputBytes: jpegData.count,
      thumbnailWidth: Int(thumbExtent.width),
      thumbnailHeight: Int(thumbExtent.height),
      thumbnailBytes: thumbData.count,
      rectangle: quadToUse,
      detectionSource: detectionSource,
      fallbackUsed: quadToUse == nil,
      timing: TimingMetadata(startedAtMs: startedAt, endedAtMs: endedAt, durationMs: max(0, endedAt - startedAt))
    )
  }

  private func resizeIfNeeded(image: CIImage, maxLongEdge: Int) -> CIImage {
    let extent = image.extent.integral
    let longEdge = max(extent.width, extent.height)
    guard longEdge > CGFloat(maxLongEdge) else {
      return image
    }

    let scale = CGFloat(maxLongEdge) / longEdge
    return image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
  }

  private func applyEnhancement(mode: String, image: CIImage) -> CIImage {
    switch mode {
    case "grayscale":
      return image.applyingFilter("CIPhotoEffectMono")
    case "binarize":
      let desaturated = image.applyingFilter("CIColorControls", parameters: [
        kCIInputSaturationKey: 0.0,
        kCIInputContrastKey: 1.35,
      ])
      return desaturated.applyingFilter("CIExposureAdjust", parameters: [kCIInputEVKey: 0.4])
    case "color":
      let adjusted = image.autoAdjustmentFilters(options: nil).reduce(image) { current, filter in
        filter.setValue(current, forKey: kCIInputImageKey)
        return filter.outputImage ?? current
      }
      return adjusted
    default:
      return image
    }
  }
}
