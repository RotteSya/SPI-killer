import Foundation
import CryptoKit

/// Frozen local identity for a capture and its retained materials. Only opaque scope IDs
/// enter session bookkeeping; credentials remain in memory and never enter telemetry.
struct CaptureRequestBinding: Equatable {
    let officialAccount: OfficialAPI.CaptureAccount?
    let channelID: String
    let scopeID: String
    /// Registration may establish a credential, but cannot change the user's selection.
    let selectionID: String

    init(mode: String, targetID: String, selectedService: String, channel: ServiceChannel,
         officialBaseURL: String, officialAccount: OfficialAPI.CaptureAccount?,
         providerID: String, endpoint: String, model: String, cliID: String) {
        let selection: [String]
        let identity: [String]
        switch channel {
        case .official:
            self.officialAccount = officialAccount
            selection = ["official", officialBaseURL]
            identity = selection + [officialAccount?.baseURL ?? "", officialAccount?.token ?? "",
                                    officialAccount.map { String($0.generation) } ?? "unregistered"]
        case .customKey(let key):
            self.officialAccount = nil
            selection = ["custom", providerID, endpoint, model, key]
            identity = selection
        case .cli:
            self.officialAccount = nil
            selection = ["cli", cliID]
            identity = selection
        }
        channelID = Self.digest(identity)
        selectionID = Self.digest([mode, targetID, selectedService] + selection)
        scopeID = Self.digest([mode, targetID, selectedService, channelID])
    }

    private static func digest(_ fields: [String]) -> String {
        // Length prefixes prevent ambiguous joins even for user-supplied endpoints/models.
        var bytes = Data()
        for field in fields {
            let value = Data(field.utf8)
            bytes.append(Data("\(value.count):".utf8)); bytes.append(value)
        }
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
}
