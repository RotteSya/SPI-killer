import Foundation
import ImageIO
import CryptoKit

/// The last owner removes the file. In-flight snapshots retain owners after a session clears.
final class QuestionAssetFile: @unchecked Sendable {
    let url: URL
    init(url: URL) { self.url = url }
    deinit {
        let path = url
        DispatchQueue.global(qos: .utility).async { try? FileManager.default.removeItem(at: path) }
    }
}
struct ContextAsset: Identifiable, Equatable, Sendable {
    let id: UUID
    let sessionID: UUID
    let file: QuestionAssetFile
    let sha256: String
    let width: Int
    let height: Int
    let byteCount: Int
    let targetFingerprint: String
    let capturedAt: Date
    static func == (a: Self, b: Self) -> Bool { a.id == b.id }
}
struct QuestionCaptureSnapshot: Sendable {
    let captureID: UUID
    let sessionID: UUID
    let generation: UInt64
    let assets: [ContextAsset]
    let expiresAt: Date
    var imagePaths: [String] { assets.map { $0.file.url.path } }
}

@MainActor
final class QuestionSessionStore {
    enum SessionError: Error { case full, expired, changedTarget, unreadable, stale }
    private(set) var sessionID = UUID()
    private(set) var generation: UInt64 = 0
    private(set) var references: [ContextAsset] = []
    private(set) var currentQuestion: ContextAsset?
    private(set) var lastActivity = Date()
    private var scope = ""
    private let now: () -> Date
    private let directory: URL
    static let lifetime: TimeInterval = 15 * 60

    init(directory: URL? = nil, now: @escaping () -> Date = Date.init) {
        self.now = now
        self.directory = directory ?? FileManager.default.temporaryDirectory
            .appendingPathComponent("notchspi-questions-" + UUID().uuidString, isDirectory: true)
        self.lastActivity = now()
        let parent = self.directory.deletingLastPathComponent()
        let cutoff = now().addingTimeInterval(-Self.lifetime)
        DispatchQueue.global(qos: .utility).async {
            let fm = FileManager.default
            for url in (try? fm.contentsOfDirectory(at: parent, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
                where url.lastPathComponent.hasPrefix("notchspi-questions-") {
                if let modified = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
                   modified < cutoff { try? fm.removeItem(at: url) }
            }
        }
    }
    func begin(scope: String, newQuestionGroup: Bool) {
        if newQuestionGroup || scope != self.scope || now().timeIntervalSince(lastActivity) >= Self.lifetime { clear() }
        self.scope = scope
        lastActivity = now()
    }
    /// First-use registration can bind already saved local material to the newly confirmed
    /// account. Existing accounts, other selections and expired groups cannot transfer it.
    @discardableResult
    func bindRegisteredAccount(from pending: CaptureRequestBinding, to registered: CaptureRequestBinding) -> Bool {
        guard pending.officialAccount == nil, registered.officialAccount != nil,
              pending.selectionID == registered.selectionID, scope == pending.scopeID,
              !expireIfNeeded() else { return false }
        scope = registered.scopeID
        return true
    }
    func clear() {
        references = []
        currentQuestion = nil
        sessionID = UUID()
        generation &+= 1
        lastActivity = now()
    }
    @discardableResult
    func expireIfNeeded() -> Bool {
        guard now().timeIntervalSince(lastActivity) >= Self.lifetime else { return false }
        clear()
        return true
    }
    func removeReference(_ id: UUID) {
        references.removeAll { $0.id == id }
        lastActivity = now()
    }
    func saveCurrentAsReference() throws {
        guard !expireIfNeeded(), let question = currentQuestion else { throw SessionError.expired }
        if references.contains(where: { $0.id == question.id }) { return }
        guard references.count < 3 else { throw SessionError.full }
        references.append(question)
        currentQuestion = nil
        lastActivity = now()
    }
    /// Disk decoding and ownership transfer happen away from the main actor.
    func adopt(path: String, targetFingerprint: String, asReference: Bool) async throws -> ContextAsset {
        guard !asReference || references.count < 3 else { throw SessionError.full }
        let expectedSession = sessionID, expectedGeneration = generation
        let destinationDirectory = directory
        let capturedAt = now()
        let asset = try await Task.detached(priority: .userInitiated) {
            let fm = FileManager.default
            try fm.createDirectory(at: destinationDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let source = URL(fileURLWithPath: path)
            guard let data = try? Data(contentsOf: source),
                  let image = CGImageSourceCreateWithData(data as CFData, nil),
                  let properties = CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? Int,
                  let height = properties[kCGImagePropertyPixelHeight] as? Int,
                  width > 0, height > 0, width * height <= 16_000_000 else { throw SessionError.unreadable }
            let id = UUID(), destination = destinationDirectory.appendingPathComponent(id.uuidString + ".jpg")
            try fm.moveItem(at: source, to: destination)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
            return ContextAsset(id: id, sessionID: expectedSession, file: QuestionAssetFile(url: destination),
                                sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(),
                                width: width, height: height, byteCount: data.count,
                                targetFingerprint: targetFingerprint, capturedAt: capturedAt)
        }.value
        guard expectedSession == sessionID, expectedGeneration == generation else { throw SessionError.stale }
        if let prior = references.first ?? currentQuestion, prior.targetFingerprint != targetFingerprint {
            clear()
            throw SessionError.changedTarget
        }
        if asReference {
            guard references.count < 3 else { throw SessionError.full }
            references.append(asset)
        } else { currentQuestion = asset }
        lastActivity = now()
        return asset
    }
    func snapshot(captureID: UUID, includeReferences: Bool) throws -> QuestionCaptureSnapshot {
        guard !expireIfNeeded(), let question = currentQuestion else { throw SessionError.expired }
        let assets = (includeReferences ? references : []) + [question]
        guard assets.count <= 4, assets.allSatisfy({ $0.sessionID == sessionID }) else { throw SessionError.stale }
        return .init(captureID: captureID, sessionID: sessionID, generation: generation, assets: assets,
                     expiresAt: now().addingTimeInterval(Self.lifetime))
    }
}
