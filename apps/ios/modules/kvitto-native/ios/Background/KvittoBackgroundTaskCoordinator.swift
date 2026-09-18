import BackgroundTasks
import Foundation
import os

/// One OS-granted background window, as JavaScript needs to see it.
public struct KvittoBackgroundLaunch {
  public let handle: String
  public let identifier: String
  /// Milliseconds since the epoch, matching `Date.now()` on the JS side.
  public let startedAt: Double

  public var payload: [String: Any] {
    [
      "handle": handle,
      "identifier": identifier,
      "startedAt": startedAt,
      // `BGTaskScheduler` never tells the app how long it has. Neither
      // `BGProcessingTask` nor `BGAppRefreshTask` carries a deadline; the only
      // signal is the expiration handler firing, and by then the window is
      // already over. So this is always null and the JS runner falls back to
      // its own budget, which is why that budget exists.
      "deadlineAt": NSNull(),
    ]
  }
}

/// Owns this app's `BGTaskScheduler` registration and the tasks it launches.
///
/// Two constraints shape everything here.
///
/// **Registration has a deadline.** `BGTaskScheduler.register` must be called
/// before `application(_:didFinishLaunchingWithOptions:)` returns, or iOS
/// raises. That is long before React Native has a JS runtime, so the launch
/// handler cannot simply call into JavaScript and wait.
///
/// **A launch can arrive before JavaScript exists.** iOS may launch the app
/// directly into the background to run the task. An event sent then would go
/// nowhere. Launches are therefore buffered and handed over when JS asks for
/// them, rather than pushed and hoped for.
public final class KvittoBackgroundTaskCoordinator {
  public static let shared = KvittoBackgroundTaskCoordinator()

  /// The single identifier this app registers.
  ///
  /// It must also appear in `BGTaskSchedulerPermittedIdentifiers` in
  /// `Info.plist`; `register` returns false otherwise and the app can never be
  /// woken. `KvittoNativeBackgroundTaskTests` asserts the two agree.
  public static let processingIdentifier = "com.kvitto.app.ios.jobs.processing"

  private let log = OSLog(subsystem: "com.kvitto.app.ios", category: "background")
  private let lock = NSLock()

  private var registered = false
  /// Every handle the app currently owes iOS a completion for. Kept separate
  /// from `liveTasks` because `BGTask` cannot be constructed in a test, so the
  /// test seam registers a handle with no task behind it.
  private var liveHandles: Set<String> = []
  private var liveTasks: [String: BGTask] = [:]
  private var expiredHandles: Set<String> = []
  private var buffered: [KvittoBackgroundLaunch] = []
  private var listener: ((KvittoBackgroundLaunch) -> Void)?

  private init() {}

  // MARK: - Launch registration

  /// Registers the launch handler. Safe to call more than once; iOS treats a
  /// second registration of the same identifier as a programmer error, so the
  /// guard is load-bearing rather than tidiness.
  @discardableResult
  public func registerLaunchHandlers() -> Bool {
    lock.lock()
    if registered {
      lock.unlock()
      return true
    }
    registered = true
    lock.unlock()

    let identifier = Self.processingIdentifier
    let accepted = BGTaskScheduler.shared.register(
      forTaskWithIdentifier: identifier,
      using: nil
    ) { [weak self] task in
      self?.handleLaunch(task: task, identifier: identifier)
    }

    if !accepted {
      // Almost always a missing Info.plist entry. Log it rather than trap: a
      // device build that cannot run background work is still a usable app,
      // and trapping here would take the whole launch down with it.
      os_log(
        "%{public}@",
        log: log,
        type: .error,
        "background:register-refused \(identifier) (check BGTaskSchedulerPermittedIdentifiers)"
      )
      lock.lock()
      registered = false
      lock.unlock()
    }

    return accepted
  }

  private func handleLaunch(task: BGTask, identifier: String) {
    let handle = UUID().uuidString
    let launch = KvittoBackgroundLaunch(
      handle: handle,
      identifier: identifier,
      startedAt: Date().timeIntervalSince1970 * 1000
    )

    // Set this before anything else can observe the task. iOS calls it on its
    // own queue, and it is the only warning the app gets.
    task.expirationHandler = { [weak self] in
      self?.expire(handle: handle)
    }

    lock.lock()
    liveHandles.insert(handle)
    liveTasks[handle] = task
    let deliver = listener
    if deliver == nil { buffered.append(launch) }
    lock.unlock()

    if let deliver {
      deliver(launch)
    }

    // The next window is requested now rather than after the sweep. Submitting
    // from inside a task iOS has already launched is the documented way to
    // keep a repeating schedule alive, and doing it first means a sweep that
    // dies mid-run still leaves a successor behind.
    _ = try? submitProcessingRequest(earliestDelaySeconds: 15 * 60, requiresNetwork: false, requiresPower: false)
  }

