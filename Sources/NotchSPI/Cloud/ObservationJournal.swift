import Foundation

struct ObservationPreference: Codable, Equatable {
    var consentEpoch: Int
    var sharingEnabled: Bool
    var validFrom: Date
    enum CodingKeys: String, CodingKey {
        case consentEpoch = "consent_epoch", sharingEnabled = "sharing_enabled", validFrom = "valid_from"
    }
}

struct ObservationCoverage: Codable, Equatable {
    let observationID: UUID
    let consentEpoch: Int
    let validFrom: Date
    let validTo: Date
    let sequenceFrom: Int
    let sequenceTo: Int
    let queueDropCount: Int
    let coverageStatus: String
    let gapReason: String
    enum CodingKeys: String, CodingKey {
        case observationID = "observation_id", consentEpoch = "consent_epoch", validFrom = "valid_from", validTo = "valid_to"
        case sequenceFrom = "sequence_from", sequenceTo = "sequence_to", queueDropCount = "queue_drop_count"
        case coverageStatus = "coverage_status", gapReason = "gap_reason"
    }
}

/// One atomic file owns both the queue and its proof of coverage. Preference metadata remains
/// when sharing is off; no product event or capture identifier remains in that state.
struct ObservationJournal: Codable {
    static let maximumCounter = 1_000_000_000
    var formatVersion = 1
    var preference: ObservationPreference
    var preferencePending = true
    var localPreferenceChange = false
    var adoptRemotePreference = true
    var scopeBinding: String?
    var nextSequence = 0
    var coveredThroughSequence = 0
    var coverageFrom: Date
    var totalDrops = 0
    var intervalDrops = 0
    var gapReason = "none"
    var gapRevision = 0
    var pendingCoverage: ObservationCoverage?
    var pendingGapRevision: Int?
    var queue: [ProductTelemetryEvent] = []
    var openCaptures: Set<UUID> = []
    var cleanShutdown = false

    init(sharingEnabled: Bool, now: Date) {
        preference = .init(consentEpoch: 0, sharingEnabled: sharingEnabled, validFrom: now)
        coverageFrom = now
    }

    mutating func gap(_ reason: String) {
        gapReason = reason
        gapRevision = min(Self.maximumCounter, gapRevision + 1)
    }

    mutating func resume(now: Date) {
        if !cleanShutdown || !openCaptures.isEmpty { gap("client_restart") }
        cleanShutdown = false
        openCaptures.removeAll()
        preferencePending = true
        prune(now: now)
    }

    mutating func setSharing(_ enabled: Bool, now: Date) {
        guard enabled != preference.sharingEnabled else { return }
        let epoch = min(Self.maximumCounter, preference.consentEpoch + 1)
        let binding = scopeBinding
        self = .init(sharingEnabled: enabled, now: now)
        preference.consentEpoch = epoch
        scopeBinding = binding
        localPreferenceChange = true
        adoptRemotePreference = false
    }

    mutating func bind(_ binding: String, now: Date) {
        if let previous = scopeBinding, previous != binding {
            let enabled = preference.sharingEnabled
            self = .init(sharingEnabled: enabled, now: now)
            gap("preference_unsynced")
        }
        scopeBinding = binding
    }

    /// Restoring a lost local journal must respect the account's last opt-out. An explicit
    /// local toggle is allowed to create a newer version, including after an offline interval.
    mutating func reconcilePreference(_ remote: ObservationPreference?, now: Date) {
        guard let remote else { adoptRemotePreference = false; return }
        if remote == preference {
            preferencePending = false
            localPreferenceChange = false
            adoptRemotePreference = false
            return
        }
        if adoptRemotePreference || (!localPreferenceChange && remote.consentEpoch >= preference.consentEpoch) {
            let binding = scopeBinding
            self = .init(sharingEnabled: remote.sharingEnabled, now: now)
            preference = remote.sharingEnabled
                ? .init(consentEpoch: min(Self.maximumCounter, remote.consentEpoch + 1), sharingEnabled: true, validFrom: now)
                : remote
            scopeBinding = binding
            preferencePending = remote.sharingEnabled
            adoptRemotePreference = false
            gap("client_restart")
        } else if remote.consentEpoch >= preference.consentEpoch {
            preference.consentEpoch = min(Self.maximumCounter, remote.consentEpoch + 1)
            queue = queue.map { old in
                var event = old
                event.consentEpoch = preference.consentEpoch
                return event
            }
            pendingCoverage = nil
            gap("preference_unsynced")
        }
    }

