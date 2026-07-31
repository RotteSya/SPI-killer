# NotchSPI

A native macOS **notch-based AI study tutor**. Press a hotkey and a Dynamic‑Island‑style
panel drops from the MacBook notch, reads the problem on your screen, and **streams a
tutoring explanation**. Zero setup: install, walk the onboarding, get **180 free
questions**, and start answering. UI in **简体中文 / 日本語 / English** (switchable live).

> **Capture exclusion.** The notch panel and NotchSPI's own windows are excluded from all
> **software** screen capture — screenshots, screen recording, and Zoom/Meet/Teams screen share
> (including "share entire screen") — via `NSWindow.sharingType = .none`. This blocks software
> capture only; it does **not** hide the panel from a camera pointed at the physical display.

## Features

- **Question-quota billing (题数额度制):** the account balance is a number of questions —
  one successful capture costs exactly 1 question, failures are never charged. New devices
  get **180 free questions** (anonymous registration, no account). Top-ups buy question
  packs on a trilingual web page. Contract in `docs/official-api.md`; reference server in
  [`server/`](server/).
- **Onboarding v2:** a five-page zero-jargon flow over a live Metal aurora shader —
  welcome (language choice) → how it works → screen-recording permission (live green check)
  → the 180-question gift moment (rolling counter + confetti) → try-it keycaps. No mention
  of APIs, CLIs, keys, or tokens anywhere.
- **Unified settings** (侧栏六页): 通用 (language, depth, capture target, launch at login) ·
  快捷键 · 外观 (five accent themes, answer text size, post-answer linger) · 账户与额度
  (animated quota ring, top-up) · 人物像 · 高级 (answering channel, custom API keys, updates).
  The notch's gear menu keeps only quick actions + quota at a glance.
- **Notch UI** (boring.notch‑style `NSPanel`): a collapsed indicator with the animated
  *Rose* loader beside the notch; **hover to expand**; the panel **auto‑sizes to the answer**;
  the status line shows **完成 · 剩余 N 题** after every answer.
- **Three answering channels** (设置 → 高级, switch freely):
  - **官方服务** (default) — captures are proxied and metered server-side; the vendor key
    never leaves the server.
  - **自定义 API Key** — your own Anthropic / OpenAI key, straight to the vendor API
    (Keychain-stored).
  - **本机 CLI** — drive a logged-in `codex` / `claude` CLI, read-only.
- **Depth modes:** 简略 (answer only) · 提示 · 引导 · 完整.
- **Global hotkeys (customizable):** `⌘⇧1` 讲题 (tutor), `⌘⇧2` 性格作答 (personality test),
  `⌘⇧Space` show/hide.
- **Check for updates:** compares against the latest GitHub release; quiet daily auto-check.

## Requirements

- macOS 14+ (built/tested on macOS 26, Apple Silicon).
- Swift 5.9+ / Xcode.
- Nothing else for the official service. The advanced channels need an API key or a
  logged-in CLI (`codex` / `claude`).

## Build & run

```sh
swift build -c release
.build/release/NotchSPI
```

(or `swift run`). Onboarding asks for **Screen Recording** permission with live detection.

### Visual QA hooks (DEBUG builds only)

```sh
NSPI_QA_EPHEMERAL=1 NSPI_VISUAL_QA=1 .build/debug/NotchSPI \
  --qa-onboarding --qa-onboarding-page 3 \      # jump straight to an onboarding page
  --qa-settings-page 2 \                        # open settings at a page (0–5)
  --qa-capture \                                # fire one full capture programmatically
  -official.baseURL http://localhost:8787       # point at a local server
```

`NSPI_QA_EPHEMERAL=1` keeps all secrets in-process (never touches the real Keychain);
`NSPI_VISUAL_QA=1` re-enables screen capture of the app's own windows for screenshots.

## Server (official service)

```sh
cd server && npm ci
DB_PATH=':memory:' OFFICIAL_PROVIDER=mock ALLOW_STUB_TOPUP=1 npm start
```

Boots with a key-free mock provider; `npm test` runs 112 unit + HTTP integration tests.
Set `TEST_POSTGRES_URL` (a throwaway database) to run the store suite against the production
Postgres backend as well.
See [`server/README.md`](server/README.md) and [`docs/official-api.md`](docs/official-api.md).

## Notes

- The CLIs are spawned in an **isolated temp directory** (read‑only), so they don't crawl
  your current project.
- Screenshots are downscaled to ~1568px JPEG before being sent, and deleted right after use.

## Layout

```
Sources/NotchSPI/
  App/                 bootstrap (accessory app), L10n (runtime zh/ja/en)
  Notch/               notch panel, controller, obsidian design system, Rose loader
  UI/                  Metal aurora background, onboarding components (keycaps, confetti…)
  Cloud/               official quota service: routing + quota gate, API client, onboarding
  Settings/            unified settings window, themes, hotkeys, personas, Keychain
  Capture/             ScreenCaptureKit → temp JPEG
  CLI/                 codex/claude runners, direct-API runner, prompts
  Update/              GitHub releases update check
server/                official service reference implementation (Fastify + SQLite)
```
