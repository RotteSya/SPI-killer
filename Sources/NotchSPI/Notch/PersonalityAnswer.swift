import Foundation

struct PersonalityContextItem: Codable, Equatable {
    let ordinal: String
    let summary: String
    let choice: String
}

struct PersonalityContextPayload: Codable, Equatable {
    let last: PersonalityContextItem
    let referenceable: [PersonalityContextItem]
}

struct PersonalityChoiceLine: Equatable {
    /// Canonical decimal ordinal (for example, `Q１` and `（１）` both become `1`).
    let ordinal: String
    /// Choice text with surrounding Markdown and whitespace normalized for exact validation.
    let choice: String
    /// Sanitized line used by the notch. Machine lines and prose never reach this field.
    let visibleText: String
}

enum PersonalityProtocolViolation: Equatable {
    case prose
    case invalidContext
    case missingContext
    case duplicateContextMarker
    case invalidError
    case duplicateErrorMarker
    case invalidErrorCombination
    case noValidChoices
}

struct PersonalityAnswerComposition: Equatable {
    let visibleChoices: String
    let finalizedChoices: [PersonalityChoiceLine]
    let provisionalChoice: PersonalityChoiceLine?
    let context: PersonalityContextPayload?
    let errorCode: String?
    let errorOrdinals: [String]
    let violations: [PersonalityProtocolViolation]

    var hasFinalizedChoices: Bool { !finalizedChoices.isEmpty }
}

enum PersonalityAnswer {
    static let contextMarker = "NSPI_CONTEXT_V1"
    static let errorMarker = "NSPI_ERROR_V1"

    static let terminalErrorCodes: Set<String> = [
        "unreadable", "depends_on_missing_previous",
    ]
    static let partialErrorCodes: Set<String> = [
        "partial_unreadable", "partial_missing_previous",
    ]

    private static let ordinalPattern = try! NSRegularExpression(
        pattern: #"^([Qq]\s*[0-9０-９]+|[\(（]\s*[0-9０-９]+\s*[\)）]|[0-9０-９]+\s*[\.．、\)）:：])\s*(.+?)\s*$"#
    )
    private static let whitespacePattern = try! NSRegularExpression(pattern: #"\s+"#)

    private struct MachineLine {
        let marker: String
        let payload: String
    }

    private struct ParsedError {
        let code: String
        let ordinals: [String]
    }

    static func compose(raw: String, streaming: Bool) -> PersonalityAnswerComposition {
        let normalizedRaw = raw.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        let lines = normalizedRaw.components(separatedBy: "\n")
        let hasOpenLastLine = !normalizedRaw.hasSuffix("\n")

        var finalized: [PersonalityChoiceLine] = []
        var provisional: PersonalityChoiceLine?
        var contextJSON: [String] = []
        var errorJSON: [String] = []
        var violations: [PersonalityProtocolViolation] = []

        for (index, sourceLine) in lines.enumerated() {
            let isOpenLastLine = streaming && hasOpenLastLine && index == lines.count - 1
            if let machine = machineLine(sourceLine) {
                if machine.marker == contextMarker { contextJSON.append(machine.payload) }
                else { errorJSON.append(machine.payload) }
                continue
            }

            if isOpenLastLine && isPossibleMarkerPrefix(sourceLine) {
                // Withhold every true prefix, including decorated `N`, `NS`, and a complete
                // marker whose JSON has not arrived yet. It must never flash on the glass.
                continue
            }

            if let choice = parseChoiceLine(sourceLine) {
                if isOpenLastLine { provisional = choice }
                else { finalized.append(choice) }
                continue
            }

            let cleaned = stripLineDecorations(sourceLine)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !cleaned.isEmpty {
                // A short, unfinished ordinal prefix is held without being called prose.
                if !(isOpenLastLine && isPossibleOrdinalPrefix(cleaned)) {
                    violations.append(.prose)
                }
            }
        }

        if contextJSON.count > 1 { violations.append(.duplicateContextMarker) }
        if errorJSON.count > 1 { violations.append(.duplicateErrorMarker) }

        var context: PersonalityContextPayload?
        for json in contextJSON {
            if let candidate = parseContext(json: json, choices: finalized) {
                context = candidate // protocol rule: the last valid payload wins
            } else {
                violations.append(.invalidContext)
            }
        }

        var parsedError: ParsedError?
        for json in errorJSON {
            if let candidate = parseError(json: json) {
                parsedError = candidate
            } else {
                violations.append(.invalidError)
            }
        }

        if !streaming && !finalized.isEmpty && contextJSON.isEmpty {
            violations.append(.missingContext)
        }
        if !streaming && finalized.isEmpty && parsedError == nil {
            violations.append(.noValidChoices)
        }

        if let code = parsedError?.code {
            if terminalErrorCodes.contains(code), !finalized.isEmpty {
                violations.append(.invalidErrorCombination)
            }
            if partialErrorCodes.contains(code), finalized.isEmpty {
                violations.append(.invalidErrorCombination)
            }
        }

        var visible = finalized.map(\.visibleText)
        if let provisional { visible.append(provisional.visibleText) }
        return PersonalityAnswerComposition(
            visibleChoices: visible.joined(separator: "\n"),
            finalizedChoices: finalized,
            provisionalChoice: provisional,
            context: context,
            errorCode: parsedError?.code,
            errorOrdinals: parsedError?.ordinals ?? [],
            violations: violations
        )
    }

    static func normalizeOrdinal(_ source: String) -> String? {
        var value = source.precomposedStringWithCompatibilityMapping
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: " ", with: "")
        if value.first == "Q" || value.first == "q" { value.removeFirst() }
        if value.hasPrefix("("), value.hasSuffix(")"), value.count >= 2 {
            value.removeFirst()
            value.removeLast()
        }
        while let last = value.last, ".、):：".contains(last) { value.removeLast() }
        guard !value.isEmpty, value.allSatisfy({ $0 >= "0" && $0 <= "9" }) else { return nil }
        let withoutLeadingZeroes = value.drop(while: { $0 == "0" })
        return withoutLeadingZeroes.isEmpty ? "0" : String(withoutLeadingZeroes)
    }

