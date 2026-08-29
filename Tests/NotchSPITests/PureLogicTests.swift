import XCTest
@testable import NotchSPI

/// Pin the UI language for the duration of `body`, restoring the user's setting afterwards.
/// L10n reads live UserDefaults, so language-sensitive assertions must not depend on the
/// machine running the tests.
func withLanguage(_ language: AppLanguage, _ body: () -> Void) {
    let saved = L10n.setting
    L10n.setting = language
    defer { L10n.setting = saved }
    body()
}

/// Unit tests for the app's pure, UI-free logic: GitHub-release version comparison and
/// system-prompt selection. These need no display, no AppKit windows, and no network.
final class UpdateCheckerVersionTests: XCTestCase {
    func testNormalizeStripsPrefixAndWhitespace() {
        XCTAssertEqual(UpdateChecker.normalize("v1.6"), "1.6")
        XCTAssertEqual(UpdateChecker.normalize(" V2.0 "), "2.0")
        XCTAssertEqual(UpdateChecker.normalize("1.5"), "1.5")
    }

    func testIsNewerIsNumericNotLexicographic() {
        XCTAssertTrue(UpdateChecker.isNewer("1.10", than: "1.9"))  // 10 > 9, not "1" vs "9"
        XCTAssertTrue(UpdateChecker.isNewer("2.0", than: "1.9"))
    }

    func testIsNewerTreatsMissingComponentsAsZero() {
        XCTAssertFalse(UpdateChecker.isNewer("1.5", than: "1.5.0"))
        XCTAssertTrue(UpdateChecker.isNewer("1.5.1", than: "1.5"))
    }

    func testIsNewerFalseForEqualOrOlder() {
        XCTAssertFalse(UpdateChecker.isNewer("1.6", than: "1.6"))
        XCTAssertFalse(UpdateChecker.isNewer("1.9", than: "1.10"))
    }

    func testUnbundledCurrentVersionMatchesVERSIONEnv() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let text = try String(contentsOf: root.appendingPathComponent("VERSION.env"), encoding: .utf8)
        var expected: String?
        for raw in text.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("APP_VERSION=") else { continue }
            expected = String(line.dropFirst("APP_VERSION=".count))
        }
        XCTAssertEqual(UpdateChecker.currentVersion, try XCTUnwrap(expected))
    }
}

final class PromptsSelectionTests: XCTestCase {
    func testBriefDepthReturnsBriefPrompt() {
        XCTAssertEqual(Prompts.tutorText("brief"), Prompts.briefPrompt)
    }

    func testDepthClausesAreApplied() {
        XCTAssertTrue(Prompts.tutorText("full").contains("FULL WORKED SOLUTION"))
        XCTAssertTrue(Prompts.tutorText("hint").contains("HINTS ONLY"))
    }

    func testUnknownDepthFallsBackToGuided() {
        XCTAssertTrue(Prompts.tutorText("nonsense").contains("GUIDED WALKTHROUGH"))
    }

    func testCapturePromptRoutesByMode() {
        let persona = Prompts.capturePrompt(
            mode: "personality", depth: "guided",
            personaName: "A社", personaText: "creative and bold", sessionContext: "CTX")
        XCTAssertTrue(persona.system.contains("creative and bold"))
        XCTAssertTrue(persona.system.contains("A社"))
        XCTAssertTrue(persona.system.contains("CTX"))

        let tutor = Prompts.capturePrompt(
            mode: "tutor", depth: "brief", personaName: "", personaText: "", sessionContext: "IGNORED")
        XCTAssertEqual(tutor.system, Prompts.briefPrompt)
        XCTAssertFalse(tutor.system.contains("IGNORED"))
    }

    func testTaskInstructionDiffersByMode() {
        let personality = Prompts.capturePrompt(
            mode: "personality", depth: "guided", personaName: "n", personaText: "t", sessionContext: "c")
        let tutor = Prompts.capturePrompt(
            mode: "tutor", depth: "guided", personaName: "", personaText: "", sessionContext: "c")
        XCTAssertNotEqual(personality.task, tutor.task)
        XCTAssertTrue(tutor.task.contains("tutor"))
    }

    func testAnswerLanguageFallbackFollowsUILanguage() {
        // A Japanese user must never get a Chinese answer to a language-ambiguous screenshot.
        withLanguage(.ja) {
            XCTAssertTrue(Prompts.tutorText("guided").contains("respond in Japanese"))
            XCTAssertTrue(Prompts.tutorText("brief").contains("respond in Japanese"))
        }
        withLanguage(.zhHans) {
            XCTAssertTrue(Prompts.tutorText("full").contains("respond in Simplified Chinese"))
        }
        withLanguage(.en) {
            XCTAssertTrue(Prompts.briefPrompt.contains("respond in English"))
        }
    }
}

