import AppKit
import XCTest
@testable import NotchSPI

final class MaterialActionAccessibilityTests: XCTestCase {
    @MainActor func testRemovedButtonCannotKeepTheDeletedMaterialFileAlive() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("material.png")
        try Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGaQAAAAASUVORK5CYII=")!.write(to: file)
        let strip = QuestionMaterialStrip(frame: NSRect(x: 0, y: 0, width: 600, height: 74))
        strip.onRemove = { [weak strip] _ in strip?.update([], explanationAvailable: false) }
        strip.update([ContextAsset(id: UUID(), sessionID: UUID(), file: QuestionAssetFile(url: file),
                                   sha256: "test", width: 1, height: 1, byteCount: 68,
                                   targetFingerprint: "test", capturedAt: Date())], explanationAvailable: false)
        // Accessibility clients can retain a removed control after it leaves the view tree.
        let retainedButton = try XCTUnwrap(strip.subviews.first as? NSButton)
        XCTAssertTrue(retainedButton.accessibilityPerformPress())
        for _ in 0..<20 where FileManager.default.fileExists(atPath: file.path) {
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        XCTAssertNil(retainedButton.superview)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    @MainActor func testActionsWorkInTheNonKeyNotchPanelAndRespectDisabledState() throws {
        let panel = NotchPanel(contentRect: NSRect(x: 0, y: 0, width: 600, height: 100))
        defer { panel.close() }
        let strip = QuestionMaterialStrip(frame: NSRect(x: 0, y: 0, width: 600, height: 74))
        panel.contentView = strip
        var added = 0, selected = 0, cleared = 0
        strip.onAdd = { added += 1 }; strip.onSelect = { selected += 1 }; strip.onClear = { cleared += 1 }
        strip.update([], explanationAvailable: false)
        let buttons = strip.subviews.compactMap { $0 as? NSButton }
        XCTAssertFalse(panel.canBecomeKey)
        XCTAssertEqual(buttons.count, 3)
        for button in buttons { XCTAssertTrue(button.accessibilityPerformPress()) }
        XCTAssertEqual(added, 1); XCTAssertEqual(selected, 1); XCTAssertEqual(cleared, 1)
        let add = try XCTUnwrap(buttons.first)
        add.isEnabled = false
        XCTAssertFalse(add.accessibilityPerformPress())
        XCTAssertEqual(added, 1)
        add.isEnabled = true; strip.isHidden = true
        XCTAssertFalse(add.accessibilityPerformPress())
        XCTAssertEqual(added, 1)
    }
}
