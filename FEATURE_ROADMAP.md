> DDJ-SB DJ started as a copy of Party Mix DJ 1.3.3 (same audio engine and screen); this document describes that shared base. The controller layer is public/ddjsb.js.

# FEATURE_ROADMAP

**Honest scope note.** "DJ Fusion Pro" as specified combines Serato, Traktor and MixMeister plus stem separation, a timeline studio, a VST host and automix. That is a multi-year, multi-person product. This roadmap orders the work so every milestone ships something that actually works and is tested. A feature is only marked **Done** when it is operational and covered by an automated check.

Status legend: **Done** · **Partial** (works, spec not fully met) · **Not started**.

## Status against the specification

| # | Phase | Status | What exists / what is missing |
|---|---|---|---|
| 0 | Audit + docs | **Done** | This document set. |
| 1 | Core audio engine | **Partial (M1 done)** | Native Rust engine `djengine.exe` (separate process): WASAPI 44.1–96 kHz, 2/4-channel output, **master on channels 1/2 + headphone cue on channels 3/4 of the Party Mix** or on a second device, real-time thread with lock-free commands (zero allocations in the render path, tested), sample-accurate transport, Hermite resampling, 3-band EQ, trim, faders, crossfader, limiter, PFL/cue mix, meters, clip counter, latency + CPU readout, buffer request, automatic reopen after device loss (46 ms in test), decoding/analysis off the UI thread. Missing: ASIO (needs SDK + driver), key-lock/time-stretch (M2), per-device buffer control is only a request on WASAPI shared mode, Web Audio fallback still present. |
| 2 | Deck system | **Partial** | 2 decks: play/cue/sync (tempo+phase), pitch, bend, jog, scratch (basic), 4 hot cues, auto-loop, jump, roll, waveform+overview, BPM+grid. Missing: 4/8 decks, reverse, slip, quantize, keylock, key detection, flexible/variable grids and grid editing, saved loops, artwork, tempo-master selection, harmonic mixing. |
| 3 | Party Mix integration | **Partial** | Detection, predefined map, LEDs. Missing: MIDI Learn, custom assignments, saved profiles, auto-load, configuration screen, generic mapping, verification of all physical controls. |
| 4 | Pro mixer | **Partial** | 2 channels: gain, 2-band EQ, fader, crossfader (linear-ish), master, headphone level + cue/master mix, PFL, limiter. Missing: 4 channels, 3-band EQ, HP/LP filters, VU/peak meters, crossfader curves. |
| 5 | Performance pads | **Partial** | 4 modes × 4 pads: hot cue, loop, jump, roll. Missing: saved loops, slicer, sampler, stems, FX trigger, drum patterns, 8/16 pads, colours/labels config, quantized triggering. |
| 6 | AI stems | **Not started** | |
| 7 | Remix/sample engine + sequencer | **Not started** | |
| 8 | FX engine | **Not started** | |
| 9 | Timeline studio | **Not started** | |
| 10 | Smart assistant + Automix | **Not started** | (BPM exists; no key/energy/genre.) |
| 11 | Smart library | **Partial** | Tags, search, folder import, drag-drop, persistence, **SQLite library (H2)**: fingerprints, incremental scan, background analysis (BPM/key/energy), duplicate query, favourites/play-count columns, key/BPM/energy columns in the playlist. Missing: playlist storage in the DB, artwork, history UI, smart playlists, UI for favourites/duplicates, artwork, duplicates, history/play counts, favourites, smart playlists, incremental background scan. |
| 12 | Recording / export | **Not started** | |
| 13 | Pro UI + workspaces | **Partial** | One DJ workspace. Missing: 8 workspaces, 4-deck layout, layout customisation, shortcut editor, top status bar (CPU, master BPM, recording). |
| 14 | Reliability | **Partial** | 48-check self-test, installer test. Missing: crash-safe session, logging, diagnostics, project recovery, DB-migration tests, audio dropout tests. |
| 16 | Harmonic Match Engine (new spec) | **In progress: H1–H4 done** (analysis, library + queue, matching engine, HARMONIC MATCH workspace with live deck matching, recommendations, Camelot wheel, playlist analyzer, graphs, set list); H5 (smart playlist generator) and H6 (manual corrections) not started | Plan below (§Harmonic Match). Done: key + Camelot with confidence, BPM/grid/downbeat/meter, energy, danceability, loudness, spectrum, onset density, tempo stability, intro/outro, vocal/mood estimates. Also done (H2): SQLite storage with migrations/backups, fingerprints, incremental scan, pausable low-priority queue. Also done (H3): scale-overlap-aware Camelot harmony, tempo/pitch-limit/half-double-time, configurable weights, reliability weighting, ranking with filters and scopes through the `libraryMatch` command. Also done (H4): the workspace (see ARCHITECTURE). Missing: playlist analyser/generator, manual correction. |
| 15 | Delivery | **Partial** | Installer + portable exe built and tested. Docs, controller profiles and troubleshooting guide still to write as features land. |

## Milestones (each ends with build + tests + docs update)

