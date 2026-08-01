import AppKit
import ScreenCaptureKit

/// What the hotkey screenshot covers.
enum CaptureTarget: Equatable {
    case fullScreen
    case app(bundleID: String)
}

enum CaptureError: Error {
    case noPermission
    case appNotRunning(name: String)
    case noCapturableWindow(name: String)
    case captureFailed
    /// Full screen only: the caller asked to exclude its own panel window but it wasn't in
    /// the shareable list. Internal signal — the controller falls back to hiding the panel.
    case panelNotExcludable
}

enum ScreenCapture {
    struct Shot {
        let path: String
        let blank: Bool
    }

    /// A running app that currently owns at least one capturable window.
    struct AppInfo {
        let bundleID: String
        let name: String
        let icon: NSImage?
    }

    // MARK: - Window enumeration

    /// Regular (Dock) apps owning at least one normal-layer window, minimized included.
    /// Synchronous and in-process, needs no screen-recording permission (window names
    /// are never read). Agent/status-bar apps (activationPolicy != .regular) are
    /// excluded, which also makes per-window size filtering unnecessary here.
    static func capturableApps() -> [AppInfo] {
        // Toll-free [NSDictionary] cast: deep-bridging thousands of CF dictionaries
        // to [String: Any] costs more than the WindowServer IPC itself.
        let windows = CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID)
            as? [NSDictionary] ?? []
        var owners = Set<pid_t>()
        for w in windows {
            guard let layer = w[kCGWindowLayer] as? Int, layer == 0,
                  let pid = w[kCGWindowOwnerPID] as? pid_t
            else { continue }
            owners.insert(pid)
        }

        let selfPID = NSRunningApplication.current.processIdentifier
        return NSWorkspace.shared.runningApplications
            .compactMap { app -> AppInfo? in
                guard app.activationPolicy == .regular,
                      app.processIdentifier != selfPID,
                      owners.contains(app.processIdentifier),
                      let bundleID = app.bundleIdentifier
                else { return nil }
                return AppInfo(bundleID: bundleID, name: app.localizedName ?? bundleID, icon: app.icon)
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Anything smaller is chrome (status items, tooltips), not real content.
    private static let minContentSize = CGSize(width: 80, height: 60)

    /// Normal document windows only: layer 0, big enough to hold real content.
    private static func isCapturable(_ w: SCWindow) -> Bool {
        w.windowLayer == 0 && w.frame.width >= minContentSize.width && w.frame.height >= minContentSize.height
    }

    // MARK: - Shareable-content cache (full-screen fast path)

    /// Cached enumeration for FULL-SCREEN captures. `SCShareableContent` costs ~100–300ms per
    /// call — the slowest client-side step — and the full-screen path only needs two stable
    /// facts from it: the display list and our own panel window. Staleness (display unplugged,
    /// resolution changed) shows up as a failed attempt, never a wrong image, and the capture
    /// then retries with a fresh enumeration. App-window targets never use the cache: window
    /// stacking changes constantly, and a stale pick could capture the wrong window.
    @MainActor private static var cachedContent: SCShareableContent?
    @MainActor private static var refreshing = false

    /// Refresh the cache off the critical path (launch, after each shot, display changes).
    @MainActor static func prefetchShareableContent() {
        guard !refreshing else { return }
        refreshing = true
        Task {
            let c = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            if let c { cachedContent = c }
            refreshing = false
        }
    }

    @MainActor static func invalidateShareableContent() {
        cachedContent = nil
    }

    // MARK: - Capture

    /// Capture the chosen target to a temp JPEG (≤ ~1568px long edge). For full screen,
    /// `excludingWindowID` composites the shot WITHOUT that window — the controller passes
    /// the notch panel so it never has to be hidden (and blink) before the shot.
    static func capture(
        target: CaptureTarget, maxLongEdge: CGFloat = 1568, excludingWindowID: CGWindowID? = nil
    ) async -> Result<Shot, CaptureError> {
        guard case .app(let bundleID) = target else {
            return await captureFullScreen(maxLongEdge: maxLongEdge, excludingWindowID: excludingWindowID)
        }

        // App targets enumerate off-screen windows too, so minimized ones are found.
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        } catch {
            return .failure(.noPermission)
        }

        let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        let name = running.first?.localizedName ?? bundleID
        let owned = content.windows.filter {
            $0.owningApplication?.bundleIdentifier == bundleID && isCapturable($0)
        }
        guard !owned.isEmpty else {
            return .failure(running.isEmpty ? .appNotRunning(name: name) : .noCapturableWindow(name: name))
        }
        // SCShareableContent lists windows front-to-back: the first on-screen one
        // is the app's frontmost. Fall back to the largest off-screen (minimized) window.
        guard let window = owned.first(where: { $0.isOnScreen })
            ?? owned.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
        else { return .failure(.noCapturableWindow(name: name)) }

        // Window-server composited: unaffected by occlusion, Space, or which display it's on.
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        config.showsCursor = false
        let scale = CGFloat(filter.pointPixelScale)
        setDimensions(config, width: filter.contentRect.width * scale,
                      height: filter.contentRect.height * scale, maxLongEdge: maxLongEdge)
        config.ignoreShadowsSingleWindow = true
        // Blank-frame heuristic only makes sense for full screen; a small window's
        // JPEG can legitimately be tiny.
        return await shoot(filter: filter, config: config, maxLongEdge: maxLongEdge, blankThreshold: 0)
    }

