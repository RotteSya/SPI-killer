# NotchSPI

A native macOS **notch-based AI study tutor**. Press a hotkey and a Dynamic-Island-style
panel drops from the MacBook notch, reads the problem on your screen, and **streams a
tutoring explanation**. Install, walk the onboarding, receive a **random 100–180 question
gift**, and start answering. UI in **简体中文 / 日本語 / English**.

> **Capture exclusion.** The notch panel and NotchSPI's own windows are excluded from all
> **software** screen capture (`NSWindow.sharingType = .none`). This does **not** hide
> the panel from a camera pointed at the physical display.

## What you get

- **Question-quota billing:** one successful capture costs 1 question; failures are never charged. Top-ups buy packs on a trilingual web page.
- **Five-page onboarding** over a live Metal aurora — language, how it works, Screen Recording permission, the gift, try-it.
- **Unified settings** (six sidebar pages): general, hotkeys, appearance, account/quota, personas, advanced.
- **Three answering channels:** official metered service (default) · your own API key · local CLI (`codex` / `claude`, off until unlocked per device).
- **Depth modes:** 简略 · 提示 · 引导 · 完整.
- **Hotkeys (customizable):**
  - `⌘⇧1` tutor
  - `⌘⇧2` follow-up with last screenshot
  - `⌘⇧9` personality test
  - `⌘⇧0` auto-capture
  - `⌘⇧Space` show/hide
- **Updates** come from the official service. No user-facing GitHub.

## Requirements

- macOS 14+ (Apple Silicon; built/tested on macOS 26).
- Swift 5.9+ / Xcode to build from source.

## Build & run

```sh
swift build -c release && .build/release/NotchSPI
```

Onboarding asks for **Screen Recording** permission.

> 开发与交接说明：见 [CLAUDE.md](CLAUDE.md)（单一真理源）。
