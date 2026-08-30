import Foundation

enum ObjectiveQuestionKind: String, Codable, CaseIterable {
    case singleChoice = "single_choice"
    case multipleChoice = "multiple_choice"
    case ordering
    case shortFill = "short_fill"
    case other
}

enum ObjectiveResultState: String, Codable {
    case ready, review, retake
}

enum ObjectiveResultReason: String, Codable {
    case none
    case ambiguousQuestion = "ambiguous_question"
    case ambiguousOptions = "ambiguous_options"
    case cropped, unreadable
    case missingContext = "missing_context"
    case unsupported
}

struct ObjectiveResultV1: Codable, Equatable {
    let v: Int
    let kind: ObjectiveQuestionKind
    let state: ObjectiveResultState
    let answer: String?
    let reason: ObjectiveResultReason
}

enum ObjectiveParserPath: String, Codable {
    case v1
    case legacyFallback = "legacy_fallback"
    case legacy
    case none
}

enum ObjectiveProtocolViolation: String, Codable, Equatable {
    case duplicateMarker, markerNotLast, invalidJSON, oversizedJSON, unknownField
    case invalidEnum, invalidStateCombination, finalMismatch, missingUsableResult
}

struct ObjectiveResultComposition: Equatable {
    let visibleText: String
    let finalAnswer: String?
    let result: ObjectiveResultV1?
    let state: ObjectiveResultState?
    let parserPath: ObjectiveParserPath
    let violations: [ObjectiveProtocolViolation]
}

enum ObjectiveResultParser {
    static let marker = "NSPI_RESULT_V1:"
    private static let keys = Set(["v", "kind", "state", "answer", "reason"])
    private static let objectiveKinds = Set(ObjectiveQuestionKind.allCases.filter { $0 != .other })

    static func normalizeAnswer(_ source: String) -> String {
        var value = source.precomposedStringWithCompatibilityMapping
            .trimmingCharacters(in: .whitespacesAndNewlines)
        value = value.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        var changed = true
        while changed {
            changed = false
            for fence in ["**", "__", "`"] where value.hasPrefix(fence) && value.hasSuffix(fence)
                && value.count > fence.count * 2 {
                value = String(value.dropFirst(fence.count).dropLast(fence.count))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                changed = true
            }
        }
        if value.range(of: #"^[A-Za-z]$"#, options: .regularExpression) != nil {
            return value.uppercased()
        }
        return value
    }

