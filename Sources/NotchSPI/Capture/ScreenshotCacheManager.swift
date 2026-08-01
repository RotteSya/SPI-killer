import Foundation

/// 上下文截图缓存：⌘⇧1（学习辅导）每答完一题，它的截图就在这里存档；⌘⇧2（上下文追问）
/// 把这张"老图"和新截图一起发送，解决"正文只出现在第一题截图里"的上下文丢失问题。
///
/// Ownership-transfer, not copy: the capture pipeline hands over the temp JPEG it would
/// otherwise delete, and the file is renamed onto ONE fixed path. So the cache costs zero
/// extra I/O, holds at most one ≤~1568px JPEG on disk (a few hundred KB), and keeps nothing
/// in memory but a flag — it cannot grow no matter how long the app runs. The fixed filename
/// also makes a stale file from a crashed session self-healing: it is never referenced (the
/// flag starts false) and the next store overwrites it.
@MainActor
final class ScreenshotCacheManager {
    static let shared = ScreenshotCacheManager()

    private let cachePath = NSTemporaryDirectory() + "notch-context-cache.jpg"
    /// Session-scoped: starts false on every launch, so yesterday's leftover file can never
    /// silently become today's context.
    private var hasContext = false

    private init() {}

    /// Path of the cached context shot, or nil when none was stored this session (or the
    /// temp file has since been cleaned from under us).
    var contextPath: String? {
        guard hasContext, FileManager.default.fileExists(atPath: cachePath) else { return nil }
        return cachePath
    }

    /// Take ownership of a finished capture's temp file as the new context. The caller must
    /// not touch `path` afterwards. On a failed move the source is deleted (the same fate it
    /// had before this cache existed) and the cache reports empty rather than pointing at a
    /// half-replaced file.
    func store(_ path: String) {
        let fm = FileManager.default
        try? fm.removeItem(atPath: cachePath)
        do {
            try fm.moveItem(atPath: path, toPath: cachePath)
            hasContext = true
        } catch {
            try? fm.removeItem(atPath: path)
            hasContext = false
        }
    }
}
