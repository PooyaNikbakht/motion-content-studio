# PRD: Motion Content Studio

Status: first version built

## 1. Overview

A book-documentary channel works with an AI director that replies in one long message: narration split into audio chunks, image scenes, animation prompts, cover prompts, publishing text (cover headline, YouTube title, captions) and a vertical (9:16) Reels and Shorts package. Turning that message into files by hand (copying each chunk to a voice tool, naming files, collecting prompts) is slow. This app does it from one paste.

It is used for real by its author, and shown as a portfolio demo.

## 2. Goals and non-goals

**Goals**
- Parse a pasted conversation into chunks, scenes, animations, the YouTube cover prompt, publishing text and the Step 6 Reels package (3 reels, each with audio, vertical image prompts, one or two vertical animation prompts and a cover prompt), and show counts to check it.
- Organise the app as two production workflows behind three main tabs (Import & Parse, YouTube 16:9, Reels 9:16). YouTube has Audio, Visual Board and Cover & SEO sub-tabs; Reels has one tab per reel, each with Audio, Visual Board and Cover & Captions sub-tabs, a shared compact action bar, deep links in the URL hash and the last position remembered.
- Work each reel as a mini-studio: audio, vertical images (labelled R01-01 and so on), vertical animations and a 9:16 reel cover, with per-prompt progress.
- Generate reel audio separately from the main chunks, saved in a Reels subfolder or ZIP folder, and track reel progress per project.
- Generate numbered audio files with ElevenLabs from the browser, saved to a folder or a ZIP.
- Show every prompt in a board with one-click copy.
- Upload the finished image, video or cover straight into a slot on the card it belongs to (click or drop), see a thumbnail or player, preview it full size, download or remove it, and have the "generated" chip follow automatically.
- Download all assets as an edit-ready folder (or a ZIP) with an edit list.
- Organise projects in a left sidebar with one level of folders, search, move (menu and drag and drop) and a mobile drawer.
- Keep all data in the browser. No backend for app logic.
- Let anyone try the whole flow safely in a demo with simulated audio.

**Non-goals**
- Accounts, teams or real-time sync between devices (one user, one open copy at a time; a version check catches a stale save).
- Generating images or video.
- A server-side proxy for ElevenLabs.

## 3. Decisions

| Topic | Decision |
|---|---|
| UI language | English, left to right. Per-project content language sets direction and font for pasted text only. |
| Storage, demo | 100% local: `localStorage` for settings, IndexedDB (`mbs_demo_db`) for projects, folders and audio. Never calls `/api`. |
| Storage, app | The server is the only source of truth: D1 for projects, folders, progress and info; R2 for generated audio. A project is loaded from the server whenever it is opened (no local copy, no outbox, no offline mode) and saved with an explicit Save button; each project row has an integer `version` and a stale save is refused with 409. Settings and the ElevenLabs key stay in `localStorage`; IndexedDB holds only folder handles. |
| ElevenLabs | Calls stay browser-direct; the Worker never sees the key or the audio request. |
| Guide | A header Guide dialog (both modes) with seven numbered steps, each "what the app does / what you do elsewhere / recommended"; the copy lives in one data object (`guide.js`) so it is easy to edit. Recommendations are labelled as suggestions. |
| Adapter | The UI uses one storage interface; `store.js` is the local adapter, `remote-store.js` the app adapter. One codebase, two storage backends. |
| Export / Import | `<name>.mbsproj.zip` (`project.json` format `mbs-project` version 1, plus audio files), both modes, import always creates a copy with a new id. No server-side ZIP. |
| Overview | Per-project page: status, publishing info, reel links, checklist. Status and info persist with the project. |
| Re-parse | Parsing is explicit (Parse button). Unchanged chunks, scenes and reels keep their progress; one undo snapshot; audio is never deleted by a re-parse. |
| Login | First-run "Create password" gated by the `RECOVERY_KEY` secret; password stored in D1 as PBKDF2-SHA256 (100,000 iterations, per-install salt); signed 30-day cookie with a session epoch. Change password needs the current one, reset needs `RECOVERY_KEY` and signs every session out. Protects the page, not the key. |
| Models | `eleven_v4` default (10,000 characters, 1 credit per character), `eleven_v3` previous generation, `eleven_multilingual_v2` and `eleven_flash_v2_5` alternatives. v3 stability snaps to 0, 0.5, 1. |
| Setup | One Setup tab holds every global ElevenLabs setting, rates, plan and output folder; audio screens only show a status line and a per-run override dialog (never changes the defaults). |
| Estimates | Credits and USD are estimates from editable rates (estimate.js); the plan is read from `/v1/user/subscription` when a key is saved. Warn, never block. |
| Media | Per-card upload slots (Image, Video, Cover image). Originals go to R2 in `/app` (100 MB per file = 100,000,000 bytes, 200 per project; streamed, Range and ETag on read, original name on download), with a 320 px thumbnail. Files follow unchanged items through a re-parse, edited ones are flagged Outdated, removed ones become unused and are only deleted by "Remove unused media". `/demo` keeps thumbnails and, up to 25 MB in total, originals in the browser and never calls `/api`. |
| Share links | Read-only `/s/<token>` page: prompts and progress only, token hash stored, 1/7/30 days, one per project. |
| Language | Public pages, `/demo` and the sample are English only (no Arabic script); Persian and RTL support stays in the code. `/app` has no built-in start phrase. |
| Look | Dark cinematic: background `#0B0F19`, cards `#151C2C`, accent `#F59E0B`. Flat, no gradients or shadows. |

