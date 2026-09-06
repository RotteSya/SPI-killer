import Foundation

/// Lifetime solve counters from the same committed snapshot as balance_version.
/// Per-attempt tokens remain separate and must never be added to this mirror.
struct OfficialAccountTotals: Decodable, Equatable {
    let questions: Int
    let inputTokens: Int
    let outputTokens: Int

    enum CodingKeys: String, CodingKey {
        case questions, inputTokens = "input_tokens", outputTokens = "output_tokens"
    }
    var isValid: Bool { questions >= 0 && inputTokens >= 0 && outputTokens >= 0 }
}

struct SettlementSnapshot: Decodable, Equatable {
    let captureID: UUID
    let operation: String?
    let terminalState: String
    let settlementStatus: String
    let questionsCharged: Int?
    let usableResult: Bool
    let balanceQuestions: Int
    let heldQuestions: Int
    let balanceVersion: String
    let canRetry: Bool
    let canRecover: Bool
    var accountTotals: OfficialAccountTotals? = nil

    enum CodingKeys: String, CodingKey {
        case operation
        case captureID = "capture_id", terminalState = "terminal_state", settlementStatus = "settlement_status"
        case questionsCharged = "questions_charged", usableResult = "usable_result"
        case balanceQuestions = "balance_questions", heldQuestions = "held_questions", balanceVersion = "balance_version"
        case canRetry = "can_retry", canRecover = "can_recover"
        case accountTotals = "account_totals"
    }
    var isTerminal: Bool {
        guard balanceQuestions >= 0, heldQuestions >= 0,
              BalanceVersion.canonical(balanceVersion) != nil,
              accountTotals?.isValid != false else { return false }
        switch settlementStatus {
        case "settled": return questionsCharged == 1 && terminalState == "usable" && usableResult
        case "released": return questionsCharged == 0 && !usableResult
            && ["retake", "no_result", "failed", "canceled"].contains(terminalState)
        case "not_required": return questionsCharged == 0
            && ["usable", "failed", "canceled"].contains(terminalState)
            && usableResult == (terminalState == "usable")
        default: return false
        }
    }
}

enum BalanceVersion {
    static func canonical(_ value: String) -> String? {
        guard !value.isEmpty, value.count <= 40,
              value.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else { return nil }
        let trimmed = value.drop(while: { $0 == "0" })
        return trimmed.isEmpty ? "0" : String(trimmed)
    }
    static func accepts(incoming: String, current: String?) -> Bool {
        guard let next = canonical(incoming) else { return false }
        guard let old = current.flatMap(canonical) else { return true }
        return next.count != old.count ? next.count > old.count : next >= old
    }
}

struct ScreenQueryRequest: Equatable {
    static let version = "screen-query-v1-r1"
    let profileID: String
    let language: String
    let parentCaptureID: UUID?

    func fields(imageCount: Int) -> [String: Any] {
        var fields: [String: Any] = [
            "response_contract": "screen_query_v1", "operation": "solve",
            "profile_id": profileID, "profile_version": Self.version, "prompt_version": Self.version,
            "ui_language": language,
            "scope": ["target_count": 1, "question_image_index": imageCount - 1,
                      "rect": ["x": 0, "y": 0, "width": 1, "height": 1]],
        ]
        if let parentCaptureID { fields["parent_capture_id"] = parentCaptureID.uuidString.lowercased() }
        return fields
    }
}

struct AuxiliaryCaptureRequest {
    let parentID: UUID
    let operation: String
    let finalAnswer: String?
    var answerCaptureID: UUID? = nil
}
