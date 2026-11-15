> DDJ-SB DJ started as a copy of Party Mix DJ 1.3.3 (same audio engine and screen); this document describes that shared base. The controller layer is public/ddjsb.js.

# DEVELOPMENT_LOG

## 2026-11-13

**Built (v1.0.0)**
- Browser prototype → Electron desktop app: two decks, colour waveforms, overview, BPM/beat grid, hot cues, loops, sync, EQ/crossfader/master/limiter, headphone cue to a second device, playlist, Numark Party Mix MIDI map + LEDs.
- NSIS installer + portable exe; silent install/uninstall tested (shortcuts, registry entry and files removed cleanly).
- In-app self-test (`DJ_SELFTEST=1`), now 48 checks; run against the unpacked, portable and installed builds.

**Bugs found and fixed**
- BPM/phase sync test compared a paused deck against a moving one → sync now aligns beats only when both decks play (also the correct DJ behaviour).
- Electron blocked MIDI (reported as `midiSysex`) and output switching (`speaker-selection`) → both granted for the app's own page only.
- Self-test polluted the real user profile → test runs now use a throw-away profile; stale test profile removed.
- Playlist showed one character per row → playlist rows shared the CSS class `row` with deck button rows (flex layout) → renamed; self-test checks the row is a table row and the title cell shows the name.
- Added artist/title columns (tags via `music-metadata`, "Artist - Title" file-name fallback) and a search box.

**Headphone investigation (user report: "headphones not working, Realtek not working")**
- Measured with Windows' own endpoint peak meters (COM `IAudioMeterInformation`), not by ear:
  | Test | Result |
  |---|---|
  | Master → Realtek | signal on Realtek (0.89) |
  | Master → Party Mix, cue → Realtek (PFL, cue-only) | signal on Realtek (0.79), none on Party Mix |
  | Master → Party Mix | channels 1/2 (0.85) |
  | Cue → "channels 3–4 of Party Mix" (Web Audio, 3 variants) | **signal on channels 1/2, none on 3/4** |
  | Native WASAPI (Rust/cpal) tone on ch 1/2 / ch 3/4 | appears on exactly those channels |
- Conclusions: the removed "channels 3–4" option could never work in Chromium (output folded to stereo) and was recommended in error → option removed; Windows endpoints (volume 100 %, not muted) receive signal for Realtek, so a silent Realtek is likely a jack/driver/physical-routing matter outside the app.
- Output pickers now: hide the duplicate "Default/Communications" entries, preselect a non-Party-Mix device for the headphone cue, and have a **Test sound** button; the engine is resumed after an output switch; a saved "split" setting is migrated to "off" with a notice.
- Native engine feasibility spike: `engine/` (Rust, cpal 0.18) lists WASAPI devices and plays a tone on chosen channels. The Party Mix opens as 4 channels F32 at 44.1 kHz.

**Phase 0 deliverables created:** ARCHITECTURE.md, FEATURE_ROADMAP.md, HARDWARE_SUPPORT.md, this log.

**Not done / known limits**
- Everything in FEATURE_ROADMAP marked Not started or Partial. Nothing from phases 6–12 exists yet.
- Physical Party Mix controls verified only partly (see HARDWARE_SUPPORT).
- Party Mix headphone jack (ch 3/4) not usable until Milestone 1 (native engine).
- Installer unsigned.

## 2026-11-13 (evening): Milestone 1, native audio engine

**Built:** `engine/` (Rust): mixer core, WASAPI I/O (2/4-channel, second-device cue with drift control, device-loss recovery), symphonia decoding, analysis in Rust, JSON-lines sidecar protocol, test beep; Electron supervision + bridge; UI routing with Web Audio fallback; audio settings dialog (master device, headphone cue = Party Mix jack on ch 3/4 or other device, sample rate, buffer request, test sounds); status chip (channels, rate, latency, CPU, xruns) and master peak meter with clip flash; engine bundled via electron-builder `extraResources`.

**Verified (all automated):**
- `cargo test --release`: 17 tests (sample-exact playback, rate, 48 kHz→44.1 kHz time accuracy, seek, track end, crossfader sides, loop wrap, PFL/cue routing, limiter ceiling + clip counter, EQ, parameter storm without NaN, **zero allocations in render**, garbage-queue hand-back, 4-deck CPU headroom 0.87 %, tempo/grid detection at 98/120/128/140 BPM, WAV decode incl. mono, missing, garbage, truncated files, beep routing).
- `node scripts/engine-hw-test.js` against the real Party Mix, measured with Windows endpoint peak meters: master → ch 1/2 only (0.87 / 0.00), cue → ch 3/4 only (0.00 / 0.87), cue on Realtek only (0.90), reopen after device loss 46 ms, audio resumes, xruns 0, callback CPU 2 %, latency 31.8 ms.
- In-app self-test: **57/57** with the native engine on the unpacked, portable and silently-installed builds; **49/49** on the Web Audio fallback; uninstall leaves no files, shortcuts or engine processes.

**Bugs found by the new tests and fixed**
- Beat-grid phase used the wrong sign (`phase − start` instead of `phase + start`); only correct when the analysis start was a multiple of the beat period. Fixed in the engine and in the JS fallback.
- Tempo estimate was off by up to 0.6 BPM (128 → 128.6) → added whole-track grid refinement.
- Test-harness defects (stale events matched, beep tail counted as silence) fixed so tests cannot pass on stale data.

**Not done / limits:** ASIO; key-lock and time-stretch (M2); scratch audio in native mode (jog moves the playhead but no scrub grain yet); buffer size is only a request on WASAPI shared mode (the Party Mix fixes a 441-frame period); headphone audio through the Party Mix jack is verified by endpoint meters, not yet by ear; Web Audio fallback remains in the codebase.

