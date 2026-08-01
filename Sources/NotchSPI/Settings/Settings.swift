import Foundation
import Carbon.HIToolbox

struct HotkeyCombo: Equatable {
    var keyCode: UInt32
    var modifiers: UInt32 // Carbon modifier mask (cmdKey, shiftKey, …)
    var label: String     // display label for the key, e.g. "1", "Space"
}

final class Settings {
    static let shared = Settings()
    private let d = UserDefaults.standard

    var cli: String {
        get { d.string(forKey: "cli") ?? "codex" }
        set { d.set(newValue, forKey: "cli") }
    }

    var depth: String {
        get { d.string(forKey: "depth") ?? "guided" }
        set { d.set(newValue, forKey: "depth") }
    }

    // MARK: - Mode (tutor ↔ personality test)

    /// "tutor" (default) or "personality".
    var mode: String {
        get { d.string(forKey: "mode") ?? "tutor" }
        set { d.set(newValue, forKey: "mode") }
    }

    /// User-chosen display name for the current target persona (人物像).
    var personaName: String {
        get { d.string(forKey: "personaName") ?? "" }
        set { d.set(newValue, forKey: "personaName") }
    }

    /// The desired persona / 人物像 description that personality-test answers should match.
    var personaText: String {
        get { d.string(forKey: "personaText") ?? "" }
        set { d.set(newValue, forKey: "personaText") }
    }

    // MARK: - Service mode (官方按量计费 / 自定义 Key / 本机 CLI)

    /// The user's chosen channel. Until explicitly set, the default is computed per install:
    /// fresh installs → official service (开箱即用); installs that predate the official service
    /// keep their old behavior (custom key if one is saved, otherwise CLI).
    var serviceMode: String {
        get {
            if let v = d.string(forKey: "serviceMode"), ServiceMode.all.contains(v) { return v }
            return ServiceRouting.defaultMode(
                isExistingInstall: isExistingInstall,
                hasCustomKey: usesCustomKey(for: cli),
                cliAllowed: OfficialAPI.cliEnabled
            )
        }
        set { d.set(newValue, forKey: "serviceMode") }
    }

    /// Any pre-official-service footprint in defaults means this install predates the feature.
    /// Only meaningful BEFORE launch-time subsystems run: PersonaStore's migration writes
    /// persona keys during controller init, which would make a fresh install look existing.
    /// That's why `bootstrapFirstRunState()` must be the first thing the app does.
    var isExistingInstall: Bool {
        ["cli", "depth", "captureKeyCode", "apiKey.claude", "apiKey.codex", "personaName"]
            .contains { d.object(forKey: $0) != nil }
    }

    /// One-time first-run bootstrap — call as the FIRST line of app launch, before any other
    /// subsystem touches UserDefaults. Pins `serviceMode` (fresh install → official; existing
    /// install → its previous behavior) and marks onboarding done for existing installs so an
    /// update never interrupts or reroutes a working setup. Idempotent: a no-op once
    /// `serviceMode` has been persisted.
    func bootstrapFirstRunState() {
        guard d.string(forKey: "serviceMode") == nil else { return }
        let existing = isExistingInstall
        serviceMode = ServiceRouting.defaultMode(
            isExistingInstall: existing,
            hasCustomKey: usesCustomKey(for: cli),
            cliAllowed: OfficialAPI.cliEnabled
        )
        if existing { onboardingDone = true }
    }

    /// Whether the first-launch onboarding has been shown (existing installs skip it silently).
    var onboardingDone: Bool {
        get { d.bool(forKey: "onboardingDone") }
        set { d.set(newValue, forKey: "onboardingDone") }
    }

    // MARK: - Custom API keys (direct-API mode)

    /// Active third-party provider id for 自定义 Key mode. Independent of `cli` (which stays the
    /// CLI-mode backend). Until explicitly set, it's migrated from the pre-provider layout where
    /// custom-key mode used `cli` (claude/codex) to pick between Anthropic and OpenAI.
    var apiProvider: String {
        get {
            if let v = d.string(forKey: "apiProvider"), APIProvider.all.contains(where: { $0.id == v }) {
                return v
            }
            return cli == "claude" ? "anthropic" : "openai"
        }
        set { d.set(newValue, forKey: "apiProvider") }
    }

