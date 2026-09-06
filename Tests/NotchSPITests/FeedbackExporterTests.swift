import XCTest
import AppKit
import CryptoKit
@testable import NotchSPI

final class FeedbackExporterTests: XCTestCase {
    private func fixture(_ body: (URL, QuestionCaptureSnapshot) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("feedback-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let sessionID = UUID()
        let assets = try [0, 1].map { index -> ContextAsset in
            let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2,
                bitsPerSample: 8, samplesPerPixel: 3, hasAlpha: false, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
            let pixels = try XCTUnwrap(bitmap.bitmapData)
            pixels.initialize(repeating: index == 0 ? 255 : 0, count: bitmap.bytesPerRow * bitmap.pixelsHigh)
            let data = try XCTUnwrap(bitmap.representation(using: .jpeg, properties: [:]))
            let source = root.appendingPathComponent("source-\(index).jpg"); try data.write(to: source)
            return ContextAsset(id: UUID(), sessionID: sessionID, file: QuestionAssetFile(url: source),
                sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), width: 2, height: 2,
                byteCount: data.count, targetFingerprint: "screen", capturedAt: Date())
        }
        try body(root, .init(captureID: UUID(), sessionID: sessionID, generation: 1, assets: assets, expiresAt: Date().addingTimeInterval(60)))
    }
    private func read(_ url: URL) throws -> FeedbackExportManifest {
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(FeedbackExportManifest.self, from: Data(contentsOf: url))
    }
    private func export(_ snapshot: QuestionCaptureSnapshot, to url: URL, selected: Set<UUID>? = nil,
                        authorization: FeedbackAuthorization = .init(purpose: .supportReview, rightsConfirmed: true)) throws -> UUID {
        try FeedbackExporter.write(snapshot: snapshot, answer: "B", standardAnswer: "B",
            selectedAssetIDs: selected ?? Set(snapshot.assets.map(\.id)), authorization: authorization, to: url)
    }
    func testExportBindsExplicitPermissionAndCopiesOnlySelectedVerifiedAssets() throws {
        try fixture { root, snapshot in
            let url = root.appendingPathComponent("feedback.json"), selected = snapshot.assets[1]
            let id = try export(snapshot, to: url, selected: [selected.id])
            let manifest = try read(url)
            XCTAssertEqual(manifest.submissionID, id); XCTAssertEqual(manifest.authorizationVersion, "feedback-v2")
            XCTAssertEqual(manifest.authorization.purpose, .supportReview); XCTAssertEqual(manifest.purpose, "support_review")
            XCTAssertTrue(manifest.authorization.rightsConfirmed)
            XCTAssertEqual(manifest.authorization.externalProcessing, "requires_separate_permission")
            XCTAssertEqual(manifest.authorization.expiresAt.timeIntervalSince(manifest.authorization.authorizedAt), 90 * 86_400)
            XCTAssertEqual(manifest.assets.map(\.role), ["question"]); XCTAssertEqual(manifest.assets[0].sha256, selected.sha256)
            XCTAssertEqual(manifest.answer, "B"); XCTAssertEqual(manifest.standardAnswer, "B")
            let assetURL = root.appendingPathComponent(manifest.assets[0].file)
            XCTAssertEqual(try Data(contentsOf: assetURL), try Data(contentsOf: selected.file.url))
            XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
            XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: assetURL.deletingLastPathComponent().path)[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        }
    }
    func testNoConsentExpiredConsentAndExpiredSnapshotCannotWriteAnything() throws {
        try fixture { root, snapshot in
            let url = root.appendingPathComponent("feedback.json")
            XCTAssertThrowsError(try export(snapshot, to: url, authorization: .init(purpose: .qualityEvaluation, rightsConfirmed: false)))
            XCTAssertThrowsError(try export(snapshot, to: url, authorization: .init(purpose: .qualityEvaluation, rightsConfirmed: true, now: Date().addingTimeInterval(-91 * 86_400))))
            let expired = QuestionCaptureSnapshot(captureID: snapshot.captureID, sessionID: snapshot.sessionID, generation: snapshot.generation,
                assets: snapshot.assets, expiresAt: .distantPast)
            XCTAssertThrowsError(try export(expired, to: url))
            XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path).filter { $0.hasPrefix("notchspi-feedback-") }, [])
        }
    }
    func testChangedMaterialRollsBackFilesAndPreservesAnExistingManifest() throws {
        try fixture { root, snapshot in
            let url = root.appendingPathComponent("feedback.json"); try Data("original".utf8).write(to: url)
            try Data("replaced private material".utf8).write(to: snapshot.assets[1].file.url)
            XCTAssertThrowsError(try export(snapshot, to: url))
            XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "original")
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path).filter { $0.hasPrefix("notchspi-feedback-") }, [])
        }
    }
    func testExplicitTextOnlyExportAndOverwritingNeverReuseAnOlderAssetSet() throws {
        try fixture { root, snapshot in
            let url = root.appendingPathComponent("feedback.json")
            _ = try export(snapshot, to: url); let old = try read(url)
            _ = try export(snapshot, to: url, selected: []); let new = try read(url)
            XCTAssertNotEqual(old.submissionID, new.submissionID); XCTAssertTrue(new.assets.isEmpty)
            XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent(old.assets[0].file).path))
        }
    }
    func testFailedCommitRemovesTheNewPackageAndUnknownSelectionIsRejected() throws {
        try fixture { root, snapshot in
            let destination = root.appendingPathComponent("existing-directory")
            try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: false)
            XCTAssertThrowsError(try export(snapshot, to: destination))
            XCTAssertThrowsError(try export(snapshot, to: root.appendingPathComponent("feedback.json"), selected: [UUID()]))
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path).filter { $0.hasPrefix("notchspi-feedback-") }, [])
        }
    }
}
