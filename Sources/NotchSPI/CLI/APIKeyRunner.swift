import Foundation

/// Direct-API channel: when the user supplies their own API key, the capture is sent straight to
/// the chosen provider's endpoint (see `APIProvider`) instead of spawning the local CLI. Anthropic
/// speaks its own Messages API; every other provider uses the OpenAI-compatible Chat Completions
/// protocol, so `makeRequest` branches on `APIWireProtocol`, not on a vendor name. `CLIRunner` is
/// untouched and remains the path whenever no key is set, so the two modes coexist: key present →
/// direct API, key empty → CLI fallback (decided per capture in `NotchController.runTapped`).
enum APIKeyRunner {

    // MARK: - Request building (pure, testable)

    static let anthropicEndpoint = "https://api.anthropic.com/v1/messages"
    static let openAIEndpoint = "https://api.openai.com/v1/chat/completions"

    /// Fire-and-forget TLS warm-up of the provider endpoint while the screenshot is captured.
    /// An unauthenticated HEAD costs nothing server-side but leaves the HTTPS connection in
    /// URLSession's pool for the real streaming POST moments later.
    static func warmUp(endpoint: String) {
        guard let url = URL(string: endpoint) else { return }
        Task.detached(priority: .userInitiated) {
            var req = URLRequest(url: url)
            req.httpMethod = "HEAD"
            req.timeoutInterval = 10
            _ = try? await URLSession.shared.data(for: req)
        }
    }

    /// Build the streaming HTTP request for the chosen protocol/endpoint. The screenshot travels
    /// inline as base64 JPEG (ScreenCapture always writes JPEG), so no file paths leak to the vendor.
    /// Returns nil when `endpoint` is not a usable URL. It comes from a free-text settings field
    /// (设置 → 高级 → 自定义端点), so a stray space or a full-width character typed by an IME used
    /// to crash the app on the next hotkey press — this is user input, not a compile-time constant.
    static func makeRequest(
        proto: APIWireProtocol,
        endpoint: String,
        apiKey: String,
        model: String,
        prompt: CapturePrompt,
        imagesBase64: [String],
        disableThinking: Bool = false
    ) -> URLRequest? {
        guard let url = URL(string: endpoint), url.scheme != nil, url.host != nil else { return nil }
        let userText = Prompts.analyzeTaskText(prompt.task, imageCount: imagesBase64.count)
        var req = URLRequest(url: url)
        let body: [String: Any]
        if proto == .anthropic {
            req.setValue(apiKey, forHTTPHeaderField: "x-api-key")
            req.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
            var content: [[String: Any]] = imagesBase64.map {
                ["type": "image",
                 "source": ["type": "base64", "media_type": "image/jpeg", "data": $0]]
            }
            content.append(["type": "text", "text": userText])
            body = [
                "model": model,
                "max_tokens": 8192,
                "stream": true,
                "system": prompt.system,
                "messages": [[
                    "role": "user",
                    "content": content,
                ]],
            ]
        } else {
            req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
            var content: [[String: Any]] = [["type": "text", "text": userText]]
            content.append(contentsOf: imagesBase64.map {
                ["type": "image_url", "image_url": ["url": "data:image/jpeg;base64,\($0)"]]
            })
            var openAIBody: [String: Any] = [
                "model": model,
                "stream": true,
                "messages": [
                    ["role": "system", "content": prompt.system],
                    ["role": "user", "content": content],
                ],
            ]
            if disableThinking {
                openAIBody["thinking"] = ["type": "disabled"]
            }
            body = openAIBody
        }
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 120
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return req
    }

    // MARK: - SSE parsing (pure, testable)

    /// The JSON payload of an SSE `data:` line, or nil for non-data lines (`event:`, blanks).
    static func sseData(_ line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("data:") else { return nil }
        return String(trimmed.dropFirst(5)).trimmingCharacters(in: .whitespaces)
    }

    /// Text delta from one Anthropic Messages-API stream line (`content_block_delta` / `text_delta`).
    static func parseAnthropicDelta(_ line: String) -> String? {
        guard let obj = jsonObject(fromSSELine: line),
              obj["type"] as? String == "content_block_delta",
              let delta = obj["delta"] as? [String: Any],
              delta["type"] as? String == "text_delta",
              let text = delta["text"] as? String
        else { return nil }
        return text
    }

    /// Text delta from one OpenAI Chat Completions stream line (`choices[0].delta.content`).
    static func parseOpenAIDelta(_ line: String) -> String? {
        guard let payload = sseData(line), payload != "[DONE]" else { return nil }
        guard let data = payload.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = obj["choices"] as? [[String: Any]],
              let delta = choices.first?["delta"] as? [String: Any],
              let text = delta["content"] as? String, !text.isEmpty
        else { return nil }
        return text
    }

