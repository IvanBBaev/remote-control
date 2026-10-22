import AppIntents
import Foundation

/// Opens the app on the most urgent waiting session, or on the agents list.
///
/// Control Center neither follows an `OpenURLIntent` returned from a control's action nor
/// accepts one as the action, and `UIApplication.open` is off limits in code the extension
/// compiles. So the intent opens the app (`openAppWhenRun`) and leaves the deep link in the
/// App Group as `{"url","at"}` JSON; the app opens it when it becomes active
/// (`src/state/pending-link.ts`). Lives in `_shared` so the app target knows the type too.
@available(iOS 18.0, *)
struct OpenAgentsIntent: AppIntent {
  static let title: LocalizedStringResource = "Open Remote Control"
  static let description = IntentDescription("Opens the agent that waits on you.")
  static let isDiscoverable = true
  static let openAppWhenRun: Bool = true

  @MainActor
  func perform() async throws -> some IntentResult {
    let link = WidgetSnapshot.load().at(Date()).link
    let pending: [String: Any] = [
      "url": link.absoluteString, "at": Date().timeIntervalSince1970 * 1000,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: pending),
      let json = String(data: data, encoding: .utf8)
    {
      UserDefaults(suiteName: SharedStore.appGroup)?.set(json, forKey: SharedStore.pendingLinkKey)
    }
    return .result()
  }
}