    mutating func append(_ original: ProductTelemetryEvent, now: Date) {
        guard preference.sharingEnabled else { return }
        guard nextSequence < Self.maximumCounter else { gap("sequence_gap"); return }
        prune(now: now)
        var event = original
        event.consentEpoch = preference.consentEpoch
        event.eventSequence = nextSequence
        nextSequence += 1
        if let id = event.captureID {
            if event.eventName == "capture_started" { openCaptures.insert(id) }
            if event.eventName == "capture_completed" { openCaptures.remove(id) }
        }
        queue.append(event)
        prune(now: now)
        if let index = queue.firstIndex(where: { $0.eventID == event.eventID }) {
            queue[index].queueDropCount = totalDrops
        }
    }

    mutating func prune(now: Date) {
        let retained = queue.filter {
            now.timeIntervalSince($0.occurredAt) <= 7 * 86_400 && $0.occurredAt.timeIntervalSince(now) <= 300
        }
        let future = queue.contains { $0.occurredAt.timeIntervalSince(now) > 300 }
        let bounded = Array(retained.suffix(100))
        let count = queue.count - bounded.count
        queue = bounded
        if count > 0 {
            totalDrops = min(Self.maximumCounter, totalDrops + count)
            intervalDrops = min(Self.maximumCounter, intervalDrops + count)
            gap(future ? "invalid_time" : "queue_drop")
        }
        // A long offline period has no timely coverage evidence. Leave that older interval
        // unobserved and resume from the portion the server can still verify.
        if now.timeIntervalSince(coverageFrom) > 7 * 86_400 {
            coverageFrom = now.addingTimeInterval(-7 * 86_400 + 1)
            pendingCoverage = nil
            gap("client_restart")
        }
    }

    mutating func acknowledgeEvents(_ batch: [ProductTelemetryEvent], rejected: Int) {
        let ids = Set(batch.map(\.eventID))
        queue.removeAll { ids.contains($0.eventID) }
        if rejected > 0 {
            totalDrops = min(Self.maximumCounter, totalDrops + rejected)
            intervalDrops = min(Self.maximumCounter, intervalDrops + rejected)
            gap("event_rejected")
        }
    }

    mutating func prepareCoverage(now: Date) -> ObservationCoverage? {
        guard preference.sharingEnabled else { return nil }
        if let pendingCoverage { return pendingCoverage }
        guard queue.isEmpty, now >= coverageFrom else { return nil }
        // Large offline backlogs still advance the coverage cursor, with an explicit gap.
        // Only bounded, fully receipted intervals may claim complete observation.
        if nextSequence - coveredThroughSequence > 10_000, gapReason == "none" { gap("sequence_gap") }
        let value = ObservationCoverage(observationID: UUID(), consentEpoch: preference.consentEpoch,
            validFrom: coverageFrom, validTo: now, sequenceFrom: coveredThroughSequence,
            sequenceTo: nextSequence, queueDropCount: intervalDrops,
            coverageStatus: gapReason == "none" ? "complete" : "partial", gapReason: gapReason)
        pendingCoverage = value
        pendingGapRevision = gapRevision
        return value
    }

    mutating func acknowledgeCoverage(_ value: ObservationCoverage) {
        guard pendingCoverage?.observationID == value.observationID,
              value.consentEpoch == preference.consentEpoch else { return }
        coveredThroughSequence = value.sequenceTo
        coverageFrom = value.validTo
        intervalDrops = max(0, intervalDrops - value.queueDropCount)
        if pendingGapRevision == gapRevision { gapReason = "none" }
        pendingCoverage = nil
        pendingGapRevision = nil
    }

    mutating func prepareShutdown() {
        cleanShutdown = openCaptures.isEmpty
        if !cleanShutdown { gap("client_restart") }
    }
}
