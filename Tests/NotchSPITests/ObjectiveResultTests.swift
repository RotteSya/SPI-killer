import XCTest
import CryptoKit
@testable import NotchSPI

final class ObjectiveResultTests: XCTestCase {
    private struct Fixture: Decodable {
        let id: String
        let raw: String
        let path: String
        let state: String?
        let violations: [String]
    }

    private struct ObjectiveManifest: Decodable {
        let schemaVersion: Int
        let fixtures: [ObjectiveFixture]
        enum CodingKeys: String, CodingKey { case schemaVersion = "schema_version", fixtures }
    }
    private struct ObjectiveFixture: Decodable {
        let id: String
        let language: String
        let kind: String
        let expectedState: String
        let acceptedAnswers: [String]
        let image: String
        let sha256: String
        enum CodingKeys: String, CodingKey {
            case id, language, kind, image, sha256
            case expectedState = "expected_state", acceptedAnswers = "accepted_answers"
        }
    }

    func testSharedGoldenFixtures() throws {
        let url = try XCTUnwrap(Bundle.module.url(
            forResource: "cases", withExtension: "json", subdirectory: "Fixtures/objective-result-v1"))
        let fixtures = try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: url))
        XCTAssertGreaterThanOrEqual(fixtures.count, 12)
        for fixture in fixtures {
            let parsed = ObjectiveResultParser.compose(raw: fixture.raw)
            XCTAssertEqual(parsed.parserPath.rawValue, fixture.path, fixture.id)
            XCTAssertEqual(parsed.state?.rawValue, fixture.state, fixture.id)
            for violation in fixture.violations {
                XCTAssertTrue(parsed.violations.map(\.rawValue).contains(violation), fixture.id)
            }
            XCTAssertFalse(parsed.visibleText.contains(ObjectiveResultParser.marker), fixture.id)
        }
    }

    func testEveryMarkerCharacterBoundaryStaysHidden() {
        let raw = "work\nFINAL: B\nNSPI_RESULT_V1: {\"v\":1,\"kind\":\"single_choice\",\"state\":\"ready\",\"answer\":\"B\",\"reason\":\"none\"}"
        var filter = ObjectiveResultStreamFilter()
        for character in raw {
            let visible = filter.append(String(character))
            XCTAssertFalse(visible.contains("NSPI_RESULT_V1"))
        }
        XCTAssertEqual(filter.finish().parserPath, .v1)
    }

    func testNormalizationAndRetakeContract() {
        XCTAssertEqual(ObjectiveResultParser.normalizeAnswer(" **ｂ** "), "B")
        let parsed = ObjectiveResultParser.compose(raw:
            "NSPI_RESULT_V1: {\"v\":1,\"kind\":\"short_fill\",\"state\":\"retake\",\"answer\":null,\"reason\":\"unreadable\"}")
        XCTAssertEqual(parsed.state, .retake)
        XCTAssertNil(parsed.finalAnswer)
    }

    func testOfficialRequestAddsOptionalProtocolFieldsOnlyWhenProvided() throws {
        let legacy = OfficialAPI.makeCaptureRequest(
            baseURL: "https://example.com", deviceToken: "dev_token", prompt: .init(system: "s", task: "t"),
            imagesBase64: ["abc"])
        let legacyJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(legacy.httpBody)) as? [String: Any])
        XCTAssertNil(legacyJSON["result_protocol"])
        XCTAssertNil(legacyJSON["capture_id"])

        let id = UUID(uuidString: "3e7979c6-20cb-4c12-a23e-ece6eb3aa52d")!
        let objective = OfficialAPI.makeCaptureRequest(
            baseURL: "https://example.com", deviceToken: "dev_token", prompt: .init(system: "s", task: "t"),
            imagesBase64: ["abc"], resultProtocol: "objective_v1", captureID: id)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(objective.httpBody)) as? [String: Any])
        XCTAssertEqual(json["result_protocol"] as? String, "objective_v1")
        XCTAssertEqual(json["capture_id"] as? String, id.uuidString.lowercased())
    }

    func testObjectiveEvaluationManifestHas240VerifiedImagesAndExactMatrix() throws {
        let manifestURL = try XCTUnwrap(Bundle.module.url(
            forResource: "manifest", withExtension: "json", subdirectory: "Fixtures/objective-v1"))
        let manifest = try JSONDecoder().decode(ObjectiveManifest.self, from: Data(contentsOf: manifestURL))
        XCTAssertEqual(manifest.schemaVersion, 1)
        XCTAssertEqual(manifest.fixtures.count, 240)
        XCTAssertEqual(Set(manifest.fixtures.map(\.id)).count, 240)
        for language in ["zh", "ja", "en"] {
            for kind in ["single_choice", "multiple_choice", "ordering", "short_fill"] {
                let group = manifest.fixtures.filter { $0.language == language && $0.kind == kind }
                XCTAssertEqual(group.count, 20, "\(language)/\(kind)")
                XCTAssertEqual(group.filter { $0.expectedState == "ready" }.count, 14)
                XCTAssertEqual(group.filter { $0.expectedState == "review" }.count, 3)
                XCTAssertEqual(group.filter { $0.expectedState == "retake" }.count, 3)
            }
        }
        let root = manifestURL.deletingLastPathComponent()
        for fixture in manifest.fixtures {
            let data = try Data(contentsOf: root.appendingPathComponent(fixture.image))
            XCTAssertEqual(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), fixture.sha256, fixture.id)
            if fixture.expectedState == "retake" { XCTAssertTrue(fixture.acceptedAnswers.isEmpty) }
            else { XCTAssertFalse(fixture.acceptedAnswers.isEmpty) }
        }
    }

    func testTelemetryQueueDropsExpiredAndKeepsNewestHundred() {
        let now = Date()
        let events = (0..<120).map { index in
            ProductTelemetryEvent(
                eventID: UUID(), captureID: nil,
                occurredAt: index == 0 ? now.addingTimeInterval(-8 * 86_400) : now,
                eventName: "capture_started", trigger: nil, channel: nil, mode: nil, depth: nil,
                contextCount: nil, questionKind: nil, resultState: nil, parserPath: nil,
                errorCode: nil, action: nil, captureMs: nil, firstTokenMs: nil, totalMs: nil,
                configRevision: nil, variant: nil)
        }
        let pruned = ProductTelemetry.pruned(events, now: now)
        XCTAssertEqual(pruned.count, 100)
        XCTAssertFalse(pruned.contains { $0.eventID == events[0].eventID })
        XCTAssertEqual(pruned.last?.eventID, events.last?.eventID)
    }
}