/// The direct-API channel's pure request-building and SSE-parsing logic. No network, no keychain.
final class APIKeyRunnerTests: XCTestCase {
    func testAnthropicRequestShape() throws {
        let req = try XCTUnwrap(APIKeyRunner.makeRequest(
            proto: .anthropic, endpoint: APIKeyRunner.anthropicEndpoint,
            apiKey: "sk-ant-test", model: "claude-opus-4-8",
            prompt: CapturePrompt(system: "SYS", task: "tutor me on the problem it shows."),
            imagesBase64: ["QUJD"]))
        XCTAssertEqual(req.url?.absoluteString, APIKeyRunner.anthropicEndpoint)
        XCTAssertEqual(req.value(forHTTPHeaderField: "x-api-key"), "sk-ant-test")
        XCTAssertEqual(req.value(forHTTPHeaderField: "anthropic-version"), "2023-06-01")
        let body = try! JSONSerialization.jsonObject(with: req.httpBody!) as! [String: Any]
        XCTAssertEqual(body["model"] as? String, "claude-opus-4-8")
        XCTAssertEqual(body["system"] as? String, "SYS")
        XCTAssertEqual(body["stream"] as? Bool, true)
    }

    func testOpenAIRequestShape() throws {
        let req = try XCTUnwrap(APIKeyRunner.makeRequest(
            proto: .openai, endpoint: APIKeyRunner.openAIEndpoint,
            apiKey: "sk-oai-test", model: "gpt-5",
            prompt: CapturePrompt(system: "SYS", task: "answer."), imagesBase64: ["QUJD"]))
        XCTAssertEqual(req.url?.absoluteString, APIKeyRunner.openAIEndpoint)
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer sk-oai-test")
        let body = try! JSONSerialization.jsonObject(with: req.httpBody!) as! [String: Any]
        XCTAssertEqual(body["model"] as? String, "gpt-5")
    }

    /// Any OpenAI-compatible provider works by pointing the same `.openai` path at its base URL —
    /// this is what makes the whole preset list (Gemini, Grok, Qwen, GLM, Kimi, OpenRouter, custom)
    /// possible without a per-vendor client.
    func testOpenAICompatibleCustomEndpoint() throws {
        let endpoint = "https://openrouter.ai/api/v1/chat/completions"
        let req = try XCTUnwrap(APIKeyRunner.makeRequest(
            proto: .openai, endpoint: endpoint,
            apiKey: "sk-or-test", model: "openai/gpt-4o",
            prompt: CapturePrompt(system: "SYS", task: "answer."), imagesBase64: ["QUJD"]))
        XCTAssertEqual(req.url?.absoluteString, endpoint)
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer sk-or-test")
    }

    /// The endpoint is free text from 设置 → 高级. A value URL(string:) rejects used to be force
    /// unwrapped, so a stray space or a full-width character typed by an IME crashed the app on
    /// the next hotkey press. Malformed input must produce nil and a guided error instead.
    func testMalformedCustomEndpointIsRejectedInsteadOfCrashing() {
        for bad in ["", "not a url", "https://exa mple.com/v1", "／／full-width", "v1/chat"] {
            XCTAssertNil(
                APIKeyRunner.makeRequest(
                    proto: .openai, endpoint: bad, apiKey: "k", model: "m",
                    prompt: CapturePrompt(system: "SYS", task: "answer."), imagesBase64: ["QUJD"]),
                "endpoint \(bad.debugDescription) must not build a request")
        }
    }

    func testAnthropicDeltaParsing() {
        let line = #"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}"#
        XCTAssertEqual(APIKeyRunner.parseDelta(proto: .anthropic, line: line), "你好")
        XCTAssertNil(APIKeyRunner.parseDelta(proto: .anthropic, line: "event: ping"))
        let stop = #"data: {"type":"message_stop"}"#
        XCTAssertNil(APIKeyRunner.parseDelta(proto: .anthropic, line: stop))
    }

    func testOpenAIDeltaParsing() {
        let line = #"data: {"choices":[{"delta":{"content":"hi"}}]}"#
        XCTAssertEqual(APIKeyRunner.parseDelta(proto: .openai, line: line), "hi")
        XCTAssertNil(APIKeyRunner.parseDelta(proto: .openai, line: "data: [DONE]"))
    }