  private func expire(handle: String) {
    lock.lock()
    expiredHandles.insert(handle)
    lock.unlock()
    os_log("%{public}@", log: log, type: .default, "background:expired \(handle)")
    // Not completed here. The sweep polls `isExpired` at every checkpoint and
    // stops at the next one; finishing the task out from under it would leave
    // a claimed job with no one to release it.
  }

  // MARK: - JavaScript bridge surface

  /// Installs the listener and hands over anything that arrived before it.
  public func setListener(_ listener: ((KvittoBackgroundLaunch) -> Void)?) {
    lock.lock()
    self.listener = listener
    let pending = listener == nil ? [] : buffered
    if listener != nil { buffered.removeAll() }
    lock.unlock()

    for launch in pending {
      listener?(launch)
    }
  }

  /// Hands over buffered launches. Used at startup, when the JS side may have
  /// missed the event that woke the process in the first place.
  public func drainPendingLaunches() -> [[String: Any]] {
    lock.lock()
    let pending = buffered
    buffered.removeAll()
    lock.unlock()
    return pending.map(\.payload)
  }

  public func isExpired(handle: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    // An unknown handle reads as expired. Either it was already finished or it
    // never existed; in both cases the honest answer to "may I start another
    // job?" is no.
    return expiredHandles.contains(handle) || !liveHandles.contains(handle)
  }

  /// Completes the task. Returns false when the handle is unknown, which means
  /// it was completed already - `setTaskCompleted` must be called exactly once.
  @discardableResult
  public func finish(handle: String, success: Bool) -> Bool {
    lock.lock()
    let known = liveHandles.remove(handle) != nil
    let task = liveTasks.removeValue(forKey: handle)
    expiredHandles.remove(handle)
    lock.unlock()

    guard known else { return false }
    os_log("%{public}@", log: log, type: .default, "background:finished \(handle) success=\(success)")
    task?.setTaskCompleted(success: success)
    return true
  }

  // MARK: - Scheduling

  @discardableResult
  public func submitProcessingRequest(
    earliestDelaySeconds: Double,
    requiresNetwork: Bool,
    requiresPower: Bool
  ) throws -> String {
    let request = BGProcessingTaskRequest(identifier: Self.processingIdentifier)
    request.earliestBeginDate = Date(timeIntervalSinceNow: max(0, earliestDelaySeconds))
    request.requiresNetworkConnectivity = requiresNetwork
    request.requiresExternalPower = requiresPower

    do {
      try BGTaskScheduler.shared.submit(request)
      return "scheduled"
    } catch BGTaskScheduler.Error.notPermitted {
      // The user or the system has turned Background App Refresh off. Nothing
      // the app can do, and not a failure worth surfacing as an error.
      return "not-permitted"
    } catch BGTaskScheduler.Error.unavailable {
      return "unavailable"
    } catch BGTaskScheduler.Error.tooManyPendingTaskRequests {
      // One is already queued, which is the state we wanted anyway.
      return "already-scheduled"
    }
  }

  public func cancelScheduledRequests() {
    BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.processingIdentifier)
  }

  public func pendingRequestIdentifiers(_ completion: @escaping ([String]) -> Void) {
    BGTaskScheduler.shared.getPendingTaskRequests { requests in
      completion(requests.map(\.identifier))
    }
  }

  // MARK: - Testing seams

  /// Drives the coordinator as iOS would, without a real `BGTask`. The launch
  /// path is otherwise unreachable from a test: `BGTask` cannot be constructed
  /// and the scheduler will not launch a task on demand.
  func simulateLaunchForTesting(handle: String) -> KvittoBackgroundLaunch {
    let launch = KvittoBackgroundLaunch(
      handle: handle,
      identifier: Self.processingIdentifier,
      startedAt: Date().timeIntervalSince1970 * 1000
    )
    lock.lock()
    liveHandles.insert(handle)
    let deliver = listener
    if deliver == nil { buffered.append(launch) }
    lock.unlock()
    deliver?(launch)
    return launch
  }

  func markExpiredForTesting(handle: String) {
    expire(handle: handle)
  }

  func resetForTesting() {
    lock.lock()
    liveHandles.removeAll()
    liveTasks.removeAll()
    expiredHandles.removeAll()
    buffered.removeAll()
    listener = nil
    lock.unlock()
  }
}
