import Foundation

/// Owns the cancellable preparation phase, before a network runner takes ownership.
@MainActor
final class CapturePreparationTask {
    private var task: Task<Void, Never>?
    private var generation = UUID()

    @discardableResult
    func start(_ operation: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        cancel()
        let expected = generation
        let next = Task { [weak self] in
            guard self?.generation == expected, !Task.isCancelled else { return }
            defer {
                // A late completion must never forget a replacement task's handle.
                if self?.generation == expected { self?.task = nil }
            }
            await operation()
        }
        task = next
        return next
    }

    func cancel() {
        generation = UUID()
        task?.cancel()
        task = nil
    }

    deinit { task?.cancel() }
}