    static func parseDelta(proto: APIWireProtocol, line: String) -> String? {
        proto == .anthropic ? parseAnthropicDelta(line) : parseOpenAIDelta(line)
    }

    /// An in-stream error event (both vendors can emit `{"error": {...}}` mid-stream).
    static func parseStreamError(_ line: String) -> String? {
        guard let obj = jsonObject(fromSSELine: line),
              let err = obj["error"] as? [String: Any],
              let msg = err["message"] as? String
        else { return nil }
        return msg
    }

    /// Human-readable message from a non-200 response body.
    static func errorMessage(from data: Data, statusCode: Int) -> String {
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let err = obj["error"] as? [String: Any],
           let msg = err["message"] as? String {
            return L10n.t("API 错误（HTTP \(statusCode)）：\(msg)", "APIエラー（HTTP \(statusCode)）：\(msg)", "API error (HTTP \(statusCode)): \(msg)")
        }
        let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty
            ? L10n.t("API 错误（HTTP \(statusCode)）", "APIエラー（HTTP \(statusCode)）", "API error (HTTP \(statusCode))")
            : L10n.t("API 错误（HTTP \(statusCode)）：\(String(text.prefix(300)))", "APIエラー（HTTP \(statusCode)）：\(String(text.prefix(300)))", "API error (HTTP \(statusCode)): \(String(text.prefix(300)))")
    }

    private static func jsonObject(fromSSELine line: String) -> [String: Any]? {
        guard let payload = sseData(line), payload != "[DONE]",
              let data = payload.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return obj
    }

    // MARK: - Run (streaming)

    /// Stream the answer via the vendor API. Mirrors `CLIRunner.run`'s contract: `onDelta` /
    /// `onDone` fire on the main queue, and a request-level 120s timeout guards a stalled stream.
    static func run(
        proto: APIWireProtocol,
        endpoint: String,
        apiKey: String,
        model: String,
        disableThinking: Bool = false,
        imagePaths: [String],
        prompt: CapturePrompt,
        onDelta: @escaping (String) -> Void,
        onDone: @escaping (_ ok: Bool, _ stderr: String) -> Void
    ) {
        Task.detached(priority: .userInitiated) {
            // File read + base64 of multi-MB screenshots stays off the main thread.
            let imagesBase64 = imagePaths.compactMap {
                FileManager.default.contents(atPath: $0)?.base64EncodedString()
            }
            guard imagesBase64.count == imagePaths.count else {
                await MainActor.run { onDone(false, L10n.t("无法读取截图文件", "スクリーンショットを読み込めません", "Could not read the screenshot file")) }
                return
            }
            guard let request = makeRequest(
                proto: proto, endpoint: endpoint, apiKey: apiKey,
                model: model, prompt: prompt, imagesBase64: imagesBase64,
                disableThinking: disableThinking
            ) else {
                await MainActor.run {
                    onDone(false, L10n.t(
                        "接口地址无效，请在「设置 → 高级」中检查自定义端点。",
                        "エンドポイントURLが不正です。「設定 → 詳細」で確認してください。",
                        "That endpoint URL isn't valid — check the custom endpoint in Settings → Advanced."))
                }
                return
            }
            #if DEBUG
            print("[NotchSPI] direct API run \(model) → \(request.url?.host ?? "?")")
            #endif
            do {
                let (bytes, response) = try await URLSession.shared.bytes(for: request)
                guard let http = response as? HTTPURLResponse else {
                    await finish(onDone, ok: false, err: L10n.t("无效的服务器响应", "サーバー応答が不正です", "Invalid server response"))
                    return
                }
                if http.statusCode != 200 {
                    var body = Data()
                    for try await byte in bytes {
                        body.append(byte)
                        if body.count > 65_536 { break }
                    }
                    await finish(onDone, ok: false, err: errorMessage(from: body, statusCode: http.statusCode))
                    return
                }
                var streamError: String?
                for try await line in bytes.lines {
                    if let text = parseDelta(proto: proto, line: line) {
                        await MainActor.run { onDelta(text) }
                    } else if let err = parseStreamError(line) {
                        streamError = err
                        break
                    }
                }
                if let streamError {
                    await finish(onDone, ok: false, err: L10n.t("API 流式响应中断：\(streamError)", "APIストリームが中断：\(streamError)", "API stream interrupted: \(streamError)"))
                } else {
                    await finish(onDone, ok: true, err: "")
                }
            } catch {
                await finish(onDone, ok: false, err: "网络请求失败：\(error.localizedDescription)")
            }
        }
    }

    private static func finish(
        _ onDone: @escaping (Bool, String) -> Void, ok: Bool, err: String
    ) async {
        await MainActor.run { onDone(ok, err) }
    }
}
