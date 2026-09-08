import AppKit
import XCTest
@testable import NotchSPI

final class OnboardingAccessibilityTests: XCTestCase {
    @MainActor func testGrantedBalanceIsReadableWithoutFollowingAnimationFrames() {
        let balance = DigitOdometerView()
        balance.suffix = "questions"
        balance.setImmediate(30)
        XCTAssertTrue(balance.isAccessibilityElement())
        XCTAssertEqual(balance.accessibilityRole(), .staticText)
        XCTAssertEqual(balance.accessibilityLabel(), "30 questions")
        balance.suffix = "题"
        XCTAssertEqual(balance.accessibilityLabel(), "30 题")
    }

    @MainActor func testActionAndConfirmationExposeDifferentSemantics() {
        var clicks = 0
        let button = GlowButton(title: "Continue", action: { clicks += 1 })
        XCTAssertTrue(button.isAccessibilityElement())
        XCTAssertEqual(button.accessibilityRole(), .button)
        XCTAssertEqual(button.accessibilityLabel(), "Continue")
        XCTAssertTrue(button.acceptsFirstResponder)
        XCTAssertTrue(button.accessibilityPerformPress())
        XCTAssertEqual(clicks, 1)
        button.isEnabled = false
        XCTAssertFalse(button.accessibilityPerformPress())
        button.isEnabled = true
        button.style = .confirm
        XCTAssertEqual(button.accessibilityRole(), .staticText)
        XCTAssertFalse(button.acceptsFirstResponder)
        XCTAssertFalse(button.accessibilityPerformPress())
        button.style = .primary
        button.isHidden = true
        XCTAssertFalse(button.accessibilityPerformPress())
        XCTAssertEqual(clicks, 1)
    }

    @MainActor func testLanguageSelectionExposesStateAndRespectsDisabledControls() {
        let language = AppLanguage.allCases[0]
        let pill = LanguagePill(language: language)
        var selected: AppLanguage?
        pill.onPick = { selected = $0 }
        XCTAssertEqual(pill.accessibilityRole(), .radioButton)
        XCTAssertEqual(pill.accessibilityLabel(), language.pickerLabel)
        XCTAssertEqual(pill.accessibilityValue() as? Int, 0)
        XCTAssertTrue(pill.accessibilityPerformPress())
        XCTAssertEqual(selected, language)
        pill.isChosen = true
        XCTAssertEqual(pill.accessibilityValue() as? Int, 1)
        selected = nil
        pill.isEnabled = false
        XCTAssertFalse(pill.acceptsFirstResponder)
        XCTAssertFalse(pill.accessibilityPerformPress())
        XCTAssertNil(selected)
    }
}