    private static func captureFullScreen(
        maxLongEdge: CGFloat, excludingWindowID: CGWindowID?
    ) async -> Result<Shot, CaptureError> {
        // Fast path: the cached enumeration. Any failure — stale display handle, panel window
        // missing — falls through to a fresh enumeration below.
        if let cached = await MainActor.run(body: { cachedContent }) {
            let r = await attemptFullScreen(content: cached, maxLongEdge: maxLongEdge,
                                            excludingWindowID: excludingWindowID)
            if case .success = r {
                await MainActor.run { prefetchShareableContent() } // keep the next press warm
                return r
            }
        }
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            return .failure(.noPermission)
        }
        await MainActor.run { cachedContent = content }
        return await attemptFullScreen(content: content, maxLongEdge: maxLongEdge,
                                       excludingWindowID: excludingWindowID)
    }

    private static func attemptFullScreen(
        content: SCShareableContent, maxLongEdge: CGFloat, excludingWindowID: CGWindowID?
    ) async -> Result<Shot, CaptureError> {
        let mainID = CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first
        else { return .failure(.captureFailed) }

        let filter: SCContentFilter
        if let id = excludingWindowID {
            guard let panel = content.windows.first(where: { $0.windowID == id })
            else { return .failure(.panelNotExcludable) }
            filter = SCContentFilter(display: display, excludingWindows: [panel])
        } else {
            filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        }
        let config = SCStreamConfiguration()
        config.showsCursor = false
        let scale = NSScreen.main?.backingScaleFactor ?? 2
        setDimensions(config, width: CGFloat(display.width) * scale,
                      height: CGFloat(display.height) * scale, maxLongEdge: maxLongEdge)
        return await shoot(filter: filter, config: config, maxLongEdge: maxLongEdge, blankThreshold: 9000)
    }

    // MARK: - Auto-mode hash sampling

    /// AUTO-MODE TICK PATH: tiny in-memory full-screen luma grid for change detection.
    /// Reuses the shareable-content cache; the window server delivers a ≤128px frame
    /// (setDimensions) which is pooled down to ScreenHasher's 32×20 grid. Never encodes,
    /// never touches disk. Runs at poll rate, so unlike `capture` it neither treats a
    /// missing panel window as an error (Release panels are sharingType .none — already
    /// invisible to capture — and a hide-blink fallback would flicker the notch at 2 Hz)
    /// nor re-warms the cache per tick (the cache isn't consumed; staleness surfaces as
    /// a failed attempt and the fresh-enumeration fallback re-caches).
    static func captureHashGrid(excludingWindowID: CGWindowID?) async -> [UInt8]? {
        if let cached = await MainActor.run(body: { cachedContent }),
           let grid = await attemptHashGrid(content: cached, excludingWindowID: excludingWindowID) {
            return grid
        }
        guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        else { return nil }
        await MainActor.run { cachedContent = content }
        return await attemptHashGrid(content: content, excludingWindowID: excludingWindowID)
    }

    private static func attemptHashGrid(
        content: SCShareableContent, excludingWindowID: CGWindowID?
    ) async -> [UInt8]? {
        let mainID = CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first
        else { return nil }

        let filter: SCContentFilter
        if let id = excludingWindowID, let panel = content.windows.first(where: { $0.windowID == id }) {
            filter = SCContentFilter(display: display, excludingWindows: [panel])
        } else {
            filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        }
        let config = SCStreamConfiguration()
        config.showsCursor = false
        setDimensions(config, width: CGFloat(display.width), height: CGFloat(display.height), maxLongEdge: 128)
        guard let cg = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        else { return nil }
        return ScreenHasher.lumaGrid(from: cg)
    }

    /// Ask the window server for the shot at its FINAL size (≤ maxLongEdge on the long side):
    /// capturing a 5K display at native pixels only to immediately downscale wastes both the
    /// capture IPC and a CPU resample on the hot path.
    private static func setDimensions(
        _ config: SCStreamConfiguration, width: CGFloat, height: CGFloat, maxLongEdge: CGFloat
    ) {
        let f = min(1, maxLongEdge / max(width, height, 1))
        config.width = Int(width * f)
        config.height = Int(height * f)
    }

    private static func shoot(
        filter: SCContentFilter, config: SCStreamConfiguration, maxLongEdge: CGFloat, blankThreshold: Int
    ) async -> Result<Shot, CaptureError> {
        do {
            let cg = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            guard let shot = encode(cg, maxLongEdge: maxLongEdge, blankThreshold: blankThreshold)
            else { return .failure(.captureFailed) }
            return .success(shot)
        } catch {
            // Window vanished mid-capture (closed / app quit), or capture was refused.
            return .failure(.captureFailed)
        }
    }

    private static func encode(_ cg: CGImage, maxLongEdge: CGFloat, blankThreshold: Int) -> Shot? {
        var image = cg
        let w = CGFloat(cg.width)
        let h = CGFloat(cg.height)
        let longEdge = max(w, h)
        if longEdge > maxLongEdge {
            let f = maxLongEdge / longEdge
            let nw = Int(w * f)
            let nh = Int(h * f)
            if let ctx = CGContext(
                data: nil, width: nw, height: nh, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) {
                ctx.interpolationQuality = .medium
                ctx.draw(cg, in: CGRect(x: 0, y: 0, width: nw, height: nh))
                if let scaled = ctx.makeImage() { image = scaled }
            }
        }

        let rep = NSBitmapImageRep(cgImage: image)
        guard let jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else {
            return nil
        }
        let blank = jpg.count < blankThreshold
        let file = NSTemporaryDirectory() + "notch-tutor-\(UUID().uuidString).jpg"
        do {
            try jpg.write(to: URL(fileURLWithPath: file))
        } catch {
            return nil
        }
        return Shot(path: file, blank: blank)
    }
}
