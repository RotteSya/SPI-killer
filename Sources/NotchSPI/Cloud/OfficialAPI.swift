import Foundation
import Security

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

/// Collapses overlapping device registrations into a single network round trip.
///
/// `registerIfNeeded()` is a check-then-act sequence: it reads `deviceToken`, and only seconds
/// later — after a full HTTP round trip — writes it back. Onboarding alone has three entry points
/// that can occupy that window at once (the window's `loadView`, the gift page appearing, and the
/// "registration still in flight" retry branch), and a cold serverless start widens it to seconds.
/// Before the registration retry credential existed, every overlapping call minted a SEPARATE
/// server device row with its OWN free grant. Only the last write survived on the client; the rest
/// became ghosts — registered, funded, and never used — which is what an operator reads as
/// "new devices that never asked a question".
///
/// Callers that arrive while a registration is running now await that same attempt instead of
/// starting another.
actor RegistrationGate {
    static let shared = RegistrationGate()
    private var inFlight: Task<Result<String, OfficialAPIError>, Never>?

    func run(
        _ body: @escaping @Sendable () async -> Result<String, OfficialAPIError>
    ) async -> Result<String, OfficialAPIError> {
        if let existing = inFlight { return await existing.value }
        let task = Task(operation: body)
        inFlight = task
        let result = await task.value
        // Clear only our own task: a follower resuming later must not wipe out a newer attempt.
        if inFlight == task { inFlight = nil }
        return result
    }
}

/// Client for the NotchSPI 官方服务（题数额度制 — the account balance is a number of questions;
/// one successful capture costs one question). The server side holds the vendor API keys,
/// proxies the model call, meters per question, and deducts quota; this client only registers
/// an anonymous device (the fixed grant is read from the register response), streams answers, and
/// mirrors the account state for the UI. The wire contract lives in docs/official-api.md.
///
/// This file is used ONLY by the `.official` service channel — the custom-key and CLI paths
/// (`APIKeyRunner`, `CLIRunner`) never touch it.
enum OfficialAPI {

    struct CaptureAccount: Equatable {
        let token: String
        let baseURL: String
        let generation: UInt64
        init(token: String, baseURL: String, generation: UInt64 = 0) {
            self.token = token; self.baseURL = baseURL; self.generation = generation
        }
    }

    static let accountState = OfficialAccountState(onChange: { notifyAccountChanged() })
    struct AccountEnvironment {
        let state: OfficialAccountState
        let session: URLSession
        static var live: Self { .init(state: accountState, session: .shared) }
    }

    /// Explicit network/account dependencies keep each capture bound to its initiating
    /// account. All observable callbacks are applied on the main actor after revalidation.
    struct CaptureEnvironment {
        let session: URLSession
        let account: () -> CaptureAccount?
        let receiveUsage: @MainActor (OfficialUsageReceipt) -> Void
        let receiveSettlement: @MainActor (SettlementSnapshot) -> Void
        let rejectCredential: @MainActor () -> Void

        static var live: Self { connected(to: .live) }

        static func connected(to environment: AccountEnvironment, expectedAccount: CaptureAccount? = nil) -> Self {
            let state = environment.state
            let owner = expectedAccount ?? state.account
            let receive: @MainActor (Int, String?, OfficialAccountTotals?) -> Void = { balance, version, totals in
                guard let owner else { return }
                state.applyBalance(balance, version: version, totals: totals, account: owner)
                // An older server's per-call usage cannot tell whether an account refresh
                // already included this capture. Resolve its lifetime counters by account GET.
                if totals == nil, state.matches(owner) {
                    Task { await refreshAccount(environment: environment, expectedAccount: owner) }
                }
            }
            return .init(session: environment.session, account: {
                guard let owner, state.matches(owner) else { return nil }
                return owner
            }, receiveUsage: { value in
                receive(value.balanceQuestions, value.balanceVersion, value.accountTotals)
            }, receiveSettlement: { status in
                receive(status.balanceQuestions, status.balanceVersion, status.accountTotals)
            }, rejectCredential: {
                if let owner { state.rejectCredential(for: owner) }
            })
        }
    }

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

