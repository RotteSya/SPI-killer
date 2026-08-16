import AppKit

/// Lightweight "check for updates" against our own service.
///
/// NotchSPI ships as a notarized `NotchSPI.dmg`. `GET /update` reports the newest published
/// version as `{ version, tag, notes }` and `GET /dl` streams that DMG — both served by the
/// official service, which reads the release storage server-side. Keeping both behind our own
/// origin means no part of the app links a user out to where the code is hosted. It also stays a
/// plain JSON GET: no Sparkle, no appcast, no EdDSA keys, no extra dependency.
///
/// We compare the reported version to the running app's `CFBundleShortVersionString` and, if
/// newer, offer to open the download.
enum UpdateChecker {
    /// Both endpoints resolve against the configured base, so an `official.baseURL` override
    /// (staging / self-hosted) moves the update check with it.
    private static var latestURL: URL { OfficialAPI.endpointURL(base: OfficialAPI.baseURL, path: "update") }
    /// Where "前往下载" goes — streams the DMG straight from the service.
    static var downloadURL: URL { OfficialAPI.endpointURL(base: OfficialAPI.baseURL, path: "dl") }
    /// Fallback when the check itself fails: the product site, which carries the download button.
    /// A page degrades better than a binary stream when the network is already misbehaving.
    static var sitePage: URL { URL(string: OfficialAPI.baseURL) ?? downloadURL }

    private static let lastCheckKey = "lastUpdateCheckAt"
    private static let skipVersionKey = "skipUpdateVersion"
    private static let autoCheckInterval: TimeInterval = 24 * 60 * 60

    /// Guards against stacking alerts if the menu item is clicked twice while a check is in flight.
    private static var inFlight = false

