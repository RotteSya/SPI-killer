import AppKit
import CryptoKit
import XCTest
@testable import NotchSPI

private struct PersonalityFixtureManifest: Decodable {
    let schemaVersion: Int
    let fixtureSetVersion: String
    let thresholds: Thresholds
    let resultSchema: ResultSchema
    let fixtures: [Fixture]

    struct Thresholds: Decodable {
        let legalChoiceRateMin: Double
        let validContextRateMin: Double
        let refusalOrLectureMaxCount: Int
        let continuityRateMin: Double
        let personaDirectionRateMin: Double

        enum CodingKeys: String, CodingKey {
            case legalChoiceRateMin = "legal_choice_rate_min"
            case validContextRateMin = "valid_context_rate_min"
            case refusalOrLectureMaxCount = "refusal_or_lecture_max_count"
            case continuityRateMin = "continuity_rate_min"
            case personaDirectionRateMin = "persona_direction_rate_min"
        }
    }

    struct ResultSchema: Decodable {
        let required: [String]
        let prohibited: [String]
    }

    struct Fixture: Decodable {
        let id: String
        let categories: [String]
        let setup: String
        let personaVariants: [PersonaVariant]
        let steps: [Step]

        enum CodingKeys: String, CodingKey {
            case id, categories, setup, steps
            case personaVariants = "persona_variants"
        }
    }

    struct PersonaVariant: Decodable {
        let id: String
        let name: String
        let text: String
        let expectedChoices: [String: [String: [String]]]?

        enum CodingKeys: String, CodingKey {
            case id, name, text
            case expectedChoices = "expected_choices"
        }
    }

    struct Step: Decodable {
        let id: String
        let image: String
        let sha256: String
        let score: Score
    }

    struct Score: Decodable {
        let expectedChoiceCount: Int
        let requiresContext: Bool
        let expectedTerminalError: String?
        let expectedPartialError: String?
        let continuity: Continuity?

        enum CodingKeys: String, CodingKey {
            case expectedChoiceCount = "expected_choice_count"
            case requiresContext = "requires_context"
            case expectedTerminalError = "expected_terminal_error"
            case expectedPartialError = "expected_partial_error"
            case continuity
        }
    }

    struct Continuity: Decodable {
        let type: String
        let ordinal: String
    }

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case fixtureSetVersion = "fixture_set_version"
        case thresholds, fixtures
        case resultSchema = "result_schema"
    }
}

private struct PersonalityEvaluationResult: Codable {
    let fixtureID: String
    let fixtureSetVersion: String
    let variantID: String
    let stepID: String
    let commit: String
    let appVersion: String
    let channel: String
    let providerModel: String
    let rawProtocolStatus: String
    let validChoiceCount: Int
    let expectedChoiceCount: Int
    let contextValid: Bool
    let expectedProtocolSatisfied: Bool
    let refusalOrLecture: Bool
    let continuityScore: Double?
    let personaDirectionScore: Double?
    let executor: String
    let reviewer: String

    enum CodingKeys: String, CodingKey {
        case fixtureID = "fixture_id"
        case fixtureSetVersion = "fixture_set_version"
        case variantID = "variant_id"
        case stepID = "step_id"
        case commit, channel, executor, reviewer
        case appVersion = "app_version"
        case providerModel = "provider_model"
        case rawProtocolStatus = "raw_protocol_status"
        case validChoiceCount = "valid_choice_count"
        case expectedChoiceCount = "expected_choice_count"
        case contextValid = "context_valid"
        case expectedProtocolSatisfied = "expected_protocol_satisfied"
        case refusalOrLecture = "refusal_or_lecture"
        case continuityScore = "continuity_score"
        case personaDirectionScore = "persona_direction_score"
    }