**New specification received (Harmonic Match Engine):** analysed, evaluated and planned in FEATURE_ROADMAP.md (steps H1–H6) and ARCHITECTURE.md §5; not started.

## 2026-11-13 (night): Harmonic Match, step H1 (feature extraction)

**Built:** `engine/src/features.rs` (+ onset envelope and tempo confidence exposed from `analysis.rs`); engine protocol: the `loaded` event now carries the full feature set and a new `features` command analyses a file without loading it; deck readout in the UI ("8A (Am) · E7", trailing "?" when the key confidence is low) with a tooltip listing key confidence, runner-up key, tempo confidence/stability, energy, danceability, loudness, intro/outro and the mood estimate.

**Verified**
- `cargo test --release`: 29 tests (17 engine + 12 feature). Feature tests use synthetic music with known ground truth: **all 24 keys exact (24/24)** on clean synthetic tonal music, 12/12 with drums, detuned +35 cents still right with the tuning estimate within 15 cents, random chromatic notes and white noise are *not* reported with confidence, the Camelot table (all 24 entries) and ideal key profiles, energy ordering, intro/outro within 3.5 s, 3/4 vs 4/4 and downbeat position within 10 ms, tempo stability steady 0.99 vs drifting 0.53, RMS/peak/band/centroid measurements, silent/tiny/short files do not panic, a 6-minute track takes 1.0 s.
- In-app self-test: **65/65** (native) on the unpacked, portable and silently installed builds; 49/49 on the Web Audio fallback; clean uninstall.

**Bugs found by the tests and fixed:** the onset counter could never count (an arithmetic bug that always yielded 0 onsets); a test signal had float phase noise (test-side artefact, fixed); one self-test regex lost a backslash.

**Honest limits of H1**
- The key accuracy above is on *synthetic* music (perfect harmonic notes). Real recordings, especially dense electronic music with strong bass and percussion, will be less accurate (typically 60–75 % exact, often a neighbouring or relative key). That is why every key carries a confidence and low-confidence keys are shown with "?".
- Vocal presence and mood are rough heuristics without a trained model; genre is not classified (it will come from file tags). Energy and danceability are documented heuristics, not a standard measure.
- No ground-truth comparison against real, human-labelled tracks has been done yet. If you give a few tracks whose key you know, I can compare.
- Nothing is stored yet (SQLite is H2), so features are computed when a track is loaded onto a deck.

## 2026-11-13 / 14: Harmonic Match step H2 (library database + analysis queue)

**Built:** `engine/src/library.rs` (SQLite library, reversible migrations + backup, fingerprints, incremental scan, analysis queue with workers/pause/CPU limit), engine protocol (`libraryOpen/Scan/ScanDirs/Reanalyze/Get/Rows/Stats/Duplicates/Pause/Resume/Config/Favorite/Played`, events `libraryReady/Progress/Scanned`, `trackAnalyzed`, `trackError`), the library is opened automatically in the user data folder (`library.db`); UI: Key and Energy columns, BPM from the analysis, "Analyze all", pause/resume, worker and CPU-share selectors, progress text, per-track re-analyse button; genre/album tags are now read and stored.

**Verified**
- `cargo test --release`: **42 tests** (17 core + 12 features + 13 library): migrations up/down/up without data loss, pre-migration backup and pruning, refusal of a newer database, incremental scan (each file analysed once; changed file re-queued; deleted file marked missing and kept; forced rescan), stored results correct (key 8A, BPM 126, tags kept), unsupported/corrupt/empty files recorded with a reason and not retried, **originals byte-identical with unchanged modification times and no files created**, pause/resume, parallel workers and the worker limit, CPU limit (rest time = 3.00 x work time at 25 %), fingerprints and duplicates, crash recovery, favourites/play counts survive re-analysis, **20,000 tracks**: filter query 8 ms, 500 path lookups 58 ms, stats 6 ms, sorted page 18 ms, concurrent scans/queries/analysis without errors.
- `node scripts/library-stress-test.js 90 4` on the real Party Mix: a steady tone looped on a deck while 4 workers analysed 90 files at full speed: **0 underruns, callback CPU max 0.9 %, latency 30.4-31.9 ms, 0 of 238 / 183 Windows-meter samples dropped** (two runs), every track analysed, second scan queued nothing, source files identical.
- In-app self-test: 77 checks including the library UI, pause/resume, playback with 0 underruns while the queue runs, persistence, worker limit.

**Bugs found by the tests and fixed**
- *Real playback dropouts during analysis* (found only after fixing a vacuous test): with 4 workers the audio callback overran once (176 % of its deadline) and Windows' meter showed ~150 ms of missing signal, although the engine's own underrun counter stayed at 0. Fixed by promoting the audio thread (cpal `realtime` feature) and running analysis threads in Windows background mode. Afterwards: callback CPU 0.9 %, no dropped meter samples. Lesson recorded: the engine's xrun counter is not sufficient evidence, the endpoint meter is the check that counts.
- A stress-test statistics bug made three checks pass vacuously (empty sample set); added a guard so an empty sample can never pass.
- Backup pruning sorted alphabetically and gave up when one old backup could not be deleted; now ordered by timestamp.
- The first audio callback after (re)opening a device reports 0 ms latency; the engine now keeps the last good value.
- Two timing-based tests were flaky on a heavily loaded PC (the PC runs near 99 % CPU from other software); the CPU-limit test is now deterministic (work/rest accounting) and the speed test has a loose limit.

