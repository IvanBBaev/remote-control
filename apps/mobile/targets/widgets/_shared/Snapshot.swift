import Foundation

/// Mirrors `apps/mobile/src/core/widget-snapshot.ts`. The app writes it as a JSON string
/// into the App Group; the widgets and the Control Center control only read it.
enum SharedStore {
  static let appGroup = "group.dev.ivanbaev.remotecontrol"
  static let snapshotKey = "widgetSnapshot"
  /// Mirrors `PENDING_LINK_KEY`: the deep link the Control Center control asks the app to open.
  static let pendingLinkKey = "pendingLink"
  static let agentsURL = URL(string: "remotecontrol://")!
}

struct WidgetRow: Codable, Hashable, Identifiable {
  let id: String
  let machine: String
  let project: String
  /// needs-ok, question, error, working, done.
  let state: String
  let label: String
  /// Unix milliseconds.
  let expiresAt: Double?
  let url: String

  var deadline: Date? { expiresAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
  var link: URL { URL(string: url) ?? SharedStore.agentsURL }
  var isWaiting: Bool { state == "needs-ok" || state == "question" }
}

struct WidgetSnapshot: Codable {
  let version: Int
  let writtenAt: Double
  let sample: Bool
  let waiting: Int
  let needsOk: Int
  let questions: Int
  let errors: Int
  let working: Int
  let nextExpiry: Double?
  let rows: [WidgetRow]
  let url: String

  var link: URL { URL(string: url) ?? SharedStore.agentsURL }

  static let empty = WidgetSnapshot(
    version: 1, writtenAt: 0, sample: false, waiting: 0, needsOk: 0, questions: 0,
    errors: 0, working: 0, nextExpiry: nil, rows: [], url: SharedStore.agentsURL.absoluteString)

  /// What the widget gallery shows before the app has written anything.
  static var preview: WidgetSnapshot {
    let soon = (Date().timeIntervalSince1970 + 4 * 60) * 1000
    return WidgetSnapshot(
      version: 1, writtenAt: 0, sample: true, waiting: 2, needsOk: 1, questions: 1,
      errors: 0, working: 1, nextExpiry: soon,
      rows: [
        WidgetRow(
          id: "preview-1", machine: "MacBook Pro", project: "billing-api", state: "needs-ok",
          label: "Run a command", expiresAt: soon, url: SharedStore.agentsURL.absoluteString),
        WidgetRow(
          id: "preview-2", machine: "Mac mini", project: "marketing-site", state: "question",
          label: "Has a question", expiresAt: soon + 60_000,
          url: SharedStore.agentsURL.absoluteString),
        WidgetRow(
          id: "preview-3", machine: "MacBook Pro", project: "infra", state: "working",
          label: "Working", expiresAt: nil, url: SharedStore.agentsURL.absoluteString),
      ],
      url: SharedStore.agentsURL.absoluteString)
  }

  static func load() -> WidgetSnapshot {
    guard
      let json = UserDefaults(suiteName: SharedStore.appGroup)?.string(
        forKey: SharedStore.snapshotKey),
      let data = json.data(using: .utf8),
      let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    else { return .empty }
    return snapshot
  }

  /// The snapshot as it stands at `date`: a request past its deadline has fallen back to
  /// the terminal (D10), so its row and its count go away until the app writes again.
  func at(_ date: Date) -> WidgetSnapshot {
    let expired = rows.filter { row in row.deadline.map { $0 <= date } ?? false }
    if expired.isEmpty { return self }
    let kept = rows.filter { row in !expired.contains(row) }
    let lostOk = expired.filter { $0.state == "needs-ok" }.count
    let lostQuestions = expired.filter { $0.state == "question" }.count
    let next = kept.compactMap(\.expiresAt).min()
    let first = kept.first(where: \.isWaiting)
    return WidgetSnapshot(
      version: version, writtenAt: writtenAt, sample: sample,
      waiting: max(0, waiting - lostOk - lostQuestions),
      needsOk: max(0, needsOk - lostOk), questions: max(0, questions - lostQuestions),
      errors: errors, working: working, nextExpiry: next, rows: kept,
      url: first?.url ?? SharedStore.agentsURL.absoluteString)
  }
}
