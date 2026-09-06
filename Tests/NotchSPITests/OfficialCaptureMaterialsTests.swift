import XCTest
import Darwin
@testable import NotchSPI

final class OfficialCaptureMaterialsTests: XCTestCase {
    private func withDirectory(_ body: (URL) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("capture-materials-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try body(directory)
    }
    func testOriginalBytesAndFourPageOrderArePreserved() throws {
        try withDirectory { directory in
            let bytes = [Data([0, 1, 2]), Data([255, 0, 4]), Data([7]), Data([9, 8])]
            let paths = try bytes.enumerated().map { index, data in
                let url = directory.appendingPathComponent("\(index).jpg"); try data.write(to: url); return url.path
            }
            XCTAssertEqual(try OfficialCaptureMaterials.load(paths), bytes.map { $0.base64EncodedString() })
            XCTAssertThrowsError(try OfficialCaptureMaterials.load(paths + [paths[0]]))
        }
    }
    func testSparseOversizeFileAndAggregateLimitAreRejectedBeforeEncoding() throws {
        try withDirectory { directory in
            let file = directory.appendingPathComponent("large.jpg")
            XCTAssertTrue(FileManager.default.createFile(atPath: file.path, contents: nil))
            let handle = try FileHandle(forWritingTo: file); defer { try? handle.close() }
            try handle.truncate(atOffset: UInt64(OfficialCaptureMaterials.imageLimit + 1))
            XCTAssertThrowsError(try OfficialCaptureMaterials.load([file.path])) { XCTAssertEqual($0 as? OfficialCaptureMaterials.Failure, .tooLarge) }
            try handle.truncate(atOffset: UInt64(1_200_000))
            XCTAssertThrowsError(try OfficialCaptureMaterials.load([file.path, file.path])) { XCTAssertEqual($0 as? OfficialCaptureMaterials.Failure, .tooLarge) }
            try handle.truncate(atOffset: UInt64(OfficialCaptureMaterials.imageLimit))
            XCTAssertEqual(try OfficialCaptureMaterials.load([file.path])[0].utf8.count, 4 * 1024 * 1024)
        }
    }
    func testNonRegularEmptyMissingAndSymlinkInputsDoNotBlockOrReadTheirTargets() throws {
        try withDirectory { directory in
            let empty = directory.appendingPathComponent("empty"), link = directory.appendingPathComponent("link"), fifo = directory.appendingPathComponent("fifo")
            try Data().write(to: empty)
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: empty)
            XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
            for path in [directory.path, empty.path, link.path, fifo.path, directory.appendingPathComponent("absent").path] {
                XCTAssertThrowsError(try OfficialCaptureMaterials.load([path]))
            }
            XCTAssertThrowsError(try OfficialCaptureMaterials.load([]))
        }
    }
    func testCanceledTaskDoesNotStartReading() async {
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            do { _ = try OfficialCaptureMaterials.load(["/must-not-be-opened"]); XCTFail("Canceled read succeeded") }
            catch { XCTAssertTrue(error is CancellationError) }
        }
        await task.value
    }
}
