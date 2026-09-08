import AppKit
import XCTest
@testable import NotchSPI

final class SettingsNavigationAccessibilityTests: XCTestCase {
    @MainActor func testThemeControlsApplyTheSelectionThroughAccessibilityAndKeyboard() throws {
        let previous = Appearance.theme.id
        defer { Appearance.setTheme(previous) }
        let controller = MainSettingsWindowController()
        let window = try XCTUnwrap(controller.window)
        defer { window.close() }
        controller.open(page: .appearance)
        let root = try XCTUnwrap(window.contentView)
        let swatches = AccentTheme.all.compactMap { theme in
            descendants(root).first { $0.accessibilityRole() == .radioButton && $0.accessibilityLabel() == theme.localizedName }
        }
        XCTAssertEqual(swatches.count, AccentTheme.all.count)
        guard swatches.count == AccentTheme.all.count else { return }
        XCTAssertTrue(swatches[1].accessibilityPerformPress())
        XCTAssertEqual(Appearance.theme.id, AccentTheme.sakura.id)
        XCTAssertEqual(swatches[1].accessibilityValue() as? Int, 1)
        XCTAssertTrue(window.firstResponder === swatches[1])
        let space = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero,
            modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil,
            characters: " ", charactersIgnoringModifiers: " ", isARepeat: false, keyCode: 49))
        swatches[2].keyDown(with: space)
        XCTAssertEqual(Appearance.theme.id, AccentTheme.matcha.id)
        XCTAssertEqual(swatches[2].accessibilityValue() as? Int, 1)
        XCTAssertEqual(swatches[1].accessibilityValue() as? Int, 0)
    }

    @MainActor private func descendants(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap { descendants($0) }
    }

    @MainActor func testSidebarActionsAndArrowKeysNavigateTheActualWindow() throws {
        let controller = MainSettingsWindowController()
        let window = try XCTUnwrap(controller.window)
        defer { window.close() }
        let root = try XCTUnwrap(window.contentView)
        let rows = descendants(root).filter { $0.accessibilityRole() == .radioButton }
        XCTAssertEqual(rows.count, MainSettingsWindowController.Page.allCases.count)
        XCTAssertEqual(rows.compactMap { $0.accessibilityLabel() },
                       MainSettingsWindowController.Page.allCases.map(\.localizedTitle))
        XCTAssertTrue(rows[1].accessibilityPerformPress())
        XCTAssertEqual(window.title, MainSettingsWindowController.Page.hotkeys.localizedTitle)
        XCTAssertTrue(window.firstResponder === rows[1])
        XCTAssertEqual(rows[1].accessibilityValue() as? Int, 1)
        XCTAssertEqual(rows[0].accessibilityValue() as? Int, 0)

        let down = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero,
            modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil,
            characters: "\u{F701}", charactersIgnoringModifiers: "\u{F701}", isARepeat: false, keyCode: 125))
        rows[1].keyDown(with: down)
        XCTAssertEqual(window.title, MainSettingsWindowController.Page.appearance.localizedTitle)
        XCTAssertTrue(window.firstResponder === rows[2])
        XCTAssertEqual(rows[2].accessibilityValue() as? Int, 1)
        XCTAssertEqual(rows[1].accessibilityValue() as? Int, 0)

        let disabled = try XCTUnwrap(rows[0] as? NSControl)
        disabled.isEnabled = false
        XCTAssertFalse(disabled.accessibilityPerformPress())
        XCTAssertFalse(disabled.canBecomeKeyView)
        XCTAssertEqual(window.title, MainSettingsWindowController.Page.appearance.localizedTitle)
    }
}