    func testStreamErrorParsing() {
        let line = #"data: {"type":"error","error":{"type":"overloaded_error","message":"boom"}}"#
        XCTAssertEqual(APIKeyRunner.parseStreamError(line), "boom")
        XCTAssertNil(APIKeyRunner.parseStreamError(#"data: {"type":"content_block_delta"}"#))
    }

    func testErrorMessageFromBody() {
        let data = #"{"error":{"message":"invalid x-api-key"}}"#.data(using: .utf8)!
        XCTAssertTrue(APIKeyRunner.errorMessage(from: data, statusCode: 401).contains("invalid x-api-key"))
        XCTAssertTrue(APIKeyRunner.errorMessage(from: Data(), statusCode: 500).contains("500"))
    }
}

/// The third-party provider registry + custom-endpoint normalization.
final class APIProviderTests: XCTestCase {
    func testRegistryIntegrity() {
        // Anthropic is the only native-protocol provider; everyone else is OpenAI-compatible.
        let anthropic = APIProvider.byID("anthropic")
        XCTAssertEqual(anthropic.proto, .anthropic)
        XCTAssertEqual(anthropic.endpoint, APIKeyRunner.anthropicEndpoint)
        XCTAssertEqual(APIProvider.byID("openai").endpoint, APIKeyRunner.openAIEndpoint)
        for p in APIProvider.all where p.id != "anthropic" { XCTAssertEqual(p.proto, .openai) }

        // Legacy storage keys are preserved so pre-feature keys carry over.
        XCTAssertEqual(anthropic.storageKey, "claude")
        XCTAssertEqual(APIProvider.byID("openai").storageKey, "codex")

        // Storage keys unique; every preset (non-custom) ships a default model + console link.
        XCTAssertEqual(Set(APIProvider.all.map { $0.storageKey }).count, APIProvider.all.count)
        for p in APIProvider.all where !p.isCustom {
            XCTAssertFalse(p.defaultModel.isEmpty, "\(p.id) missing default model")
            XCTAssertNotNil(p.consoleURL, "\(p.id) missing console URL")
        }

        // Unknown id falls back to the first provider, never crashes.
        XCTAssertEqual(APIProvider.byID("nope").id, APIProvider.all[0].id)
    }

    func testCustomEndpointNormalization() {
        let s = Settings.shared
        let original = s.apiCustomBaseURL
        defer { s.apiCustomBaseURL = original }
        let custom = APIProvider.byID("custom")

        // Preset endpoints are used verbatim regardless of the custom base URL.
        XCTAssertEqual(s.endpoint(for: APIProvider.byID("grok")), "https://api.x.ai/v1/chat/completions")

        // A bare base gets the chat path appended (trailing slash tolerated).
        s.apiCustomBaseURL = "https://api.deepseek.com/v1/"
        XCTAssertEqual(s.endpoint(for: custom), "https://api.deepseek.com/v1/chat/completions")

        // A full endpoint is left as-is.
        s.apiCustomBaseURL = "https://host/openai/v1/chat/completions"
        XCTAssertEqual(s.endpoint(for: custom), "https://host/openai/v1/chat/completions")

        // Empty stays empty (the capture path guards on this).
        s.apiCustomBaseURL = ""
        XCTAssertEqual(s.endpoint(for: custom), "")
    }
}

/// Three-mode routing (official / customKey / cli) and the billing gate. The single most
/// important invariant: the billing interceptor can NEVER stop a custom-key or CLI capture.
final class ServiceRoutingTests: XCTestCase {
    func testResolveMatrixWhenCLIUnlocked() {
        XCTAssertEqual(ServiceRouting.resolve(mode: "official", customKey: "", cliAllowed: true), .official)
        XCTAssertEqual(ServiceRouting.resolve(mode: "official", customKey: "sk-x", cliAllowed: true), .official)
        XCTAssertEqual(ServiceRouting.resolve(mode: "cli", customKey: "sk-x", cliAllowed: true), .cli)
        XCTAssertEqual(ServiceRouting.resolve(mode: "customKey", customKey: "sk-x", cliAllowed: true), .customKey("sk-x"))
        // customKey mode without a key falls back to the CLI — the pre-official behavior.
        XCTAssertEqual(ServiceRouting.resolve(mode: "customKey", customKey: "   ", cliAllowed: true), .cli)
        // Unknown/corrupt mode strings resolve to the default.
        XCTAssertEqual(ServiceRouting.resolve(mode: "banana", customKey: "", cliAllowed: true), .official)
    }

    func testResolveMatrixWhenCLILocked() {
        // The retired CLI channel is unreachable until the per-device switch is flipped:
        // an explicit cli mode AND the empty-custom-key fallback both reroute to official.
        XCTAssertEqual(ServiceRouting.resolve(mode: "cli", customKey: "", cliAllowed: false), .official)
        XCTAssertEqual(ServiceRouting.resolve(mode: "cli", customKey: "sk-x", cliAllowed: false), .official)
        XCTAssertEqual(ServiceRouting.resolve(mode: "customKey", customKey: "   ", cliAllowed: false), .official)
        // A real custom key is unaffected by the switch.
        XCTAssertEqual(ServiceRouting.resolve(mode: "customKey", customKey: "sk-x", cliAllowed: false), .customKey("sk-x"))
        XCTAssertEqual(ServiceRouting.resolve(mode: "official", customKey: "", cliAllowed: false), .official)
    }

    func testQuotaGateNeverBlocksNonOfficialChannels() {
        // Even with the worst possible account state (no token, zero questions), custom-key
        // and CLI captures must pass through untouched.
        for balance in [nil, 0, -5] as [Int?] {
            XCTAssertEqual(
                QuotaGate.preflight(channel: .customKey("sk-x"), hasDeviceToken: false, balanceQuestions: balance),
                .allow)
            XCTAssertEqual(
                QuotaGate.preflight(channel: .cli, hasDeviceToken: false, balanceQuestions: balance),
                .allow)
        }
    }

    func testQuotaGateOfficialChannel() {
        // No device token → deny with guidance.
        if case .allow = QuotaGate.preflight(channel: .official, hasDeviceToken: false, balanceQuestions: nil) {
            XCTFail("un-registered official capture must be denied")
        }
        // Zero / negative quota → deny.
        if case .allow = QuotaGate.preflight(channel: .official, hasDeviceToken: true, balanceQuestions: 0) {
            XCTFail("zero quota must be denied")
        }
        // Positive quota → allow.
        XCTAssertEqual(QuotaGate.preflight(channel: .official, hasDeviceToken: true, balanceQuestions: 180), .allow)
        // Unknown quota → allow; the server (402) is the source of truth.
        XCTAssertEqual(QuotaGate.preflight(channel: .official, hasDeviceToken: true, balanceQuestions: nil), .allow)
    }

    func testDefaultModeMigration() {
        // Fresh installs land on the official service.
        XCTAssertEqual(ServiceRouting.defaultMode(isExistingInstall: false, hasCustomKey: false, cliAllowed: false), "official")
        XCTAssertEqual(ServiceRouting.defaultMode(isExistingInstall: false, hasCustomKey: true, cliAllowed: false), "official")
        // Existing installs with a key keep it — never silently rerouted.
        XCTAssertEqual(ServiceRouting.defaultMode(isExistingInstall: true, hasCustomKey: true, cliAllowed: false), "customKey")
        // Key-less existing installs used to default to the CLI; retired unless unlocked.
        XCTAssertEqual(ServiceRouting.defaultMode(isExistingInstall: true, hasCustomKey: false, cliAllowed: true), "cli")
        XCTAssertEqual(ServiceRouting.defaultMode(isExistingInstall: true, hasCustomKey: false, cliAllowed: false), "official")
    }

    func testHeaderLabels() {
        withLanguage(.zhHans) {
            XCTAssertEqual(ServiceRouting.headerLabel(
                channel: .official, cliBackend: "claude", customProviderName: "Claude"), "官方服务")
        }
        // Custom-key mode labels from the active provider name, so any vendor reads correctly.
        XCTAssertEqual(ServiceRouting.headerLabel(
            channel: .customKey("k"), cliBackend: "claude", customProviderName: "Google Gemini"), "Google Gemini · API")
        XCTAssertEqual(ServiceRouting.headerLabel(
            channel: .cli, cliBackend: "codex", customProviderName: "Claude"), "Codex")
    }
}

/// The official service's SSE protocol and account helpers.
final class OfficialAPITests: XCTestCase {
    func testStreamEventParsing() {
        XCTAssertEqual(
            OfficialAPI.parseStreamLine(#"data: {"type":"delta","text":"你好"}"#),
            .delta("你好"))
        XCTAssertEqual(
            OfficialAPI.parseStreamLine(#"data: {"type":"usage","input_tokens":120,"output_tokens":45,"questions_charged":1,"balance_questions":179}"#),
            .usage(inputTokens: 120, outputTokens: 45, questionsCharged: 1, balanceQuestions: 179))
        XCTAssertEqual(
            OfficialAPI.parseStreamLine(#"data: {"type":"error","error":{"message":"boom","code":"upstream_error"}}"#),
            .error(message: "boom", code: "upstream_error"))
        XCTAssertEqual(
            OfficialAPI.parseStreamLine(#"data: {"type":"error","error":{"message":"boom"}}"#),
            .error(message: "boom", code: nil))
        XCTAssertEqual(OfficialAPI.parseStreamLine("data: [DONE]"), .done)
        XCTAssertNil(OfficialAPI.parseStreamLine("event: ping"))
        XCTAssertNil(OfficialAPI.parseStreamLine(""))
    }

    func testLocalizedMessageMapsKnownCodesAndFallsBack() {
        withLanguage(.zhHans) {
            XCTAssertTrue(OfficialAPI.localizedMessage(code: "insufficient_quota", fallback: "x").contains("题数已用完"))
            XCTAssertTrue(OfficialAPI.localizedMessage(code: "invalid_token", fallback: "x").contains("凭证"))
        }
        withLanguage(.ja) {
            XCTAssertTrue(OfficialAPI.localizedMessage(code: "insufficient_quota", fallback: "x").contains("使い切りました"))
        }
        withLanguage(.en) {
            XCTAssertTrue(OfficialAPI.localizedMessage(code: "insufficient_quota", fallback: "x").contains("out of questions"))
        }
        // Unknown codes surface the server's own message untouched.
        XCTAssertEqual(OfficialAPI.localizedMessage(code: "weird_new_code", fallback: "server says"), "server says")
        XCTAssertEqual(OfficialAPI.localizedMessage(code: nil, fallback: "raw"), "raw")
    }

    func testTopUpURL() {
        let url = OfficialAPI.topUpURL(baseURL: "https://notchspi-api.vercel.app", deviceToken: "dev_123", lang: "ja")
        XCTAssertEqual(url?.absoluteString, "https://notchspi-api.vercel.app/topup?device=dev_123&lang=ja")
        // Without a token the lang still rides along (the page renders a token-less state).
        let bare = OfficialAPI.topUpURL(baseURL: "https://notchspi-api.vercel.app", deviceToken: nil, lang: "en")
        XCTAssertEqual(bare?.absoluteString, "https://notchspi-api.vercel.app/topup?lang=en")
    }

    func testEndpointURLIsCrashSafeAndPreservesBasePath() {
        // A path-bearing self-hosted base keeps its path segment.
        XCTAssertEqual(
            OfficialAPI.endpointURL(base: "https://host/api", path: "v1/devices").absoluteString,
            "https://host/api/v1/devices")
        // An unparseable override falls back to the production default instead of crashing.
        XCTAssertEqual(
            OfficialAPI.endpointURL(base: "", path: "v1/devices").absoluteString,
            "https://notchspi-api.vercel.app/v1/devices")
        // Leading slashes in the path don't clobber the base.
        XCTAssertEqual(
            OfficialAPI.endpointURL(base: "https://host/api", path: "/topup").absoluteString,
            "https://host/api/topup")
    }

    func testCaptureRequestShape() {
        let req = OfficialAPI.makeCaptureRequest(
            baseURL: "https://api.notchspi.app", deviceToken: "dev_123",
            prompt: CapturePrompt(system: "SYS", task: "tutor me."), imagesBase64: ["QUJD"])
        XCTAssertEqual(req.url?.absoluteString, "https://api.notchspi.app/v1/captures")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer dev_123")
        let body = try! JSONSerialization.jsonObject(with: req.httpBody!) as! [String: Any]
        XCTAssertEqual(body["system"] as? String, "SYS")
        XCTAssertEqual(body["stream"] as? Bool, true)
        XCTAssertEqual(body["image_media_type"] as? String, "image/jpeg")
        // Single image: legacy field only, so the wire shape is unchanged from pre-context builds.
        XCTAssertEqual(body["image_base64"] as? String, "QUJD")
        XCTAssertNil(body["images_base64"])
    }

    /// 上下文追问: both images travel in order (context first, fresh capture last), and the
    /// legacy single-image field carries the LAST image so an old server still answers the
    /// current question rather than the stale context.
    func testCaptureRequestTwoImageShape() {
        let req = OfficialAPI.makeCaptureRequest(
            baseURL: "https://api.notchspi.app", deviceToken: "dev_123",
            prompt: CapturePrompt(system: "SYS", task: Prompts.contextTask),
            imagesBase64: ["OLD", "NEW"])
        let body = try! JSONSerialization.jsonObject(with: req.httpBody!) as! [String: Any]
        XCTAssertEqual(body["images_base64"] as? [String], ["OLD", "NEW"])
        XCTAssertEqual(body["image_base64"] as? String, "NEW")
        XCTAssertEqual(body["task"] as? String,
                       Prompts.analyzeTaskText(Prompts.contextTask, imageCount: 2))
        XCTAssertTrue((body["task"] as? String)?.contains("2 attached screenshot images") == true)
    }
}

/// The CLI ↔ custom-key coexistence: labels and routing gates read from Settings.
final class ChannelRoutingTests: XCTestCase {
    func testLabelReflectsChannel() {
        // CLI-mode engine label. (Custom-key "· API" labels are covered by testHeaderLabels, which
        // now derives them from the active provider name rather than the CLI backend.)
        XCTAssertEqual(Settings.label(forCLI: "claude"), "Claude")
        XCTAssertEqual(Settings.label(forCLI: "codex"), "Codex")
    }

    func testCustomKeyGateAndModelDefault() {
        let s = Settings.shared
        let originalKey = s.apiKey(for: "claude")
        let originalModel = UserDefaults.standard.string(forKey: "apiModel.claude") ?? ""
        defer {
            s.setAPIKey(originalKey, for: "claude")
            UserDefaults.standard.set(originalModel, forKey: "apiModel.claude")
        }

        s.setAPIKey("  ", for: "claude") // whitespace only ⇒ still CLI mode
        XCTAssertFalse(s.usesCustomKey(for: "claude"))
        s.setAPIKey("sk-ant-xyz", for: "claude")
        XCTAssertTrue(s.usesCustomKey(for: "claude"))

        s.setAPIModel("", for: "claude") // empty ⇒ per-backend default
        XCTAssertEqual(s.apiModel(for: "claude"), Settings.defaultAPIModels["claude"])
        s.setAPIModel("claude-sonnet-5", for: "claude")
        XCTAssertEqual(s.apiModel(for: "claude"), "claude-sonnet-5")
    }
}

/// First-run bootstrap: the launch-order regression guard. PersonaStore's migration writes
/// persona keys during controller init, so the fresh/existing decision MUST be pinned before
/// that (bootstrapFirstRunState is the first line of app launch) — and once pinned, later
/// launch-time writes must not change the outcome.
final class FirstRunBootstrapTests: XCTestCase {
    private let keys = ["serviceMode", "onboardingDone", "cli", "depth", "captureKeyCode",
                        "apiKey.claude", "apiKey.codex", "personaName", "official.cliEnabled"]
    private let keychainAccounts = ["apiKey.claude", "apiKey.codex"]

    /// Run `body` against a clean slate of the involved defaults AND keychain items
    /// (a developer machine may hold real keys), restoring both afterwards.
    private func withCleanDefaults(_ body: () -> Void) {
        let d = UserDefaults.standard
        let saved = keys.map { ($0, d.object(forKey: $0)) }
        let savedSecrets = keychainAccounts.map { ($0, KeychainStore.read($0)) }
        keys.forEach { d.removeObject(forKey: $0) }
        keychainAccounts.forEach { KeychainStore.write(nil, account: $0) }
        defer {
            for (k, v) in saved {
                if let v { d.set(v, forKey: k) } else { d.removeObject(forKey: k) }
            }
            for (account, v) in savedSecrets { KeychainStore.write(v, account: account) }
        }
        body()
    }

    func testFreshInstallBootsToOfficialAndSurvivesLaunchWrites() {
        withCleanDefaults {
            Settings.shared.bootstrapFirstRunState()
            XCTAssertEqual(Settings.shared.serviceMode, "official")
            XCTAssertFalse(Settings.shared.onboardingDone)
            // Simulate PersonaStore's launch-time migration write; the pinned mode must hold.
            UserDefaults.standard.set("", forKey: "personaName")
            Settings.shared.bootstrapFirstRunState() // idempotent second call
            XCTAssertEqual(Settings.shared.serviceMode, "official")
            XCTAssertFalse(Settings.shared.onboardingDone)
        }
    }

    func testExistingKeylessInstallLandsOnOfficialWhileCLIIsLocked() {
        withCleanDefaults {
            UserDefaults.standard.set("guided", forKey: "depth") // pre-official footprint
            Settings.shared.bootstrapFirstRunState()
            // The CLI channel is retired: without the per-device switch, the old key-less
            // default reroutes to the official service (onboarding is still skipped).
            XCTAssertEqual(Settings.shared.serviceMode, "official")
            XCTAssertTrue(Settings.shared.onboardingDone)
        }
    }

    func testExistingKeylessInstallKeepsCLIWhenUnlocked() {
        withCleanDefaults {
            UserDefaults.standard.set("guided", forKey: "depth") // pre-official footprint
            UserDefaults.standard.set(true, forKey: "official.cliEnabled") // 设备码已开通
            Settings.shared.bootstrapFirstRunState()
            XCTAssertEqual(Settings.shared.serviceMode, "cli")
            XCTAssertTrue(Settings.shared.onboardingDone)
        }
    }

    func testExistingCustomKeyInstallKeepsCustomKey() {
        withCleanDefaults {
            UserDefaults.standard.set("codex", forKey: "cli")
            UserDefaults.standard.set("sk-test", forKey: "apiKey.codex")
            Settings.shared.bootstrapFirstRunState()
            XCTAssertEqual(Settings.shared.serviceMode, "customKey")
            XCTAssertTrue(Settings.shared.onboardingDone)
        }
    }

    func testTokenTruncationForDisplay() {
        XCTAssertEqual(OfficialAPI.truncatedToken("dev_1234567890abcdef"), "dev_1234…cdef")
        XCTAssertEqual(OfficialAPI.truncatedToken("short"), "short")
    }
}

/// The runtime-switchable localization layer: resolution rules and quota formatting.
final class L10nTests: XCTestCase {
    func testManualChoiceWinsOverSystemLanguages() {
        XCTAssertEqual(L10n.resolve(setting: .ja, preferred: ["zh-Hans-CN", "en"]), .ja)
        XCTAssertEqual(L10n.resolve(setting: .zhHans, preferred: ["en-US"]), .zh)
        XCTAssertEqual(L10n.resolve(setting: .en, preferred: ["ja-JP"]), .en)
    }

    func testAutoResolvesFirstSupportedSystemLanguage() {
        XCTAssertEqual(L10n.resolve(setting: .auto, preferred: ["zh-Hans-CN", "en-US"]), .zh)
        XCTAssertEqual(L10n.resolve(setting: .auto, preferred: ["zh-Hant-TW"]), .zh) // Traditional → zh for now
        XCTAssertEqual(L10n.resolve(setting: .auto, preferred: ["ja-JP", "en-US"]), .ja)
        XCTAssertEqual(L10n.resolve(setting: .auto, preferred: ["fr-FR", "ja-JP"]), .ja) // skip unsupported
        XCTAssertEqual(L10n.resolve(setting: .auto, preferred: ["fr-FR", "de-DE"]), .en) // default en
        XCTAssertEqual(L10n.resolve(setting: .auto, preferred: []), .en)
    }

    func testQuotaFormattingPerLanguage() {
        withLanguage(.zhHans) {
            XCTAssertEqual(L10n.questions(180), "180 题")
            XCTAssertEqual(L10n.questionsLeft(3), "剩余 3 题")
        }
        withLanguage(.ja) {
            XCTAssertEqual(L10n.questions(180), "180問")
            XCTAssertEqual(L10n.questionsLeft(3), "残り3問")
        }
        withLanguage(.en) {
            XCTAssertEqual(L10n.questions(180), "180 questions")
            XCTAssertEqual(L10n.questions(1), "1 question")
            XCTAssertEqual(L10n.questionsLeft(1), "1 question left")
            XCTAssertEqual(L10n.questionsLeft(3), "3 questions left")
        }
    }

    func testLanguageChangeInvalidatesCacheAndNotifies() {
        let saved = L10n.setting
        defer { L10n.setting = saved }
        var fired = false
        let observer = NotificationCenter.default.addObserver(
            forName: L10n.languageDidChange, object: nil, queue: nil) { _ in fired = true }
        defer { NotificationCenter.default.removeObserver(observer) }
        L10n.setting = .ja
        XCTAssertEqual(L10n.lang, .ja)
        L10n.setting = .en
        XCTAssertEqual(L10n.lang, .en)
        XCTAssertTrue(fired)
    }
}

/// The single-flight gate in front of anonymous device registration.
///
/// `POST /v1/devices` carries no idempotency key, so every concurrent registration used to mint a
/// SEPARATE server device row with its own free grant. Only the last one written to the Keychain
/// survived on the client; the rest became ghost rows — registered, funded, never used — which an
/// operator reads as "new devices that never asked a question". Onboarding alone had three entry
/// points that could overlap, and a cold serverless start widened the window to seconds.
///
/// Tested against the primitive rather than the network so it is deterministic and never touches
/// the real device token.
final class RegistrationGateTests: XCTestCase {
    /// Counts how many times the underlying registration body actually ran.
    private actor Calls {
        private(set) var count = 0
        func bump() { count += 1 }
    }

    func testConcurrentCallersShareOneRegistration() async {
        let gate = RegistrationGate()
        let calls = Calls()
        await withTaskGroup(of: String?.self) { group in
            for _ in 0..<8 {
                group.addTask {
                    let r = await gate.run {
                        await calls.bump()
                        // Hold the window open so every sibling arrives while this one is running.
                        try? await Task.sleep(nanoseconds: 60_000_000)
                        return .success("dev_shared")
                    }
                    return try? r.get()
                }
            }
            for await token in group {
                XCTAssertEqual(token, "dev_shared", "every caller must receive the shared result")
            }
        }
        let count = await calls.count
        XCTAssertEqual(count, 1, "8 concurrent callers must produce exactly ONE registration")
    }

    /// The gate collapses overlap only — it must not turn into a one-shot latch, or a device whose
    /// first attempt failed offline could never register again.
    func testASubsequentCallStartsAFreshAttempt() async {
        let gate = RegistrationGate()
        let calls = Calls()
        for _ in 0..<3 {
            _ = await gate.run {
                await calls.bump()
                return .failure(OfficialAPIError(message: "offline"))
            }
        }
        let count = await calls.count
        XCTAssertEqual(count, 3, "sequential retries must each make their own attempt")
    }
}

/// Keychain-backed secret storage and the one-time migration off plaintext UserDefaults.
final class KeychainStoreTests: XCTestCase {
    /// A write whose status was discarded used to let callers delete the value's only other copy
    /// on the assumption it had landed. The device token is the sole key to purchased quota, so
    /// the result is now the signal that deleting the plaintext copy is safe.
    func testWriteReportsWhetherTheKeychainAcceptedIt() {
        let account = "test.keychain.\(UUID().uuidString)"
        XCTAssertTrue(KeychainStore.write("secret-1", account: account), "a fresh add must report success")
        XCTAssertTrue(KeychainStore.write("secret-2", account: account), "an in-place update must report success")
        XCTAssertEqual(KeychainStore.read(account), "secret-2")
        XCTAssertTrue(KeychainStore.write(nil, account: account), "a delete must report success")
        XCTAssertTrue(KeychainStore.write(nil, account: account), "deleting an absent item is not a failure")
    }

    func testWriteReadDeleteRoundTrip() {
        let account = "test.keychain.\(UUID().uuidString)"
        XCTAssertNil(KeychainStore.read(account))
        KeychainStore.write("secret-1", account: account)
        XCTAssertEqual(KeychainStore.read(account), "secret-1")
        KeychainStore.write("secret-2", account: account) // upsert overwrites
        XCTAssertEqual(KeychainStore.read(account), "secret-2")
        KeychainStore.write(nil, account: account) // nil deletes
        XCTAssertNil(KeychainStore.read(account))
    }

    func testLegacyPlaintextAPIKeyMigratesToKeychain() {
        let account = "apiKey.claude"
        let d = UserDefaults.standard
        let savedSecret = KeychainStore.read(account)
        let savedDefault = d.object(forKey: account)
        defer {
            KeychainStore.write(savedSecret, account: account)
            if let savedDefault { d.set(savedDefault, forKey: account) } else { d.removeObject(forKey: account) }
        }

        KeychainStore.write(nil, account: account)
        d.set("sk-legacy", forKey: account) // pre-Keychain plaintext storage
        XCTAssertEqual(Settings.shared.apiKey(for: "claude"), "sk-legacy") // first read migrates
        XCTAssertNil(d.object(forKey: account), "plaintext copy must be removed after migration")
        XCTAssertEqual(KeychainStore.read(account), "sk-legacy")
    }
}

/// Pixel-exact placement of the notch slab against the physical cutout. These are the regression
/// tests for the "程序刘海与硬件刘海错位/穿帮" fix: independent point-rounding used to slide the
/// collapsed slab a physical pixel off the hardware notch wall. Ground-truth numbers below are a
/// real 14″ MacBook Pro (1512×982 @2×, notch 185pt wide, 32pt tall, side areas reported 663/664).
final class NotchGeometryTests: XCTestCase {
    private let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
    private let scale: CGFloat = 2
    private let notchW: CGFloat = 185
    private let notchH: CGFloat = 32
    private let sideExt: CGFloat = 60

    private var metrics: NotchGeometry.Metrics {
        .init(screenFrame: screen, scale: scale, notchWidth: notchW, notchHeight: notchH)
    }

    // The single fact the whole illusion rests on: the collapsed slab's RIGHT wall must coincide,
    // to the physical pixel, with the hardware notch's right wall. The pre-fix math rounded x to an
    // integer point (603.5 → 604), pushing this wall to 849pt (+1px). It must be 848.5pt exactly.
    func testCollapsedRightWallFusesWithHardwareNotch() {
        let f = NotchGeometry.collapsed(metrics, sideExtension: sideExt)
        let hardwareRightWall = screen.midX + notchW / 2 // 848.5pt — display-centered cutout
        XCTAssertEqual(f.maxX, hardwareRightWall, accuracy: 0.001,
                       "collapsed slab right wall must fuse with the hardware notch wall (no 穿帮)")
        // …and land on the backing-pixel grid so the wall is crisp, not a blurred half-pixel.
        XCTAssertEqual((f.maxX * scale).rounded(), f.maxX * scale, accuracy: 0.001)
    }

    // The slab's implied notch-region LEFT wall (right edge minus the notch width) must equally land
    // on the hardware left wall — the whole slab shares the cutout's axis, not the screen's.
    func testCollapsedNotchRegionSharesHardwareAxis() {
        let f = NotchGeometry.collapsed(metrics, sideExtension: sideExt)
        let notchLeftWall = f.maxX - notchW
        XCTAssertEqual(notchLeftWall, screen.midX - notchW / 2, accuracy: 0.001) // 663.5pt
    }

    // The top of the slab must sit exactly on the display's top edge, or a hairline seam opens at
    // the top of the cutout. Height-then-derive-y guarantees it regardless of fractional heights.
    func testTopEdgePinnedToDisplayTop() {
        let c = NotchGeometry.collapsed(metrics, sideExtension: sideExt)
        XCTAssertEqual(c.maxY, screen.maxY, accuracy: 0.001)
        // Fractional card height (from text measurement) must NOT let the top drift — the classic
        // round(y)+round(h) ≠ top bug. 87.3 + 28 margin is deliberately fraction-heavy.
        let e = NotchGeometry.expanded(metrics, cardWidth: 600, cardHeight: 87.3,
                                       marginH: 22, marginBottom: 28)
        XCTAssertEqual(e.maxY, screen.maxY, accuracy: 0.001)
    }

    // Collapsed and expanded must share ONE horizontal center (the notch axis), so the expand /
    // collapse morph rises straight out of the cutout instead of sliding sideways.
    func testCollapsedAndExpandedShareNotchCenter() {
        let notchCenter = screen.midX // 756
        let c = NotchGeometry.collapsed(metrics, sideExtension: sideExt)
        let e = NotchGeometry.expanded(metrics, cardWidth: 600, cardHeight: 120,
                                       marginH: 22, marginBottom: 28)
        // Collapsed panel is asymmetric (left extension for the rose), so its NOTCH region — not the
        // whole panel — is what must be centered: right wall minus half the notch width.
        XCTAssertEqual(c.maxX - notchW / 2, notchCenter, accuracy: 0.001)
        XCTAssertEqual(e.midX, notchCenter, accuracy: 0.001) // symmetric card is centered outright
    }

    // The expanded card keeps its exact requested width once the transparent shadow margins are
    // stripped, so the obsidian body is never off by a stray pixel.
    func testExpandedCardWidthPreservedInsideMargins() {
        let e = NotchGeometry.expanded(metrics, cardWidth: 600, cardHeight: 120,
                                       marginH: 22, marginBottom: 28)
        XCTAssertEqual(e.width - 22 * 2, 600, accuracy: 0.001)
    }

    func testPixelAlignSnapsToBackingGrid() {
        XCTAssertEqual(NotchGeometry.pixelAlign(603.5, scale: 2), 603.5, accuracy: 0.0001) // already on grid
        XCTAssertEqual(NotchGeometry.pixelAlign(603.3, scale: 2), 603.5, accuracy: 0.0001) // → nearest 0.5
        XCTAssertEqual(NotchGeometry.pixelAlign(603.1, scale: 2), 603.0, accuracy: 0.0001)
        XCTAssertEqual(NotchGeometry.pixelAlign(100.0, scale: 1), 100.0, accuracy: 0.0001)
        XCTAssertEqual(NotchGeometry.pixelAlign(100.4, scale: 1), 100.0, accuracy: 0.0001)
    }
}
