import XCTest
import Carbon.HIToolbox
@testable import NotchSPI

/// A combo that another app already owns registers successfully for exactly one process; the
/// loser learns of it only through a return code, and its keystroke then goes nowhere forever.
/// These tests pin the reporting of that verdict — the failure mode it exists to prevent is a
/// user pressing keys into silence with nothing on screen ever mentioning it.
///
/// The conflict is reproduced in-process by claiming the same combo twice, which is the same
/// `RegisterEventHotKey` refusal a cross-app collision produces.
final class HotkeyConflictTests: XCTestCase {

    // F13–F15 with all four modifiers: not a system shortcut, and nothing on a normal Mac
    // competes for it, so the FIRST registration in each test is expected to succeed.
    private let allMods = UInt32(cmdKey | shiftKey | optionKey | controlKey)

    override func tearDown() {
        HotKeyCenter.shared.unregisterAll()
        super.tearDown()
    }

    func testFirstClaimSucceedsAndReportsNoConflict() {
        let ok = HotKeyCenter.shared.register(
            role: .capture, keyCode: UInt32(kVK_F13), modifiers: allMods) {}
        XCTAssertTrue(ok, "an uncontested combo must register")
        XCTAssertFalse(HotKeyCenter.shared.conflicted.contains(.capture))
    }

    func testSecondClaimOfTheSameComboIsReportedAsConflicted() {
        XCTAssertTrue(HotKeyCenter.shared.register(
            role: .capture, keyCode: UInt32(kVK_F14), modifiers: allMods) {})

        let ok = HotKeyCenter.shared.register(
            role: .personality, keyCode: UInt32(kVK_F14), modifiers: allMods) {}

        XCTAssertFalse(ok, "a combo already claimed cannot be claimed again")
        XCTAssertTrue(HotKeyCenter.shared.conflicted.contains(.personality),
                      "the losing ROLE is what the UI needs to point at")
        XCTAssertFalse(HotKeyCenter.shared.conflicted.contains(.capture),
                       "the role that won must not be blamed")
    }

    func testConflictChangeIsAnnouncedSoOpenUIRepaints() {
        XCTAssertTrue(HotKeyCenter.shared.register(
            role: .capture, keyCode: UInt32(kVK_F15), modifiers: allMods) {})

        let announced = expectation(description: "conflictsDidChange posted")
        let observer = NotificationCenter.default.addObserver(
            forName: HotKeyCenter.conflictsDidChange, object: nil, queue: .main
        ) { _ in announced.fulfill() }
        defer { NotificationCenter.default.removeObserver(observer) }

        HotKeyCenter.shared.register(
            role: .toggle, keyCode: UInt32(kVK_F15), modifiers: allMods) {}

        wait(for: [announced], timeout: 2)
    }

    func testUnregisterAllClearsStaleVerdicts() {
        HotKeyCenter.shared.register(role: .capture, keyCode: UInt32(kVK_F13), modifiers: allMods) {}
        HotKeyCenter.shared.register(role: .toggle, keyCode: UInt32(kVK_F13), modifiers: allMods) {}
        XCTAssertFalse(HotKeyCenter.shared.conflicted.isEmpty)

        // Re-registration starts from a clean slate: a verdict about combos we no longer hold
        // would keep a fixed hotkey looking broken.
        HotKeyCenter.shared.unregisterAll()
        XCTAssertTrue(HotKeyCenter.shared.conflicted.isEmpty)
    }
}
