import XCTest
@testable import NotchSPI

final class CaptureSystemOperationTests: XCTestCase {
    @MainActor func testTimeoutKeepsUncooperativeOperationOccupiedAndDiscardsLateDelivery() async throws {
        let gate = CaptureSystemOperation<Int>()
        let started = expectation(description: "system operation started")
        let completed = expectation(description: "system operation completed")
        var callback: CheckedContinuation<Int, Never>?
        var delivered = false
        let first = Task {
            let value = try await gate.run(timeout: .milliseconds(40)) {
                let result = await withCheckedContinuation { callback = $0; started.fulfill() }
                completed.fulfill()
                return result
            }
            delivered = true
            return value
        }
        await fulfillment(of: [started], timeout: 2)
        do { _ = try await first.value; XCTFail("stalled request succeeded") }
        catch CaptureSystemOperationError.timedOut { }
        do { _ = try await gate.run { XCTFail("overlapping API invocation"); return 2 }; XCTFail("busy request succeeded") }
        catch CaptureSystemOperationError.busy { }
        callback?.resume(returning: 1)
        await fulfillment(of: [completed], timeout: 2)
        XCTAssertFalse(delivered, "late results cannot reach image encoding or sending")
        let next = try await gate.run { 3 }
        XCTAssertEqual(next, 3)
    }

    @MainActor func testCoalescedCallersHaveIndependentDeadlinesAndUseOnlyOneEnumeration() async throws {
        let gate = CaptureSystemOperation<Int>(coalescesRequests: true)
        let started = expectation(description: "enumeration started")
        var callback: CheckedContinuation<Int, Never>?
        var starts = 0
        let first = Task {
            try await gate.run(timeout: .milliseconds(40)) {
                starts += 1
                return await withCheckedContinuation { callback = $0; started.fulfill() }
            }
        }
        await fulfillment(of: [started], timeout: 2)
        let second = Task {
            try await gate.run(timeout: .seconds(2)) { starts += 1; return -1 }
        }
        do { _ = try await first.value; XCTFail("first caller missed its deadline") }
        catch CaptureSystemOperationError.timedOut { }
        callback?.resume(returning: 7)
        let value = try await second.value
        XCTAssertEqual(value, 7)
        XCTAssertEqual(starts, 1)
    }

    @MainActor func testCancellationReturnsWithoutWaitingForSystemCallback() async throws {
        let gate = CaptureSystemOperation<Int>()
        let started = expectation(description: "system operation started")
        let completed = expectation(description: "system operation completed")
        var callback: CheckedContinuation<Int, Never>?
        let first = Task {
            try await gate.run {
                let result = await withCheckedContinuation { callback = $0; started.fulfill() }
                completed.fulfill()
                return result
            }
        }
        await fulfillment(of: [started], timeout: 2)
        first.cancel()
        do { _ = try await first.value; XCTFail("cancelled request succeeded") }
        catch is CancellationError { }
        do { _ = try await gate.run { XCTFail("cancelled API still occupies its slot"); return 2 }; XCTFail("busy request succeeded") }
        catch CaptureSystemOperationError.busy { }
        callback?.resume(returning: 1)
        await fulfillment(of: [completed], timeout: 2)
        let next = try await gate.run { 4 }
        XCTAssertEqual(next, 4)
    }

    @MainActor func testAlreadyCancelledCallerNeverStartsSystemWorkAndImmediateResultsReleaseSlot() async throws {
        let gate = CaptureSystemOperation<Int>()
        let task = Task { try await gate.run { XCTFail("cancelled work started"); return 1 } }
        task.cancel()
        do { _ = try await task.value; XCTFail("cancelled request succeeded") }
        catch is CancellationError { }
        let first = try await gate.run { 2 }
        let second = try await gate.run { 3 }
        XCTAssertEqual(first, 2)
        XCTAssertEqual(second, 3)
    }
}
