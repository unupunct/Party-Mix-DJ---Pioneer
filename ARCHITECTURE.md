> DDJ-SB DJ started as a copy of Party Mix DJ 1.3.3 (same audio engine and screen); this document describes that shared base. The controller layer is public/ddjsb.js.

# ARCHITECTURE

Status snapshot: 2026-11-13. This document is the Phase 0 audit of the existing application plus the target architecture.
Everything marked **measured** was verified on this PC (i7-6700, 32 GB, Windows 11) with the Numark Party Mix connected.

## 1. What exists today (audit)

| Area | Finding |
|---|---|
| Name / version | "Party Mix DJ" 1.3.3 (the "skeleton" this plan builds on) |
| Languages | JavaScript (vanilla, no framework), HTML, CSS. ~1,000 lines in total. |
| Shell | Electron 45 (Chromium), CommonJS main process, sandboxed preload bridge. Also runs in a plain browser via `server.js`. |
| Dependencies | `electron`, `electron-builder` (dev), `music-metadata` (tag reading). No database, no native code, no UI framework. |
| Packaging | NSIS installer + portable exe (`npm run dist`), unsigned. Per-user install, user data in `%APPDATA%\Party Mix DJ`. |
| Audio engine | Chromium Web Audio. Whole tracks decoded to RAM (`decodeAudioData`), played with `AudioBufferSourceNode`. |
| Controller | Web MIDI. Party Mix mapping taken from the open-source Mixxx preset; LEDs driven over the Party Mix MIDI output port. |
| Library | In-memory array persisted as JSON in `localStorage`. Tags via `music-metadata`, file-name fallback. |
| Tests | `electron/selftest.js`: 48 in-app checks (decode, BPM, audio on bus, waveform, MIDI mapping, sync, loops, playlist, search, output routing). Runs against the unpacked, portable and installed builds. |

### 1.1 Working features (all verified by the self-test unless noted)
Two decks · play/pause/cue (hold = preview) · pitch ±16 % · jog nudge/search/basic scratch · hot cues (4, saved per track) · auto-loop, beat-jump, roll · tempo + beat-phase sync · BPM + beat-grid detection (one fixed grid) · colour waveforms (zoom), overview strip · 2-band EQ, trim, channel fader, crossfader, master, limiter · headphone cue to a second output device · master output selection · Party Mix MIDI mapping + LED feedback · playlist with artist/title tags, search, drag-and-drop, folder import, persistence · installer.

### 1.2 Gaps against the DJ Fusion Pro specification
No native audio (no ASIO/WASAPI control, no buffer/sample-rate settings, no latency readout, no device-reconnect handling) · no key-lock/time-stretch (pitch changes with tempo) · no reverse/slip/quantize · fixed beat-grid only · no musical-key detection · only 2 decks and 2-band EQ · no channel filters, VU meters or clip indicator · no MIDI Learn, profiles, or controller configuration screen · no SQLite library (artwork, duplicates, history, smart playlists missing) · no FX, sampler, stems, timeline, automix, recording · single workspace.

### 1.3 Measured findings that drive the architecture
1. **Chromium cannot reach the Party Mix headphone jack.** The Party Mix is one 4-channel WASAPI endpoint (channels 3/4 = headphones). Web Audio folds a 4-channel destination down to stereo: a cue signal sent to channels 3/4 appeared on channels 1/2 (Windows endpoint peak meter, all three tried configurations). A **native** WASAPI stream (Rust/cpal spike in `engine/`) opens the same device as 4 channels at 44.1 kHz and a tone on channels 3/4 appears on channels 3/4 only. → A native engine is required for the Party Mix's own headphone output.
2. Master on the Realtek endpoint and headphone cue on the Realtek endpoint both deliver signal (0.89 / 0.79 peak) with the current engine. Endpoint volume 100 %, not muted.
3. Electron reports Web MIDI as the `midiSysex` permission and `setSinkId` needs `speaker-selection`; both are granted for the app's own local page only.
4. The Party Mix is not an ASIO device; no ASIO drivers are installed on this PC. WASAPI shared mode at 44.1 kHz is the realistic path.

### 1.4 Performance and real-time review
* Audio renders on Chromium's own real-time thread, so UI work does not stall playback. But there is no control over buffer size/priority, `AudioBufferSourceNode` cannot reverse or time-stretch, and loops/rate changes re-anchor sources on the main thread.
* BPM/waveform analysis runs **synchronously on the UI thread** at load (~0.1–0.5 s freeze per track, scales with track length).
* The playlist re-renders every row on each change (fine for 713 tracks, will not scale to tens of thousands). Needs virtualised rows.
* Whole file read over IPC as an ArrayBuffer copy, then decoded to Float32 (≈ 10 MB/min stereo). Fine for 2 decks, heavy for 8 + stems.
* No crash-safe session state, no log file, no diagnostics screen.

