import AppKit
import XCTest
@testable import NotchSPI

final class QuestionRegionPickerTests: XCTestCase {
    @MainActor private func canvas(_ picker: QuestionRegionPicker) throws -> NSView {
        let window = try XCTUnwrap(picker.window)
        return try XCTUnwrap(window.initialFirstResponder)
    }

    @MainActor private func key(_ code: UInt16, view: NSView, shift: Bool = false) throws {
        view.keyDown(with: try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero,
            modifierFlags: shift ? .shift : [], timestamp: 0, windowNumber: view.window!.windowNumber,
            context: nil, characters: "", charactersIgnoringModifiers: "", isARepeat: false, keyCode: code)))
    }

    @MainActor private func mouse(_ type: NSEvent.EventType, point: NSPoint, view: NSView) throws -> NSEvent {
        try XCTUnwrap(NSEvent.mouseEvent(with: type, location: view.convert(point, to: nil),
            modifierFlags: [], timestamp: 0, windowNumber: view.window!.windowNumber,
            context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
    }

    @MainActor func testEscapeBeforeMouseInteractionCompletesOnce() throws {
        var results: [QuestionRegion?] = []
        let picker = QuestionRegionPicker(image: NSImage(size: NSSize(width: 800, height: 400))) { results.append($0) }
        let view = try canvas(picker)
        XCTAssertTrue(picker.window?.firstResponder === view)
        try key(53, view: view)
        picker.window?.performClose(nil)
        XCTAssertEqual(results.count, 1)
        XCTAssertNil(results[0])
    }

    @MainActor func testKeyboardSelectionMovesResizesAndConfirmsNormalizedCoordinates() throws {
        var results: [QuestionRegion?] = []
        let picker = QuestionRegionPicker(image: NSImage(size: NSSize(width: 800, height: 400))) { results.append($0) }
        defer { picker.close() }
        let view = try canvas(picker)
        try key(36, view: view)
        XCTAssertTrue(results.isEmpty, "Return must not select the whole image implicitly")
        try key(124, view: view)
        try key(125, view: view, shift: true)
        try key(36, view: view)
        let result = try XCTUnwrap(results.first.flatMap { $0 })
        XCTAssertEqual(result.x, 0.26, accuracy: 0.000001)
        XCTAssertEqual(result.y, 0.25, accuracy: 0.000001)
        XCTAssertEqual(result.width, 0.5, accuracy: 0.000001)
        XCTAssertEqual(result.height, 0.51, accuracy: 0.000001)
        XCTAssertTrue(result.isValid)
        XCTAssertEqual(results.count, 1)
    }

    @MainActor func testKeyboardBoundsCannotLeaveTheCapturedImage() throws {
        var result: QuestionRegion?
        let picker = QuestionRegionPicker(image: NSImage(size: NSSize(width: 100, height: 1000))) { result = $0 }
        defer { picker.close() }
        let view = try canvas(picker)
        for _ in 0..<150 { try key(123, view: view); try key(126, view: view) }
        for _ in 0..<150 { try key(124, view: view, shift: true); try key(125, view: view, shift: true) }
        XCTAssertTrue(view.accessibilityPerformPress())
        let region = try XCTUnwrap(result)
        XCTAssertEqual(region, QuestionRegion(x: 0, y: 0, width: 1, height: 1))
    }

    @MainActor func testLetterboxIsExcludedAndMouseUpUsesItsFinalPosition() throws {
        var results: [QuestionRegion?] = []
        let picker = QuestionRegionPicker(image: NSImage(size: NSSize(width: 100, height: 400))) { results.append($0) }
        defer { picker.close() }
        let view = try canvas(picker)
        view.frame.size = NSSize(width: 400, height: 400)
        view.mouseDown(with: try mouse(.leftMouseDown, point: NSPoint(x: 10, y: 20), view: view))
        view.mouseUp(with: try mouse(.leftMouseUp, point: NSPoint(x: 250, y: 350), view: view))
        XCTAssertTrue(results.isEmpty, "A drag beginning in the margin must not select image content")
        view.mouseDown(with: try mouse(.leftMouseDown, point: NSPoint(x: 175, y: 100), view: view))
        view.mouseDragged(with: try mouse(.leftMouseDragged, point: NSPoint(x: 200, y: 200), view: view))
        view.mouseUp(with: try mouse(.leftMouseUp, point: NSPoint(x: 225, y: 300), view: view))
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0], QuestionRegion(x: 0.25, y: 0.25, width: 0.5, height: 0.5))
    }

    @MainActor func testWindowCloseCancelsWithoutReturningASelectedRegion() throws {
        var results: [QuestionRegion?] = []
        let picker = QuestionRegionPicker(image: NSImage(size: NSSize(width: 800, height: 400))) { results.append($0) }
        try key(124, view: canvas(picker))
        picker.window?.performClose(nil)
        XCTAssertEqual(results.count, 1)
        XCTAssertNil(results[0])
    }
}
