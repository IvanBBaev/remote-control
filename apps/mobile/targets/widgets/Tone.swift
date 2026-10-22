import SwiftUI

/// The app's tones (`src/ui/theme.ts`): orange = needs OK, cyan = question, red = error,
/// blue = working, green = done.
enum Tone {
  static let background = Color(red: 0x0B / 255, green: 0x0D / 255, blue: 0x10 / 255)
  static let secondary = Color(red: 0x9A / 255, green: 0xA3 / 255, blue: 0xAF / 255)

  static func color(_ state: String) -> Color {
    switch state {
    case "needs-ok": return Color(red: 1, green: 0x9F / 255, blue: 0x0A / 255)
    case "question": return Color(red: 0x64 / 255, green: 0xD2 / 255, blue: 1)
    case "error": return Color(red: 1, green: 0x45 / 255, blue: 0x3A / 255)
    case "working": return Color(red: 0x0A / 255, green: 0x84 / 255, blue: 1)
    case "done": return Color(red: 0x30 / 255, green: 0xD1 / 255, blue: 0x58 / 255)
    default: return Color(red: 0x8E / 255, green: 0x8E / 255, blue: 0x93 / 255)
    }
  }

  /// The badge text, as in the app and the Island's compact view.
  static func glyph(_ state: String) -> String {
    switch state {
    case "needs-ok": return "OK?"
    case "question": return "?"
    case "error": return "!"
    case "working": return "•••"
    case "done": return "✓"
    default: return "–"
    }
  }
}
