import SwiftUI
import WidgetKit

/// Every widget of the extension. M4-06 adds the Live Activity here.
@main
struct RemoteControlWidgets: WidgetBundle {
  var body: some Widget {
    AgentsWidget()
    WaitingControl()
  }
}
