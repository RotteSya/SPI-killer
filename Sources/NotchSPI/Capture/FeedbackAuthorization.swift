import Foundation

enum FeedbackPurpose: String, Codable, CaseIterable {
    case supportReview = "support_review"
    case qualityEvaluation = "quality_evaluation"

    var title: String {
        switch self {
        case .supportReview: return L10n.t("仅排查本次问题", "今回の問題の調査のみ", "Investigate this problem only")
        case .qualityEvaluation: return L10n.t("排查问题并用于质量评测", "問題の調査と品質評価", "Investigate and evaluate quality")
        }
    }
}

struct FeedbackAuthorization: Codable, Equatable {
    static let currentVersion = "feedback-v2"
    static let contact = "raysyadesu@gmail.com"
    static let maximumDays = 90

    let version: String
    let purpose: FeedbackPurpose
    let rightsConfirmed: Bool
    let authorizedAt: Date
    let expiresAt: Date
    let externalProcessing: String
    let withdrawalContact: String

    init(purpose: FeedbackPurpose, rightsConfirmed: Bool, now: Date = Date()) {
        version = Self.currentVersion; self.purpose = purpose; self.rightsConfirmed = rightsConfirmed
        authorizedAt = now; expiresAt = now.addingTimeInterval(Double(Self.maximumDays) * 86_400)
        externalProcessing = "requires_separate_permission"
        withdrawalContact = Self.contact
    }

    func isValid(at now: Date) -> Bool {
        version == Self.currentVersion && rightsConfirmed && authorizedAt <= now && expiresAt > now
            && expiresAt.timeIntervalSince(authorizedAt) == Double(Self.maximumDays) * 86_400
            && externalProcessing == "requires_separate_permission" && withdrawalContact == Self.contact
    }

    enum CodingKeys: String, CodingKey {
        case version, purpose
        case rightsConfirmed = "rights_confirmed", authorizedAt = "authorized_at", expiresAt = "expires_at"
        case externalProcessing = "external_processing", withdrawalContact = "withdrawal_contact"
    }
}
