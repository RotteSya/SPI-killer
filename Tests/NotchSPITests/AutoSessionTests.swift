import XCTest
@testable import NotchSPI

/// The auto-session engine decides when a quota-costing capture fires with no human
/// in the loop — these tests pin down every transition so a regression can't silently
/// burn questions (double-trigger, trigger-on-noise) or wedge a session open.
@MainActor
final class AutoSessionTests: XCTestCase {
    private final class Clock {
        var now = Date(timeIntervalSince1970: 1_000)
        func advance(_ seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }
    }

    private func grid(_ value: UInt8) -> [UInt8] {
        [UInt8](repeating: value, count: ScreenHasher.gridW * ScreenHasher.gridH)
    }

    private func flipped(_ base: [UInt8], cells: Int, to value: UInt8) -> [UInt8] {
        var g = base
        for i in 0..<cells { g[i] = value }
        return g
    }

    /// Engine already started and one question answered — parked in .baselinePending.
    private func watchingEngine(
        clock: Clock = Clock(), maxQuestions: Int = 20
    ) -> AutoSessionEngine {
        let engine = AutoSessionEngine(now: { clock.now })
        engine.start(config: .init(maxQuestions: maxQuestions))
        XCTAssertEqual(engine.noteRunSucceeded(balanceQuestions: 100, credentialRejected: false), .none)
        return engine
    }

    // MARK: ScreenHasher

    func testIdenticalGridsHaveZeroDifferenceAndAreNotChanged() {
        let a = grid(100)
        XCTAssertEqual(ScreenHasher.difference(a, a), 0)
        XCTAssertFalse(ScreenHasher.changed(a, a))
    }

    func testUniformShiftWithinToleranceIsNotChanged() {
        XCTAssertFalse(ScreenHasher.changed(grid(100), grid(105)),
                       "a global +5 luma drift is capture noise, not a screen change")
    }

    func testSingleCellFlipIsBelowTheChangedThreshold() {
        let a = grid(100)
        XCTAssertFalse(ScreenHasher.changed(a, flipped(a, cells: 1, to: 255)),
                       "one cell (0.16% of the grid) must not read as a page change")
    }

    func testTwoPercentOfCellsBeyondToleranceIsChanged() {
        let a = grid(100)
        XCTAssertFalse(ScreenHasher.changed(a, flipped(a, cells: 12, to: 255)), "12/640 is under 2%")
        XCTAssertTrue(ScreenHasher.changed(a, flipped(a, cells: 13, to: 255)), "13/640 crosses 2%")
    }

    func testMismatchedLengthsCountAsFullyChanged() {
        XCTAssertEqual(ScreenHasher.difference(grid(100), [1, 2, 3]), 1)
        XCTAssertEqual(ScreenHasher.difference([], []), 1)
    }

    // MARK: Engine lifecycle

    func testStartThenFirstSuccessEntersBaselinePending() {
        let engine = AutoSessionEngine()
        engine.start(config: .init(maxQuestions: 20))
        XCTAssertEqual(engine.state, .running)
        XCTAssertEqual(engine.questionsAsked, 0)
        XCTAssertEqual(engine.noteRunSucceeded(balanceQuestions: 100, credentialRejected: false), .none)
        XCTAssertEqual(engine.questionsAsked, 1)
        XCTAssertEqual(engine.state, .baselinePending)
    }

    func testFirstTickOnlySetsTheBaselineAndNeverTriggers() {
        let engine = watchingEngine()
        XCTAssertEqual(engine.tick(hash: grid(100)), .none)
        XCTAssertEqual(engine.state, .watching)
    }

    func testUnchangedTicksNeverTrigger() {
        let engine = watchingEngine()
        for _ in 0..<100 {
            XCTAssertEqual(engine.tick(hash: grid(100)), .none)
        }
    }

    func testChangeThenTwoStableTicksTriggers() {
        let engine = watchingEngine()
        XCTAssertEqual(engine.tick(hash: grid(100)), .none)   // baseline
        XCTAssertEqual(engine.tick(hash: grid(200)), .none)   // changed seen
        XCTAssertEqual(engine.tick(hash: grid(200)), .none)   // stable 1
        XCTAssertEqual(engine.tick(hash: grid(200)), .trigger)
        XCTAssertEqual(engine.state, .running, "the trigger hands the moment back to the capture pipeline")
        XCTAssertEqual(engine.tick(hash: grid(200)), .none, "stray timer ticks while running are inert")
    }

