import AppKit
import CryptoKit

enum DeviceSourceGroup: String, Codable, CaseIterable {
    case spi = "spi_entry"
    case readingPractice = "reading_practice_entry"
    case direct = "direct"

    var title: String {
        switch self {
        case .spi: return L10n.t("SPI 备考介绍", "SPI 対策の案内", "SPI preparation page")
        case .readingPractice: return L10n.t("阅读练习介绍", "読解練習の案内", "Reading practice page")
        case .direct: return L10n.t("直接下载或其他入口", "直接ダウンロード・その他", "Direct download or another source")
        }
    }
}

/// A voluntary attribution answer, independent of the selected question profile or telemetry
/// preference. Skipping stores only a local dismissal; it never sends a source request.
@MainActor
final class DeviceSourceSelection {
    static let shared: DeviceSourceSelection = {
        #if DEBUG
        if ProcessInfo.processInfo.environment["NSPI_QA_GIFT"] != nil ||
            ProcessInfo.processInfo.environment["NSPI_QA_EPHEMERAL"] == "1" {
            return DeviceSourceSelection(scheduleAutomatically: false, persistEnabled: false)
        }
        #endif
        return DeviceSourceSelection()
    }()
    static let storageKey = "attribution.voluntarySource.v1"

    struct Record: Codable, Equatable {
        enum State: String, Codable { case skipped, pending, confirmed, conflict }
        let version: Int
        let id: UUID
        let group: DeviceSourceGroup?
        let selectedAt: Date
        var binding: String?
        var state: State
    }
    struct Environment {
        var token: @MainActor () -> String?
        var baseURL: @MainActor () -> String
        @MainActor static var live: Self { .init(token: { OfficialAPI.deviceToken }, baseURL: { OfficialAPI.baseURL }) }
    }
    private(set) var record: Record?
    private let defaults: UserDefaults
    private let session: URLSession
    private let environment: Environment
    private let scheduleAutomatically: Bool
    private let persistEnabled: Bool
    private var inFlight: Task<Void, Never>?
    private var retry: DispatchWorkItem?
    private var observers: [NSObjectProtocol] = []

    init(defaults: UserDefaults = .standard, session: URLSession = .shared, environment: Environment? = nil,
         scheduleAutomatically: Bool = true, persistEnabled: Bool = true) {
        self.defaults = defaults; self.session = session; self.environment = environment ?? .live
        self.scheduleAutomatically = scheduleAutomatically; self.persistEnabled = persistEnabled
        if persistEnabled, let data = defaults.data(forKey: Self.storageKey),
           let saved = try? JSONDecoder().decode(Record.self, from: data), saved.version == 1,
           (saved.state == .skipped) == (saved.group == nil),
           saved.binding == nil || saved.binding?.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
           saved.state == .pending || saved.state == .skipped || saved.binding != nil { record = saved }
        if scheduleAutomatically {
            for name in [OfficialAPI.accountDidChange, NSApplication.didBecomeActiveNotification] {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    Task { @MainActor in await self?.flush() }
                })
            }
            schedule()
        }
    }

    deinit {
        retry?.cancel()
        inFlight?.cancel()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    /// The first committed answer is immutable, matching the server's device source record.
    @discardableResult
    func choose(_ group: DeviceSourceGroup?) -> Bool {
        guard record == nil else { return false }
        let value = Record(version: 1, id: UUID(), group: group, selectedAt: Date(),
                           binding: group == nil ? nil : currentBinding, state: group == nil ? .skipped : .pending)
        guard save(value) else { return false }
        if group != nil, scheduleAutomatically { Task { await flush() } }
        return true
    }

    /// Only a server-confirmed answer for this exact host/device can label new events.
    var telemetrySource: (group: String, method: String) {
        guard let record, record.state == .confirmed, let binding = currentBinding,
              record.binding == binding, let group = record.group else {
            return ("unknown", "unknown")
        }
        return (group.rawValue, "self_reported")
    }

    func flush() async {
        if let inFlight { await inFlight.value; return }
        guard let value = record, value.state == .pending, let group = value.group,
              let token = environment.token(), !token.isEmpty else { return }
        let base = environment.baseURL(), binding = Self.binding(base: base, token: token)
        guard value.binding == nil || value.binding == binding else { return }
        var bound = value; bound.binding = binding
        guard save(bound) else { return }
        retry?.cancel(); retry = nil
        let task = Task { [weak self] in
            guard let self else { return }
            defer { self.inFlight = nil; self.schedule() }
            do {
                let request = Self.request(base: base, token: token, group: group)
                let (data, response) = try await self.session.data(for: request)
                guard !Task.isCancelled, self.currentBinding == binding, self.record == bound,
                      let http = response as? HTTPURLResponse else { return }
                var next = bound
                if http.statusCode == 200,
                   let body = try? JSONDecoder().decode(Acknowledgement.self, from: data), body.accepted {
                    next.state = .confirmed
                } else if http.statusCode == 409 { next.state = .conflict }
                else { return }
                _ = self.save(next)
            } catch { /* The persisted selection retries later; credentials are never modified. */ }
        }
        inFlight = task
        await task.value
    }

    private struct Acknowledgement: Decodable { let accepted: Bool }
    static func request(base: String, token: String, group: DeviceSourceGroup) -> URLRequest {
        var value = URLRequest(url: OfficialAPI.endpointURL(base: base, path: "v1/device-source"))
        value.httpMethod = "POST"; value.timeoutInterval = 8
        value.cachePolicy = .reloadIgnoringLocalCacheData
        value.setValue("application/json", forHTTPHeaderField: "Content-Type")
        value.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        value.httpBody = try? JSONEncoder().encode(["source_group": group.rawValue])
        return value
    }
    private var currentBinding: String? {
        guard let token = environment.token(), !token.isEmpty else { return nil }
        return Self.binding(base: environment.baseURL(), token: token)
    }
    private static func binding(base: String, token: String) -> String {
        SHA256.hash(data: Data((base + "\0" + token).utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private func save(_ value: Record) -> Bool {
        if persistEnabled {
            guard let data = try? JSONEncoder().encode(value) else { return false }
            defaults.set(data, forKey: Self.storageKey)
            guard defaults.data(forKey: Self.storageKey) == data else { return false }
        }
        record = value
        return true
    }
    private func schedule() {
        guard scheduleAutomatically, record?.state == .pending else { return }
        retry?.cancel()
        let work = DispatchWorkItem { [weak self] in Task { @MainActor in await self?.flush() } }
        retry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: work)
    }
}