    /// Resolved provider object for custom-key mode.
    var activeProvider: APIProvider { APIProvider.byID(apiProvider) }

    /// User-supplied base URL for the `custom` (OpenAI-compatible) provider. Normalized in
    /// `endpoint(for:)`.
    var apiCustomBaseURL: String {
        get { (d.string(forKey: "apiCustomBaseURL") ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
        set { d.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "apiCustomBaseURL") }
    }

    /// Streaming endpoint for a provider: the preset endpoint, or the normalized custom base URL.
    /// Custom accepts either a full endpoint or a bare base — the chat path is appended when absent.
    func endpoint(for provider: APIProvider) -> String {
        guard provider.isCustom else { return provider.endpoint }
        var base = apiCustomBaseURL
        if base.isEmpty { return "" }
        if base.hasSuffix("/") { base.removeLast() }
        if base.contains("/chat/completions") || base.hasSuffix("/messages") { return base }
        return base + "/chat/completions"
    }

    /// Default model per backend/provider when the user hasn't overridden it. Built from the
    /// provider registry so every preset (and the legacy "claude"/"codex" CLI backends) resolves.
    static let defaultAPIModels: [String: String] = {
        var m: [String: String] = [:]
        for p in APIProvider.all where !p.defaultModel.isEmpty { m[p.storageKey] = p.defaultModel }
        return m
    }()

    /// User-supplied API key for a backend ("claude" → Anthropic, "codex" → OpenAI).
    /// Non-empty ⇒ captures go straight to the vendor API; empty ⇒ fall back to the local CLI.
    /// Stored in the Keychain; a value from the pre-Keychain plaintext storage is migrated
    /// (and its UserDefaults copy removed) on first read.
    func apiKey(for cli: String) -> String {
        let account = "apiKey.\(cli)"
        if let v = KeychainStore.read(account) {
            return v.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let legacy = (d.string(forKey: account) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        // Remove the plaintext copy only on a confirmed Keychain write; a failed one would
        // otherwise silently discard a key the user has to go find and paste again.
        if !legacy.isEmpty, KeychainStore.write(legacy, account: account) {
            d.removeObject(forKey: account)
        }
        return legacy
    }

    func setAPIKey(_ key: String, for cli: String) {
        let account = "apiKey.\(cli)"
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if KeychainStore.write(trimmed, account: account) {
            d.removeObject(forKey: account) // never leave a plaintext copy behind
        } else if !trimmed.isEmpty {
            d.set(trimmed, forKey: account) // see OfficialAPI.deviceToken: recoverable > lost
        }
    }

    func usesCustomKey(for cli: String) -> Bool { !apiKey(for: cli).isEmpty }

    /// Model ID used in direct-API mode; falls back to the per-backend default when unset.
    func apiModel(for cli: String) -> String {
        let v = (d.string(forKey: "apiModel.\(cli)") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return v.isEmpty ? (Settings.defaultAPIModels[cli] ?? "") : v
    }

    func setAPIModel(_ model: String, for cli: String) {
        d.set(model.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "apiModel.\(cli)")
    }

    // MARK: - Capture target

    /// Bundle ID of the app whose window gets captured; nil = full screen.
    var captureTargetBundleID: String? {
        get {
            let v = d.string(forKey: "captureTargetBundleID")
            return (v?.isEmpty ?? true) ? nil : v
        }
        set { d.set(newValue ?? "", forKey: "captureTargetBundleID") }
    }

    /// Display name remembered for the picker UI (shown even when the app isn't running).
    var captureTargetName: String? {
        get { d.string(forKey: "captureTargetName") }
        set { d.set(newValue ?? "", forKey: "captureTargetName") }
    }

    var captureTarget: CaptureTarget {
        if let id = captureTargetBundleID { return .app(bundleID: id) }
        return .fullScreen
    }

    // MARK: - Auto mode

    /// Per-session question cap for 自动连答. Snapshotted when a session starts,
    /// so edits apply from the next session.
    var autoModeMaxQuestions: Int {
        get { AutoSessionEngine.clampMaxQuestions(d.integer(forKey: "autoMaxQuestions")) }
        set { d.set(AutoSessionEngine.clampMaxQuestions(newValue), forKey: "autoMaxQuestions") }
    }

    // MARK: - Hotkeys

    private static let defaultCapture = HotkeyCombo(keyCode: UInt32(kVK_ANSI_1), modifiers: UInt32(cmdKey | shiftKey), label: "1")
    // ⌘⇧2 was the personality combo until the 上下文追问 remap; personality moved to ⌘⇧3.
    // Users who explicitly recorded a combo keep their stored value (see `combo(_:_:)`).
    private static let defaultContext = HotkeyCombo(keyCode: UInt32(kVK_ANSI_2), modifiers: UInt32(cmdKey | shiftKey), label: "2")
    // ⌘⇧9, NOT ⌘⇧3: the 3–6 row is owned by the system screenshot shortcuts, which swallow
    // the event after RegisterEventHotKey "succeeds" (same invisible-by-design dead combo as
    // documented for auto mode below).
    private static let defaultPersonality = HotkeyCombo(keyCode: UInt32(kVK_ANSI_9), modifiers: UInt32(cmdKey | shiftKey), label: "9")
    private static let defaultToggle = HotkeyCombo(keyCode: UInt32(kVK_Space), modifiers: UInt32(cmdKey | shiftKey), label: "Space")
    // ⌘⇧0: the 3–6 row is owned by the system screenshot shortcuts, which swallow the
    // event after RegisterEventHotKey "succeeds" — an invisible-by-design dead combo.
    private static let defaultAutoMode = HotkeyCombo(keyCode: UInt32(kVK_ANSI_0), modifiers: UInt32(cmdKey | shiftKey), label: "0")

    /// Capture-and-tutor (学习辅导). Bound to its own hotkey so the mode is chosen by which key
    /// you press — no manual mode switching.
    var captureCombo: HotkeyCombo {
        get { combo("capture", Settings.defaultCapture) }
        set { setCombo("capture", newValue) }
    }
    /// Capture-and-ask WITH context (上下文追问): the new shot travels together with the last
    /// ⌘⇧1 shot (see `ScreenshotCacheManager`), so a question whose passage scrolled away can
    /// still be answered.
    var contextCombo: HotkeyCombo {
        get { combo("context", Settings.defaultContext) }
        set { setCombo("context", newValue) }
    }
    /// Capture-and-personality-test (性格测试作答). The mode for this capture, by hotkey.
    var personalityCombo: HotkeyCombo {
        get { combo("personality", Settings.defaultPersonality) }
        set { setCombo("personality", newValue) }
    }
    var toggleCombo: HotkeyCombo {
        get { combo("toggle", Settings.defaultToggle) }
        set { setCombo("toggle", newValue) }
    }
    /// Start/stop an auto session (连续自动截图作答) — one hotkey, toggle semantics.
    var autoModeCombo: HotkeyCombo {
        get { combo("autoMode", Settings.defaultAutoMode) }
        set { setCombo("autoMode", newValue) }
    }

    private func combo(_ prefix: String, _ def: HotkeyCombo) -> HotkeyCombo {
        guard d.object(forKey: "\(prefix)KeyCode") != nil else { return def }
        return HotkeyCombo(
            keyCode: UInt32(d.integer(forKey: "\(prefix)KeyCode")),
            modifiers: UInt32(d.integer(forKey: "\(prefix)Mods")),
            label: d.string(forKey: "\(prefix)Label") ?? def.label
        )
    }
    private func setCombo(_ prefix: String, _ c: HotkeyCombo) {
        d.set(Int(c.keyCode), forKey: "\(prefix)KeyCode")
        d.set(Int(c.modifiers), forKey: "\(prefix)Mods")
        d.set(c.label, forKey: "\(prefix)Label")
    }

    static func displayString(_ c: HotkeyCombo) -> String {
        var s = ""
        if c.modifiers & UInt32(controlKey) != 0 { s += "⌃" }
        if c.modifiers & UInt32(optionKey) != 0 { s += "⌥" }
        if c.modifiers & UInt32(shiftKey) != 0 { s += "⇧" }
        if c.modifiers & UInt32(cmdKey) != 0 { s += "⌘" }
        return s + c.label
    }

    // MARK: - Labels

    static func label(forCLI cli: String) -> String {
        cli == "claude" ? "Claude" : "Codex"
    }

    static let depthCycle = ["brief", "hint", "guided", "full"]
}
