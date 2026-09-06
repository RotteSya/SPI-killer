import XCTest
@testable import NotchSPI

final class ObservationJournalTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func event(_ id: UUID = UUID(), at date: Date? = nil, name: String = "capture_started") -> ProductTelemetryEvent {
        .init(eventID: id, captureID: UUID(), occurredAt: date ?? now, eventName: name,
              trigger: "capture_hotkey", channel: "official", mode: "tutor", depth: "brief",
              contextCount: 0, questionKind: nil, resultState: nil, parserPath: nil, errorCode: nil,
              action: nil, captureMs: nil, firstTokenMs: nil, totalMs: nil, configRevision: "test", variant: "control")
    }

    func testQueueAndSequenceSurviveTheSameAtomicSerialization() throws {
        var journal = ObservationJournal(sharingEnabled: true, now: now)
        journal.append(event(), now: now)
        journal.append(event(), now: now)
        let saved = try JSONEncoder().encode(journal)
        var restored = try JSONDecoder().decode(ObservationJournal.self, from: saved)
        XCTAssertEqual(restored.nextSequence, 2)
        XCTAssertEqual(restored.queue.map(\.eventSequence), [0, 1])
        XCTAssertNil(restored.prepareCoverage(now: now))
        restored.acknowledgeEvents(restored.queue, rejected: 0)
        let proof = try XCTUnwrap(restored.prepareCoverage(now: now))
        XCTAssertEqual(proof.sequenceFrom, 0)
        XCTAssertEqual(proof.sequenceTo, 2)
        XCTAssertEqual(proof.coverageStatus, "complete")
        XCTAssertEqual(restored.prepareCoverage(now: now.addingTimeInterval(2)), proof)
    }

    func testDroppedEventsCannotBecomeCompleteObservation() throws {
        var journal = ObservationJournal(sharingEnabled: true, now: now)
        for _ in 0..<105 { journal.append(event(), now: now) }
        XCTAssertEqual(journal.queue.count, 100)
        XCTAssertEqual(journal.queue.first?.eventSequence, 5)
        XCTAssertEqual(journal.totalDrops, 5)
        journal.acknowledgeEvents(journal.queue, rejected: 0)
        let proof = try XCTUnwrap(journal.prepareCoverage(now: now))
        XCTAssertEqual(proof.coverageStatus, "partial")
        XCTAssertEqual(proof.queueDropCount, 5)
        journal.acknowledgeCoverage(proof)
        XCTAssertEqual(journal.totalDrops, 5, "lifetime drop evidence is retained")
        XCTAssertEqual(journal.intervalDrops, 0)
        XCTAssertEqual(journal.prepareCoverage(now: now.addingTimeInterval(1))?.coverageStatus, "complete")
    }

    func testOptOutErasesQueuedEventsAndCaptureIdentifiers() throws {
        var journal = ObservationJournal(sharingEnabled: true, now: now)
        let value = event()
        journal.append(value, now: now)
        journal.setSharing(false, now: now.addingTimeInterval(1))
        journal.append(event(), now: now.addingTimeInterval(2))
        XCTAssertTrue(journal.queue.isEmpty)
        XCTAssertTrue(journal.openCaptures.isEmpty)
        XCTAssertNil(journal.prepareCoverage(now: now.addingTimeInterval(3)))
        let text = String(decoding: try JSONEncoder().encode(journal), as: UTF8.self)
        XCTAssertFalse(text.lowercased().contains(value.eventID.uuidString.lowercased()))
        XCTAssertFalse(text.lowercased().contains(value.captureID!.uuidString.lowercased()))
        XCTAssertTrue(journal.preferencePending)
    }

    func testLargeOfflineGapCanBeAcknowledgedWithoutStallingFutureCoverage() throws {
        var journal = ObservationJournal(sharingEnabled: true, now: now)
        journal.nextSequence = 20_001
        journal.intervalDrops = 19_901
        journal.totalDrops = 19_901
        journal.gap("queue_drop")
        let proof = try XCTUnwrap(journal.prepareCoverage(now: now))
        XCTAssertEqual(proof.coverageStatus, "partial")
        XCTAssertEqual(proof.sequenceTo, 20_001)
        journal.acknowledgeCoverage(proof)
        XCTAssertEqual(journal.prepareCoverage(now: now.addingTimeInterval(1))?.coverageStatus, "complete")
    }

    func testLostLocalStateRestoresOptOutAndNeverReusesAnEnabledSequenceNamespace() {
        var optedOut = ObservationJournal(sharingEnabled: true, now: now)
        optedOut.append(event(), now: now)
        optedOut.reconcilePreference(.init(consentEpoch: 7, sharingEnabled: false, validFrom: now.addingTimeInterval(-100)), now: now)
        XCTAssertFalse(optedOut.preference.sharingEnabled)
        XCTAssertTrue(optedOut.queue.isEmpty)
        XCTAssertFalse(optedOut.preferencePending)

        var enabled = ObservationJournal(sharingEnabled: true, now: now)
        enabled.reconcilePreference(.init(consentEpoch: 7, sharingEnabled: true, validFrom: now.addingTimeInterval(-100)), now: now)
        XCTAssertEqual(enabled.preference.consentEpoch, 8)
        XCTAssertTrue(enabled.preferencePending)
        XCTAssertEqual(enabled.gapReason, "client_restart")
    }

    func testExplicitOfflineToggleRebasesToANewerConsentVersion() {
        var journal = ObservationJournal(sharingEnabled: true, now: now)
        journal.setSharing(false, now: now)
        journal.setSharing(true, now: now.addingTimeInterval(1))
        journal.append(event(at: now.addingTimeInterval(2)), now: now.addingTimeInterval(2))
        journal.reconcilePreference(.init(consentEpoch: 8, sharingEnabled: false, validFrom: now), now: now.addingTimeInterval(3))
        XCTAssertEqual(journal.preference.consentEpoch, 9)
        XCTAssertTrue(journal.preference.sharingEnabled)
        XCTAssertEqual(journal.queue.first?.consentEpoch, 9)
        XCTAssertEqual(journal.gapReason, "preference_unsynced")
    }

    func testCoverageAcknowledgmentCannotClearANewerGapOrNewEvents() throws {
        var journal = ObservationJournal(sharingEnabled: true, now: now)
        let proof = try XCTUnwrap(journal.prepareCoverage(now: now.addingTimeInterval(1)))
        let newer = event(at: now.addingTimeInterval(2))
        journal.append(newer, now: now.addingTimeInterval(2))
        journal.gap("storage_failure")
        journal.acknowledgeCoverage(proof)
        XCTAssertEqual(journal.coveredThroughSequence, 0)
        XCTAssertEqual(journal.queue.first?.eventID, newer.eventID)
        XCTAssertEqual(journal.gapReason, "storage_failure")
    }

    func testCrashAndChangedAccountLeaveUnknownIntervals() {
        var journal = ObservationJournal(sharingEnabled: true, now: now)
        journal.bind("first-account", now: now)
        journal.append(event(), now: now)
        journal.resume(now: now.addingTimeInterval(10))
        XCTAssertEqual(journal.gapReason, "client_restart")
        journal.bind("another-account", now: now.addingTimeInterval(20))
        XCTAssertTrue(journal.queue.isEmpty)
        XCTAssertEqual(journal.nextSequence, 0)
        XCTAssertEqual(journal.gapReason, "preference_unsynced")
    }

    func testExpiredAndFutureEventsAreDiscardedWithEvidence() {
        var journal = ObservationJournal(sharingEnabled: true, now: now)
        journal.append(event(at: now.addingTimeInterval(-8 * 86_400)), now: now)
        journal.append(event(at: now.addingTimeInterval(400)), now: now)
        XCTAssertTrue(journal.queue.isEmpty)
        XCTAssertEqual(journal.totalDrops, 2)
        XCTAssertEqual(journal.gapReason, "invalid_time")
        XCTAssertEqual(journal.nextSequence, 2)
    }
}
