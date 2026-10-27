import ExpoModulesCore
import LocalAuthentication
import Security

/// The app's device signing key (ADR 0017, M4-04): a P-256 key in the Secure Enclave
/// whose every use needs the currently enrolled biometry. The simulator has no Secure
/// Enclave, so there the key is a keychain key with the same access control.
public class DeviceKeyModule: Module {
  private static let tag = "dev.ivanbaev.remotecontrol.device-key".data(using: .utf8)!

  public func definition() -> ModuleDefinition {
    Name("DeviceKey")

    /// The public key as an X9.63 point (65 bytes, base64), created on first use.
    AsyncFunction("getOrCreate") { () throws -> [String: Any] in
      let key = try Self.existingKey() ?? Self.createKey()
      guard let publicKey = SecKeyCopyPublicKey(key),
        let raw = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?
      else { throw DeviceKeyException("the public key could not be exported") }
      return ["publicKey": raw.base64EncodedString(), "secureEnclave": Self.inSecureEnclave(key)]
    }

    /// ECDSA P-256 over SHA-256(message) in DER, after Face ID / Touch ID; `null` when the
    /// user cancels.
    AsyncFunction("sign") { (message: String, reason: String) throws -> String? in
      guard let data = Data(base64Encoded: message) else {
        throw DeviceKeyException("the message is not base64")
      }
      let context = LAContext()
      context.localizedReason = reason
      guard let key = try Self.existingKey(context: context) else {
        throw DeviceKeyException("there is no device key")
      }
      var error: Unmanaged<CFError>?
      guard
        let signature = SecKeyCreateSignature(
          key, .ecdsaSignatureMessageX962SHA256, data as CFData, &error) as Data?
      else {
        let code = (error?.takeRetainedValue() as Error?).map { ($0 as NSError).code }
        if code == Int(errSecUserCanceled) || code == LAError.userCancel.rawValue
          || code == LAError.appCancel.rawValue || code == LAError.systemCancel.rawValue
        {
          return nil
        }
        throw DeviceKeyException("signing failed (\(code.map(String.init) ?? "unknown"))")
      }
      return signature.base64EncodedString()
    }

    /// Deletes the key (account deletion, re-pairing after a biometry change).
    AsyncFunction("remove") { () in
      SecItemDelete(Self.query() as CFDictionary)
    }
  }

  private static func query() -> [String: Any] {
    [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    ]
  }

  private static func existingKey(context: LAContext? = nil) throws -> SecKey? {
    var query = query()
    query[kSecReturnRef as String] = true
    if let context { query[kSecUseAuthenticationContext as String] = context }
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let item else {
      throw DeviceKeyException("the keychain refused (\(status))")
    }
    return (item as! SecKey)
  }

  private static func createKey() throws -> SecKey {
    guard
      let access = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.privateKeyUsage, .biometryCurrentSet], nil)
    else { throw DeviceKeyException("the access control could not be created") }
    var attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: tag,
        kSecAttrAccessControl as String: access,
      ] as [String: Any],
    ]
    #if !targetEnvironment(simulator)
      attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
    #endif
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      let reason = error?.takeRetainedValue().localizedDescription ?? "unknown"
      throw DeviceKeyException("the key could not be created: \(reason)")
    }
    return key
  }

  private static func inSecureEnclave(_ key: SecKey) -> Bool {
    let attributes = SecKeyCopyAttributes(key) as? [String: Any]
    return attributes?[kSecAttrTokenID as String] as? String
      == kSecAttrTokenIDSecureEnclave as String
  }
}

final class DeviceKeyException: GenericException<String>, @unchecked Sendable {
  override var reason: String { "Device key: \(param)" }
}