    /// The original credential namespace is preserved. Unavailable Keychain reads never
    /// authorize registration; a failed explicit reset leaves the current device recoverable.
    static var deviceToken: String? {
        get { accountState.token }
        set { accountState.replaceCredential(newValue) }
    }
    static var balanceQuestions: Int? {
        get { accountState.value("balanceQuestions") as? Int }
        set { accountState.setValue(newValue, for: "balanceQuestions") }
    }
    static let lowQuotaThreshold = 10
    static var cliEnabled: Bool {
        get { accountState.value("cliEnabled") as? Bool ?? false }
        set { accountState.setValue(newValue ? true : nil, for: "cliEnabled") }
    }
    static var credentialRejected: Bool {
        get { accountState.value("credentialRejected") as? Bool ?? false }
        set { accountState.setValue(newValue ? true : nil, for: "credentialRejected") }
    }
    static var totalQuestions: Int { accountState.value("totalQuestions") as? Int ?? 0 }
    static var totalInputTokens: Int { accountState.value("totalInputTokens") as? Int ?? 0 }
    static var totalOutputTokens: Int { accountState.value("totalOutputTokens") as? Int ?? 0 }

    static func accumulateUsage(_ current: Int, _ amount: Int) -> Int {
        let (value, overflow) = max(0, current).addingReportingOverflow(max(0, amount))
        return overflow ? Int.max : value
    }
    @discardableResult
    static func applyBalance(_ balance: Int, version: String?) -> Bool {
        accountState.applyBalance(balance, version: version)
    }
    @discardableResult
    static func resetCredential() -> Bool { accountState.resetCredential() }

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
        case "payload_too_large":
            return captureTooLargeMessage
        case "insufficient_quota":
            return L10n.t(
                "题数已用完，本次没有消耗额度。充值后即可继续使用。",
                "質問数を使い切りました(今回は消費されていません)。チャージすると続けられます。",
                "You're out of questions — this attempt wasn't charged. Top up to keep going.")
        case "invalid_token":
            return L10n.t(
                "服务暂时未接受本机凭证。凭证已保留，请在账户页重试或联系支持。",
                "認証情報は保持されています。アカウント画面から再試行するか、サポートにお問い合わせください。",
                "The service did not accept this device credential. It has been preserved. Retry in Account or contact support.")
        case "upstream_error":
            return L10n.t(
                "答案生成服务暂时出了点问题。请核对本次额度后重试。",
                "回答サービスに一時的な問題が発生しました。残高を確認してから再試行してください。",
                "The answering service hit a temporary problem. Check this request's quota before trying again.")
        case "invalid_image":
            return L10n.t("图片格式、尺寸或完整性无效，请重新截图。", "画像の形式・サイズ・内容を確認できません。撮り直してください。", "The image format, size or contents could not be validated. Take a new screenshot.")
        case "rate_limited":
            return L10n.t("当前请求较多，请稍后重试。", "処理が混み合っています。少し待って再試行してください。", "The service is busy. Please try again shortly.")
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

