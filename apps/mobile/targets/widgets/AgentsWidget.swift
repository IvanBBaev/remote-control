import SwiftUI
import WidgetKit

struct AgentsEntry: TimelineEntry {
  let date: Date
  let snapshot: WidgetSnapshot
}

struct AgentsProvider: TimelineProvider {
  func placeholder(in context: Context) -> AgentsEntry {
    AgentsEntry(date: Date(), snapshot: .preview)
  }

  func getSnapshot(in context: Context, completion: @escaping (AgentsEntry) -> Void) {
    let stored = WidgetSnapshot.load()
    let snapshot = context.isPreview && stored.rows.isEmpty ? .preview : stored
    completion(AgentsEntry(date: Date(), snapshot: snapshot.at(Date())))
  }

  /// One entry now and one at each deadline, when that request falls back to the terminal.
  /// The app reloads the timeline whenever what the widgets show changes.
  func getTimeline(in context: Context, completion: @escaping (Timeline<AgentsEntry>) -> Void) {
    let now = Date()
    let snapshot = WidgetSnapshot.load()
    let deadlines = Set(snapshot.rows.compactMap(\.deadline).filter { $0 > now }).sorted()
    let entries = [AgentsEntry(date: now, snapshot: snapshot.at(now))]
      + deadlines.map { AgentsEntry(date: $0, snapshot: snapshot.at($0)) }
    completion(Timeline(entries: entries, policy: .never))
  }
}

private struct Badge: View {
  let state: String

  var body: some View {
    Text(Tone.glyph(state))
      .font(.system(size: 11, weight: .heavy, design: .rounded))
      .foregroundStyle(Tone.color(state))
      .padding(.horizontal, 6)
      .padding(.vertical, 2)
      .background(Tone.color(state).opacity(0.18), in: Capsule())
  }
}

private struct Countdown: View {
  let deadline: Date?

  var body: some View {
    if let deadline {
      Text(deadline, style: .timer)
        .font(.system(size: 12, weight: .semibold, design: .monospaced))
        .foregroundStyle(Tone.secondary)
        .multilineTextAlignment(.trailing)
        .frame(maxWidth: 52, alignment: .trailing)
    }
  }
}

private struct Header: View {
  let snapshot: WidgetSnapshot

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: "dot.radiowaves.left.and.right")
      Text(snapshot.sample ? "Sample" : "Agents")
      Spacer(minLength: 0)
    }
    .font(.system(size: 11, weight: .semibold))
    .foregroundStyle(Tone.secondary)
  }
}

private struct SmallView: View {
  let snapshot: WidgetSnapshot

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Header(snapshot: snapshot)
      Spacer(minLength: 0)
      Text("\(snapshot.waiting)")
        .font(.system(size: 40, weight: .bold, design: .rounded))
        .foregroundStyle(snapshot.waiting > 0 ? Tone.color(snapshot.rows.first?.state ?? "") : .white)
      Text("waiting on you")
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(Tone.secondary)
      if let row = snapshot.rows.first, row.isWaiting {
        HStack(spacing: 4) {
          Text(row.project).font(.system(size: 12, weight: .semibold)).lineLimit(1)
          Spacer(minLength: 0)
          Countdown(deadline: row.deadline)
        }
        .foregroundStyle(.white)
      } else {
        Text(snapshot.working > 0 ? "\(snapshot.working) working" : "All clear")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(.white)
      }
    }
  }
}

private struct RowView: View {
  let row: WidgetRow

  var body: some View {
    HStack(spacing: 8) {
      Badge(state: row.state).frame(minWidth: 34)
      VStack(alignment: .leading, spacing: 1) {
        Text(row.project).font(.system(size: 13, weight: .semibold)).lineLimit(1)
          .foregroundStyle(.white)
        Text("\(row.label) · \(row.machine)").font(.system(size: 11)).lineLimit(1)
          .foregroundStyle(Tone.secondary)
      }
      Spacer(minLength: 0)
      Countdown(deadline: row.deadline)
    }
  }
}

private struct MediumView: View {
  let snapshot: WidgetSnapshot

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Header(snapshot: snapshot)
        Text(snapshot.waiting > 0 ? "\(snapshot.waiting) waiting" : "Nothing waiting")
          .font(.system(size: 11, weight: .bold))
          .foregroundStyle(snapshot.waiting > 0 ? Tone.color("needs-ok") : Tone.secondary)
      }
      if snapshot.rows.isEmpty {
        Spacer(minLength: 0)
        Text("No agents running").font(.system(size: 14, weight: .semibold))
          .foregroundStyle(Tone.secondary)
        Spacer(minLength: 0)
      } else {
        ForEach(snapshot.rows) { row in
          Link(destination: row.link) { RowView(row: row) }
        }
        Spacer(minLength: 0)
      }
    }
  }
}

private struct CircularView: View {
  let snapshot: WidgetSnapshot

  var body: some View {
    ZStack {
      AccessoryWidgetBackground()
      VStack(spacing: 0) {
        Image(systemName: snapshot.waiting > 0 ? "hand.raised.fill" : "checkmark")
          .font(.system(size: 12, weight: .semibold))
        Text("\(snapshot.waiting)").font(.system(size: 18, weight: .bold, design: .rounded))
      }
    }
    .widgetAccentable()
  }
}

private struct RectangularView: View {
  let snapshot: WidgetSnapshot

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(snapshot.waiting > 0 ? "\(snapshot.waiting) waiting on you" : "No agent waiting")
        .font(.headline)
        .widgetAccentable()
      if let row = snapshot.rows.first {
        Text("\(row.project) · \(row.label)").font(.caption).lineLimit(1)
        if let deadline = row.deadline {
          Text(deadline, style: .timer).font(.caption.monospacedDigit())
        } else {
          Text(row.machine).font(.caption).lineLimit(1)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct AgentsWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: AgentsEntry

  var body: some View {
    let snapshot = entry.snapshot
    Group {
      switch family {
      case .systemMedium: MediumView(snapshot: snapshot)
      case .accessoryCircular: CircularView(snapshot: snapshot)
      case .accessoryRectangular: RectangularView(snapshot: snapshot)
      case .accessoryInline:
        Label(
          snapshot.waiting > 0 ? "\(snapshot.waiting) agents waiting" : "No agent waiting",
          systemImage: "dot.radiowaves.left.and.right")
      default: SmallView(snapshot: snapshot)
      }
    }
    .widgetURL(snapshot.link)
    .containerBackground(for: .widget) { Tone.background }
  }
}

struct AgentsWidget: Widget {
  static let kind = "AgentsWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: Self.kind, provider: AgentsProvider()) { entry in
      AgentsWidgetView(entry: entry)
    }
    .configurationDisplayName("Agents")
    .description("How many agents wait on you, and which one is next.")
    .supportedFamilies([
      .systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline,
    ])
  }
}