    /// Running app version from the bundle's Info.plist (`CFBundleShortVersionString`), e.g. "1.5".
    /// Unbundled `swift run` has no Info.plist, so fall back to `devFallbackVersion`.
    static var currentVersion: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? devFallbackVersion
    }

    /// Dev-only fallback for `swift run` (the real .app reads its Info.plist). Keep roughly in sync
    /// with `VERSION` in `scripts/make-dmg.sh`, which is the source of truth for releases.
    private static let devFallbackVersion = "2.9"

    struct Release {
        let version: String   // normalized numeric core, e.g. "1.6"
        let tag: String       // raw tag, e.g. "v1.6"
        let notes: String     // changelog for this release
    }

    enum CheckResult {
        case upToDate(current: String)
        case updateAvailable(Release)
        case failed(String)
    }

    // MARK: - Entry points

    /// Gear-menu "检查更新…": always reports back (up to date / update / error).
    static func checkForUpdatesManually() {
        guard !inFlight else { return }
        inFlight = true
        check { result in
            inFlight = false
            switch result {
            case .updateAvailable(let r): presentUpdate(r, manual: true)
            case .upToDate(let v): presentUpToDate(v)
            case .failed(let msg): presentFailure(msg)
            }
        }
    }

    /// Silent launch check: runs at most once per day and only shows UI when an update is available
    /// and that version hasn't been skipped. Failures are swallowed (the menu item is always there).
    static func autoCheckIfDue() {
        guard !inFlight else { return }
        let now = Date().timeIntervalSince1970
        let last = UserDefaults.standard.double(forKey: lastCheckKey)
        if last > 0, now - last < autoCheckInterval { return }
        UserDefaults.standard.set(now, forKey: lastCheckKey) // record the attempt, so we don't retry on every launch

        inFlight = true
        check { result in
            inFlight = false
            guard case .updateAvailable(let r) = result else { return }
            if r.version == UserDefaults.standard.string(forKey: skipVersionKey) { return }
            presentUpdate(r, manual: false)
        }
    }

    // MARK: - Network

    /// Fetch the latest release and compare to the running version. `completion` runs on the main thread.
    static func check(completion: @escaping (CheckResult) -> Void) {
        var req = URLRequest(url: latestURL)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.timeoutInterval = 15
        req.cachePolicy = .reloadIgnoringLocalCacheData

        URLSession.shared.dataTask(with: req) { data, response, error in
            let finish: (CheckResult) -> Void = { r in DispatchQueue.main.async { completion(r) } }

            if let error { finish(.failed(error.localizedDescription)); return }
            guard let http = response as? HTTPURLResponse else { finish(.failed(L10n.t("无网络响应", "ネットワーク応答なし", "No network response"))); return }
            guard http.statusCode == 200, let data else {
                finish(.failed("HTTP \(http.statusCode)")); return
            }
            guard
                let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                let version = obj["version"] as? String
            else { finish(.failed(L10n.t("无法解析更新信息", "更新情報を解析できません", "Could not parse update info"))); return }

            // `version` is already normalized server-side; normalize again so a hand-edited or
            // older-format response ("v2.6") still compares correctly.
            let latest = normalize(version)
            let tag = (obj["tag"] as? String) ?? "v\(latest)"
            let notes = (obj["notes"] as? String) ?? ""
            if isNewer(latest, than: normalize(currentVersion)) {
                finish(.updateAvailable(Release(version: latest, tag: tag, notes: notes)))
            } else {
                finish(.upToDate(current: currentVersion))
            }
        }.resume()
    }

    // MARK: - Version comparison

    /// Strip a leading "v"/"V" and surrounding whitespace, leaving the dotted numeric core.
    static func normalize(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("v") || s.hasPrefix("V") { s.removeFirst() }
        return s
    }

    /// Numeric, component-wise comparison so "1.10" > "1.9" and "1.5" == "1.5.0".
    static func isNewer(_ a: String, than b: String) -> Bool {
        let pa = a.split(separator: ".").map { Int($0) ?? 0 }
        let pb = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0
            let y = i < pb.count ? pb[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    // MARK: - Presentation (main thread)

    /// App logo used as the alert icon, so the alert shows the NotchSPI mark instead of the generic
    /// executable icon. Released `.app`: the bundled `NotchSPI.icns`. Dev (`swift run`, no bundle):
    /// straight from the source `Resources/`. `nil` → NSAlert keeps its default icon.
    private static let appLogo: NSImage? = {
        if let url = Bundle.main.url(forResource: "NotchSPI", withExtension: "icns"),
           let img = NSImage(contentsOf: url) { return img }
        let devURL = URL(fileURLWithPath: #filePath)   // Sources/NotchSPI/Update/UpdateChecker.swift
            .deletingLastPathComponent()                // Sources/NotchSPI/Update
            .deletingLastPathComponent()                // Sources/NotchSPI
            .deletingLastPathComponent()                // Sources
            .deletingLastPathComponent()                // package root
            .appendingPathComponent("Resources/NotchSPI.png")
        return NSImage(contentsOf: devURL)
    }()

    private static func presentUpdate(_ r: Release, manual: Bool) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        if let appLogo { alert.icon = appLogo }
        alert.alertStyle = .informational
        alert.messageText = L10n.t("发现新版本 NotchSPI \(r.version)", "新しいバージョン NotchSPI \(r.version)", "NotchSPI \(r.version) is available")
        var info = L10n.t("当前版本 \(currentVersion)，最新版本 \(r.version)。是否立即下载更新？", "現在 \(currentVersion)、最新 \(r.version)。今すぐダウンロードしますか？", "You have \(currentVersion); the latest is \(r.version). Download it now?")
        let notes = r.notes.trimmingCharacters(in: .whitespacesAndNewlines)
        if !notes.isEmpty { info += "\n\n" + L10n.t("更新内容：", "更新内容：", "What is new:") + "\n\(notes)" }
        alert.informativeText = String(info.prefix(800))
        alert.addButton(withTitle: L10n.t("前往下载", "ダウンロード", "Download"))      // .alertFirstButtonReturn
        alert.addButton(withTitle: L10n.t("稍后", "あとで", "Later"))           // .alertSecondButtonReturn
        if !manual { alert.addButton(withTitle: L10n.t("跳过此版本", "このバージョンをスキップ", "Skip This Version")) } // .alertThirdButtonReturn

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            NSWorkspace.shared.open(downloadURL)
        case .alertThirdButtonReturn:
            UserDefaults.standard.set(r.version, forKey: skipVersionKey)
        default:
            break
        }
    }

    private static func presentUpToDate(_ version: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        if let appLogo { alert.icon = appLogo }
        alert.alertStyle = .informational
        alert.messageText = L10n.t("已是最新版本", "最新バージョンです", "You are up to date")
        alert.informativeText = L10n.t("NotchSPI \(version) 已是最新版本。", "NotchSPI \(version) は最新です。", "NotchSPI \(version) is the latest version.")
        alert.addButton(withTitle: L10n.ok)
        alert.runModal()
    }

    private static func presentFailure(_ message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        if let appLogo { alert.icon = appLogo }
        alert.alertStyle = .warning
        alert.messageText = L10n.t("检查更新失败", "更新の確認に失敗", "Update check failed")
        alert.informativeText = L10n.t("无法获取更新信息：\(message)\n\n你也可以打开官网自行下载。", "更新情報を取得できません：\(message)\n\n公式サイトから直接ダウンロードすることもできます。", "Could not fetch update info: \(message)\n\nYou can also download it from the website.")
        alert.addButton(withTitle: L10n.t("打开官网", "サイトを開く", "Open Website"))
        alert.addButton(withTitle: L10n.ok)
        if alert.runModal() == .alertFirstButtonReturn {
            NSWorkspace.shared.open(sitePage)
        }
    }
}