| M | Goal | Contents | Why first |
|---|---|---|---|
| **M0** (done) | Audit, docs, feasibility | These docs; Rust/cpal spike proving 4-channel Party Mix output. | De-risks the architecture. |
| **M1** (**done**, see DEVELOPMENT_LOG) | Native audio engine, 2 decks | `djengine.exe`: WASAPI 4-ch output, master → ch 1/2 and cue → ch 3/4 (or two devices), decode off-thread (symphonia), sample-accurate transport, lock-free commands, meters, latency readout, buffer/sample-rate settings, reconnect handling; UI talks to it; Web Audio kept as fallback. Tests: playback, routing (endpoint meter), crossfade, dropout stress. | Fixes the headphone problem and is the base for everything else. |
| **M2** | Time-stretch + deck depth | Key-lock, reverse, slip, quantize, 3-band EQ, filters, VU/peak meters, clip indicator, crossfader curves. | Core DJ feel. |
| **M3** | Library on SQLite | Migrations with backup, background incremental scan, key detection, artwork, duplicates, history, favourites, smart playlists, virtualised list, off-thread analysis. | Needed before automix/assistant. |
| **M4** | Controller platform | MIDI Learn, profiles, configuration screen, generic mapping, real-hardware verification checklist. | Unlocks other controllers. |
| **M5** | Grids, cues, loops | Variable-tempo grids + editing, saved loops, cue management, 4/8 decks. | |
| **M6** | FX rack + sampler/drum sequencer | The 18 effects (BPM-synced), per-deck/master chains, presets; sample decks, quantised launch. | |
| **M7** | Recording + mastering | Master/deck recording, WAV/FLAC/MP3 export, loudness/limiter chain. | |
| **M8** | Stems (cached first) | ONNX Runtime + permissive model, background separation, stem mixer, export. Real-time only if hardware allows. | Needs a vetted model licence and a GPU/CPU benchmark (this PC: i7-6700, no discrete GPU listed). |
| **M9** | Timeline Studio | Multitrack project format, automation curves, transitions, non-destructive edits, recovery. | Largest UI effort. |
| **M10** | Automix + assistant | Recommendations, transition-point finder, automix with manual override. | Depends on M3, M5, M9. |
| **M11** | Polish / hardening | Workspaces, layouts, shortcuts, crash recovery, diagnostics, VST3 (optional, out-of-process). | |

## External dependencies and open decisions
* **ASIO** needs Steinberg's SDK (licence) and an ASIO driver; none installed. WASAPI is the supported path.
* **Stem model**: needs a model whose weights licence permits redistribution; to be selected and recorded in `THIRD-PARTY-NOTICES`.
* **MP3 encoding** for export: choose an encoder with a compatible licence (LAME is LGPL).
* **Code signing** certificate if SmartScreen warnings should disappear.
* No feature will be shown in the UI as available before it works; unfinished ones stay out of the build or are clearly disabled.

## Harmonic Match Engine (second specification, received 2026-11-13)

Scope: key/Camelot, BPM/grid/downbeat, energy, danceability, spectral features, intro/outro, vocal/mood/genre estimates, a weighted match score (configurable weights), live deck matching, playlist analyser with Camelot wheel, smart-playlist generator (harmonic / energy flow / similar), tempo-adjust suggestions, SQLite storage with fingerprints, pausable analysis queue, and a HARMONIC MATCH workspace. It extends M3 (library on SQLite) and M10 (assistant), so it is scheduled right after M1/M2.

| Step | Contents | Test strategy |
|---|---|---|
| H1 (**done**) | Rust analysis: FFT chroma (HPCP-style) → key via Krumhansl–Schmuckler/Temperley profiles with a **confidence** (best vs runner-up correlation), Camelot mapping, RMS/peak/dynamic range, spectral centroid + low/mid/high energy, onset density, tempo stability, energy 1–10, danceability (beat strength × tempo stability), intro/outro from energy envelope. Genre/mood/vocal are **heuristic estimates flagged low-confidence** until an ML model is added. | Synthetic audio with known keys (major/minor, all 24), noise/atonal (must report low confidence), tempo set, corrupt/unsupported files. |
| H2 (**done**) | SQLite (`rusqlite`, WAL) with numbered, reversible migrations and an automatic backup of the DB file first; track table with file path, size+mtime+content fingerprint, features, confidence, timestamp, engine version; indexes; incremental scan (skip unchanged files); analysis queue with pause/resume, worker count, CPU cap, lowest thread priority so playback always wins. | Migration up/down, fingerprint change detection, 10k-track synthetic library, concurrent playback + analysis (xrun count stays 0). |
| H3 (**done**) | Match engine: Camelot compatibility (same, ±1, relative, energy boost, key-distance on the circle of fifths rather than numbers only), BPM compatibility with pitch-limit and half/double-time, weighted 0–100 score with configurable weights (defaults 20/15/15/15/10/10/5/5/5), tempo-adjust suggestion. | Unit tests for every Camelot case, symmetric/weight-sum properties, ranking tests on fixture libraries. |
| H4 (**done**) | UI "HARMONIC MATCH" workspace: live deck matching (Deck A playing → recommend for B and vice-versa, off the audio thread), recommendations table (sort/filter), preview, load A/B, add to playlist, find similar; Camelot wheel with click-to-filter; playlist analyser (BPM/key/energy/genre distributions, risky transitions); energy graph. | In-app self-test driving the real UI. |
| H5 | Smart playlist generator (harmonic mix / energy flow / similar), constraints (count, min score, BPM/energy ranges, max BPM diff, vocals), drag-reorder + replace. | Generated sets satisfy all constraints; deterministic seeds. |
| H6 | Manual correction of BPM/key/grid stored as user overrides that **never overwrite** automatic results or existing cues/grids; optional, confirmed tag export. | Overrides survive re-analysis. |

Honest accuracy note: chroma-based key detection on dense electronic music is typically right on the exact key roughly 60–75 % of the time and often lands on a relative/neighbouring key; the engine will therefore show a confidence value and offer manual correction rather than present guesses as facts. Genre and mood cannot be reliably classified without a trained model, so they will be labelled as estimates.