**Known limits:** background-mode analysis is deliberately slow, about 4x slower than normal priority (2.1 s vs 0.55 s for a 60 s track on an idle PC; a 700-track library at ~4 min per track and 2 workers takes roughly 45 min in the background; raise the worker count if the DJ is not playing). Peak memory is about 21 MB per minute of audio per worker (a 10-minute track is ~210 MB while it is analysed). The playlist itself is still stored as JSON (only analysis results are in SQLite). Duplicate and favourite data are in the database but have no UI yet.

## 2026-11-14: Harmonic Match step H3 (matching engine)

**Built:** `engine/src/matching.rs`; schema v3 (numeric feature columns + `json_extract` backfill, reversible); `Library::profiles / profile_for_path / match_for` with scopes; protocol `libraryMatch` -> `libraryMatches` / `libraryMatchError`; renderer helper `match(path, {settings, filter, scope})`; `scripts/verify-all.ps1` (build + self-test of every packaged form).

**Verified:** 58 engine tests (17 core, 12 features, 13 library, 13 matching, 3 matching through the database) and 86 in-app checks.
- Camelot: parsing and tonic arithmetic agree with the analyser for all 24 keys; every relation from 8A (same 1.00, +-1 0.88, relative 0.92, diagonal 0.60, energy boost +2 only when energy rises 0.72); relations are symmetric; keys outside the named relations are ranked by how many scale notes they share, not by wheel number.
- Tempo: 124 vs 128 BPM -> slow the candidate by 3.125 %; half/double-time recognised; the pitch limit is configurable; a score falls monotonically with the adjustment; the source's own pitch fader moves the target.
- "Close BPM is not enough": same BPM but clashing key/energy/meter/genre scores 27 %; a perfect key that cannot be tempo-matched is gated down.
- Without key-lock a 7.4 % tempo change moves a same-key track one semitone (8A -> 1A on the wheel): 57 % instead of 86 % with key-lock.
- Weights: defaults are exactly 20/15/15/15/10/10/5/5/5; relative (x3 changes nothing), single-weight results equal that component, negative/NaN/all-zero rejected, changing priorities changes the order.
- The example from the brief: 8A/126/E8 vs 8A/126/E8 = 100 %, 7A/128/E8 = 96 %, 8B/124/E7 = 95 %, a clashing key/tempo/energy = 27 %.
- End to end with real analysis: tracks in A minor 128 BPM, C major 124 (relative), E minor 126 (neighbour) rank on top; F# major (clash) and a 160 BPM track rank last. Scopes (playlist, folder ignoring case, exclusions), filters, unanalysed source rejected, tracks still in the queue reported as "unanalysed" rather than guessed.
- 20,000 tracks: pure ranking 185 ms; through the database (load + score + sort) 195 ms.

**Design corrections found by the tests**
- Uncertain estimates were first blended towards 0.5, which made two identical tracks score 98.75 %. Now a low-confidence estimate keeps its honest score but counts with a reduced weight, so identical tracks score 100 % and shaky evidence neither rewards nor punishes as much (a clashing key is punished less when the key estimate is shaky).
- A tempo change that cannot be applied (outside the pitch limit) was still transposing the key in the harmonic score, punishing the track twice; the key shift now applies only to tempo changes within the limit.

**Limits**
- Genre comes from file tags only (unknown genre is neutral); mood and vocal are rough estimates (reduced weight); no similarity "learning". "Instrumentation similarity" is approximated by the spectral balance and vocal estimate, not by instrument recognition.
- Key-lock does not exist yet in the player (M2): the matcher models both cases, but today's decks change pitch with tempo, so key-lock off is the accurate setting.
- The scoring weights, gates and the Camelot relation values are judgment calls (documented in code and tests), not published standards; they are configurable where it matters (weights, pitch limit, key-lock, gates).
- No screen yet: H4 builds the HARMONIC MATCH workspace on top of `libraryMatch`.

## 2026-11-14: Harmonic Match step H4 (workspace) + toolbar + controller feel

**Built:** engine `libraryAnalyzeSequence` (+5 tests: distributions, transitions, problems, settings, empty/unanalysed, 2,000 tracks in 110 ms); `public/harmonic.js` and styles (the workspace described in ARCHITECTURE section 6); a sticky top bar; a Jog sensitivity slider; engine-command coalescing; playlist rendering rewrite.

**User reports handled**
- *"Top toolbar not showing correctly"* (screenshot: toolbar scrolled half out of view): turning the browse knob called `scrollIntoView`, which scrolled the whole page to reveal the playlist row. Fix: header + tabs are a sticky bar, and rows are revealed by scrolling only the playlist box. Regression checks added (toolbar position stays 0 after 40 browse-knob ticks and a page scroll; moving the selection never scrolls the page). Also fixed the "Click anywhere to enable audio" banner staying on in native mode.
- *"More responsive on the buttons, less responsive on the wheels"*: measured first (command path is fast; the UI thread stalled up to 137 ms during analysis because the playlist was rebuilt and saved every 300 ms, and wheel ticks each sent an engine command); fixed as described in ARCHITECTURE section 7; jog gains reduced to 45 % by default with a slider. Not yet felt on the hardware by the developer: please check the new defaults.
- *"Scratch pad now working"*: noted.
- *"Copy the exact console picture, remake the UI to look like the console"*: no picture was attached to the message, so nothing was copied. See open questions.

**Verified:** 63 engine tests, 124 in-app checks (workspace, wheel, filters, weights, every button, preview, live follow, toolbar regressions).

**Test mistakes found and fixed:** a row check demanded a BPM for a 5-second clip that has none; the BPM sort check could not parse a dash; the workspace object was read from the wrong place; and the new workspace checks left deck B on a 5-second track, which broke the older checks that run after them (they now restore the decks).

