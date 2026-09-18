import Foundation
import UIKit

protocol NativeArchiveSharePort {
  @MainActor
  func shareArchive(fileURL: URL, completion: @escaping (Result<Bool, Error>) -> Void)
}

enum NativeArchiveShareAdapterError: Error, LocalizedError {
  case fileMissing(String)
  case noPresenter

  var errorDescription: String? {
    switch self {
    case .fileMissing(let path):
      return "There is no file to share at \(path)."
    case .noPresenter:
      return "The app has no visible screen to present the share sheet from."
    }
  }
}

/**
 Hands an exported archive to the system share sheet.

 Without this, export wrote a `.kvitto` file into the app's own caches directory
 and told the user where it was - a path inside the container, which nothing on
 the phone can open. The file existed and was correct and completely unreachable,
 which made the whole export feature unusable.
 */
final class NativeArchiveShareAdapter: NativeArchiveSharePort {
  /// Held only while a sheet is up. `UIActivityViewController` is not retained
  /// by the presenter until it is on screen, and its completion handler is the
  /// only thing that resolves the promise.
  private var presented: UIActivityViewController?

  @MainActor
  func shareArchive(fileURL: URL, completion: @escaping (Result<Bool, Error>) -> Void) {
    guard FileManager.default.fileExists(atPath: fileURL.path) else {
      // Checked here rather than left to the share sheet, which presents an
      // empty picker for a missing file and reports success when dismissed.
      completion(.failure(NativeArchiveShareAdapterError.fileMissing(fileURL.path)))
      return
    }

    guard let presenter = Self.topMostViewController() else {
      completion(.failure(NativeArchiveShareAdapterError.noPresenter))
      return
    }

    let controller = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)

    /*
     * Required on iPad, where a share sheet is a popover and presenting one
     * with no anchor raises an exception rather than failing softly. This app
     * targets both families, so there is no "iPhone only" way out of it. The
     * anchor is the centre of the presenting view: the call arrives from
     * JavaScript, so there is no button frame to point at.
     */
    if let popover = controller.popoverPresentationController {
      popover.sourceView = presenter.view
      popover.sourceRect = CGRect(
        x: presenter.view.bounds.midX,
        y: presenter.view.bounds.midY,
        width: 0,
        height: 0
      )
      popover.permittedArrowDirections = []
    }

    controller.completionWithItemsHandler = { [weak self] _, completed, _, error in
      self?.presented = nil
      if let error {
        completion(.failure(error))
        return
      }
      // `completed` is false when the sheet was dismissed without choosing, which
      // is a normal outcome and not an error.
      completion(.success(completed))
    }

    presented = controller
    presenter.present(controller, animated: true)
  }

  /**
   The view controller actually on screen.

   The root controller is not enough: the archive screens are themselves pushed
   inside a presented stack, and presenting from a controller that is already
   covered puts the sheet behind what the user is looking at, or silently does
   nothing.
   */
  @MainActor
  private static func topMostViewController() -> UIViewController? {
    let scene = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .first { $0.activationState == .foregroundActive }
      ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first

    guard let root = scene?.windows.first(where: \.isKeyWindow)?.rootViewController
        ?? scene?.windows.first?.rootViewController
    else {
      return nil
    }

    var top = root
    while let next = top.presentedViewController, !next.isBeingDismissed {
      top = next
    }
    return top
  }
}
