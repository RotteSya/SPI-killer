import Foundation

enum CaptureSystemOperationError: Error { case timedOut, busy }

/// Bounds callers' waits without assuming that a system API obeys Task cancellation.
/// One underlying operation remains occupied until its actual callback returns. Late
/// results have no callers to resume, so they cannot trigger downstream image writes.
@MainActor
final class CaptureSystemOperation<Value> {
    private struct Waiter {
        let continuation: CheckedContinuation<Value, Error>
        let deadline: Task<Void, Never>
    }
    private let coalescesRequests: Bool
    private var active: UUID?
    private var waiters: [UUID: Waiter] = [:]

    init(coalescesRequests: Bool = false) { self.coalescesRequests = coalescesRequests }

    func run(timeout: Duration = .seconds(10),
             operation: @escaping @MainActor () async throws -> Value) async throws -> Value {
        try Task.checkCancellation()
        if active != nil && !coalescesRequests { throw CaptureSystemOperationError.busy }
        let waiterID = UUID()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let deadline = Task { [weak self] in
                    do { try await Task.sleep(for: timeout) } catch { return }
                    self?.finishWaiter(waiterID, result: .failure(CaptureSystemOperationError.timedOut))
                }
                waiters[waiterID] = Waiter(continuation: continuation, deadline: deadline)
                if active == nil {
                    let operationID = UUID()
                    active = operationID
                    Task {
                        let result: Result<Value, Error>
                        do { result = .success(try await operation()) }
                        catch { result = .failure(error) }
                        guard active == operationID else { return }
                        active = nil
                        let completed = waiters
                        waiters.removeAll()
                        for waiter in completed.values {
                            waiter.deadline.cancel()
                            waiter.continuation.resume(with: result)
                        }
                    }
                }
            }
        } onCancel: {
            Task { @MainActor in
                self.finishWaiter(waiterID, result: .failure(CancellationError()))
            }
        }
    }

    private func finishWaiter(_ id: UUID, result: Result<Value, Error>) {
        guard let waiter = waiters.removeValue(forKey: id) else { return }
        waiter.deadline.cancel()
        waiter.continuation.resume(with: result)
    }
}
