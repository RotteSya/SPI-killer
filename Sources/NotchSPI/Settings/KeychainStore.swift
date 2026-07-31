import Foundation
import Security

/// Minimal Keychain wrapper for the app's secrets (自定义 API Key、官方服务设备令牌).
/// Generic-password items keyed by account name, user-local and non-synchronizable —
/// unlike UserDefaults they are not a plaintext plist readable by every process under
/// the same user, and they stay out of ordinary backups.
enum KeychainStore {
    private static let service = "com.rottesya.notchspi"

    #if DEBUG
    /// Visual-QA escape hatch: with NSPI_QA_EPHEMERAL=1 all secrets live in this in-process
    /// dictionary only. The real Keychain service is SHARED with the packaged app, so QA runs
    /// must never read or write the user's actual device token / API keys.
    private static var ephemeral: [String: String]? =
        ProcessInfo.processInfo.environment["NSPI_QA_EPHEMERAL"] == "1" ? [:] : nil
    #endif

    static func read(_ account: String) -> String? {
        #if DEBUG
        if ephemeral != nil { return ephemeral?[account] }
        #endif
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8), !value.isEmpty
        else { return nil }
        return value
    }

    /// Upsert; nil or empty deletes the item. Returns whether the Keychain now holds exactly what
    /// was asked for.
    ///
    /// Callers use the result to decide whether it is safe to destroy the value's other copy —
    /// the device token is the only key to purchased quota, so a write that failed (locked
    /// keychain, denied ACL after a re-sign, full keychain) must never be mistaken for a write
    /// that succeeded. Update-in-place is tried first: the old delete-then-add left a window with
    /// no item at all, and turned a failed add into silent, permanent loss of the secret.
    @discardableResult
    static func write(_ value: String?, account: String) -> Bool {
        #if DEBUG
        if ephemeral != nil {
            ephemeral?[account] = (value?.isEmpty ?? true) ? nil : value
            return true
        }
        #endif
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        guard let value, !value.isEmpty, let data = value.data(using: .utf8) else {
            let status = SecItemDelete(base as CFDictionary)
            return status == errSecSuccess || status == errSecItemNotFound
        }
        let updated = SecItemUpdate(
            base as CFDictionary,
            [kSecValueData as String: data] as CFDictionary)
        if updated == errSecSuccess { return true }
        guard updated == errSecItemNotFound else { return false }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }
}
