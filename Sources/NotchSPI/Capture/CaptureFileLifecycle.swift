import Foundation

/// Serializes temporary-file creation with process shutdown. A late capture cannot recreate
/// files after the final cleanup has completed. All disk operations run off the main actor.
final class CaptureFileLifecycle: @unchecked Sendable {
    static let shared = CaptureFileLifecycle()
    enum Failure: Error { case shuttingDown }
    private let lock = NSLock()
    private var closing = false
    private var directories = Set<URL>()
    private let captureDirectory = FileManager.default.temporaryDirectory
        .appendingPathComponent("notchspi-capture-" + UUID().uuidString, isDirectory: true)

    func withWritableDirectory<T>(_ directory: URL, operation: () throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        guard !closing else { throw Failure.shuttingDown }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        directories.insert(directory)
        return try operation()
    }

    func writeJPEG(_ data: Data) throws -> String {
        try withWritableDirectory(captureDirectory) {
            let file = captureDirectory.appendingPathComponent(UUID().uuidString + ".jpg")
            try data.write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            return file.path
        }
    }

    /// False cancels termination so the user can retry; do not silently leave private files.
    func removeAllForTermination() -> Bool {
        lock.lock(); defer { lock.unlock() }
        closing = true
        var succeeded = true
        for directory in directories {
            do { try FileManager.default.removeItem(at: directory) }
            catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileNoSuchFileError { }
            catch { succeeded = false }
        }
        if succeeded { directories.removeAll() }
        else { closing = false }
        return succeeded
    }
}
