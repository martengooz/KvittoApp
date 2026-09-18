import Vision
import XCTest

/// The detector itself needs a camera, so what is testable here is the part
/// with judgement in it: the score that decides whether a quad is a receipt
/// worth arming the shutter for, and the orientation mapping that decides
/// which way up Vision reads the frame.
///
/// `FrameDocumentScoring` is compiled straight into this target rather than
/// imported. The hybrid object it belongs to is built with Nitro's C++
/// interop, and an Objective-C test target cannot import a module built that
/// way - `NitroModules`' headers need Objective-C++. Keeping the judgement in
/// a dependency-free file is what makes it reachable from here at all.
final class KvittoFramesDocumentAnalyzerTests: XCTestCase {
    /// Vision's normalized space: origin bottom-left, both axes 0-1.
    ///
    /// Confidence is not settable on a hand-built observation - it comes back
    /// as 1.0 - so the confidence term of the score is exercised on device
    /// rather than here.
    private func observation(
        insetX: CGFloat,
        insetY: CGFloat,
        skewTopBy: CGFloat = 0
    ) -> VNRectangleObservation {
        VNRectangleObservation(
            requestRevision: VNDetectRectanglesRequestRevision1,
            topLeft: CGPoint(x: insetX + skewTopBy, y: 1 - insetY),
            bottomLeft: CGPoint(x: insetX, y: insetY),
            bottomRight: CGPoint(x: 1 - insetX, y: insetY),
            topRight: CGPoint(x: 1 - insetX - skewTopBy, y: 1 - insetY)
        )
    }

    func testAWellFramedRectangleScoresAboveTheAutoCaptureThreshold() {
        // 0.35 is the scan controller's `MIN_EVIDENCE`. A receipt filling a
        // comfortable part of the frame has to clear it, or auto-capture never
        // arms and the whole feature is decoration.
        let score = FrameDocumentScoring.score(for: observation(insetX: 0.2, insetY: 0.15))
        XCTAssertGreaterThan(score.evidence, 0.35)
        XCTAssertEqual(score.coverage, 0.6 * 0.7, accuracy: 0.01)
    }

    func testARectangleTooSmallToReadScoresZero() {
        // Far away, or a stray rectangle in the background. Either way, not
        // something to fire the shutter at.
        let score = FrameDocumentScoring.score(for: observation(insetX: 0.46, insetY: 0.46))
        XCTAssertEqual(score.evidence, 0, accuracy: 0.0001)
    }

    func testARectangleFillingTheWholeFrameScoresZero() {
        // At this coverage the paper's edges are almost certainly outside the
        // frame, so the crop would cut the receipt rather than find it.
        let score = FrameDocumentScoring.score(for: observation(insetX: 0.005, insetY: 0.005))
        XCTAssertEqual(score.evidence, 0, accuracy: 0.0001)
    }

    func testABadlySkewedQuadScoresBelowASquareOne() {
        // Opposite sides that disagree mean either a severe angle or something
        // that is not a rectangle. Both are worse captures than a flat one.
        let square = FrameDocumentScoring.score(for: observation(insetX: 0.2, insetY: 0.15))
        let skewed = FrameDocumentScoring.score(for: observation(insetX: 0.2, insetY: 0.15, skewTopBy: 0.25))
        XCTAssertLessThan(skewed.evidence, square.evidence)
    }

    func testCoverageIsTheQuadsShareOfTheFrame() {
        let score = FrameDocumentScoring.score(for: observation(insetX: 0.25, insetY: 0.25))
        XCTAssertEqual(score.coverage, 0.25, accuracy: 0.01)
    }

    func testOrientationMapsVisionCameraNamesOntoVisionsRotations() {
        XCTAssertEqual(FrameDocumentScoring.cgOrientation(degrees: 0, isMirrored: false), .up)
        XCTAssertEqual(FrameDocumentScoring.cgOrientation(degrees: 90, isMirrored: false), .right)
        XCTAssertEqual(FrameDocumentScoring.cgOrientation(degrees: 180, isMirrored: false), .down)
        XCTAssertEqual(FrameDocumentScoring.cgOrientation(degrees: 270, isMirrored: false), .left)
    }

    func testAMirroredFrameGetsAMirroredOrientation() {
        // The front camera delivers mirrored buffers. Reading one as unmirrored
        // hands Vision a left-right-flipped receipt, and the quad comes back
        // describing a corner that is not there.
        XCTAssertEqual(FrameDocumentScoring.cgOrientation(degrees: 0, isMirrored: true), .upMirrored)
        XCTAssertEqual(FrameDocumentScoring.cgOrientation(degrees: 90, isMirrored: true), .rightMirrored)
        XCTAssertEqual(FrameDocumentScoring.cgOrientation(degrees: 180, isMirrored: true), .downMirrored)
        XCTAssertEqual(FrameDocumentScoring.cgOrientation(degrees: 270, isMirrored: true), .leftMirrored)
    }

    func testAnUnexpectedRotationFallsBackToUpright() {
        XCTAssertEqual(FrameDocumentScoring.cgOrientation(degrees: 45, isMirrored: false), .up)
        XCTAssertEqual(FrameDocumentScoring.cgOrientation(degrees: -90, isMirrored: false), .left)
        XCTAssertEqual(FrameDocumentScoring.cgOrientation(degrees: 450, isMirrored: false), .right)
    }
}
