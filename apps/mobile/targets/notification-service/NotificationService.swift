import CryptoKit
import Foundation
import Security
import UserNotifications

/// Opens the sealed summary (`rc.sum`) of a pending-request push (M4-05, D5, ADR 0001) and
/// turns the relay's generic alert into "project: tool" with the masked detail line. The
/// relay never sees this text (I1); without a key that opens it the generic alert stays.
final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var fallback: UNMutableNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      contentHandler(request.content)
      return
    }
    fallback = content
    PushSummaryReader.apply(to: content)
    contentHandler(content)
  }

  /// Time is up: show what there is (the generic alert at worst).
  override func serviceExtensionTimeWillExpire() {
    if let contentHandler, let fallback { contentHandler(fallback) }
  }
}

/// Mirrors `PushSummary` in `packages/protocol/src/push-summary.ts`.
struct PushSummary: Decodable {
  let v: Int
  let p: String?
  let l: String
  let s: String?
  let r: String?
  let k: String?
}

/// Mirrors `SharedNotificationKey` in `apps/mobile/src/core/notifications.ts`.
struct SharedNotificationKey: Decodable {
  let deviceId: String
  let key: String
}

enum PushSummaryReader {
  /// Mirrors `PENDING_CATEGORY` / `NOTICE_CATEGORY`.
  static let pendingCategory = "rc.pending"
  static let noticeCategory = "rc.notice"
  /// Mirrors `summaryAad` in `packages/crypto/src/push-summary.ts`.
  static let aadPrefix = "rc/v1/push"
  static let maxSealedBytes = 1024

  /// The Keychain item the app writes (`apps/mobile/src/adapters/notifications.ts`):
  /// expo-secure-store's service `rc.push` + `:no-auth`, account `rc.push.keys`.
  static let keychainService = "rc.push:no-auth"
  static let keychainAccount = "rc.push.keys"
  static let accessGroup = "group.dev.ivanbaev.remotecontrol"

  /// Shows the summary fields as sealed: the agent has already replaced every hidden or
  /// direction-changing character with a `⟨U+XXXX⟩` marker (V3-S03b), so the extension
  /// needs no reveal of its own.
  static func apply(to content: UNMutableNotificationContent) {
    guard
      let rc = content.userInfo["rc"] as? [String: Any],
      let rid = rc["rid"] as? String,
      let sum = rc["sum"] as? String,
      let sealed = Data(base64Encoded: sum),
      let summary = open(sealed: sealed, rid: rid, keys: loadKeys())
    else { return }

    if let project = summary.p {
      content.title = "\(project): \(summary.l)"
    } else {
      content.title = summary.l
    }
    content.subtitle = ""
    let notice = summary.k != nil
    content.body = summary.s ?? (notice ? "Tap to open." : "Tap to review.")
    content.categoryIdentifier = notice ? noticeCategory : pendingCategory
    // expo-notifications hands `userInfo.body` to JS as `content.data`.
    var userInfo = content.userInfo
    userInfo["body"] = ["request": summary.r ?? rid]
    content.userInfo = userInfo
  }

  /// Tries every pairing's key; AES-GCM authentication picks the right one.
  static func open(sealed: Data, rid: String, keys: [SymmetricKey]) -> PushSummary? {
    guard sealed.count > 12 + 16, sealed.count <= maxSealedBytes else { return nil }
    let aad = Data((aadPrefix + rid).utf8)
    guard let box = try? AES.GCM.SealedBox(combined: sealed) else { return nil }
    for key in keys {
      guard let plaintext = try? AES.GCM.open(box, using: key, authenticating: aad) else {
        continue
      }
      guard let summary = try? JSONDecoder().decode(PushSummary.self, from: plaintext),
        summary.v == 1
      else { return nil }
      return summary
    }
    return nil
  }

  static func loadKeys() -> [SymmetricKey] {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keychainService,
      kSecAttrAccount as String: Data(keychainAccount.utf8),
      kSecAttrGeneric as String: Data(keychainAccount.utf8),
      kSecAttrAccessGroup as String: accessGroup,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data,
      let shared = try? JSONDecoder().decode([SharedNotificationKey].self, from: data)
    else { return [] }
    return shared.compactMap { entry in
      guard let raw = Data(base64Encoded: entry.key), raw.count == 32 else { return nil }
      return SymmetricKey(data: raw)
    }
  }
}