## 2. Target architecture

```
┌────────────────────────── Electron UI (existing, kept) ──────────────────────────┐
│  workspaces · decks · waveforms · mixer · library · config screens               │
│  Web MIDI stays in the UI for now (controller → UI → engine commands)            │
└───────────────▲──────────────────────────────────────────┬───────────────────────┘
        meters/positions @30-60 Hz (shared ring / pipe)    │ commands (JSON lines over stdio/named pipe)
┌───────────────┴──────────────────────────────────────────▼───────────────────────┐
│  djengine.exe  (Rust, separate process = a plugin/model crash cannot stop the UI)│
│   control thread ── lock-free SPSC command queue ──▶ AUDIO THREAD (WASAPI, RT)   │
│   decode/analysis/stem workers (background threads) ── preloaded ring buffers ──▶│
│   audio thread: decks → time-stretch → EQ/filter → FX → mixer → master / cue     │
│   outputs: master pair + cue pair on ONE 4-ch device, or two devices             │
└───────────────────────────────────────────────────────────────────────────────────┘
          │ rusqlite (library.db, WAL)   │ ONNX Runtime (stems, background)   │ files
```

### 2.1 Real-time rules (enforced by design and by tests)
No allocation, locks, disk, DB, logging or inference inside the audio callback. UI→engine via lock-free SPSC queues of fixed-size command structs; engine→UI via atomics / ring buffer for meters and playhead. Track audio is decoded off-thread into pre-allocated buffers; the callback only reads them. Stems and analysis never run on the audio thread.

### 2.2 Why a separate Rust process instead of rewriting everything in C++
The existing toolchain on this PC is Rust + MSVC Build Tools + Node (no CMake). Rust gives memory-safe real-time code, a mature WASAPI layer (`cpal`), pure-Rust decoders (`symphonia`: MP3/FLAC/WAV/AIFF/AAC) and simple distribution as one exe. The UI keeps working during the migration: the Web Audio engine stays as the fallback until the native engine passes parity tests. The spec asks for C++ only as an example of a native engine; a native engine is the requirement.

### 2.3 Library choices and licences
| Need | Choice | Licence / note |
|---|---|---|
| Audio I/O (WASAPI) | `cpal` | Apache-2.0. ASIO needs Steinberg's ASIO SDK (separate licence, cannot be bundled freely) → optional build, off by default. |
| Decoding | `symphonia` | MPL-2.0 |
| Resampling | `rubato` | MIT |
| Time-stretch / key-lock | `signalsmith-stretch` (MIT) first; SoundTouch (LGPL) is the fallback. Rubber Band is GPL/commercial → avoided. |
| SQLite | `rusqlite` + migrations | MIT |
| Stem inference | ONNX Runtime (`ort`) + a permissively licensed model | Model licence must be checked before shipping (Demucs code is MIT; individual weight files differ). Pre-separate + cache first, real-time later. |
| VST3 hosting | optional, out-of-process | VST3 SDK is MIT since 3.8; plugin hosting is a late milestone. |
| Tag reading | `music-metadata` (existing) in UI process; `lofty`/symphonia in engine | MIT |

### 2.4 Data and safety
User data lives in `%APPDATA%\Party Mix DJ` (settings, `library.db`, controller profiles, projects, stem cache, logs), never in the install folder. Schema changes use numbered migrations with an automatic timestamped backup of `library.db` first. Original audio files are opened read-only and never written. No existing source file is deleted without approval; the Web Audio engine stays in place until its replacement is verified.

## 3. Build / test
* UI: `npm start`, `npm run dist`. Engine: `cargo build --release` in `engine/` (currently the `djprobe` feasibility spike).
* Tests: in-app self-test (48 checks), plus the Windows endpoint peak-meter harness used for routing proofs (will be turned into an automated test for the native engine).

## 4. Milestone 1 status: native engine (built and verified 2026-11-13)

`engine/` is a Rust crate (`djengine.exe`, ~3.6 MB) started by the Electron main process and bundled into the installer.