    static func normalizeChoice(_ source: String) -> String {
        let stripped = stripPairedMarkdown(source)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let range = NSRange(stripped.startIndex..<stripped.endIndex, in: stripped)
        return whitespacePattern.stringByReplacingMatches(
            in: stripped, range: range, withTemplate: " "
        )
    }

    static func isTerminalError(_ code: String?) -> Bool {
        code.map(terminalErrorCodes.contains) ?? false
    }

    private static func parseChoiceLine(_ source: String) -> PersonalityChoiceLine? {
        let line = stripLineDecorations(source)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { return nil }
        let range = NSRange(line.startIndex..<line.endIndex, in: line)
        guard let match = ordinalPattern.firstMatch(in: line, range: range),
              let ordinalRange = Range(match.range(at: 1), in: line),
              let choiceRange = Range(match.range(at: 2), in: line),
              let ordinal = normalizeOrdinal(String(line[ordinalRange]))
        else { return nil }
        let choice = normalizeChoice(String(line[choiceRange]))
        guard !choice.isEmpty else { return nil }
        return PersonalityChoiceLine(ordinal: ordinal, choice: choice, visibleText: line)
    }

    private static func parseContext(
        json: String, choices: [PersonalityChoiceLine]
    ) -> PersonalityContextPayload? {
        guard json.lengthOfBytes(using: .utf8) <= 4_096,
              let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              Set(dictionary.keys) == Set(["last", "referenceable"]),
              let lastObject = dictionary["last"] as? [String: Any],
              let referenceObjects = dictionary["referenceable"] as? [[String: Any]],
              referenceObjects.count <= 8,
              let last = parseContextItem(lastObject)
        else { return nil }

        var referenceable: [PersonalityContextItem] = []
        for object in referenceObjects {
            guard let item = parseContextItem(object) else { return nil }
            referenceable.append(item)
        }
        let payload = PersonalityContextPayload(last: last, referenceable: referenceable)
        let items = [last] + referenceable
        guard items.allSatisfy({ payloadItem($0, matchesOneOf: choices) }) else { return nil }
        return payload
    }

