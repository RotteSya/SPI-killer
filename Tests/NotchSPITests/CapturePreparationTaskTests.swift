import XCTest
@testable import NotchSPI

final class CapturePreparationTaskTests: XCTestCase {
    @MainActor func testCancellationBeforeExecutionDoesNotStartCaptureWork() async {
        let owner = CapturePreparationTask()
        var started = false
        let task = owner.start { started = true }
        owner.cancel()
        await task.value
        XCTAssertFalse(started)
    }

    @MainActor func testClearingWhileEnumeratingPreventsTheImageAndRequestStages() async {
        let owner = CapturePreparationTask()
        let enumeration = CaptureSystemOperation<Int>(coalescesRequests: true)
        let started = expectation(description: "system enumeration started")
        let completed = expectation(description: "system enumeration returned late")
        var callback: CheckedContinuation<Int, Never>?
        var captured = false, sent = false, cancelled = false
        let task = owner.start {
            do {
                _ = try await enumeration.run {
                    let value = await withCheckedContinuation { callback = $0; started.fulfill() }
                    completed.fulfill()
                    return value
                }
                captured = true
                sent = true
            } catch is CancellationError { cancelled = true }
            catch { XCTFail("unexpected error: \(error)") }
        }
        await fulfillment(of: [started], timeout: 2)
        owner.cancel()
        await task.value
        XCTAssertTrue(cancelled)
        callback?.resume(returning: 1)
        await fulfillment(of: [completed], timeout: 2)
        XCTAssertFalse(captured)
        XCTAssertFalse(sent)
    }

    @MainActor func testLateOldCompletionCannotClearTheReplacementCancellationHandle() async {
        let owner = CapturePreparationTask()
        let oldStarted = expectation(description: "old preparation started")
        var oldCallback: CheckedContinuation<Void, Never>?
        let old = owner.start {
            await withCheckedContinuation { oldCallback = $0; oldStarted.fulfill() }
        }
        await fulfillment(of: [oldStarted], timeout: 2)
        let replacementStarted = expectation(description: "replacement started")
        let replacementSystem = CaptureSystemOperation<Int>()
        var newCallback: CheckedContinuation<Int, Never>?
        var replacementCancelled = false
        let replacement = owner.start {
            do {
                _ = try await replacementSystem.run {
                    await withCheckedContinuation { newCallback = $0; replacementStarted.fulfill() }
                }
            } catch is CancellationError { replacementCancelled = true }
            catch { XCTFail("unexpected error: \(error)") }
        }
        await fulfillment(of: [replacementStarted], timeout: 2)
        oldCallback?.resume()
        await old.value
        owner.cancel()
        await replacement.value
        XCTAssertTrue(replacementCancelled)
        newCallback?.resume(returning: 1)
    }
}