    static func compose(raw: String, protocolEnabled: Bool = true) -> ObjectiveResultComposition {
        let normalized = raw.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        let lines = normalized.components(separatedBy: "\n")
        let markerIndexes = lines.indices.filter { lines[$0].hasPrefix(marker) }
        let lastNonempty = lines.indices.last { !lines[$0].trimmingCharacters(in: .whitespaces).isEmpty }
        var violations: [ObjectiveProtocolViolation] = []
        func append(_ violation: ObjectiveProtocolViolation) {
            if !violations.contains(violation) { violations.append(violation) }
        }
        if markerIndexes.count > 1 { append(.duplicateMarker) }
        if let last = markerIndexes.last, last != lastNonempty { append(.markerNotLast) }
        let markerInFence = markerIndexes.count == 1 && isInsideMarkdownFence(
            lines: lines, markerIndex: markerIndexes[0])
        if markerInFence { append(.invalidStateCombination) }

        let visible = lines.filter { !$0.hasPrefix(marker) }.joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let final = AnswerComposer.parse(visible, streaming: false).final.flatMap {
            let value = $0.trimmingCharacters(in: .whitespacesAndNewlines)
            return !value.isEmpty && value.unicodeScalars.count <= 512 ? value : nil
        }
        var result: ObjectiveResultV1?

        if protocolEnabled, markerIndexes.count == 1, markerIndexes[0] == lastNonempty,
           !markerInFence {
            let line = lines[markerIndexes[0]]
            let payload = String(line.dropFirst(marker.count)).drop(while: { $0 == " " || $0 == "\t" })
            if payload.utf8.count > 4_096 {
                append(.oversizedJSON)
            } else if let data = String(payload).data(using: .utf8),
                      let object = try? JSONSerialization.jsonObject(with: data),
                      let dictionary = object as? [String: Any] {
                if Set(dictionary.keys) != keys {
                    append(.unknownField)
                } else if let v = dictionary["v"] as? Int, v == 1,
                          let kindRaw = dictionary["kind"] as? String,
                          let kind = ObjectiveQuestionKind(rawValue: kindRaw),
                          let stateRaw = dictionary["state"] as? String,
                          let state = ObjectiveResultState(rawValue: stateRaw),
                          let reasonRaw = dictionary["reason"] as? String,
                          let reason = ObjectiveResultReason(rawValue: reasonRaw),
                          dictionary["answer"] is String || dictionary["answer"] is NSNull {
                    let answer = dictionary["answer"] as? String
                    let candidate = ObjectiveResultV1(v: v, kind: kind, state: state, answer: answer, reason: reason)
                    if valid(candidate) { result = candidate } else { append(.invalidStateCombination) }
                } else {
                    append(.invalidEnum)
                }
            } else {
                append(.invalidJSON)
            }

            if let candidate = result, candidate.state != .retake {
                if final == nil || normalizeAnswer(final!) != normalizeAnswer(candidate.answer ?? "") {
                    append(.finalMismatch)
                    result = nil
                }
            } else if result?.state == .retake, final != nil {
                append(.invalidStateCombination)
                result = nil
            }
        }

        if let result {
            return .init(visibleText: visible, finalAnswer: result.answer, result: result,
                         state: result.state, parserPath: .v1, violations: violations)
        }
        if let final {
            let fallback = protocolEnabled
            return .init(visibleText: visible, finalAnswer: final, result: nil,
                         state: fallback ? .review : nil,
                         parserPath: fallback ? .legacyFallback : .legacy,
                         violations: violations)
        }
        append(.missingUsableResult)
        return .init(visibleText: visible, finalAnswer: nil, result: nil, state: nil,
                     parserPath: .none, violations: violations)
    }

    private static func valid(_ value: ObjectiveResultV1) -> Bool {
        let answerValid = value.answer.map { !$0.isEmpty && $0.unicodeScalars.count <= 512 } ?? false
        switch value.state {
        case .ready:
            return answerValid && value.reason == .none && objectiveKinds.contains(value.kind)
        case .review:
            let validReasons: Set<ObjectiveResultReason> = [
                .ambiguousQuestion, .ambiguousOptions, .missingContext, .unsupported,
            ]
            return answerValid && validReasons.contains(value.reason)
                && (value.kind != .other || value.reason == .unsupported)
        case .retake:
            return value.answer == nil && [.cropped, .unreadable, .missingContext].contains(value.reason)
        }
    }

    private static func isInsideMarkdownFence(lines: [String], markerIndex: Int) -> Bool {
        var openFence: String?
        for line in lines.prefix(markerIndex) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let token = trimmed.hasPrefix("```") ? "```" : (trimmed.hasPrefix("~~~") ? "~~~" : nil)
            guard let token else { continue }
            if openFence == nil { openFence = token }
            else if openFence == token { openFence = nil }
        }
        return openFence != nil
    }
}

/// Incremental presentation filter. It never exposes a marker line, including partial prefixes.
struct ObjectiveResultStreamFilter {
    private(set) var rawBuffer = ""

    mutating func append(_ delta: String) -> String {
        rawBuffer += delta
        return visible(streaming: true)
    }

    mutating func finish() -> ObjectiveResultComposition {
        ObjectiveResultParser.compose(raw: rawBuffer)
    }

    private func visible(streaming: Bool) -> String {
        let normalized = rawBuffer.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        var lines = normalized.components(separatedBy: "\n")
        let openLast = !normalized.hasSuffix("\n")
        lines = lines.enumerated().compactMap { index, line in
            if line.hasPrefix(ObjectiveResultParser.marker) { return nil }
            if streaming && openLast && index == lines.count - 1 {
                let candidate = line.drop(while: { $0 == " " || $0 == "\t" })
                if !candidate.isEmpty && ObjectiveResultParser.marker.hasPrefix(String(candidate)) { return nil }
            }
            return line
        }
        return lines.joined(separator: "\n")
    }
}