| Module | Role | Real-time rules |
|---|---|---|
| `core.rs` | `Mixer`: 4 decks, Hermite resampling (any file rate → device rate), loop wrap, 3-band EQ (RBJ biquads), trim, channel fader, crossfader, PFL cue bus + cue/master mix, limiter, meters, test beep | Called from the audio callback. No allocation, no locks, no I/O. Commands arrive over a lock-free SPSC queue; retired tracks are returned through a second queue and freed on a worker thread. **Test:** a counting global allocator proves 0 allocations in `render` over 2,000 callbacks with commands, seeks and loops. |
| `audio.rs` | cpal/WASAPI streams on a manager thread: master (ch 1/2), headphone cue on ch 3/4 of the same device or on a second device (ring buffer with drift control), automatic reopen after device loss | Callbacks only render, copy and touch atomics. `try_lock` on the mixer (uncontended; contended only while a dead stream is being replaced). |
| `decode.rs` | symphonia: MP3, FLAC, WAV, AIFF, AAC/M4A, OGG/Vorbis, ALAC → stereo f32 | Worker threads only. Damaged files return an error, never panic (tested). |
| `features.rs` | **H1.** Key (spectral-peak chroma with tuning estimate, Krumhansl–Kessler profiles, confidence from the margin to the runner-up), Camelot, RMS/peak/dynamic range, spectral centroid and low/mid/high split, onset density, tempo stability, beat strength, downbeat + 3/4 vs 4/4, energy 1–10, danceability, intro/outro, vocal and mood *estimates* (confidence capped at 0.5) | Worker threads only. ~1 s for a 6-minute track. |
| `library.rs` | **H2.** SQLite (rusqlite, WAL): `tracks` table (path, size, mtime, fingerprint, status, tags, BPM, key/Camelot + confidence, energy, danceability, mood, full feature JSON, timestamp, engine version) with indexes; numbered reversible migrations (v1 tracks, v2 favourites/play counts), automatic backup of the DB file before any schema change (newest 5 kept), refusal to open a database from a newer app; incremental scan (size + mtime + engine version), missing files marked not deleted, failed files not retried until changed or re-queued by the user; crash recovery (half-done work is re-queued at start); analysis queue with 1–4 workers, pause/resume, CPU share limit, workers run in Windows background mode (lowest CPU, disk and memory priority) | Worker threads only. Files are opened read-only. |
| `matching.rs` | **H3.** Pure scoring on `Profile`s: harmonic (Camelot relation table checked against real diatonic scale overlap; energy boost only when energy rises; without key-lock a tempo change transposes the key by whole semitones, which is applied only if the change is within the pitch limit), tempo (pitch change needed, configurable pitch limit, half/double-time at a 15 % discount, steadiness cap), energy, rhythm (incl. meter), genre (file tags, families), mood and vocal (rough estimates), danceability, spectral. Weighted 0–100 score (defaults 20/15/15/15/10/10/5/5/5, configurable, validated, relative); evidence the analyser is unsure about counts with a reduced weight instead of distorting the score; documented gates for impossible tempo / harmonic clash; every result carries its breakdown and explanatory notes. `library.rs` loads analysed tracks as profiles (schema v3 adds numeric feature columns, backfilled from the stored JSON) and applies scopes (playlist paths, folder, exclusions) | Worker thread per request; 20,000 tracks ranked in ~200 ms. |
| `analysis.rs` | Waveform colours (150 buckets/s), BPM (75–175, autocorrelation + whole-track grid refinement), beat grid | Worker threads only; moved off the UI thread. |
| `main.rs` | JSON-lines protocol over stdin/stdout: `devices`, `open`, `load`, `play`, `pause`, `seek`, `rate`, `loop`, `param`, `beep`, `simulateLoss`, `quit`; events `ready`, `audio`, `audioLost`, `loaded`, `loadError`, `state` (30 Hz: positions, peaks, CPU, xruns, clips, latency, buffer) | UI never blocks on audio. |

Electron side: `electron/main.js` supervises the process (restarts up to 3×, UI re-opens the device and reloads decks), `electron/preload.js` exposes `electronAPI.engine`, `public/app.js` routes decks, mixer parameters, loading and settings to the engine when it is active and otherwise keeps using the Web Audio path (fallback, also exercised by the self-test with `DJ_ENGINE=off`).

Measured: 4 decks + EQ + cue use **0.87 %** of real time (i7-6700); output latency **31.8 ms** with the Party Mix's fixed 441-frame (10 ms) WASAPI period; **0 xruns**; reconnect after (simulated) device loss in **46 ms**.

## 5. Technology evaluation for audio analysis (Harmonic Match, 2026-11-13)

| Option | Licence | Packaging | Verdict |
|---|---|---|---|
| Essentia | AGPL-3.0 (or commercial) | Large C++ library | **Not adopted**: licence is incompatible with shipping this app as a normal installer. Its algorithms (HPCP + key profiles) are well documented and re-implemented independently. |
| librosa | ISC | Needs Python + numpy/scipy/numba (hundreds of MB, slow start) | Not adopted: packaging weight, runtime dependency. |
| aubio | GPL-3.0 | Small | Not adopted: GPL; tempo/onset only. |
| FFmpeg | LGPL/GPL builds | ~80 MB | Not needed: symphonia already decodes MP3/WAV/FLAC/AIFF/AAC/M4A. |
| **Own Rust implementation in `engine/`** | App's own | No new heavy dependency (adds `rustfft` MIT/Apache, `rusqlite` MIT) | **Chosen.** Runs beside the existing decoder and analysis, on low-priority worker threads, never in the audio callback. |

