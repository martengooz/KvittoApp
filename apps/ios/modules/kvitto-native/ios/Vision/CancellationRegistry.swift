import Foundation

struct KvittoCancellationError: Error, CustomStringConvertible {
  var description: String { "Operation was cancelled" }
}

actor CancellationRegistry {
  private var cancelledOperationIDs: Set<String> = []

  func cancel(_ operationID: String) {
    cancelledOperationIDs.insert(operationID)
  }

  func isCancelled(_ operationID: String?) -> Bool {
    guard let operationID, !operationID.isEmpty else {
      return false
    }
    return cancelledOperationIDs.contains(operationID)
  }

  func clear(_ operationID: String?) {
    guard let operationID, !operationID.isEmpty else {
      return
    }
    cancelledOperationIDs.remove(operationID)
  }
}
