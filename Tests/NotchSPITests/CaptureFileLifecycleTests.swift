import Foundation
import XCTest
@testable import NotchSPI

final class CaptureFileLifecycleTests: XCTestCase {
    func testShutdownRemovesOnlyOwnedDirectoriesAndRejectsLateWrites() throws {
        let lifecycle = CaptureFileLifecycle()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let unrelated = root.appendingPathComponent("keep.txt")
        try Data("keep".utf8).write(to: unrelated)
        let owned = root.appendingPathComponent("owned")
        try lifecycle.withWritableDirectory(owned) { try Data([1, 2, 3]).write(to: owned.appendingPathComponent("capture.jpg")) }
        let capture = try lifecycle.writeJPEG(Data([4, 5, 6]))
        let permissions = try FileManager.default.attributesOfItem(atPath: capture)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
        XCTAssertTrue(lifecycle.removeAllForTermination())
        XCTAssertFalse(FileManager.default.fileExists(atPath: owned.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: capture))
        XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path))
        XCTAssertThrowsError(try lifecycle.withWritableDirectory(owned) { XCTFail("late writer ran") })
        XCTAssertThrowsError(try lifecycle.writeJPEG(Data([7])))
        XCTAssertFalse(FileManager.default.fileExists(atPath: owned.path))
        XCTAssertTrue(lifecycle.removeAllForTermination(), "cleanup is idempotent")
    }

    func testShutdownWaitsForAnInFlightWriteThenRemovesItsOutput() async throws {
        let lifecycle = CaptureFileLifecycle()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let entered = expectation(description: "writer holds lifecycle lock")
        let release = DispatchSemaphore(value: 0)
        let writer = Task.detached {
            try lifecycle.withWritableDirectory(root) {
                entered.fulfill()
                guard release.wait(timeout: .now() + 5) == .success else { throw CocoaError(.userCancelled) }
                try Data([1]).write(to: root.appendingPathComponent("late.jpg"))
            }
        }
        await fulfillment(of: [entered], timeout: 5)
        let shutdown = Task.detached { lifecycle.removeAllForTermination() }
        release.signal()
        try await writer.value
        let cleaned = await shutdown.value
        XCTAssertTrue(cleaned)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        XCTAssertThrowsError(try lifecycle.withWritableDirectory(root) { XCTFail("write after shutdown") })
    }
}