ML-based genre/mood/vocal classification would need ONNX Runtime plus a model with a redistributable licence; until then those fields are heuristic estimates with explicit low confidence.

## 6. HARMONIC MATCH workspace (H4)
`public/harmonic.js` is a view over the engine, it computes nothing itself: **`libraryMatch`** (ranked candidates with a full breakdown) and **`libraryAnalyzeSequence`** (distributions, per-transition scores, problem transitions for an ordered list; `Library::analyze_sequence`, 2,000 tracks in ~110 ms).
* Live deck matching: the source is the deck that is playing (if both play, the one more on-air by channel fader x crossfader; or a fixed deck; or "Similar to" a pinned track). It re-queries within ~0.6 s whenever the loaded track, play state, pitch fader (+-0.5 %) or analysis state changes, in the background, never in the audio thread. The source deck's current pitch fader is part of the query, so the advice matches what is actually playing.
* Table (match %, label, BPM, key, energy, tempo change with half/double-time, key compatibility with relation and the key after any pitch shift, energy delta, genre, mood), sorting, filters (min score, BPM range, max BPM diff, energy range, genre, vocals), scope (library, playlist, set list, not in set list, folder), presets and a weights editor (9 sliders, relative), pitch limit, key-lock, penalties; a detail panel explains every component and notes low-confidence inputs.
* Actions: Preview (loads the free deck, cues it to the headphones with its channel fader forced to 0, starts at the intro end), Load to A/B, Add to set list, Find similar (re-ranks with the "Similar sound" weights around that track), Analyze track. Generate Smart Playlist is deliberately disabled (H5).
* Camelot wheel (24 keys, track counts, source key and compatible keys outlined, click = filter the table **and** the main playlist), playlist analyzer (totals, duration, average transition, smooth share, problem transitions with reasons, missing analysis with a one-click "Analyze missing", genre chips), energy progression and BPM distribution graphs, an ordered set list (reorder, load, remove).
* The toolbar and tab bar are one sticky top bar; revealing a playlist row scrolls only the playlist box, never the page.

## 7. Controller feel (responsiveness)
Measured while 300 tracks were analysed in the background: command round trip (renderer -> main -> engine -> back) 0.6 ms median idle, p95 1.1 ms after the fixes; UI-thread stalls over 50 ms went from 16 to 2 (both at the moment 300 tracks are added at once). Fixes: the playlist is rendered with one innerHTML and one delegated listener, analysis and tag results patch single rows, saving is debounced, the engine commands that wheels/knobs/faders generate are coalesced (first one immediate, last one always delivered), the engine process runs at above-normal priority. The jog wheels were far too sensitive: all jog gains are now scaled by a "Jog" slider in the toolbar, default 45 %.

## 8. Console faceplate (skin v1)
`public/console.js` + styles dress the DJ screen as a Party Mix-style controller **without changing what any control does**: it reuses the existing buttons, pads, sliders, MIDI bindings and engine commands and adds (a) a jog wheel per deck (platter turns at 33 1/3 rpm x the deck's rate while playing, a ring shows the track position, dragging or scrolling it jogs/scratches through the same `Deck.jog` as the hardware wheel), (b) a **HARMONIC MATCH hub in the centre of each wheel** (shows the deck's Camelot key and BPM; pressing it calls `harmonic.openForDeck(i)`: the Harmonic Match tab opens with that deck's track as the source and the list is "the next song for Deck X"; the hub glows while Harmonic Match follows that deck), (c) rotary knobs bound two-way to the gain / treble / bass / master / cue-mix / headphone controls (drag, scroll, double-click to reset; the hardware moving a control moves the knob), (d) a browse knob (drag/scroll to move the playlist selection, press to load the selected track onto the free deck) with LOAD A / LOAD B, (e) per-channel level meters from the engine, (f) vertical tempo sliders on the outer sides, backlit transport buttons and pads.
**Mixer layout (as specified by the user):** top row LOAD 1 | browse wheel | LOAD 2; below it channel 1 (gain, treble, bass, fader, meter) | centre column MASTER GAIN, CUE MIX, CUE GAIN (top to bottom) | channel 2; along the bottom the crossfader with "◀◀ 1" and "2 ▶▶" and a centre mark directly under CUE GAIN. Layout checks in the self-test measure these positions.
**Status:** built from the Party Mix's control list and layout knowledge, not from a photograph: no picture was attached to the request, so control positions, proportions and colours are an interpretation, not an exact copy. A front-on photo of the unit would let the layout be matched precisely.