**Open question:** Party Mix console skin, awaiting the picture (a front-on photo of the unit).

## 2026-11-14: Console faceplate (skin v1) + wheel-centre Harmonic Match

**Request:** skin the app like the Numark Party Mix console; put HARMONIC MATCH in the centre of the jog wheels; pressing it opens the Harmonic Match tab, finding the next song for the deck whose wheel was pressed (A or B).
**Built:** see ARCHITECTURE section 8; `harmonic.openForDeck`; wording changed to "Next song for Deck X"; crossfader label overlap fixed.
**Verified:** 136+ in-app checks including: both wheels have the hub, nine knobs, dragging a knob changes the mixer, the controller moves the knob, the platter turns and the ring shows position while playing, dragging the jog nudges the deck, the browse knob moves the selection, LOAD B loads onto deck B, pressing the centre of wheel A opens Harmonic Match for Deck A (and B for Deck B), the active hub glows on the DJ screen.
**Found by the tests:** the hub highlight only lit while the Harmonic Match tab was open (when the wheel is hidden); now it glows on the deck being followed.
**Limitation:** not copied from a photo (none was attached); see ARCHITECTURE section 8.

## 2026-11-14: mixer layout per the user's description
*"Crossfader is missing"* / *"cue gain middle of mixer above the middle mark of the crossfader, above it cue mix, above master gain, LOAD 1 and LOAD 2 and the browse wheel on top"*: the mixer was rebuilt as LOAD 1 | browse wheel | LOAD 2 over channel 1 | MASTER GAIN / CUE MIX / CUE GAIN | channel 2 over a large crossfader with "◀◀ 1" and "2 ▶▶" and a centre mark. Self-test (142 checks) measures: crossfader size and visibility inside the mixer, the order and alignment of the centre knobs, LOAD buttons flanking the wheel above MASTER GAIN, channel positions.
**Still open:** the user asked three times for an *exact replica* of the Party Mix console; no photograph has been provided, so proportions, colours and finer details are an interpretation of the user's layout description and the control list.

## 2026-11-13: faceplate rebuilt from the user's photos; fit-to-screen; fullscreen
- Console faceplate (public/console.js) rebuilt as a 736x440 stage scaled to the window height AND width: two jog wheels with the HARMONIC MATCH hub in the centre, scratch / headphone buttons under each wheel, 2x2 pads + PAD MODE (legend EFFECT / CUE / LOOP / SAMPLER as printed), SYNC (blue) | CUE (purple) | PLAY/PAUSE (green), tempo slider on the outer edge (-% top, +% bottom), mixer with BROWSE, LOAD 1/2, MASTER GAIN, CUE MIX, CUE GAIN, channel knobs and faders, crossfader "<<< 1 ... 2 >>>", three party-light orbs on the top edge, LIGHTS button (off/on/beat/music).
- Button lights in the app use the same state as the controller LEDs (one source: updateUi / updateLeds).
- DJ view and Harmonic Match tab never scroll the page; the playlist and tables scroll inside their own panels. App starts fullscreen, F11 toggles to a maximised window.
- Engine: shorter play/seek de-click ramps (1.5 ms / 24 samples). Self-test 151 checks; engine tests 63.
- Open: hardware light CCs (0x40/0x42/0x43) and tempo-fader direction are unverified on the device; calibration of knob/fader ranges needs a guided "move each control" pass.

## 2026-11-14: calibration, visuals, lights, LEDs
- Calibration wizard (public/calib.js; Calibrate button; opens on first start when the Party Mix is connected): starts with every controller light off, then ZERO position (all knobs left, faders down, crossfader left), FULL position (all right), then learns each tempo fader (message, top = -%, bottom = +%, centre detent), each jog wheel (message, encoding, direction, speed), and a starting position the screen follows. Stored in localStorage "calibration"; applied before the built-in MIDI map, so a fader/wheel that sends a different message than the Mixxx map assumed now works.
- Pad presses light the pad on screen and its LED on the controller (momentary); all LED states are re-sent every 2 s.
- Time display: click toggles elapsed / remaining. Browse knob is a dark ribbed rubber wheel (no marker). Party lights are small, spin, change hue and glide with the beat/music.
- Side visuals (public/visuals.js): two framed screens in the free space either side of the console, one picture shown on both, 50 procedural presets in the console's colours, click = random preset on both. Reacts to master level and the beat.
- Fullscreen: window created fullscreen with retries, F11 and a toolbar button toggle (an already-running old instance only gets focused: close it first).
- Self-test: 171 checks (new: calibration wizard, ranges, pad LEDs, time toggle, visuals sync, light size).
- Unverified on hardware: LED note values, party-light CCs, whether the left tempo fader sends CC 0x09 on channel 1 (calibration will learn it).

