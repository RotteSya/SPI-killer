import Foundation

/// Error wrapper so `Result` can carry a user-facing message plus the server's machine-readable
/// error code (`String` itself doesn't conform to `Error`). Known codes are localized client-side
/// via `OfficialAPI.localizedMessage`; the server message is the fallback for unknown codes.
struct OfficialAPIError: Error, Equatable {
    let message: String
    let code: String?

    init(message: String, code: String? = nil) {
        self.message = message
        self.code = code
    }
}

/// Client for the NotchSPI 官方服务（题数额度制 — the account balance is a number of questions;
/// one successful capture costs one question). The server side holds the vendor API keys,
/// proxies the model call, meters per question, and deducts quota; this client only registers
/// an anonymous device (granting the 180-question trial), streams answers, and mirrors the
/// account state for the UI. The wire contract lives in docs/official-api.md.
///
/// This file is used ONLY by the `.official` service channel — the custom-key and CLI paths
/// (`APIKeyRunner`, `CLIRunner`) never touch it.
enum OfficialAPI {

    // MARK: - Configuration

    /// Production endpoint of the official service. Overridable via the "official.baseURL"
    /// default for staging/self-hosted deployments (no UI; `defaults write` only).
    static let defaultBaseURL = "https://notchspi-api.vercel.app"

