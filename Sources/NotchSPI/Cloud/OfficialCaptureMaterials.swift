import Foundation
import Darwin

/// Bounds local file reads before base64/JSON allocations. The server separately verifies
/// actual image content; this reader preserves the original bytes and caller's page order.
enum OfficialCaptureMaterials {
    enum Failure: Error { case unavailable, tooLarge }
    // The official deployment accepts at most 4.5 MB. Leave transport margin and check the
    // final JSON separately; no resizing, re-encoding, or page removal is performed here.
    static let requestBodyLimit = 4 * 1024 * 1024
    static let imageLimit = requestBodyLimit / 4 * 3

    static func load(_ paths: [String]) throws -> [String] {
        guard (1...4).contains(paths.count) else { throw Failure.unavailable }
        var remaining = requestBodyLimit, images: [String] = []
        for (index, path) in paths.enumerated() {
            try Task.checkCancellation()
            // For multiple pages the current question also appears in legacy image_base64.
            let occurrences = paths.count > 1 && index == paths.count - 1 ? 2 : 1
            let data = try read(path, limit: min(imageLimit, remaining / occurrences / 4 * 3))
            remaining -= ((data.count + 2) / 3 * 4) * occurrences
            images.append(data.base64EncodedString())
        }
        return images
    }

    private static func read(_ path: String, limit: Int) throws -> Data {
        // O_NONBLOCK keeps a substituted FIFO from hanging before fstat can reject it.
        let descriptor = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { throw Failure.unavailable }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size > 0 else { throw Failure.unavailable }
        guard info.st_size <= limit else { throw Failure.tooLarge }
        var data = Data()
        while true {
            try Task.checkCancellation()
            guard let chunk = try handle.read(upToCount: min(65_536, limit - data.count + 1)), !chunk.isEmpty else { break }
            guard chunk.count <= limit - data.count else { throw Failure.tooLarge }
            data.append(chunk)
        }
        guard !data.isEmpty else { throw Failure.unavailable }
        return data
    }
}