## 2026-11-14 (2): per-control calibration, master DJ filter, Auto DJ, better sync
- **Calibration v3** (public/calib.js): a guided *learn each control* wizard (RO / EN). The faceplate highlights one control at a time (37: per deck gain, treble, bass, channel fader, tempo fader, jog, PLAY, CUE, SYNC, PFL, SCRATCH/HM, pads 1-4; centre master, cue mix, filter, crossfader, browse, LOAD 1/2); the user moves/presses just that one and the app records the MIDI message and its real travel (7-bit CC, 14-bit pairs use the high half, pitch-bend; tempo fader top = -%, jog encoding/direction/speed, browse direction). A message already owned by another control is refused. Learned mapping is applied before the built-in map, so a hardware knob can no longer end up driving the wrong software control (the report "treble acts like volume"). Starts with all controller lights off and the "everything to zero" page. Re-runnable: Calibrate button and Audio settings -> Controller calibration (Recalibrate / Forget). The panel is above the visuals and moves to the opposite side of the highlighted control.
- **Master DJ filter** on the former CUE GAIN knob (engine `ParamId::Filter`, `MasterFilter` in core.rs): 4th-order Butterworth, left of centre = low-pass (20 kHz -> 80 Hz), right = high-pass (20 Hz -> 8 kHz), dead zone at the centre, applied to the summed master so it works on any channel / volume / crossfader / EQ setting. Headphone level is fixed. Web Audio fallback has the same filter. 4 new engine tests (67 total) + EQ band tests.
- **Auto DJ** (public/autodj.js; AUTO DJ button next to Audio settings, before Calibrate): modes BEST MATCH (library Harmonic Match, tempo-matchable songs first), VIBE (similar mood/energy, weighted variety), RANDOM, PLAYLIST ORDER, ENERGY UP, ENERGY DOWN. Loads the next song on the free deck shortly before the end, matches the tempo (1x, 2x or 0.5x within the pitch limit), starts it on the next bar of the playing song, crossfades over 8 / 16 / 32 beats with a bass swap, stops the old deck, repeats. SKIP, STOP, panel with NOW / NEXT / progress.
- **Better sync**: `syncTo` considers half/double time and aligns phase in real time (no seek for < 8 ms). Measured in the self-test with a 128 BPM song under a 120 BPM song: tempo equal within 0.15 BPM, phase difference 0.013 beats.
- Fonts bigger/bolder on the faceplate and panels; party lights have a coloured glow (blue, magenta, green); the track text between the knobs is gone (it is the browse tooltip now); fullscreen start is retried and logged (fullscreen.log in the user-data folder). NOTE: an already-running instance only gets focused by a new launch: close the old one first.
- Self-test: 189 checks native, 85 fallback. Unverified on hardware: LED values, party-light CCs, and each control's real messages (the new calibration learns them).

## 2026-11-14 (later): hardware-report fixes, FX pads, calibration fine-tuning
- **Volume fader range**: a learned range that was too short (capture ended during a pause mid-sweep) made the physical top read ~50 %. Now a knob/fader/crossfader must be swept over ≥100 of 127 before the wizard accepts it on its own, reached end stops snap to exactly 0/127, and any value beyond the learned range widens it live (so the next push to the top fixes an old, wrong calibration without re-running it).
- **PAD MODE button**: the wizard now learns it (control 39 of 39, per deck) and every press cycles CUE → LOOP → SAMPLER → EFFECT; the default mapping also cycles instead of jumping to a fixed mode. Mode LEDs are switched off with velocity 0 (they used to be "off" = 0x01, which is the dim-ON value; likely why all stayed lit). **Not verified on hardware**: which note the real button sends (calibrate it) and that velocity 0 darkens the mode LEDs.
- **DJ filter (CUE GAIN)**: new curve `filter_cutoff` in `engine/src/core.rs` (+ mirrored in the Web Audio fallback): flat dead zone ±5 %, then log sweep over the whole travel; low-pass 18 kHz → 200 Hz (bass line stays), high-pass 30 Hz → 6 kHz (highs only). 3 Rust tests.
- **Party lights** (3 lights on the top edge of the mixer): now faceted gems with a segmented ring that fills with the light's level; same states/meaning.
- **Side visuals**: last visual stored per side (`visual.left`, `visual.right`) and restored on start. The two screens still show one picture (left wins on restore).
- **FX in SAMPLER pad mode** (native engine only): new `engine/src/fx.rs`, 4 slots × 16 effects (Flanger, Phaser, Echo, Ping-Pong, Reverb, Bit Crusher, Gater, Auto-Pan, Ring Mod, Auto-Wah, Chorus, Overdrive, Stutter, Dub Echo, Telephone, Filter Sweep), tempo-synced to the playing track. Pads 1-4 hold their effect while pressed; right-click or scroll on a pad (SAMPLER mode) picks another of the 16; choice is remembered (`fxSlots`). Not available in the Web Audio fallback. 3 Rust tests (pass-through when off, every effect finite/bounded/audible and releases cleanly, 4-slot chaining). Effects are my own implementations inspired by common DJ-software FX lists, not copies of Serato's; sound quality has been checked only numerically, not by ear.
- **Calibration fine-tuning**: after a control is learned the wizard waits 4.5 s of quiet (was 0.9 s) and keeps measuring: jog wheels re-scale from the real step size while you keep turning, knobs/faders keep widening their range.
- Tests: `cargo test --release` all green (incl. 6 new); self-test 194/194 native, 90/90 fallback (new checks: PAD MODE learn, fader range widening, jog fine-tune, FX pad on/off, 16 effects).

## 1.1.0: pad-mode LEDs follow the real controller
- From the Numark user guide / Mixxx manual: the Party Mix has **3** pad-mode LEDs (CUE, LOOP, SAMPLER); EFFECT mode lights **all three**. The faceplate now shows 3 LEDs, EFFECT is a bracket over them, and the app sends exactly that to the controller (notes 0x00 / 0x0B / 0x0E; the unused 0x18 LED is no longer driven).
- PAD MODE button: community notes say it sends a note on channel 5/6 that names a mode (0x00 CUE, 0x0B LOOP, 0x0E SAMPLER, 0x0F EFFECT) and it is unknown whether that is the mode before or after the press. A note naming another mode selects it; the current mode's note means "next mode" (works for both readings). 0x0F added. **Unverified on hardware.**
- The manual's EFFECT mode (pads 1-3 effect while held, pad 4 dry/wet) is not implemented: SAMPLER carries the 4 effect pads as requested; EFFECT stays loop-roll.
- Version 1.1.0; self-test and cargo tests re-run.

