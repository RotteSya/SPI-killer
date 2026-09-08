import AppKit
import XCTest
@testable import NotchSPI

final class AnswerAccessibilityTests: XCTestCase {
    @MainActor func testSpeechUsesComposedTextAndHonorsReasoningFold() throws {
        let view = StreamingAnswerView()
        let raw = "需要计算的过程\nFINAL: **B**"
        let folded = NotchType.answerString(raw, presentation: .init(mode: "tutor", depth: "brief", finished: true, revealed: false))
        view.setAnswer(folded, isPlaceholder: false)
        XCTAssertTrue(view.isAccessibilityElement())
        XCTAssertEqual(view.accessibilityValue() as? String, folded.string)
        let spoken = try XCTUnwrap(view.accessibilityValue() as? String)
        XCTAssertTrue(spoken.contains("B"))
        XCTAssertFalse(spoken.contains("FINAL:"))
        XCTAssertFalse(spoken.contains("需要计算的过程"))
        let expanded = NotchType.answerString(raw, presentation: .init(mode: "tutor", depth: "brief", finished: true, revealed: true))
        view.setAnswer(expanded, isPlaceholder: false)
        XCTAssertEqual(view.accessibilityValue() as? String, expanded.string)
        XCTAssertTrue((view.accessibilityValue() as? String)?.contains("需要计算的过程") == true)
    }

    @MainActor func testActionsCallExistingHandlersAndRecheckAvailability() throws {
        let view = StreamingAnswerView()
        var allowed = true, copies = 0, toggles = 0
        view.canCopyAnswer = { allowed }
        view.onCopyAnswer = { copies += 1 }
        view.onToggleReasoning = { toggles += 1 }
        view.setAnswer(NotchType.answerString("过程\nFINAL: B", presentation: .init(mode: "tutor", depth: "brief", finished: true, revealed: false)), isPlaceholder: false)
        let actions = try XCTUnwrap(view.accessibilityCustomActions())
        XCTAssertEqual(actions.count, 2)
        XCTAssertTrue(try XCTUnwrap(actions.first?.handler)())
        XCTAssertTrue(try XCTUnwrap(actions.last?.handler)())
        XCTAssertEqual(copies, 1); XCTAssertEqual(toggles, 1)
        allowed = false
        XCTAssertFalse(try XCTUnwrap(actions.first?.handler)())
        view.setAnswer(NotchType.placeholderLine(mode: "tutor"), isPlaceholder: true)
        XCTAssertNil(view.accessibilityCustomActions())
        XCTAssertFalse(try XCTUnwrap(actions.last?.handler)())
        XCTAssertEqual(copies, 1); XCTAssertEqual(toggles, 1)
    }
}