    func testContinuousScrollingNeverTriggers() {
        let engine = watchingEngine()
        XCTAssertEqual(engine.tick(hash: grid(0)), .none)     // baseline
        for step in 1...60 {
            let value = UInt8(min(250, step * 40 % 251))
            XCTAssertEqual(engine.tick(hash: grid(value)), .none,
                           "every tick differs from the previous — still moving, no trigger")
        }
    }

    func testSettlingBackToTheBaselineRearmsInsteadOfTriggering() {
        let engine = watchingEngine()
        XCTAssertEqual(engine.tick(hash: grid(100)), .none)   // baseline
        XCTAssertEqual(engine.tick(hash: grid(200)), .none)   // banner appears
        XCTAssertEqual(engine.tick(hash: grid(100)), .none)   // banner gone (moving vs previous)
        XCTAssertEqual(engine.tick(hash: grid(100)), .none)   // stable 1
        XCTAssertEqual(engine.tick(hash: grid(100)), .none,
                       "settled back onto the baseline — must rearm, not burn a question")
        XCTAssertEqual(engine.state, .watching)
        XCTAssertEqual(engine.tick(hash: grid(200)), .none)   // real change
        XCTAssertEqual(engine.tick(hash: grid(200)), .none)
        XCTAssertEqual(engine.tick(hash: grid(200)), .trigger, "watching continued after the rearm")
    }

    // MARK: Stop conditions

    func testCapStopsExactlyAtTheLimit() {
        let engine = AutoSessionEngine()
        engine.start(config: .init(maxQuestions: 2))
        XCTAssertEqual(engine.noteRunSucceeded(balanceQuestions: 100, credentialRejected: false), .none)
        engine.tick(hash: grid(1))  // park in .watching; the trigger path re-enters .running
        engine.stop(reason: .userToggled)
        engine.start(config: .init(maxQuestions: 2))
        XCTAssertEqual(engine.noteRunSucceeded(balanceQuestions: 100, credentialRejected: false), .none)
        XCTAssertEqual(engine.noteRunSucceeded(balanceQuestions: 100, credentialRejected: false),
                       .stop(.questionCap(2)))
        XCTAssertFalse(engine.isActive)
    }

    func testZeroBalanceStopsAfterTheSuccessfulRun() {
        let engine = AutoSessionEngine()
        engine.start(config: .init(maxQuestions: 20))
        XCTAssertEqual(engine.noteRunSucceeded(balanceQuestions: 0, credentialRejected: false),
                       .stop(.quotaExhausted))
    }

    func testCredentialRejectionStopsAfterTheSuccessfulRun() {
        let engine = AutoSessionEngine()
        engine.start(config: .init(maxQuestions: 20))
        XCTAssertEqual(engine.noteRunSucceeded(balanceQuestions: nil, credentialRejected: true),
                       .stop(.quotaExhausted),
                       "a 401 wipes the cached balance to nil — the flag is the only remaining guard")
    }

    func testNilBalanceWithGoodCredentialContinues() {
        let engine = AutoSessionEngine()
        engine.start(config: .init(maxQuestions: 20))
        XCTAssertEqual(engine.noteRunSucceeded(balanceQuestions: nil, credentialRejected: false), .none,
                       "non-official channels have no balance and must keep working")
    }

    func testRunFailureStopsTheSessionAndLaterTicksAreInert() {
        let engine = watchingEngine()
        XCTAssertEqual(engine.tick(hash: grid(100)), .none)
        XCTAssertEqual(engine.noteRunFailed(), .stop(.runFailed))
        XCTAssertEqual(engine.tick(hash: grid(200)), .none)
        XCTAssertEqual(engine.noteRunFailed(), .none, "stopping twice must be harmless")
    }

    func testThreeConsecutiveHashFailuresStop() {
        let engine = watchingEngine()
        XCTAssertEqual(engine.tick(hash: nil), .none)
        XCTAssertEqual(engine.tick(hash: nil), .none)
        XCTAssertEqual(engine.tick(hash: nil), .stop(.hashFailures))
    }