- AI Director: the app can run the master prompt on Gemini itself (Import & Parse mode toggle), per-user key in the browser, Setup holds key, model, token rates and the prompt vault; /demo simulates it. The conversation is stored as the project text so the parser, diff and carry logic are unchanged. Cost is an estimate before the run and counted from usage after each turn. Decisions: default model gemini-3.8-flash ($0.75/$3.75 per 1M tokens), then gemini-4-hydrogen ($1.50/$7.50) and gemini-4-carbon (best quality, $2/$10 until 30 Nov 2026, $4/$20 after); gemini-2.5-pro and 2.5-flash remain selectable but are deprecated and may 404 for new keys. All rates are editable in Setup. Smart per-stage routing: presets Smart Hybrid (default), All Carbon, All Flash plus per-stage overrides, mid-run model switch in the panel, and per-turn cost from the model that actually ran (assumption: a turn uses the model of the stage reached by the previous reply). Project text cap raised to 900 KB (rows stay under D1's 2 MB).
- Director feedback: per-stage feedback reply, Regenerate, edit-and-accept of the last reply, "Pause after each stage" toggle; duplicated numbered chunks or scenes resolve to the latest version (unnumbered chunks cannot be matched, so they are all kept).
- Setup cards are collapsible; open/closed is remembered per card in the browser; first run opens all, afterwards only cards needing attention (assumption: "per user" means per browser profile, no server storage).
- Audio chunks are found by `**Audio chunk N**` labels with the text in a code block. The start phrase is optional (per project, the Setup value is the default) and only a fallback for older conversations.

## 4. Acceptance criteria

- The sample conversation parses to 6 chunks, 8 scenes, 3 animations, a thumbnail, a cover headline, a YouTube title and 3 Step 6 reels (3 to 4 images and 1 to 2 animation prompts each, with cover headline and caption), with no Step 6 content in the main counts.
- In the demo, "Start generating all audio files" produces six playable placeholder files without any network call to ElevenLabs.
- In the app, a missing key or voice ID is reported before any request. A 401 stops the queue with a clear message.
- Reloading keeps projects, text and generated audio (in the app from the server, in the demo from the browser).
- In the app a project always loads from the server, so a change saved on one device appears on another after a reload. Edits are unsaved until Save (the sticky bar at the top of the content, or Ctrl/Cmd+S): the bar shows "All changes saved", an "Unsaved changes" dot, Saving... or an error with Retry; leaving the page with unsaved changes asks first; switching project asks Save / Discard / Cancel. Parse, director replies, uploads and project or folder changes save at once. If the project changed elsewhere, Save is refused and the person chooses Reload latest or Overwrite. On the Setup tab the same bar saves Setup. /demo has no save bar and writes locally as you go.
- Every `/api` route answers 401 JSON when signed out, 403 for a missing `X-MBS` header or foreign `Origin` on writes, 415 for a wrong content type, 413 over the size caps and 429 over the rate limit. Deleting a project removes its R2 objects; deleting a folder moves its projects to the top level.
- `/demo` never loads the remote store and makes no `/api` request.
- Exporting a project and importing the zip gives a copy with the same text, parsed content, progress, info, status and audio, in both modes.
- Typing in the paste box changes nothing in the project; Parse with existing progress shows a confirmation, Cancel keeps everything, Replace keeps unchanged ticks and Undo restores the previous state.
- The Overview suggests "Mark as Ready?" only when every audio, image, video and cover item is ticked.
- `/app` redirects to `/login` without a valid cookie. `/` and `/demo` need no sign-in.
- Works at 360px wide, with keyboard access and visible focus.
- `/format` explains the expected input, offers a template that parses to its documented counts and a live checker that runs the real parser in the browser without creating a project. It is linked from the landing page, the app and the demo.

## 5. Risks

- Server storage means project text and publishing info are now on Cloudflare (D1, R2). Mitigation: same login, `/api` guards, private no-store responses; the key still never leaves the browser.
- Two tabs or devices editing the same project: the later Save gets a 409 and the person picks Reload or Overwrite (no merge). Edits made while offline are not kept: the app needs the server, and unsaved edits are lost if the page is closed (the browser warns first).
- Free-tier limits (D1 rows and storage, R2 storage, Worker requests) and the per-IP rate limit can throttle a very large migration. Mitigation: size caps, paced migration honouring Retry-After.
- The rate-limit binding behaves differently in local dev; the handler works without it.
- Parse undo is kept in the browser (localStorage, up to its quota) and stays on this device; the change history (counts and hashes) is part of the project.

- The real conversation format may differ from the assumed one. Mitigation: tolerant parser, optional start-phrase fallback, warnings, tests on a sample.
- Browsers without the File System Access API (Safari, Firefox) cannot save to a folder. Mitigation: ZIP download.
- The key sits in the browser. Mitigation: documented; use a key with a limit.
- Gemini rates, model names and limits change. Mitigation: rates are editable in Setup, the estimate is labelled, and real token counts are used after each turn.
- The File API upload needs the browser to read the x-goog-upload-url response header; if Google does not expose it, large PDFs fail with a clear message (compress the PDF or paste a summary).