## 1.2.0
- **FX are per deck**: each channel has its own FX unit; a deck's SAMPLER pads only affect that deck (they used to hit the master, so the left WAH changed the right deck). Pad holds are tracked per deck and slot (no shared counter that could get stuck and silence the other side's pad).
- **PAD MODE LEDs**: after a PAD MODE press the screen's LED state is re-sent to that deck's controller LEDs, so controller and screen show the same mode; each button only changes its own deck (channel 5 = deck A, channel 6 = deck B). If both decks still change together on the hardware, capture the messages with the MIDI monitor to see what the unit sends. **Unverified on hardware.**
- **Auto cue points**: after analysis, a track without cues gets 4 hot cues on the bar grid: first downbeat, end of intro, chorus/drop (largest sustained loudness rise after the intro), start of outro. Once per track, never over your own cues.
- Song name on the waveform: bigger, bold, white on a dark band. PARTY MIX on the mixer is text only, smaller, one line.
- Self-test 195/195 native, 91/91 fallback; cargo tests green.

## 1.3.0
- **PAD MODE follows the controller.** The Mixxx preset for this unit sends no LED messages: the Party Mix keeps the mode and its 3 LEDs itself and reports the mode as a note (0x00 CUE, 0x0B LOOP, 0x0E 3rd LED, 0x18 all three) on channel 5/6. The app now sets the mode straight from that note and **never writes the mode LEDs** (our "off" = 0x01 is a non-zero value, the likely reason all 3 stayed lit). Removed the PAD MODE entry from the calibration wizard (back to 37 controls) and the earlier set/advance guess. Clicking a mode on the screen changes the screen only. Unverified on hardware.
- **Modes renamed**: CUE, LOOP, **EFFECTS** (was SAMPLER; 4 effect pads, as before) and **EFFECT 2** (the manual's EFFECT mode, all 3 LEDs: pads 1-3 hold an effect, pad 4 switches Dry/Wet <-> Dry+Wet, pad 4 lit = Dry/Wet). Engine: 8 FX slots, `FxMode` command, Rust test for Dry+Wet. The old JUMP and ROLL pad functions were dropped.
- Song name on the waveform: half the previous size (still bold, white on a dark band).
- Tests: cargo green (7 FX/filter tests), self-test 195/195 native, 91/91 fallback. No installer built (waiting for the troubleshooting round).
- **Right volume erratic** (calibration was correct: CC 0x1C ch 2, 0-127): fader/knob input now ignores an isolated wrong value (a sudden jump >16 waits for confirmation or 40 ms of silence; normal motion is applied at once). If the fader really sends noisy data this hides it; capture it with the MIDI monitor if it persists (could be a worn fader).
- **Pause = brake**: PLAY/PAUSE slows the deck to a stop over ~0.8 s (native engine; `Brake` command, Rust test). Cue, load and scratch stops stay instant. Not in the Web Audio fallback; switch off with `localStorage.brake = false`.
- **Layout**: playlist rows are compact and the list is tall enough for 10 songs (on screens ≥ ~820 px tall); the console and visuals scale down to make room.
- **Fader smoothness**: small fader/knob moves from the controller are eased toward the target every frame (~25 ms, no 7-bit stair-stepping); a big jump is applied at once. 
- **Speakers**: 3 speaker models (tower, subwoofer, studio monitor) are presets 51-53 of the side visuals: a frame shows a visual or speakers, never both. No red outline around the visual screens., 3 models (tower, subwoofer, studio monitor) with cones that pump to the bass/beat; click a speaker to switch model (remembered per side).
- **Diagnostics for the right volume fader**: the last 500 control-change messages (jog excluded) are stored in localStorage `midiLog` ("ms,status,cc,value;...") to analyse what the fader really sends.
- **Right volume fader, diagnosed from a raw capture** (2545 messages): the left fader and the middle of the right fader are clean, but the last ~15 % of the right fader's travel is electrically noisy: parked at the top it sends a saw-tooth between about 98 and 127 (falls by 1 every ~2 ms, then jumps back up), i.e. a worn/dirty track end, not a mapping error. Software fix (`topFilter` in `public/calib.js`, channel faders only): if any value of the last 250 ms reached 118+, the fader counts as full volume; everything else follows the raw value at once; leaving the top is a quick smooth slide. The proper cure is cleaning the fader (contact cleaner). Tests simulate the measured saw-tooth.
- **CUE MIX knob = HEADPHONES VOLUME** (CC 0x0D, ch 16): sets the level of the headphone/cue output (native `HeadGain`, Web Audio cue gain); the cue content stays "cued channels + 30 % master". On screen: headphone icon (same as the button) and the word VOLUME. Not tested with real headphones yet.
- **Browse PC = folder browser** (`public/fbrowser.js`): the Browse PC button turns the playlist area into a browser (tree of Music/Desktop/Downloads/Documents/Home + drives and folders on the left, the audio files of the chosen folder in the list instead of the playlist); the same button brings the playlist back. Folder tracks load with A / B or double-click; + adds one track to the playlist, the + next to a folder adds the whole folder tree. The temporary folder list is never saved over the playlist; the last folder is remembered.
- **M3U / Radio**: "M3U / Radio…" opens an .m3u / .m3u8 / .pls file (local songs join the playlist, http addresses become radio stations) or an internet radio address (stream or playlist link, fetched in the main process, HLS refused with an explanation). Radio stations play on a separate RADIO player in the playlist bar (play/stop/volume, default output); they cannot be loaded into a deck. Parser checked on sample M3U and PLS text; **no real radio server was contacted in the tests** (a local file stands in for the stream).
- Tests now: self-test 208/208 native, 104/104 fallback.

## Right volume fader: recorded troubleshooting (v1.2.0 test build)
- Diagnostic trace: `midiLog` now also records the filtered value applied to each channel fader (`out,<id>,<target>,<0-1000>,<min>,<max>`), ring raised to 6000 entries. Read it through the debug port (`electron . --remote-debugging-port=9333`).
- Finding from a recorded session: the worn top end of the right fader ramps down ~1 step per 2-6 ms to about 91 and jumps back to 127. The old 250 ms hold then dropped the output in one big step (117 to 45) and kept it at 127 while the hand was already lower.
- Fix (`public/calib.js`, `topEval`): hold at full volume only while the raw value stays >= 84 and a value >= 118 was seen in the last 250 ms; below 84 follow the hand at once; leaving the top slides at up to 1.2 units/ms. Replay of the recorded data: samples stuck at 127 while the hand was below 100 went from 833 to 29-218, zigzags 1 to 0.

## Harmonic Match: advisor row (reads the song, recommends the next one)
- `public/harmonic.js`: new row `#hmAdv` above the filters with three cards. (1) Reading the song: key + confidence, tempo, 10-segment energy meter, danceability, mood/vocal/bass chips, the track's coloured waveform with INTRO / OUTRO (mix point) shading, cue points, loop and playhead (redrawn 4x/s), and a hint of when to bring the next song in. (2) Camelot wheel, redrawn as a dial: bezel with ticks, hub showing the current key and BPM, glowing source segment, playlist counts as before, and numbered dots plotted in the key of each of the 5 best next songs, joined to the hub. (3) Play next: ranked cards with score ring, key move in words (perfect match, energy lift, settle down, mood switch), BPM and tempo change, energy up/down, one-line reason, Preview / A / B / add-to-set buttons. Clicking a card or a dot selects the track everywhere.
- Copies of the same song (same path, or same title, BPM and key) are left out of the recommendations.
- The small wheel card at the bottom moved into the new row; the table, filters, weights and detail panel are unchanged.

## EQ boost +20 %
- `eqDb` (`public/app.js`, used by the native engine and the Web Audio fallback): TREBLE and BASS boost range raised from +12 dB to +14.4 dB at full clockwise (20 % more); the cut side (-26 dB) and the centre detent are unchanged.

## 20 new effects, realistic speakers, beat-pulsing party lights, richer waveform
- FX (`engine/src/fx.rs`, `public/app.js`): 36 effects now (16 classic + 20 new): Tape Stop, Spinback, Reverse, Trance Gate (16-step), Machine Gun (1/16 roll), Beat Roll (1-beat roll), Tape Echo, Vibrato, Sidechain Pump, Lo-Fi, Megaphone, Underwater, Noise Riser (8 beats), Robot, Jet, HP Sweep, Bass Kill, Lows Only, Octave Down, Octave Up (granular two-head pitch shifter). Right-click or scroll on an FX pad opens the choose menu (3 columns, scrolls); saved choices stay valid.
- Bug found and fixed on the way: Stutter was silent. Pressing a pad cleared the effect's history before freezing the loop, so it froze silence (the old test could not tell silence from sound). Idle slots now keep recording the signal, so Stutter / Rolls / Spinback / Reverse have audio the moment the pad goes down; `rd()` index overflow fixed too. Tests now warm the unit up idle and require real energy (tape stop / spinback excepted); new tests: octave shift halves/doubles pitch, tape stop / spinback wind down, riser grows, pump ducks, bass kill removes 60 Hz.
- Speakers (`public/visuals.js`): cabinets with wood-vinyl grain, bevel, gloss and baffle screws (drawn once, cached), metal frames with bolts, rubber surrounds, brushed-metal cones with ridges, specular dust caps and domes, tweeter waveguides, ports, feet, floor reflection, power LED; the cabinet shakes slightly with the bass. Tower is now tweeter + midrange + woofer.
- Party lights (`public/console.js`, CSS): the beat phase comes from the playing track's own beat grid and playhead; every light pulses (gem swells up to 26 %, ring and halo flare) on the beat, strongest on the bar, slightly staggered across the three lights; without a grid it follows the music level. Verified: the pulse fires every 476 ms at 126 BPM.
- Waveform (`public/app.js` `drawWave`): saturated, brightened colours (also on the overview strip), played part dimmed, bright core inside the peak envelope, tips fade, bar numbers and gold phrase lines on the beat grid, beat ticks, intro / outro zones with IN / OUT flags, time ruler, loop with edges and label, cue flags, glowing playhead.
- Self-test updated (36 effects, treble boost 14.4 dB): 208/208 native and 104/104 fallback apart from the folder-scan check that depends on the fixture folder.

## XY Multi-FX pad (right), Loop Control + Loop Slicer (left), visuals beside the waveforms
- Layout: the two visual screens moved to the left and right of the waveform block (the waveforms are narrower, `#waves`, `visuals.js` layout). The places beside the console now hold the new panels (`public/sidehost.js` positions them and hides them when the window is too narrow): LOOP CONTROL + LOOP SLICER on the left, XY MULTI-FX on the right.
- XY pad: `engine/src/xyfx.rs` (master bus, after the master filter, before the limiter): Filter (ZDF state-variable low-pass with resonance), Echo (tempo delay, darkened soft-limited feedback), Reverb (the engine's Schroeder reverb, new `Rev::set_room`), Flanger. Convex mix `dry*(1-act) + act*sum(w_i*P_i)`, 4 ms linear activation ramp, per-sample parameter smoothing, idle = bit-exact pass-through, release clears every tail. UI: `public/xyfx.js` (pure core: normalisation, neutral zone, smoothstep activation, bilinear weights, parameter mapping, state machine, config sanitising) + `public/xypad.js` (canvas, pointer events with capture, settings, presets, Web Audio fallback). Command: `xy {act, w[4], p[8]}`.
- Loop slicer: `engine/src/slicer.rs` (per-deck position controller: region = loop, N slices, ONE-SHOT / LOOP / HOLD / QUANTIZED, grid quantisation, repeat interval, per-slice reverse, timeline "ghost" so one-shots rejoin the groove exactly) wired into the deck sample loop with a 2 ms cross-fade on every position jump (also applied to ordinary loop wraps). Commands: `sliceCfg`, `slicePad`, `sliceStop`; the engine state carries `slice` / `slicePend` for the pad highlights.
- Loop control: `public/loopcalc.js` (sizes 1/32 .. 32 beats, quantised IN / OUT / AUTO, move, x2 / ÷2, slice regions and bounds, slicer message, pad pointer state) + `public/looppanel.js` (the deck's existing loop and waveform overlay are reused; target deck AUTO / A / B; settings and colours persisted in localStorage `loopPanel`).
- Tests: `cargo test --release` (26 lib incl. 7 XY + 9 slicer, 26 integration incl. 3 new on the real mixer), `node scripts/test-xyfx.js` (10), `node scripts/test-loopcalc.js` (11), in-app self-test (loop / slicer / XY block).

## One layout, filter type
- Layout (`public/sidehost.js`, `visuals.js`, `style.css`, `index.html`): top bar = title + MIDI + engine left, AUTO DJ centred, Calibrate / fullscreen / LIGHTS / Jog / Invert pitch / MIDI monitor / Audio settings on the right (Audio last). Three aligned columns: waveforms exactly as wide as the mixer above the mixer; left column = visual above LOOP CONTROL + SLICER; right column = visual above the XY pad (visuals grow down to their panel, no empty strip). Panels are capped at 640 px and centred in their column, panel heights equal the mixer's; the loop panel shrinks its contents to fit (`--lz`). The playlist is 40 % of the window height (13 rows at 1152 px). The speaker visual keeps realistic cabinet proportions in a wide frame. The wide XY panel puts the pad on the left and the X / Y readout and effect meters on the right.
- XY filter type: LOW-PASS / HIGH-PASS / BAND-PASS / NOTCH (selector in the FILTER row and in the settings; `ft` in the `xy` command; engine SVF outputs, Web Audio biquad type in the fallback; a high-pass climbs from the bottom, the others close from the top). Rust test + Node test added.

## XY effects with more power; sharper, more musical visuals
- XY (engine + defaults): resonance up to 98 % (damping 2 .. 0.06), cutoff 50 Hz .. 20 kHz, echo up to 2 beats and 92 % feedback with brighter, louder repeats, reverb with longer tails and a wetter mix, flanger with 2x the sweep and feedback up to 85 %, flanger rate up to 14 Hz; smaller neutral zone (0.10), full strength at 0.27 from the centre, zone focus 1.4 (the corners dominate). Saved configurations from the old defaults are upgraded once (`v: 2`).
- Visuals: canvases render at device resolution (sharp), screen size = real size (circles stay circles), shorter trails (clean lines), round joins and caps, finer plasma cells; 60 fps (30 only if drawing gets expensive); fast attack on the level, a kick detector (sudden rise in level) and a pulse locked to the playing track's own beat grid.

## 1.3.0 release notes (build)
- Fix: the first message of an XY pad press is sent at once (before, a press within 8 ms of the previous message was held back by the merge timer; 16 of 40 fast presses in a test, 0 of 60 now).
- Installer and portable exe built (`npm run dist`), published with the source on GitHub.

## Waveform mouse control, half-size visuals, 28 XY effects
- Layout: the visuals are half the width of a side panel, at the outer margins; the waveforms fill the space between them (1326 px at 2048 px). The waveform is a control: click = play / pause, drag = scrub, wheel = zoom (0.8 .. 60 s), shift + wheel = nudge.
- XY pad: seven effects per family selectable on each row and in the settings (filter: low-pass, high-pass, band-pass, notch, comb, vowel, peak boost; echo: echo, ping-pong, tape, dub, slapback, reverse, triplet; reverb: room, hall, plate, spring, gated, swell, dark; flanger: flanger, phaser, chorus, vibrato, tremolo, auto-pan, ring mod). Engine: `engine/src/xyfx.rs` (`NV = 7`, `Command::Xy` carries `var: [u8; 4]`); tests: all 28 are finite, bounded, audible, different from the base effect, and release to the exact dry signal with no tail. Web Audio fallback: all four families and the filter types work; the other variants use the base echo / reverb / flanger.

## 1.3.1
- Mac first-start audio defaults (master = system default output, cue = Party Mix jack, common sample rate); Auto DJ ignores the physical crossfader while it is on (app.js default mapping and calib.js); macOS builds on Electron 43; Controller test window; cue to the Party Mix jack when it is a separate output device.

## 1.3.2
- Saved master/cue device ids are re-matched ignoring the USB location segment (Mac); README: Mac tested on a real machine.

## 1.3.3
- Headphone cue: jitter buffer, louder curve with soft clip, no master in the cue, per-deck HEADPHONE (note-off LED, every press of the latch counts), automatic speaker/headphone delay alignment with a trim slider.