    func testAHashSuccessBetweenFailuresResetsTheStreak() {
        let engine = watchingEngine()
        XCTAssertEqual(engine.tick(hash: nil), .none)
        XCTAssertEqual(engine.tick(hash: nil), .none)
        XCTAssertEqual(engine.tick(hash: grid(100)), .none)   // recovery resets the streak
        XCTAssertEqual(engine.tick(hash: nil), .none)
        XCTAssertEqual(engine.tick(hash: nil), .none)
        XCTAssertEqual(engine.tick(hash: nil), .stop(.hashFailures))
    }

    func testIdleTimeoutStopsAQuietWatch() {
        let clock = Clock()
        let engine = watchingEngine(clock: clock)
        XCTAssertEqual(engine.tick(hash: grid(100)), .none)
        clock.advance(15 * 60)
        XCTAssertEqual(engine.tick(hash: grid(100)), .stop(.idleTimeout))
    }

    // MARK: Paused ticks (截图目标锁定)

    func testPausedTicksNeverTriggerAndNeverCountAsHashFailures() {
        let engine = watchingEngine()
        XCTAssertEqual(engine.tick(hash: grid(100)), .none)   // baseline
        for _ in 0..<10 {
            XCTAssertEqual(engine.tickPaused(), .none, "a paused tick must be inert")
        }
        XCTAssertEqual(engine.tick(hash: nil), .none)
        XCTAssertEqual(engine.tick(hash: nil), .none,
                       "paused ticks must not have advanced the hash-failure streak")
    }

    func testPausedTicksStillHonorTheIdleTimeout() {
        let clock = Clock()
        let engine = watchingEngine(clock: clock)
        XCTAssertEqual(engine.tick(hash: grid(100)), .none)
        clock.advance(15 * 60)
        XCTAssertEqual(engine.tickPaused(), .stop(.idleTimeout),
                       "a session parked on another app must still die eventually")
    }

    func testWatchStateSurvivesAPauseSoReturningToTheSamePageRearms() {
        let engine = watchingEngine()
        XCTAssertEqual(engine.tick(hash: grid(100)), .none)   // baseline
        XCTAssertEqual(engine.tick(hash: grid(200)), .none)   // change seen just before the switch
        for _ in 0..<5 { XCTAssertEqual(engine.tickPaused(), .none) }
        XCTAssertEqual(engine.tick(hash: grid(100)), .none)   // back on the SAME page (≈ baseline)
        XCTAssertEqual(engine.tick(hash: grid(100)), .none)
        XCTAssertEqual(engine.tick(hash: grid(100)), .none, "settled onto the baseline — rearm, no trigger")
        XCTAssertEqual(engine.state, .watching)
        XCTAssertEqual(engine.tick(hash: grid(200)), .none)   // now a REAL new page
        XCTAssertEqual(engine.tick(hash: grid(200)), .none)
        XCTAssertEqual(engine.tick(hash: grid(200)), .trigger, "watching still works after the pause")
    }

    func testStopDuringARunMakesTheLateCompletionInert() {
        let engine = AutoSessionEngine()
        engine.start(config: .init(maxQuestions: 20))
        engine.stop(reason: .userToggled)
        XCTAssertEqual(engine.noteRunSucceeded(balanceQuestions: 100, credentialRejected: false), .none)
        XCTAssertEqual(engine.questionsAsked, 0, "a run finishing after the user stopped must not count")
        XCTAssertEqual(engine.lastStopReason, .userToggled, "the user's reason must not be overwritten")
    }

    func testClampMaxQuestionsBounds() {
        XCTAssertEqual(AutoSessionEngine.clampMaxQuestions(0), 20, "unset UserDefaults reads as 0")
        XCTAssertEqual(AutoSessionEngine.clampMaxQuestions(-5), 1)
        XCTAssertEqual(AutoSessionEngine.clampMaxQuestions(1), 1)
        XCTAssertEqual(AutoSessionEngine.clampMaxQuestions(20), 20)
        XCTAssertEqual(AutoSessionEngine.clampMaxQuestions(50), 50)
        XCTAssertEqual(AutoSessionEngine.clampMaxQuestions(999), 50)
    }
}
