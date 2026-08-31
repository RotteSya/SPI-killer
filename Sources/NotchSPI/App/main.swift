import AppKit

if CommandLine.arguments.contains("--print-objective-eval-prompt") {
    let prompt = Prompts.capturePrompt(
        mode: "tutor", depth: "brief", personaName: "", personaText: "", sessionContext: "",
        objectiveProtocolEnabled: true)
    print(prompt.system)
    exit(0)
}

if CommandLine.arguments.contains("--print-objective-eval-task") {
    let prompt = Prompts.capturePrompt(
        mode: "tutor", depth: "brief", personaName: "", personaText: "", sessionContext: "",
        objectiveProtocolEnabled: true)
    print(prompt.task)
    exit(0)
}

if CommandLine.arguments.contains("--print-legacy-eval-prompt") {
    let prompt = Prompts.capturePrompt(
        mode: "tutor", depth: "brief", personaName: "", personaText: "", sessionContext: "")
    print(prompt.system)
    exit(0)
}

if CommandLine.arguments.contains("--print-legacy-eval-task") {
    let prompt = Prompts.capturePrompt(
        mode: "tutor", depth: "brief", personaName: "", personaText: "", sessionContext: "")
    print(prompt.task)
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// Accessory: no Dock icon, lives at the notch like a menu-bar app.
app.setActivationPolicy(.accessory)
#if DEBUG
// Visual-QA hook: `--qa-regular` runs as a regular app so screenshot tooling that filters by the
// app allowlist (and only enumerates regular apps) can capture the notch panel. Never in Release.
if CommandLine.arguments.contains("--qa-regular") { app.setActivationPolicy(.regular) }
#endif
app.run()