    private static func parseContextItem(_ object: [String: Any]) -> PersonalityContextItem? {
        guard Set(object.keys) == Set(["ordinal", "summary", "choice"]),
              let ordinal = object["ordinal"] as? String,
              let summary = object["summary"] as? String,
              let choice = object["choice"] as? String,
              !ordinal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !choice.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              ordinal.count <= 24, summary.count <= 240, choice.count <= 80,
              normalizeOrdinal(ordinal) != nil
        else { return nil }
        return PersonalityContextItem(ordinal: ordinal, summary: summary, choice: choice)
    }

    private static func payloadItem(
        _ item: PersonalityContextItem, matchesOneOf choices: [PersonalityChoiceLine]
    ) -> Bool {
        guard let ordinal = normalizeOrdinal(item.ordinal) else { return false }
        let choice = normalizeChoice(item.choice)
        return choices.contains { $0.ordinal == ordinal && $0.choice == choice }
    }

    private static func parseError(json: String) -> ParsedError? {
        guard json.lengthOfBytes(using: .utf8) <= 4_096,
              let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              Set(dictionary.keys).isSubset(of: Set(["code", "ordinals"])),
              let code = dictionary["code"] as? String,
              terminalErrorCodes.contains(code) || partialErrorCodes.contains(code)
        else { return nil }
        let rawOrdinals: [String]
        if let value = dictionary["ordinals"] {
            guard let values = value as? [String], values.count <= 8 else { return nil }
            rawOrdinals = values
        } else {
            rawOrdinals = []
        }
        var ordinals: [String] = []
        for value in rawOrdinals {
            guard value.count <= 24, let normalized = normalizeOrdinal(value) else { return nil }
            ordinals.append(normalized)
        }
        return ParsedError(code: code, ordinals: ordinals)
    }

    private static func machineLine(_ source: String) -> MachineLine? {
        let line = stripLineDecorations(source)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let colon = line.firstIndex(where: { $0 == ":" || $0 == "：" }) else { return nil }
        let header = line[..<colon].trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard header == contextMarker || header == errorMarker else { return nil }
        let payloadStart = line.index(after: colon)
        let payload = line[payloadStart...].trimmingCharacters(in: .whitespacesAndNewlines)
        return MachineLine(marker: header, payload: payload)
    }

    private static func isPossibleMarkerPrefix(_ source: String) -> Bool {
        let candidate = stripLeadingDecorations(source)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "：", with: ":")
            .uppercased()
        guard !candidate.isEmpty else { return false }
        return "\(contextMarker):".hasPrefix(candidate) || "\(errorMarker):".hasPrefix(candidate)
    }

    private static func isPossibleOrdinalPrefix(_ line: String) -> Bool {
        let value = line.precomposedStringWithCompatibilityMapping
        return value.range(
            of: #"^(?:[Qq]?\d{0,24}|[（(]\d{0,24}[）)]?)\s*[.、)）:]?$"#,
            options: .regularExpression
        ) != nil
    }

    private static func stripLineDecorations(_ source: String) -> String {
        // Strip balanced whole-line decoration before treating unbalanced prefixes as streaming
        // decoration; otherwise `**1. choice**` would lose only its opening pair.
        stripPairedMarkdown(stripLeadingDecorations(stripPairedMarkdown(source)))
    }

    private static func stripLeadingDecorations(_ source: String) -> String {
        var value = source.trimmingCharacters(in: .whitespaces)
        var changed = true
        while changed {
            changed = false
            for prefix in ["**", "__", "~~", "`", "*", "_", "> ", "# ", "- ", "+ "] {
                if value.hasPrefix(prefix) {
                    value.removeFirst(prefix.count)
                    value = value.trimmingCharacters(in: .whitespaces)
                    changed = true
                    break
                }
            }
        }
        return value
    }

    private static func stripPairedMarkdown(_ source: String) -> String {
        var value = source.trimmingCharacters(in: .whitespacesAndNewlines)
        var changed = true
        while changed {
            changed = false
            for pair in ["**", "__", "~~", "`", "*", "_"] {
                if value.hasPrefix(pair), value.hasSuffix(pair), value.count >= pair.count * 2 {
                    value.removeFirst(pair.count)
                    value.removeLast(pair.count)
                    value = value.trimmingCharacters(in: .whitespacesAndNewlines)
                    changed = true
                    break
                }
            }
        }
        return value
    }
}