    func signed(by reviewer: String) -> Self {
        Self(
            fixtureID: fixtureID, fixtureSetVersion: fixtureSetVersion,
            variantID: variantID, stepID: stepID,
            commit: commit, appVersion: appVersion, channel: channel,
            providerModel: providerModel, rawProtocolStatus: rawProtocolStatus,
            validChoiceCount: validChoiceCount, expectedChoiceCount: expectedChoiceCount,
            contextValid: contextValid, expectedProtocolSatisfied: expectedProtocolSatisfied,
            refusalOrLecture: refusalOrLecture, continuityScore: continuityScore,
            personaDirectionScore: personaDirectionScore, executor: executor, reviewer: reviewer
        )
    }
}

private struct PersonalityEvaluationSummary {
    let legalChoiceRate: Double
    let validContextRate: Double
    let refusalOrLectureCount: Int
    let continuityRate: Double
    let personaDirectionRate: Double
    let expectedProtocolRate: Double

    static func calculate(_ results: [PersonalityEvaluationResult]) -> Self {
        let choiceResults = results.filter { $0.expectedChoiceCount > 0 }
        let choiceDenominator = choiceResults.reduce(0) {
            $0 + max($1.validChoiceCount, $1.expectedChoiceCount)
        }
        let choiceNumerator = choiceResults.reduce(0) {
            $0 + min($1.validChoiceCount, $1.expectedChoiceCount)
        }
        let contextResults = results.filter { $0.expectedChoiceCount > 0 }
        let continuity = results.compactMap(\.continuityScore)
        let direction = results.compactMap(\.personaDirectionScore)
        return Self(
            legalChoiceRate: choiceDenominator == 0 ? 0 : Double(choiceNumerator) / Double(choiceDenominator),
            validContextRate: contextResults.isEmpty ? 0
                : Double(contextResults.filter(\.contextValid).count) / Double(contextResults.count),
            refusalOrLectureCount: results.filter(\.refusalOrLecture).count,
            continuityRate: continuity.isEmpty ? 0 : continuity.reduce(0, +) / Double(continuity.count),
            personaDirectionRate: direction.isEmpty ? 0 : direction.reduce(0, +) / Double(direction.count),
            expectedProtocolRate: results.isEmpty ? 0
                : Double(results.filter(\.expectedProtocolSatisfied).count) / Double(results.count)
        )
    }
}

private enum PersonalityEvaluationChannel {
    case official
    case cli(id: String, path: String)
    case customKey(
        provider: APIProvider,
        endpoint: String,
        model: String,
        apiKey: String
    )

    var resultChannel: String {
        switch self {
        case .official: return "official"
        case .cli: return "cli"
        case .customKey: return "customKey"
        }
    }

    var channelIdentity: String {
        switch self {
        case .official:
            return "official:\(OfficialAPI.baseURL)"
        case .cli(let id, _):
            return "cli:\(id)"
        case .customKey(let provider, let endpoint, let model, _):
            return "customKey:\(provider.id):\(endpoint):\(model)"
        }
    }

    var defaultProviderModel: String {
        switch self {
        case .official:
            return "official:server-configured"
        case .cli(let id, _):
            return "cli:\(id):default"
        case .customKey(let provider, _, let model, _):
            return "\(provider.id):\(model)"
        }
    }

    var fileSuffix: String {
        switch self {
        case .official:
            return ""
        case .cli(let id, _):
            return "-cli-\(id)"
        case .customKey(let provider, _, let model, _):
            let safeModel = model.map { $0.isLetter || $0.isNumber ? $0 : "-" }
            return "-customKey-\(provider.id)-\(String(safeModel).prefix(48))"
        }
    }

    var isReleaseGate: Bool {
        if case .official = self { return true }
        return false
    }
}

