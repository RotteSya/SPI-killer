import Foundation
import CryptoKit
import ImageIO
import Darwin

struct FeedbackExportManifest: Codable {
    struct Asset: Codable {
        let file: String
        let role: String
        let ordinal: Int
        let sha256: String
        let widthPx: Int
        let heightPx: Int
        let byteCount: Int
    }

    let submissionID: UUID
    let authorizationVersion: String
    let authorization: FeedbackAuthorization
    let purpose: String
    let retention: String
    let exportedAt: Date
    let captureID: UUID
    let sessionID: UUID
    let answer: String
    let standardAnswer: String?
    let assets: [Asset]

    enum CodingKeys: String, CodingKey {
        case submissionID = "submission_id"
        case authorizationVersion = "authorization_version"
        case authorization
        case purpose, retention
        case exportedAt = "exported_at"
        case captureID = "capture_id"
        case sessionID = "session_id"
        case answer
        case standardAnswer = "standard_answer"
        case assets
    }
}

enum FeedbackExporter {
    enum ExportError: Error { case unauthorized, expired, invalidSelection, changedMaterial, invalidDestination }
    /// Writes a reviewable local package. No network call is made and the package contains only
    /// the images the user already selected, the visible answer, and the optional reference answer.
    static func write(snapshot: QuestionCaptureSnapshot, answer: String, standardAnswer: String?,
                      selectedAssetIDs: Set<UUID>, authorization: FeedbackAuthorization, to manifestURL: URL) throws -> UUID {
        let fm = FileManager.default
        let now = Date()
        guard authorization.isValid(at: now) else { throw ExportError.unauthorized }
        guard snapshot.expiresAt > now else { throw ExportError.expired }
        guard !answer.isEmpty, answer.utf8.count <= 64 * 1024, (standardAnswer?.utf8.count ?? 0) <= 16 * 1024,
              snapshot.assets.count <= 4, Set(snapshot.assets.map(\.id)).count == snapshot.assets.count,
              selectedAssetIDs.isSubset(of: Set(snapshot.assets.map(\.id))) else { throw ExportError.invalidSelection }
        guard manifestURL.isFileURL else { throw ExportError.invalidDestination }
        let submissionID = UUID()
        let assetDirectory = manifestURL.deletingLastPathComponent().appendingPathComponent("notchspi-feedback-" + submissionID.uuidString.lowercased() + "-assets", isDirectory: true)
        try fm.createDirectory(at: assetDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        var committed = false
        defer { if !committed { try? fm.removeItem(at: assetDirectory) } }

        let assets = try snapshot.assets.filter { selectedAssetIDs.contains($0.id) }.enumerated().map { index, asset -> FeedbackExportManifest.Asset in
            let role = asset.id == snapshot.assets.last?.id ? "question" : "reference"
            let data = try boundedImageData(at: asset.file.url)
            guard data.count <= 2 * 1024 * 1024, data.count == asset.byteCount,
                  SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == asset.sha256,
                  let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) == 1,
                  let type = CGImageSourceGetType(source) as String?, ["public.jpeg", "public.png"].contains(type),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
                  width == asset.width, height == asset.height, width > 0, height > 0, width <= 16_000_000 / height,
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil), image.width == width, image.height == height,
                  CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete else { throw ExportError.changedMaterial }
            let filename = String(format: "%02d-%@", index + 1, role) + (type == "public.png" ? ".png" : ".jpg")
            let destination = assetDirectory.appendingPathComponent(filename)
            try data.write(to: destination, options: .atomic)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
            return .init(file: assetDirectory.lastPathComponent + "/" + filename, role: role, ordinal: index,
                         sha256: asset.sha256, widthPx: asset.width, heightPx: asset.height, byteCount: data.count)
        }

        let manifest = FeedbackExportManifest(
            submissionID: submissionID,
            authorizationVersion: authorization.version,
            authorization: authorization,
            purpose: authorization.purpose.rawValue,
            retention: "local_until_user_deletes",
            exportedAt: now,
            captureID: snapshot.captureID,
            sessionID: snapshot.sessionID,
            answer: answer,
            standardAnswer: standardAnswer?.isEmpty == true ? nil : standardAnswer,
            assets: assets
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        let stagedManifest = assetDirectory.appendingPathComponent("manifest.json")
        try encoder.encode(manifest).write(to: stagedManifest, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stagedManifest.path)
        guard Darwin.rename(stagedManifest.path, manifestURL.path) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        committed = true
        return submissionID
    }

    private static func boundedImageData(at url: URL) throws -> Data {
        let limit = 2 * 1024 * 1024
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { throw ExportError.changedMaterial }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_size > 0, info.st_size <= limit,
              let data = try handle.read(upToCount: limit + 1), data.count <= limit else { throw ExportError.changedMaterial }
        return data
    }
}