    struct PurchaseSessionResponse: Decodable {
        let purchaseURL: URL
        let expiresAt: Date?
        var account: CaptureAccount?
        func belongs(to state: OfficialAccountState = accountState) -> Bool {
            account.map(state.matches) ?? false
        }
        enum CodingKeys: String, CodingKey { case purchaseURL = "purchase_url", expiresAt = "expires_at" }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            purchaseURL = try c.decode(URL.self, forKey: .purchaseURL)
            if let value = try? c.decode(String.self, forKey: .expiresAt) { expiresAt = ISO8601DateFormatter().date(from: value) } else { expiresAt = nil }
        }
    }

    /// Opens the short-lived purchase handoff. The device bearer is sent only in this
    /// authenticated request; the returned browser URL contains an expiring session secret.
    static func createPurchaseSession(packID: String, catalogVersion: String,
                                      purchaseID: UUID = UUID(), environment: AccountEnvironment = .live) async throws -> PurchaseSessionResponse {
        try Task.checkCancellation()
        let account = try environment.state.prepareRefresh().account
        var request = URLRequest(url: endpointURL(base: account.baseURL, path: "v1/purchase-sessions"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(account.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        addClientHeaders(&request)
        request.timeoutInterval = 20
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "pack_id": packID, "catalog_version": catalogVersion,
            "purchase_id": purchaseID.uuidString.lowercased(), "lang": topUpLang,
        ])
        let (code, data) = try await readAccountHTTP(request, session: environment.session)
        return try await MainActor.run {
            try Task.checkCancellation()
            guard environment.state.matches(account) else { throw accountError(OfficialAccountFailure.changed) }
            guard (200..<300).contains(code) else {
                throw OfficialAPIError(message: localizedErrorBody(data, statusCode: code))
            }
            var result = try JSONDecoder().decode(PurchaseSessionResponse.self, from: data)
            guard ["https", "http"].contains(result.purchaseURL.scheme?.lowercased() ?? ""),
                  result.purchaseURL.host?.isEmpty == false, result.purchaseURL.user == nil, result.purchaseURL.password == nil else {
                throw OfficialAccountFailure.invalidResponse
            }
            result.account = account
            return result
        }
    }

    /// Extract `{"error":{"message":…,"code":…}}` from a non-200 response body and localize it.
    static func localizedErrorBody(_ data: Data, statusCode: Int) -> String {
        // The platform can reject before our JSON error handler runs.
        if statusCode == 413 { return captureTooLargeMessage }
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

    static func makeRegisterRequest(baseURL: String, appVersion: String, registrationAttemptID: String? = nil) -> URLRequest {
        var req = URLRequest(url: endpointURL(base: baseURL, path: "v1/devices"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 30
        var payload = ["platform": "macos", "app_version": appVersion]
        if let registrationAttemptID { payload["registration_attempt_id"] = registrationAttemptID }
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        return req
    }

    static func makeAccountRequest(baseURL: String, deviceToken: String) -> URLRequest {
        var req = URLRequest(url: endpointURL(base: baseURL, path: "v1/account"))
        req.setValue("Bearer \(deviceToken)", forHTTPHeaderField: "Authorization")
        addClientHeaders(&req)
        req.timeoutInterval = 30
        return req
    }

    /// `imagesBase64` order is meaningful: context shot(s) first, the fresh capture last.
    /// `image_base64` always carries the LAST image so a server that predates `images_base64`
    /// still answers the current question (degraded to context-less, never wrong-image).
    static func makeCaptureRequest(
        baseURL: String, deviceToken: String,
        prompt: CapturePrompt, imagesBase64: [String],
        resultProtocol: String? = nil, captureID: UUID? = nil, screenQuery: ScreenQueryRequest? = nil
    ) -> URLRequest {
        var req = URLRequest(url: endpointURL(base: baseURL, path: "v1/captures"))
        req.httpMethod = "POST"
        req.setValue("Bearer \(deviceToken)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        addClientHeaders(&req)
        req.timeoutInterval = 110
        var payload: [String: Any] = [
            "system": prompt.system,
            "task": Prompts.analyzeTaskText(prompt.task, imageCount: imagesBase64.count),
            "image_base64": imagesBase64.last ?? "",
            "image_media_type": "image/jpeg",
            "stream": true,
        ]
        if imagesBase64.count > 1 { payload["images_base64"] = imagesBase64 }
        if let resultProtocol { payload["result_protocol"] = resultProtocol }
        if let captureID { payload["capture_id"] = captureID.uuidString.lowercased() }
        if let screenQuery { payload.merge(screenQuery.fields(imageCount: imagesBase64.count)) { _, new in new } }
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload, options: [.withoutEscapingSlashes])
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
        Task { @MainActor in ClientConfigService.shared.refresh() }
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
    static func registerIfNeeded(environment: AccountEnvironment = .live) async -> Result<String, OfficialAPIError> {
        guard !Task.isCancelled else { return .failure(accountError(OfficialAccountFailure.changed)) }
        return await environment.state.registrationGate.run {
            do {
                let preparation = try environment.state.prepareRegistration()
                switch preparation {
                case .existing(let token): return .success(token)
                case .request(let ticket):
                    let request = makeRegisterRequest(baseURL: ticket.baseURL, appVersion: appVersion,
                                                      registrationAttemptID: ticket.attempt)
                    let (code, data) = try await readAccountHTTP(request, session: environment.session)
                    guard code == 200 else { return .failure(OfficialAPIError(message: localizedErrorBody(data, statusCode: code))) }
                    let value = try JSONDecoder().decode(OfficialAccountResponse.self, from: data)
                    return try await MainActor.run {
                        try Task.checkCancellation()
                        return .success(try environment.state.acceptRegistration(value, ticket: ticket))
                    }
                }
            } catch { return .failure(accountError(error)) }
        }
    }

    /// Quota, CLI permission and totals are committed together only to the initiating device
    /// and service. An older refresh cannot undo a newer account read or balance version.
    @discardableResult
    static func refreshAccount(environment: AccountEnvironment = .live,
                               expectedAccount: CaptureAccount? = nil) async -> Result<Void, OfficialAPIError> {
        do {
            try Task.checkCancellation()
            let ticket = try environment.state.prepareRefresh()
            guard expectedAccount == nil || expectedAccount == ticket.account else { throw OfficialAccountFailure.changed }
            let request = makeAccountRequest(baseURL: ticket.account.baseURL, deviceToken: ticket.account.token)
            let (code, data) = try await readAccountHTTP(request, session: environment.session)
            return try await MainActor.run {
                try Task.checkCancellation()
                guard environment.state.matches(ticket.account) else { throw OfficialAccountFailure.changed }
                if code == 401 {
                    environment.state.rejectCredential(for: ticket.account, refreshSequence: ticket.sequence)
                    return .failure(OfficialAPIError(message: localizedMessage(code: "invalid_token", fallback: ""), code: "invalid_token"))
                }
                guard code == 200 else { return .failure(OfficialAPIError(message: localizedErrorBody(data, statusCode: code))) }
                let value = try JSONDecoder().decode(OfficialAccountResponse.self, from: data)
                try environment.state.acceptRefresh(value, ticket: ticket)
                return .success(())
            }
        } catch { return .failure(accountError(error)) }
    }

    private static func accountError(_ error: Error) -> OfficialAPIError {
        switch error {
        case OfficialAccountFailure.credentialUnavailable:
            return .init(message: L10n.t("无法读取或保存服务凭证，请解锁钥匙串后重试。",
                "認証情報を読み書きできません。キーチェーンを解除して再試行してください。",
                "The service credential could not be read or saved. Unlock Keychain and retry."), code: "credential_unavailable")
        case OfficialAccountFailure.changed, is CancellationError:
            return .init(message: accountChangedMessage, code: "account_changed")
        case OfficialAccountFailure.missingCredential:
            return .init(message: L10n.t("尚未领取额度", "まだ無料枠を受け取っていません", "Free questions not claimed yet"))
        default: return .init(message: cannotConnectMessage)
        }
    }

    static var accountChangedMessage: String {
        L10n.t("账户或服务已变化，请刷新当前账户。", "アカウントまたは接続先が変わりました。更新してください。",
               "The account or service changed. Refresh the current account.")
    }

    /// Small JSON endpoints cannot grow an unbounded Data buffer or silently follow a redirect
    /// carrying a credential to another service. All early exits cancel the underlying task.
    static func readAccountHTTP(_ request: URLRequest, session: URLSession) async throws -> (Int, Data) {
        try Task.checkCancellation()
        var request = request
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (bytes, response) = try await session.bytes(for: request, delegate: AccountHTTPDelegate())
        defer { bytes.task.cancel() }
        guard let http = response as? HTTPURLResponse,
              http.value(forHTTPHeaderField: "Content-Type")?.split(separator: ";").first?
                .trimmingCharacters(in: .whitespaces).lowercased() == "application/json",
              response.expectedContentLength <= 65_536 else { throw OfficialAccountFailure.invalidResponse }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < 65_536 else { throw OfficialAccountFailure.invalidResponse }
            data.append(byte)
        }
        try Task.checkCancellation()
        return (http.statusCode, data)
    }

    private final class AccountHTTPDelegate: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    /// Stream one capture through the official service. Mirrors the other runners' contract:
    /// `onDelta` / `onDone` fire on the main queue. Metered usage from the stream's `usage`
    /// event updates the local quota mirror automatically.
    @discardableResult
    static func run(
        imagePaths: [String], prompt: CapturePrompt, resultProtocol: String? = nil,
        captureID: UUID? = nil, screenQuery: ScreenQueryRequest? = nil, auxiliary: AuxiliaryCaptureRequest? = nil,
        environment: CaptureEnvironment = .live,
        onUsage: ((OfficialUsageReceipt) -> Void)? = nil,
        onDelta: @escaping (String) -> Void,
        onDone: @escaping (_ ok: Bool, _ stderr: String) -> Void
    ) -> Task<Void, Never>? {
        guard let account = environment.account() else {
            DispatchQueue.main.async { onDone(false, cannotConnectMessage) }
            return nil
        }
        let token = account.token, base = account.baseURL
        let id = captureID ?? UUID()
        let operation = auxiliary?.operation ?? "solve"
        return Task.detached(priority: .userInitiated) {
            guard await MainActor.run(body: { !Task.isCancelled && environment.account() == account }) else {
                await MainActor.run { onDone(false, cannotConnectMessage) }; return
            }
            guard screenQuery == nil || resultProtocol == "objective_v1",
                  auxiliary == nil || (screenQuery != nil && ["explain", "recover"].contains(operation)),
                  auxiliary?.answerCaptureID == nil || operation == "explain" else {
                await MainActor.run { onDone(false, localizedMessage(code: "feature_disabled", fallback: cannotConnectMessage)) }; return
            }
            let imagesBase64: [String]
            do { imagesBase64 = try OfficialCaptureMaterials.load(imagePaths) }
            catch {
                let message = error as? OfficialCaptureMaterials.Failure == .tooLarge
                    ? captureTooLargeMessage
                    : L10n.t("无法读取截图，请重新截图后重试。", "画像を読み込めません。もう一度撮影してください。", "Unable to read the images. Capture them again and retry.")
                await MainActor.run { onDone(false, message) }; return
            }
            var request = makeCaptureRequest(baseURL: base, deviceToken: token, prompt: prompt,
                                             imagesBase64: imagesBase64, resultProtocol: resultProtocol,
                                             captureID: id, screenQuery: screenQuery)
            if let auxiliary, let data = request.httpBody,
               var payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let route = auxiliary.operation == "explain" ? "explanation" : "recovery"
                let path = "v1/captures/" + auxiliary.parentID.uuidString.lowercased() + "/" + route
                request.url = endpointURL(base: base, path: path)
                payload[auxiliary.operation == "explain" ? "explanation_id" : "recovery_id"] = id.uuidString.lowercased()
                if let answer = auxiliary.finalAnswer { payload["final_answer"] = answer }
                if let answerID = auxiliary.answerCaptureID, answerID != auxiliary.parentID {
                    payload["answer_capture_id"] = answerID.uuidString.lowercased()
                }
                request.httpBody = try? JSONSerialization.data(withJSONObject: payload, options: [.withoutEscapingSlashes])
            }
            guard let body = request.httpBody, body.count <= OfficialCaptureMaterials.requestBodyLimit else {
                await MainActor.run { onDone(false, captureTooLargeMessage) }; return
            }
            var completed = false, sawContent = false
            var streamError: String?
            do {
                try Task.checkCancellation()
                guard await MainActor.run(body: { environment.account() == account }) else { throw CancellationError() }
                let (bytes, response) = try await environment.session.bytes(for: request)
                defer { bytes.task.cancel() }
                guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
                if http.statusCode != 200 {
                    var body = Data()
                    for try await byte in bytes { try Task.checkCancellation(); body.append(byte); if body.count > 65_536 { break } }
                    bytes.task.cancel()
                    if http.statusCode == 401 {
                        await MainActor.run {
                            if !Task.isCancelled, environment.account() == account { environment.rejectCredential() }
                        }
                    }
                    if http.statusCode == 409,
                       await MainActor.run(body: { !Task.isCancelled && environment.account() == account }),
                       let status = await captureStatus(id, base: base, token: token, operation: operation, session: environment.session), status.isTerminal {
                        await MainActor.run {
                            if !Task.isCancelled, environment.account() == account { environment.receiveSettlement(status) }
                        }
                    }
                    let message = localizedErrorBody(body, statusCode: http.statusCode)
                    await MainActor.run { onDone(false, message) }; return
                }
                guard http.value(forHTTPHeaderField: "Content-Type")?.split(separator: ";").first?
                    .trimmingCharacters(in: .whitespaces).lowercased() == "text/event-stream" else { throw URLError(.badServerResponse) }
                let outcome = try await OfficialStreamDecoder.consume(bytes, captureID: id, screenQuery: screenQuery != nil,
                                                                       operation: operation) { event in
                    try await MainActor.run {
                        try Task.checkCancellation()
                        guard environment.account() == account else { throw CancellationError() }
                        switch event {
                        case .delta(let text): onDelta(text)
                        case .usage(let value):
                            environment.receiveUsage(value)
                            try Task.checkCancellation()
                            guard environment.account() == account else { throw CancellationError() }
                            onUsage?(value)
                        case .error, .done: break
                        }
                    }
                }
                completed = true; sawContent = outcome.hasContent
                streamError = outcome.serviceError.map { localizedMessage(code: $0.code, fallback: $0.message) }
            } catch { streamError = cannotConnectMessage }
            if !completed, await MainActor.run(body: { !Task.isCancelled && environment.account() == account }) {
                if let status = await captureStatus(id, base: base, token: token, operation: operation, session: environment.session), status.isTerminal,
                   await MainActor.run(body: {
                       guard !Task.isCancelled, environment.account() == account else { return false }
                       environment.receiveSettlement(status); return true
                   }) {
                    // A billed server answer does not prove the full answer reached this client.
                    streamError = status.questionsCharged == 0
                        ? L10n.t("本次未消耗额度。请调整输入后重试。", "今回は消費されていません。入力を調整して再試行してください。", "This request was not charged. Adjust the input and retry.")
                        : L10n.t("本次已结算，但答案传输中断。请保留本次请求并联系支持。", "決済済みですが回答の受信が中断しました。サポートにお問い合わせください。", "This request settled, but the answer transfer was interrupted. Contact support with this request.")
                } else {
                    streamError = L10n.t("正在核对本次额度，请在账户页刷新。", "今回の残高を確認しています。アカウント画面を更新してください。", "Reconciling this request's quota. Refresh the Account page.")
                }
            }
            let delivered = completed && sawContent && streamError == nil
            let message = streamError ?? ""
            await MainActor.run {
                onDone(delivered && environment.account() == account && !Task.isCancelled, message)
            }
        }
    }

    private static var captureTooLargeMessage: String {
        L10n.t("图片数据过大，请缩小区域或减少材料。", "画像が大きすぎます。範囲または資料を減らしてください。", "The images are too large. Select a smaller region or remove material.")
    }

    /// Reconcile a retained parent using its initiating credential, with no network request
    /// after replacement and no late account/UI mutation after an in-flight identity change.
    static func reconcileCaptureStatus(_ id: UUID, account: CaptureAccount,
                                       environment: AccountEnvironment = .live) async -> SettlementSnapshot? {
        guard !Task.isCancelled, environment.state.matches(account) else { return nil }
        let status = await captureStatus(id, base: account.baseURL, token: account.token, session: environment.session)
        return await MainActor.run {
            guard !Task.isCancelled, environment.state.matches(account) else { return nil }
            if let status, status.isTerminal {
                CaptureEnvironment.connected(to: environment, expectedAccount: account).receiveSettlement(status)
            }
            return status
        }
    }

    static func captureStatus(_ id: UUID, base: String? = nil, token: String? = nil,
                              operation: String = "solve", session: URLSession = .shared) async -> SettlementSnapshot? {
        guard let credential = token ?? deviceToken else { return nil }
        let path = "v1/captures/" + id.uuidString.lowercased() + "/status"
        var request = URLRequest(url: endpointURL(base: base ?? baseURL, path: path))
        request.timeoutInterval = 10
        request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
        do {
            try Task.checkCancellation()
            let (bytes, response) = try await session.bytes(for: request)
            defer { bytes.task.cancel() }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  http.value(forHTTPHeaderField: "Content-Type")?.split(separator: ";").first?
                    .trimmingCharacters(in: .whitespaces).lowercased() == "application/json",
                  response.expectedContentLength <= 65_536 else { return nil }
            var data = Data()
            for try await byte in bytes {
                try Task.checkCancellation()
                guard data.count < 65_536 else { return nil }
                data.append(byte)
            }
            try Task.checkCancellation()
            let snapshot = try JSONDecoder().decode(SettlementSnapshot.self, from: data)
            guard snapshot.captureID == id, snapshot.operation == operation else { return nil }
            return snapshot
        } catch { return nil }
    }
}
