import AppIntents
import SwiftUI
import WidgetKit

/// The waiting count, read from the App Group whenever Control Center redraws.
@available(iOS 18.0, *)
struct WaitingValueProvider: ControlValueProvider {
  var previewValue: Int { 1 }

  func currentValue() async throws -> Int { WidgetSnapshot.load().at(Date()).waiting }
}

/// Control Center (and Lock Screen / Action button) control: shows the waiting count and
/// opens the most urgent waiting session, else the agents list.
@available(iOS 18.0, *)
struct WaitingControl: ControlWidget {
  static let kind = "dev.ivanbaev.remotecontrol.waiting"

  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: Self.kind, provider: WaitingValueProvider()) { waiting in
      ControlWidgetButton(action: OpenAgentsIntent()) {
        Label(
          waiting > 0 ? "\(waiting) waiting" : "No agent waiting",
          systemImage: waiting > 0 ? "hand.raised.fill" : "checkmark.circle")
      }
    }
    .displayName("Agents waiting")
    .description("Opens the agent that waits on you.")
  }
}