    static var baseURL: String {
        var v = (UserDefaults.standard.string(forKey: "official.baseURL") ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        while v.hasSuffix("/") { v = String(v.dropLast()) } // avoid "https://host//v1/…"
        return v.isEmpty ? defaultBaseURL : v
    }

    /// Posted whenever quota / usage / registration state changes, so open panels refresh.
    static let accountDidChange = Notification.Name("OfficialAPI.accountDidChange")

    // MARK: - Local account state (UserDefaults-backed cache; the server is authoritative)

    private static var d: UserDefaults { .standard }

    /// Bearer credential for the official service — Keychain-backed. A token from the
    /// pre-Keychain plaintext storage migrates (and its UserDefaults copy is removed)
    /// on first read.
    static var deviceToken: String? {
        get {
            if let v = KeychainStore.read("official.deviceToken") { return v }
            let legacy = d.string(forKey: "official.deviceToken") ?? ""
            guard !legacy.isEmpty else { return nil }
            KeychainStore.write(legacy, account: "official.deviceToken")
            d.removeObject(forKey: "official.deviceToken")
            return legacy
        }
        set {
            KeychainStore.write(newValue, account: "official.deviceToken")
            d.removeObject(forKey: "official.deviceToken") // never leave a plaintext copy behind
            notifyAccountChanged()
        }
    }

    /// Last question balance reported by the server. nil = never synced.
    static var balanceQuestions: Int? {
        get { d.object(forKey: "official.balanceQuestions") as? Int }
        set {
            if let v = newValue { d.set(v, forKey: "official.balanceQuestions") }
            else { d.removeObject(forKey: "official.balanceQuestions") }
            notifyAccountChanged()
        }
    }

    /// Below this many remaining questions the UI starts nudging toward a top-up.
    static let lowQuotaThreshold = 10

    /// Per-device switch for the retired CLI channel, controlled server-side: the operator
    /// flips it in the admin console for a given 设备码, exactly like a manual quota grant.
    /// Mirrored locally on every account sync (the server is authoritative), so an unlocked
    /// device keeps its CLI access offline. Gates ServiceRouting (see `resolve(cliAllowed:)`)
    /// and the 设置 → 高级 channel picker.
    static var cliEnabled: Bool {
        get { d.bool(forKey: "official.cliEnabled") }
        set {
            if newValue { d.set(true, forKey: "official.cliEnabled") }
            else { d.removeObject(forKey: "official.cliEnabled") }
            notifyAccountChanged()
        }
    }

    /// True when the server last answered 401 for this device's token. We deliberately do NOT
    /// delete the token on a 401 (see `handleInvalidToken`): the token is the ONLY key to any
    /// purchased quota, and a spurious 401 — a mis-pointed `official.baseURL`, a transient server
    /// misconfiguration — must never silently strand a paying user's balance. Instead we raise
    /// this flag so 设置 →「账户与额度」can warn and offer an explicit, confirmed reset. Cleared on
    /// any successful register/refresh.
    static var credentialRejected: Bool {
        get { d.bool(forKey: "official.credentialRejected") }
        set {
            if newValue { d.set(true, forKey: "official.credentialRejected") }
            else { d.removeObject(forKey: "official.credentialRejected") }
        }
    }

    static var totalQuestions: Int { d.integer(forKey: "official.totalQuestions") }
    static var totalInputTokens: Int { d.integer(forKey: "official.totalInputTokens") }
    static var totalOutputTokens: Int { d.integer(forKey: "official.totalOutputTokens") }

    /// Fold one capture's metered usage into the local mirror (totals + quota snapshot).
    static func recordUsage(inputTokens: Int, outputTokens: Int, questionsCharged: Int, balanceQuestionsAfter: Int?) {
        d.set(totalQuestions + max(0, questionsCharged), forKey: "official.totalQuestions")
        d.set(totalInputTokens + max(0, inputTokens), forKey: "official.totalInputTokens")
        d.set(totalOutputTokens + max(0, outputTokens), forKey: "official.totalOutputTokens")
        if let b = balanceQuestionsAfter { d.set(b, forKey: "official.balanceQuestions") }
        notifyAccountChanged()
    }

    /// The server answered 401 for our device token. Do NOT delete the token here — a merely
    /// transient or mis-targeted 401 would otherwise orphan any purchased quota (the token is the
    /// only key to it). Keep the credential, drop just the cached balance so the UI stops showing
    /// a number nobody can spend, and flag the rejection so the account page can offer an explicit
    /// reset. `resetCredential()` is the ONLY path that actually discards the token.
    private static func handleInvalidToken() {
        d.removeObject(forKey: "official.balanceQuestions")
        credentialRejected = true
        notifyAccountChanged()
    }

    /// Explicit, user-confirmed credential reset (设置 →「账户与额度」). Discards the rejected device
    /// token and all cached account state so the next registration mints a fresh one. Behind a
    /// confirmation precisely because discarding a still-valid token would strand purchased quota.
    static func resetCredential() {
        KeychainStore.write(nil, account: "official.deviceToken")
        d.removeObject(forKey: "official.deviceToken") // clear any legacy plaintext copy too
        d.removeObject(forKey: "official.balanceQuestions")
        d.removeObject(forKey: "official.cliEnabled") // the switch belongs to the old 设备码
        credentialRejected = false
        notifyAccountChanged()
    }

    private static func notifyAccountChanged() {
        if Thread.isMainThread {
            NotificationCenter.default.post(name: accountDidChange, object: nil)
        } else {
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: accountDidChange, object: nil)
            }
        }
    }

    // MARK: - Localized service errors (pure, testable)

    /// Map a server error code to the user's language; unknown codes fall back to the server's
    /// own message. Known classes carry a way out with zero jargon.
    static func localizedMessage(code: String?, fallback: String) -> String {
        switch code {
        case "insufficient_quota":
            return L10n.t(
                "题数已用完，本次没有消耗额度。充值后即可继续使用。",
                "質問数を使い切りました(今回は消費されていません)。チャージすると続けられます。",
                "You're out of questions — this attempt wasn't charged. Top up to keep going.")
        case "invalid_token":
            return L10n.t(
                "本机的服务凭证已失效。请打开设置 →「账户与额度」重新领取（不影响已购买的题数）。",
                "このデバイスの認証情報が無効になりました。設定→「アカウントと残高」から再取得してください(購入済みの質問数には影響しません)。",
                "This device's service credential has expired. Re-initialize it in Settings → Account (your purchased questions are unaffected).")
        case "upstream_error":
            return L10n.t(
                "答案生成服务暂时出了点问题，本次没有消耗额度，请稍后重试。",
                "回答サービスに一時的な問題が発生しました(今回は消費されていません)。しばらくして再試行してください。",
                "The answering service hit a temporary problem — this attempt wasn't charged. Please try again shortly.")
        default:
            return fallback
        }
    }

    /// Guidance appended to unexpected official-service failures so novice users always have a
    /// way out (the advanced channels live in 设置 → 高级).
    static var fallbackHint: String {
        L10n.t(
            "\n\n如持续出现，可稍后重试，或在设置 →「高级」切换其他答题通道。",
            "\n\n続く場合はしばらくして再試行するか、設定→「詳細」で別のチャネルに切り替えられます。",
            "\n\nIf this keeps happening, try again later or switch channels in Settings → Advanced.")
    }

    // MARK: - Pure helpers (testable)

    /// The device token is a bearer credential — show just enough to identify it in support
    /// requests, never the whole thing (shoulder-surfing / third-party screenshot tools).
    static func truncatedToken(_ token: String) -> String {
        guard token.count > 14 else { return token }
        return "\(token.prefix(8))…\(token.suffix(4))"
    }

    /// Resolved endpoint under the configured base. Never force-unwraps user input: a
    /// hand-typed `official.baseURL` override that doesn't parse falls back to the production
    /// default instead of crashing. Path components are appended WITHOUT a leading slash so a
    /// path-bearing base ("https://host/api") is preserved.
    static func endpointURL(base: String, path: String) -> URL {
        let clean = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let url = URL(string: base) ?? URL(string: defaultBaseURL)! // default is a compile-time constant
        return url.appendingPathComponent(clean)
    }

    /// The web top-up page for this device. Appends to the base URL's path (same as the API
    /// endpoints) so self-hosted bases like "https://host/api" keep working. `lang` localizes
    /// the page to match the app.
    static func topUpURL(baseURL: String, deviceToken: String?, lang: String) -> URL? {
        var comps = URLComponents(url: endpointURL(base: baseURL, path: "topup"), resolvingAgainstBaseURL: false)
        var items: [URLQueryItem] = []
        if let t = deviceToken, !t.isEmpty {
            items.append(URLQueryItem(name: "device", value: t))
        }
        items.append(URLQueryItem(name: "lang", value: lang))
        comps?.queryItems = items
        return comps?.url
    }

    /// The current UI language as the top-up page's `lang` parameter.
    static var topUpLang: String {
        switch L10n.lang {
        case .zh: return "zh"
        case .ja: return "ja"
        case .en: return "en"
        }
    }

    /// One SSE line from the capture stream. The official service uses a small fixed event set.
    enum StreamEvent: Equatable {
        case delta(String)
        case usage(inputTokens: Int, outputTokens: Int, questionsCharged: Int, balanceQuestions: Int?)
        case error(message: String, code: String?)
        case done
    }

    static func parseStreamLine(_ line: String) -> StreamEvent? {
        guard let payload = APIKeyRunner.sseData(line) else { return nil }
        if payload == "[DONE]" { return .done }
        guard let data = payload.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        switch obj["type"] as? String {
        case "delta":
            guard let text = obj["text"] as? String else { return nil }
            return .delta(text)
        case "usage":
            return .usage(
                inputTokens: obj["input_tokens"] as? Int ?? 0,
                outputTokens: obj["output_tokens"] as? Int ?? 0,
                questionsCharged: obj["questions_charged"] as? Int ?? 0,
                balanceQuestions: obj["balance_questions"] as? Int
            )
        case "error":
            let err = obj["error"] as? [String: Any]
            let message = (err?["message"] as? String) ?? (obj["message"] as? String)
                ?? L10n.t("未知错误", "不明なエラー", "Unknown error")
            return .error(message: message, code: err?["code"] as? String)
        default:
            return nil
        }
    }

    /// Extract `{"error":{"message":…,"code":…}}` from a non-200 response body and localize it.
    static func localizedErrorBody(_ data: Data, statusCode: Int) -> String {
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let err = obj["error"] as? [String: Any] {
            let fallback = (err["message"] as? String) ?? "HTTP \(statusCode)"
            return localizedMessage(code: err["code"] as? String, fallback: fallback)
        }
        return APIKeyRunner.errorMessage(from: data, statusCode: statusCode)
    }

    /// This build's marketing version, or "dev" when running unbundled (`swift run`), where
    /// there is no Info.plist to read it from.
    static var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }

    /// Diagnostics carried on every authenticated request. Deliberately just two facts about
    /// THIS install — no identifiers beyond the device token the request already carries:
    ///   • the running build, so a device stops being reported forever as whatever version it
    ///     first registered on;
    ///   • whether onboarding was ever completed, which is what separates "quit during the
    ///     intro" from "finished it and then nothing happened" on a device with 0 questions.
    private static func addClientHeaders(_ req: inout URLRequest) {
        req.setValue(appVersion, forHTTPHeaderField: "X-App-Version")
        req.setValue(Settings.shared.onboardingDone ? "1" : "0", forHTTPHeaderField: "X-Onboarded")
    }

    static func makeRegisterRequest(baseURL: String, appVersion: String) -> URLRequest {
        var req = URLRequest(url: endpointURL(base: baseURL, path: "v1/devices"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 30
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "platform": "macos",
            "app_version": appVersion,
        ])
        return req
    }

    static func makeAccountRequest(baseURL: String, deviceToken: String) -> URLRequest {
        var req = URLRequest(url: endpointURL(base: baseURL, path: "v1/account"))
        req.setValue("Bearer \(deviceToken)", forHTTPHeaderField: "Authorization")
        addClientHeaders(&req)
        req.timeoutInterval = 30
        return req
    }

    static func makeCaptureRequest(
        baseURL: String, deviceToken: String,
        prompt: CapturePrompt, imageBase64: String
    ) -> URLRequest {
        var req = URLRequest(url: endpointURL(base: baseURL, path: "v1/captures"))
        req.httpMethod = "POST"
        req.setValue("Bearer \(deviceToken)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        addClientHeaders(&req)
        req.timeoutInterval = 120
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "system": prompt.system,
            "task": "Analyze the attached screenshot image, then \(prompt.task)",
            "image_base64": imageBase64,
            "image_media_type": "image/jpeg",
            "stream": true,
        ])
        return req
    }

    private static var cannotConnectMessage: String {
        L10n.t("无法连接服务，请检查网络后重试。",
               "サービスに接続できません。ネットワークを確認して再試行してください。",
               "Can't reach the service — check your connection and try again.")
    }

    // MARK: - Async operations

    /// Fire-and-forget network warm-up, called the moment the hotkey is pressed. While the
    /// screenshot is being taken this establishes DNS + TLS + HTTP/2 to the service and wakes
    /// the serverless function and its database, so the capture POST rides a hot path. The
    /// response is deliberately ignored — warming must never mutate account state.
    static func warmUp() {
        let base = baseURL
        let token = deviceToken
        Task.detached(priority: .userInitiated) {
            var req: URLRequest
            if let token {
                // /v1/account touches auth + DB, waking a suspended database as well. It also
                // doubles as the only record that the hotkey was pressed at all: this fires
                // before the screenshot and before the quota gate, so a press still registers
                // when the capture later fails. Without it, "never pressed" and "pressed and it
                // silently died" are the same empty row.
                req = makeAccountRequest(baseURL: base, deviceToken: token)
                req.setValue("hotkey", forHTTPHeaderField: "X-Client-Event")
            } else {
                req = URLRequest(url: endpointURL(base: base, path: "healthz"))
            }
            req.timeoutInterval = 10
            _ = try? await URLSession.shared.data(for: req)
        }
    }

    /// Anonymous device registration — the onboarding "开箱即用" step. Grants the free question
    /// quota server-side. Safe to call repeatedly: returns the existing token when already
    /// registered.
    @discardableResult
    static func registerIfNeeded() async -> Result<String, OfficialAPIError> {
        if let token = deviceToken { return .success(token) }
        let req = makeRegisterRequest(baseURL: baseURL, appVersion: appVersion)
        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = obj["device_token"] as? String, !token.isEmpty
            else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? -1
                return .failure(OfficialAPIError(message: localizedErrorBody(data, statusCode: code)))
            }
            deviceToken = token
            credentialRejected = false // a fresh, accepted token clears any prior rejection
            if let b = obj["balance_questions"] as? Int { balanceQuestions = b }
            return .success(token)
        } catch {
            return .failure(OfficialAPIError(message: cannotConnectMessage))
        }
    }

    /// Pull the authoritative quota + lifetime usage from the server.
    @discardableResult
    static func refreshAccount() async -> Result<Void, OfficialAPIError> {
        guard let token = deviceToken else {
            return .failure(OfficialAPIError(
                message: L10n.t("尚未领取额度", "まだ無料枠を受け取っていません", "Free questions not claimed yet")))
        }
        let req = makeAccountRequest(baseURL: baseURL, deviceToken: token)
        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            let code = (response as? HTTPURLResponse)?.statusCode ?? -1
            if code == 401 {
                handleInvalidToken()
                return .failure(OfficialAPIError(
                    message: localizedMessage(code: "invalid_token", fallback: ""), code: "invalid_token"))
            }
            guard code == 200,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                return .failure(OfficialAPIError(message: localizedErrorBody(data, statusCode: code)))
            }
            credentialRejected = false // the server accepted our token — clear any prior rejection
            if let b = obj["balance_questions"] as? Int { balanceQuestions = b }
            // Mirror the per-device CLI switch (absent in older server responses → leave as-is).
            if let cli = obj["cli_enabled"] as? Bool { cliEnabled = cli }
            // The server's lifetime totals are authoritative; overwrite the local mirror.
            if let tq = obj["total_questions"] as? Int { d.set(tq, forKey: "official.totalQuestions") }
            if let ti = obj["total_input_tokens"] as? Int { d.set(ti, forKey: "official.totalInputTokens") }
            if let to = obj["total_output_tokens"] as? Int { d.set(to, forKey: "official.totalOutputTokens") }
            notifyAccountChanged()
            return .success(())
        } catch {
            return .failure(OfficialAPIError(message: cannotConnectMessage))
        }
    }

    /// Stream one capture through the official service. Mirrors the other runners' contract:
    /// `onDelta` / `onDone` fire on the main queue. Metered usage from the stream's `usage`
    /// event updates the local quota mirror automatically.
    static func run(
        imagePath: String,
        prompt: CapturePrompt,
        onDelta: @escaping (String) -> Void,
        onDone: @escaping (_ ok: Bool, _ stderr: String) -> Void
    ) {
        guard let token = deviceToken else {
            DispatchQueue.main.async {
                onDone(false, L10n.t("服务尚未准备好，请稍后重试。",
                                     "サービスの準備ができていません。しばらくして再試行してください。",
                                     "The service isn't ready yet — please try again shortly."))
            }
            return
        }
        Task.detached(priority: .userInitiated) {
            // File read + base64 of a multi-MB screenshot stays off the main thread.
            guard let imageData = FileManager.default.contents(atPath: imagePath) else {
                await MainActor.run {
                    onDone(false, L10n.t("无法读取截图文件", "スクリーンショットを読み込めません", "Couldn't read the screenshot file"))
                }
                return
            }
            let request = makeCaptureRequest(
                baseURL: baseURL, deviceToken: token,
                prompt: prompt,
                imageBase64: imageData.base64EncodedString()
            )
            #if DEBUG
            print("[NotchSPI] official API run → \(request.url?.host ?? "?")")
            #endif
            do {
                let (bytes, response) = try await URLSession.shared.bytes(for: request)
                guard let http = response as? HTTPURLResponse else {
                    await MainActor.run {
                        onDone(false, L10n.t("无效的服务器响应", "サーバー応答が不正です", "Invalid server response"))
                    }
                    return
                }
                if http.statusCode != 200 {
                    var body = Data()
                    for try await byte in bytes {
                        body.append(byte)
                        if body.count > 65_536 { break }
                    }
                    switch http.statusCode {
                    case 402:
                        // The server said the quota is gone — mirror that so the quota gate
                        // blocks further official captures until a top-up.
                        balanceQuestions = 0
                        await MainActor.run {
                            onDone(false, localizedMessage(code: "insufficient_quota", fallback: ""))
                        }
                    case 401:
                        handleInvalidToken()
                        await MainActor.run {
                            onDone(false, localizedMessage(code: "invalid_token", fallback: ""))
                        }
                    default:
                        let msg = localizedErrorBody(body, statusCode: http.statusCode) + fallbackHint
                        await MainActor.run { onDone(false, msg) }
                    }
                    return
                }
                var streamError: String?
                for try await line in bytes.lines {
                    switch parseStreamLine(line) {
                    case .delta(let text):
                        await MainActor.run { onDelta(text) }
                    case .usage(let input, let output, let charged, let balanceAfter):
                        recordUsage(inputTokens: input, outputTokens: output,
                                    questionsCharged: charged, balanceQuestionsAfter: balanceAfter)
                    case .error(let message, let code):
                        streamError = localizedMessage(code: code, fallback: message)
                    case .done, .none:
                        break
                    }
                    if streamError != nil { break }
                }
                if let streamError {
                    await MainActor.run { onDone(false, streamError + fallbackHint) }
                } else {
                    await MainActor.run { onDone(true, "") }
                }
            } catch {
                await MainActor.run { onDone(false, cannotConnectMessage) }
            }
        }
    }
}
