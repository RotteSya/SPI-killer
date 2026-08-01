import Combine

/// Observable state the notch renders. Mutated on the main thread by the controller's pipeline.
/// `ObservableObject` / `@Published` are Combine types — the notch is pure AppKit and observes
/// this via `objectWillChange`, no SwiftUI involved.
@MainActor
final class TutorModel: ObservableObject {
    enum Status {
        case idle, ready, running, streaming, error
    }

    // Display strings start empty and are populated by NotchController from L10n on init,
    // so no hardcoded-language defaults can ever flash on screen.
    @Published var expanded = false
    @Published var status: Status = .ready
    @Published var statusText = ""
    @Published var answer = "" // streamed markdown text
    @Published var cliLabel = ""
    @Published var depthLabel = ""
    @Published var answerDepth = "guided" // depth the CURRENT answer was captured with (frozen per run)
    @Published var reasoningRevealed = false // brief mode: the folded scratch work is open
    @Published var mode = "tutor"        // active mode id: "tutor" | "personality"
    @Published var modeLabel = ""        // header title for the active mode
    @Published var personaLabel = ""      // current persona name (empty = not set)
    @Published var autoActive = false    // an auto session is live (any phase)
    @Published var autoProgress = ""     // "3/20" while autoActive; capsule + status suffix
}
