import Foundation

/// Which wire protocol a third-party endpoint speaks. Anthropic has its own Messages API; every
/// other mainstream vendor we support exposes an OpenAI-compatible Chat Completions endpoint, so a
/// single `.openai` path (with a per-provider base URL) covers DeepSeek, OpenAI, Gemini, Grok,
/// Qwen, GLM, Kimi, OpenRouter and any user-supplied compatible endpoint.
enum APIWireProtocol {
    case anthropic
    case openai
}

/// A third-party API provider that 自定义 Key mode can target. Presets carry a fixed endpoint plus
/// a sensible default model; the `custom` entry lets the user paste any OpenAI-compatible base URL.
///
/// Every preset defaults to a VISION-capable model on purpose — captures are screenshots, so a
/// vendor's text-only default model cannot answer here.
struct APIProvider {
    let id: String            // stable id persisted in Settings.apiProvider
    let name: String          // display name (picker + notch header)
    let proto: APIWireProtocol
    /// Full streaming endpoint for presets; empty for `custom` (the user supplies a base URL).
    let endpoint: String
    let defaultModel: String
    /// Keychain / UserDefaults suffix: `apiKey.<storageKey>`, `apiModel.<storageKey>`. Anthropic
    /// and OpenAI reuse the legacy "claude"/"codex" suffixes so keys saved before this feature
    /// carry over untouched.
    let storageKey: String
    let keyPlaceholder: String
    let consoleURL: String?   // "获取 Key" deep link, nil for custom
    let disablesThinking: Bool

    init(
        id: String,
        name: String,
        proto: APIWireProtocol,
        endpoint: String,
        defaultModel: String,
        storageKey: String,
        keyPlaceholder: String,
        consoleURL: String?,
        disablesThinking: Bool = false
    ) {
        self.id = id
        self.name = name
        self.proto = proto
        self.endpoint = endpoint
        self.defaultModel = defaultModel
        self.storageKey = storageKey
        self.keyPlaceholder = keyPlaceholder
        self.consoleURL = consoleURL
        self.disablesThinking = disablesThinking
    }

    var isCustom: Bool { id == "custom" }

    /// The order here is the picker order. Anthropic + OpenAI first (also the migration targets),
    /// then the rest of the mainstream vision-capable vendors, then the custom escape hatch.
    static let all: [APIProvider] = [
        APIProvider(id: "anthropic", name: "Claude", proto: .anthropic,
                    endpoint: APIKeyRunner.anthropicEndpoint, defaultModel: "claude-opus-4-8",
                    storageKey: "claude", keyPlaceholder: "sk-ant-…",
                    consoleURL: "https://console.anthropic.com/settings/keys"),
        APIProvider(id: "deepseek", name: "DeepSeek", proto: .openai,
                    endpoint: "https://api.deepseek.com/chat/completions",
                    defaultModel: "deepseek-v4-flash-vision-exp", storageKey: "deepseek",
                    keyPlaceholder: "sk-…", consoleURL: "https://platform.deepseek.com/api_keys",
                    disablesThinking: true),
        APIProvider(id: "openai", name: "OpenAI", proto: .openai,
                    endpoint: APIKeyRunner.openAIEndpoint, defaultModel: "gpt-5",
                    storageKey: "codex", keyPlaceholder: "sk-…",
                    consoleURL: "https://platform.openai.com/api-keys"),
        APIProvider(id: "gemini", name: "Google Gemini", proto: .openai,
                    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
                    defaultModel: "gemini-2.5-flash", storageKey: "gemini", keyPlaceholder: "AIza…",
                    consoleURL: "https://aistudio.google.com/app/apikey"),
        APIProvider(id: "grok", name: "xAI Grok", proto: .openai,
                    endpoint: "https://api.x.ai/v1/chat/completions",
                    defaultModel: "grok-4", storageKey: "grok", keyPlaceholder: "xai-…",
                    consoleURL: "https://console.x.ai"),
        APIProvider(id: "qwen", name: "通义千问 Qwen", proto: .openai,
                    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
                    defaultModel: "qwen-vl-max", storageKey: "qwen", keyPlaceholder: "sk-…",
                    consoleURL: "https://bailian.console.aliyun.com/"),
        APIProvider(id: "zhipu", name: "智谱 GLM", proto: .openai,
                    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
                    defaultModel: "glm-4v", storageKey: "zhipu", keyPlaceholder: "…",
                    consoleURL: "https://open.bigmodel.cn/usercenter/apikeys"),
        APIProvider(id: "moonshot", name: "月之暗面 Kimi", proto: .openai,
                    endpoint: "https://api.moonshot.cn/v1/chat/completions",
                    defaultModel: "moonshot-v1-8k-vision-preview", storageKey: "moonshot",
                    keyPlaceholder: "sk-…", consoleURL: "https://platform.moonshot.cn/console/api-keys"),
        APIProvider(id: "openrouter", name: "OpenRouter", proto: .openai,
                    endpoint: "https://openrouter.ai/api/v1/chat/completions",
                    defaultModel: "openai/gpt-4o", storageKey: "openrouter", keyPlaceholder: "sk-or-…",
                    consoleURL: "https://openrouter.ai/keys"),
        // Escape hatch: any OpenAI-compatible endpoint. The user fills in Base URL + model name.
        APIProvider(id: "custom", name: "Custom", proto: .openai,
                    endpoint: "", defaultModel: "",
                    storageKey: "custom", keyPlaceholder: "sk-…", consoleURL: nil),
    ]

    static func byID(_ id: String) -> APIProvider {
        all.first { $0.id == id } ?? all[0]
    }
}