@MainActor
final class PersonalityEvaluationTests: XCTestCase {
    private var repositoryFixtureRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/Personality", isDirectory: true)
    }

    private func selectedFixtureRoot() -> URL {
        if let override = ProcessInfo.processInfo.environment["NSPI_PERSONALITY_FIXTURES_DIR"],
           !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return repositoryFixtureRoot
    }

    private func loadManifest(from root: URL) throws -> PersonalityFixtureManifest {
        let data = try Data(contentsOf: root.appendingPathComponent("manifest.json"))
        return try JSONDecoder().decode(PersonalityFixtureManifest.self, from: data)
    }

    func testSyntheticFixtureManifestIsCompleteAndSelfConsistent() throws {
        let root = repositoryFixtureRoot
        let manifest = try loadManifest(from: root)
        XCTAssertEqual(manifest.schemaVersion, 1)
        XCTAssertFalse(manifest.fixtureSetVersion.contains("draft"))
        XCTAssertEqual(Set(manifest.fixtures.map(\.id)).count, manifest.fixtures.count)
        XCTAssertGreaterThanOrEqual(manifest.fixtures.filter {
            $0.categories.contains("refusal_resistance")
        }.count, 10)
        XCTAssertGreaterThanOrEqual(manifest.fixtures.filter {
            $0.categories.contains("opposite_persona_direction")
        }.count, 10)
        XCTAssertGreaterThanOrEqual(manifest.fixtures.filter {
            $0.categories.contains("immediate_previous_continuity")
                && $0.steps.count >= 2
        }.count, 10)
        XCTAssertTrue(manifest.fixtures.contains { $0.categories.contains("numbering_and_language_edges") })
        XCTAssertTrue(manifest.fixtures.contains { $0.categories.contains("readability_errors") })

        let required = Set(manifest.resultSchema.required)
        for key in [
            "fixture_id", "fixture_set_version", "commit", "app_version", "channel", "provider_model",
            "raw_protocol_status", "valid_choice_count", "context_valid",
            "refusal_or_lecture", "continuity_score", "persona_direction_score",
            "executor", "reviewer",
        ] {
            XCTAssertTrue(required.contains(key), "missing required result field: \(key)")
        }
        XCTAssertTrue(Set(manifest.resultSchema.prohibited).isSuperset(of: [
            "raw_completion", "persona_text", "question_text", "user_data",
        ]))

        var imageCount = 0
        for fixture in manifest.fixtures {
            XCTAssertFalse(fixture.id.isEmpty)
            XCTAssertFalse(fixture.personaVariants.isEmpty)
            for step in fixture.steps {
                XCTAssertFalse(step.image.hasPrefix("/"), "absolute fixture path is forbidden")
                let url = root.appendingPathComponent(step.image)
                let data = try Data(contentsOf: url)
                XCTAssertEqual(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), step.sha256)
                XCTAssertNotNil(NSImage(data: data), "invalid fixture image: \(step.image)")
                imageCount += 1
            }
        }
        XCTAssertGreaterThanOrEqual(imageCount, 40)
    }

    func testSummaryPenalizesBothMissingAndInventedChoiceLines() {
        func result(valid: Int, expected: Int, context: Bool) -> PersonalityEvaluationResult {
            PersonalityEvaluationResult(
                fixtureID: "f", fixtureSetVersion: "1.0.0",
                variantID: "v", stepID: "s", commit: "c",
                appVersion: "1", channel: "official", providerModel: "m",
                rawProtocolStatus: "valid", validChoiceCount: valid,
                expectedChoiceCount: expected, contextValid: context,
                expectedProtocolSatisfied: true, refusalOrLecture: false,
                continuityScore: nil, personaDirectionScore: nil,
                executor: "e", reviewer: "r"
            )
        }
        let summary = PersonalityEvaluationSummary.calculate([
            result(valid: 1, expected: 2, context: true),
            result(valid: 3, expected: 2, context: true),
            result(valid: 0, expected: 0, context: false),
        ])
        XCTAssertEqual(summary.legalChoiceRate, 3.0 / 5.0, accuracy: 0.0001)
        XCTAssertEqual(summary.validContextRate, 1.0)
    }

    func testOfficialPersonalityReleaseGateWhenExplicitlyEnabled() async throws {
        guard ProcessInfo.processInfo.environment["NSPI_RUN_PERSONALITY_EVAL"] == "1" else {
            throw XCTSkip("Set NSPI_RUN_PERSONALITY_EVAL=1 to run an explicit personality evaluation")
        }
        let root = selectedFixtureRoot()
        let manifest = try loadManifest(from: root)
        let filter = ProcessInfo.processInfo.environment["NSPI_EVAL_FILTER"]
        let fixtures = filter.map { value in
            manifest.fixtures.filter { $0.id.contains(value) || $0.categories.contains(value) }
        } ?? manifest.fixtures
        XCTAssertFalse(fixtures.isEmpty, "NSPI_EVAL_FILTER selected no fixtures")

        let executor = ProcessInfo.processInfo.environment["NSPI_EVAL_EXECUTOR"] ?? "codex"
        let channel = try await Self.resolveEvaluationChannel()
        let reviewer = ProcessInfo.processInfo.environment["NSPI_EVAL_REVIEWER"]
            ?? (channel.isReleaseGate ? "pending-second-review" : "not-required-nonblocking-baseline")
        let providerModel = ProcessInfo.processInfo.environment["NSPI_EVAL_PROVIDER_MODEL"]
            ?? channel.defaultProviderModel
        let head = Self.git(["rev-parse", "--short", "HEAD"]) ?? "unknown-head"
        let dirty = !(Self.git(["status", "--porcelain", "--untracked-files=normal"]) ?? "").isEmpty
        let commit = dirty ? "\(head)-dirty" : head
        let appVersion = ProcessInfo.processInfo.environment["NSPI_EVAL_APP_VERSION"]
            ?? Self.releaseVersion()
            ?? "dev"
        let date = Self.dateFormatter.string(from: Date())
        let resultDirectory = Self.evaluationOutputDirectory(fixtureRoot: root)
        try FileManager.default.createDirectory(at: resultDirectory, withIntermediateDirectories: true)
        let resultURL = resultDirectory.appendingPathComponent(
            "\(date)-\(commit)\(channel.fileSuffix).jsonl"
        )
        FileManager.default.createFile(atPath: resultURL.path, contents: nil)
        let resultHandle = try FileHandle(forWritingTo: resultURL)
        try resultHandle.truncate(atOffset: 0)
        defer { try? resultHandle.close() }

        let requiredCalls = fixtures.reduce(0) { subtotal, fixture in
            subtotal + fixture.personaVariants.count * fixture.steps.count
        }
        if channel.isReleaseGate {
            guard OfficialAPI.deviceToken != nil else {
                XCTFail("No official device token is available in Keychain")
                return
            }
            _ = await OfficialAPI.refreshAccount()
            if let balance = OfficialAPI.balanceQuestions {
                XCTAssertGreaterThanOrEqual(
                    balance, requiredCalls,
                    "Not enough official quota for the complete selected run"
                )
            }
        }

        var results: [PersonalityEvaluationResult] = []
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        for fixture in fixtures {
            for variant in fixture.personaVariants {
                let session = PersonalitySession()
                let scope = PersonalitySessionScope(
                    personaID: "\(fixture.id):\(variant.id)",
                    personaName: variant.name,
                    personaText: variant.text,
                    captureTargetID: "fixture:\(fixture.id)",
                    channelID: channel.channelIdentity
                )
                if fixture.setup == "unavailable_previous" {
                    let unavailable = session.begin(scope: scope)
                    session.markPreviousUnavailable(token: unavailable)
                }
                var previousChoice: String?
                for step in fixture.steps {
                    let token = session.begin(scope: scope)
                    let prompt = Prompts.capturePrompt(
                        mode: "personality", depth: "guided",
                        personaName: variant.name, personaText: variant.text,
                        sessionContext: token.contextBlock
                    )
                    let run = PersonalityCaptureRun(token: token, prompt: prompt)
                    let model = TutorModel()
                    model.mode = "personality"
                    let transport = await Self.stream(
                        channel: channel,
                        imagePath: root.appendingPathComponent(step.image).path,
                        run: run,
                        model: model
                    )
                    let outcome = run.complete(
                        session: session, currentScope: scope, transportOK: transport.ok
                    )
                    let composition = outcome.composition
                    // Some questionnaires restart numbering within one page. The production
                    // parser intentionally preserves those visible lines, so the evaluator must
                    // not impose a uniqueness precondition and crash. For the manifest's
                    // ordinal-keyed scores, the last visible occurrence is the deterministic one.
                    var choices: [String: String] = [:]
                    for choice in composition.finalizedChoices {
                        choices[choice.ordinal] = choice.choice
                    }
                    let refusal = fixture.categories.contains("refusal_resistance")
                        && (composition.violations.contains(.prose) || composition.finalizedChoices.isEmpty)
                    let continuityScore: Double?
                    if let continuity = step.score.continuity,
                       continuity.type == "same_choice_as_previous",
                       let current = choices[PersonalityAnswer.normalizeOrdinal(continuity.ordinal) ?? continuity.ordinal],
                       let previousChoice {
                        continuityScore = current == previousChoice ? 1 : 0
                    } else {
                        continuityScore = nil
                    }
                    let directionScore: Double?
                    if let expected = variant.expectedChoices?[step.id], !expected.isEmpty {
                        let matched = expected.reduce(0) { total, pair in
                            let ordinal = PersonalityAnswer.normalizeOrdinal(pair.key) ?? pair.key
                            let accepted = pair.value.map(PersonalityAnswer.normalizeChoice)
                            return total + (choices[ordinal].map(accepted.contains) == true ? 1 : 0)
                        }
                        directionScore = Double(matched) / Double(expected.count)
                    } else {
                        directionScore = nil
                    }
                    let protocolSatisfied = Self.protocolSatisfied(step: step, composition: composition)
                    let result = PersonalityEvaluationResult(
                        fixtureID: fixture.id,
                        fixtureSetVersion: manifest.fixtureSetVersion,
                        variantID: variant.id,
                        stepID: step.id,
                        commit: commit,
                        appVersion: appVersion,
                        channel: channel.resultChannel,
                        providerModel: providerModel,
                        rawProtocolStatus: Self.protocolStatus(transportOK: transport.ok, outcome: outcome),
                        validChoiceCount: composition.finalizedChoices.count,
                        expectedChoiceCount: step.score.expectedChoiceCount,
                        contextValid: composition.context != nil,
                        expectedProtocolSatisfied: protocolSatisfied,
                        refusalOrLecture: refusal,
                        continuityScore: continuityScore,
                        personaDirectionScore: directionScore,
                        executor: executor,
                        reviewer: reviewer
                    )
                    results.append(result)
                    var line = try encoder.encode(result)
                    line.append(0x0A)
                    try resultHandle.write(contentsOf: line)
                    previousChoice = composition.finalizedChoices.last?.choice
                }
            }
        }

        let summary = PersonalityEvaluationSummary.calculate(results)
        if filter == nil, root == repositoryFixtureRoot {
            let summaryDirectory = Self.evaluationOutputDirectory(fixtureRoot: root)
            try FileManager.default.createDirectory(at: summaryDirectory, withIntermediateDirectories: true)
            let summaryURL = summaryDirectory.appendingPathComponent(
                "\(date)-\(commit)\(channel.fileSuffix).md"
            )
            try Self.summaryMarkdown(
                manifest: manifest, summary: summary, results: results,
                commit: commit, appVersion: appVersion, providerModel: providerModel,
                executor: executor, reviewer: reviewer, isReleaseGate: channel.isReleaseGate
            ).write(to: summaryURL, atomically: true, encoding: .utf8)
        }

        if filter != nil {
            XCTAssertTrue(results.allSatisfy(\.expectedProtocolSatisfied))
            XCTAssertFalse(results.contains { $0.rawProtocolStatus == "transport_failure" })
            return
        }

        XCTAssertFalse(results.contains { $0.rawProtocolStatus == "transport_failure" })
        if channel.isReleaseGate {
            Self.assertReleaseThresholds(summary, manifest: manifest)
            XCTAssertFalse(reviewer.hasPrefix("pending"), "A second reviewer must sign off directionality results")
        }
    }

    func testExistingOfficialRecordWhenExplicitlyReviewed() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let path = environment["NSPI_REVIEW_PERSONALITY_EVAL"], !path.isEmpty else {
            throw XCTSkip("Set NSPI_REVIEW_PERSONALITY_EVAL to a JSONL result after manual review")
        }
        let reviewer = environment["NSPI_EVAL_REVIEWER"] ?? "pending-second-review"
        XCTAssertFalse(reviewer.hasPrefix("pending"), "Provide the second reviewer's identity")
        guard !reviewer.hasPrefix("pending") else { return }

        let root = selectedFixtureRoot()
        let manifest = try loadManifest(from: root)
        let resultURL = URL(fileURLWithPath: path)
        let data = try Data(contentsOf: resultURL)
        let decoder = JSONDecoder()
        let results = try data.split(separator: 0x0A).map { line in
            try decoder.decode(PersonalityEvaluationResult.self, from: Data(line))
        }
        XCTAssertFalse(results.isEmpty)
        XCTAssertTrue(results.allSatisfy { $0.channel == "official" })
        XCTAssertTrue(results.allSatisfy { $0.fixtureSetVersion == manifest.fixtureSetVersion })
        XCTAssertFalse(results.contains { $0.rawProtocolStatus == "transport_failure" })

        let expectedKeys = Set(manifest.fixtures.flatMap { fixture in
            fixture.personaVariants.flatMap { variant in
                fixture.steps.map { "\(fixture.id)|\(variant.id)|\($0.id)" }
            }
        })
        let actualKeys = Set(results.map { "\($0.fixtureID)|\($0.variantID)|\($0.stepID)" })
        XCTAssertEqual(actualKeys, expectedKeys, "The reviewed record must cover the full manifest")
        XCTAssertEqual(results.count, expectedKeys.count, "Duplicate or missing result rows")

        let summary = PersonalityEvaluationSummary.calculate(results)
        Self.assertReleaseThresholds(summary, manifest: manifest)

        // Signing changes metadata only. No raw completion, persona, or question text is added.
        let signed = results.map { $0.signed(by: reviewer) }
        try Self.writeJSONL(signed, to: resultURL)

        let first = try XCTUnwrap(signed.first)
        let summaryDirectory = Self.evaluationOutputDirectory(fixtureRoot: root)
        try FileManager.default.createDirectory(at: summaryDirectory, withIntermediateDirectories: true)
        let summaryURL = summaryDirectory.appendingPathComponent(
            resultURL.deletingPathExtension().lastPathComponent + ".md"
        )
        try Self.summaryMarkdown(
            manifest: manifest, summary: summary, results: signed,
            commit: first.commit, appVersion: first.appVersion,
            providerModel: first.providerModel, executor: first.executor,
            reviewer: reviewer, isReleaseGate: true
        ).write(to: summaryURL, atomically: true, encoding: .utf8)
    }

    private static func assertReleaseThresholds(
        _ summary: PersonalityEvaluationSummary,
        manifest: PersonalityFixtureManifest
    ) {
        XCTAssertGreaterThanOrEqual(summary.legalChoiceRate, manifest.thresholds.legalChoiceRateMin)
        XCTAssertGreaterThanOrEqual(summary.validContextRate, manifest.thresholds.validContextRateMin)
        XCTAssertLessThanOrEqual(summary.refusalOrLectureCount, manifest.thresholds.refusalOrLectureMaxCount)
        XCTAssertGreaterThanOrEqual(summary.continuityRate, manifest.thresholds.continuityRateMin)
        XCTAssertGreaterThanOrEqual(summary.personaDirectionRate, manifest.thresholds.personaDirectionRateMin)
    }

    private static func writeJSONL(
        _ results: [PersonalityEvaluationResult], to url: URL
    ) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var data = Data()
        for result in results {
            data.append(try encoder.encode(result))
            data.append(0x0A)
        }
        try data.write(to: url, options: .atomic)
    }

    private static func protocolSatisfied(
        step: PersonalityFixtureManifest.Step,
        composition: PersonalityAnswerComposition
    ) -> Bool {
        if let expected = step.score.expectedTerminalError {
            return composition.errorCode == expected && composition.finalizedChoices.isEmpty
        }
        if let expected = step.score.expectedPartialError {
            return composition.errorCode == expected
                && composition.finalizedChoices.count == step.score.expectedChoiceCount
                && composition.context != nil
        }
        return composition.finalizedChoices.count == step.score.expectedChoiceCount
            && (!step.score.requiresContext || composition.context != nil)
    }

    private static func protocolStatus(
        transportOK: Bool, outcome: PersonalityCompletionOutcome
    ) -> String {
        guard transportOK else { return "transport_failure" }
        if let code = outcome.composition.errorCode { return code }
        switch outcome.primary {
        case .done, .missingPrevious: return "valid"
        case .invalidContext: return "invalid_context"
        case .noValidChoices: return "no_valid_choices"
        case .contextCleared: return "discarded_stale_result"
        default: return String(describing: outcome.primary)
        }
    }

    private static func resolveEvaluationChannel() async throws -> PersonalityEvaluationChannel {
        let environment = ProcessInfo.processInfo.environment
        switch environment["NSPI_EVAL_CHANNEL"] ?? "official" {
        case "official":
            return .official
        case "cli":
            let id = environment["NSPI_EVAL_CLI"] ?? Settings.shared.cli
            guard id == "claude" || id == "codex" else {
                throw XCTSkip("NSPI_EVAL_CLI must be claude or codex")
            }
            let detected = await CLIRunner.detectFresh()
            guard let info = detected[id], info.installed, info.loggedIn != false,
                  let path = info.path else {
                throw XCTSkip("Requested CLI baseline is not installed and logged in: \(id)")
            }
            return .cli(id: id, path: path)
        case "customKey":
            let providerID = environment["NSPI_EVAL_API_PROVIDER"] ?? Settings.shared.apiProvider
            let provider = APIProvider.byID(providerID)
            let endpoint = environment["NSPI_EVAL_API_ENDPOINT"] ?? Settings.shared.endpoint(for: provider)
            let model = environment["NSPI_EVAL_API_MODEL"] ?? Settings.shared.apiModel(for: provider.storageKey)
            let apiKey = environment["NSPI_EVAL_API_KEY"] ?? Settings.shared.apiKey(for: provider.storageKey)
            guard !endpoint.isEmpty, !model.isEmpty, !apiKey.isEmpty else {
                throw XCTSkip("Requested customKey baseline has no complete provider configuration")
            }
            return .customKey(
                provider: provider, endpoint: endpoint, model: model, apiKey: apiKey
            )
        default:
            throw XCTSkip("NSPI_EVAL_CHANNEL must be official, customKey, or cli")
        }
    }

    private static func stream(
        channel: PersonalityEvaluationChannel,
        imagePath: String, run: PersonalityCaptureRun, model: TutorModel
    ) async -> (ok: Bool, error: String) {
        await withCheckedContinuation { continuation in
            let onDelta = { (delta: String) in run.append(delta, to: model) }
            let onDone = { (ok: Bool, error: String) in
                continuation.resume(returning: (ok, error))
            }
            switch channel {
            case .official:
                OfficialAPI.run(
                    imagePaths: [imagePath], prompt: run.prompt,
                    onDelta: onDelta, onDone: onDone
                )
            case .cli(let id, let path):
                CLIRunner.run(
                    cliId: id, binPath: path, imagePaths: [imagePath], prompt: run.prompt,
                    onDelta: onDelta, onDone: onDone
                )
            case .customKey(let provider, let endpoint, let model, let apiKey):
                APIKeyRunner.run(
                    proto: provider.proto, endpoint: endpoint, apiKey: apiKey, model: model,
                    disableThinking: provider.disablesThinking,
                    imagePaths: [imagePath], prompt: run.prompt,
                    onDelta: onDelta, onDone: onDone
                )
            }
        }
    }

    private static func summaryMarkdown(
        manifest: PersonalityFixtureManifest,
        summary: PersonalityEvaluationSummary,
        results: [PersonalityEvaluationResult],
        commit: String,
        appVersion: String,
        providerModel: String,
        executor: String,
        reviewer: String,
        isReleaseGate: Bool
    ) -> String {
        func percent(_ value: Double) -> String { String(format: "%.1f%%", value * 100) }
        func pass(_ value: Bool) -> String { value ? "PASS" : "FAIL" }
        let directionRows = results.compactMap { result -> String? in
            guard let score = result.personaDirectionScore else { return nil }
            return "| `\(result.fixtureID)` | `\(result.variantID)` | `\(result.stepID)` | \(percent(score)) |"
        }.joined(separator: "\n")
        return """
        # Personality release evaluation

        - Fixture set: `\(manifest.fixtureSetVersion)`
        - Commit: `\(commit)`
        - App version: `\(appVersion)`
        - Channel/model: `\(providerModel)`
        - Executor: `\(executor)`
        - Reviewer: `\(reviewer)`
        - Policy: `\(isReleaseGate ? "official release gate" : "non-blocking channel baseline")`
        - Result rows: \(results.count)

        | Metric | Result | Gate | Status |
        |---|---:|---:|---|
        | Legal choice output | \(percent(summary.legalChoiceRate)) | ≥ \(percent(manifest.thresholds.legalChoiceRateMin)) | \(pass(summary.legalChoiceRate >= manifest.thresholds.legalChoiceRateMin)) |
        | Valid NSPI_CONTEXT_V1 | \(percent(summary.validContextRate)) | ≥ \(percent(manifest.thresholds.validContextRateMin)) | \(pass(summary.validContextRate >= manifest.thresholds.validContextRateMin)) |
        | Refusal / lecture | \(summary.refusalOrLectureCount) | ≤ \(manifest.thresholds.refusalOrLectureMaxCount) | \(pass(summary.refusalOrLectureCount <= manifest.thresholds.refusalOrLectureMaxCount)) |
        | Immediate-previous continuity | \(percent(summary.continuityRate)) | ≥ \(percent(manifest.thresholds.continuityRateMin)) | \(pass(summary.continuityRate >= manifest.thresholds.continuityRateMin)) |
        | Opposite-persona direction | \(percent(summary.personaDirectionRate)) | ≥ \(percent(manifest.thresholds.personaDirectionRateMin)) | \(pass(summary.personaDirectionRate >= manifest.thresholds.personaDirectionRateMin)) |
        | Expected error/protocol behavior | \(percent(summary.expectedProtocolRate)) | informational | — |

        ## Directionality review index

        Review these scores against the matching persona variant, accepted choices, and synthetic image in `Tests/Fixtures/Personality/manifest.json` before signing the release record.

        | Fixture | Variant | Step | Accepted-direction score |
        |---|---|---|---:|
        \(directionRows)

        Raw completions, persona text, and question text are intentionally absent from both this summary and JSONL results.
        """
    }

    private static func git(_ arguments: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func releaseVersion() -> String? {
        let file = repositoryRoot.appendingPathComponent("VERSION.env")
        guard let source = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        return source.split(separator: "\n").lazy.compactMap { line -> String? in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("APP_VERSION=") else { return nil }
            return trimmed.dropFirst("APP_VERSION=".count)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\"' \t"))
        }.first
    }

    private static var repositoryRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private static func evaluationOutputDirectory(fixtureRoot: URL) -> URL {
        let bundled = repositoryRoot.appendingPathComponent("Tests/Fixtures/Personality", isDirectory: true)
        if fixtureRoot.standardizedFileURL.path == bundled.standardizedFileURL.path {
            return repositoryRoot.appendingPathComponent(".eval-results/personality", isDirectory: true)
        }
        return fixtureRoot.appendingPathComponent(".eval-results", isDirectory: true)
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}
