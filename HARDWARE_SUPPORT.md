> DDJ-SB DJ started as a copy of Party Mix DJ 1.3.3 (same audio engine and screen); this document describes that shared base. The controller layer is public/ddjsb.js.

# HARDWARE_SUPPORT

## Numark Party Mix (primary controller)

### Identification (measured on this PC)
| Item | Value |
|---|---|
| USB | `VID_15E4 PID_0038` (Numark Industries) |
| Windows names | Audio "Party Mix", MIDI "Party Mix MIDI", endpoint "Speakers (2- Party Mix)" |
| MIDI | 1 input + 1 output port named "Party Mix MIDI" (the app matches `/party\s*mix/i`) |
| Audio | **One 4-channel, 44.1 kHz (up to 384 kHz) WASAPI endpoint.** Channels 1/2 = master output, **channels 3/4 = headphone output** (standard for this controller; the app has not heard the headphone jack yet, see below). |
| ASIO | None installed/available. WASAPI shared mode only. |

The model is identified by USB name/ID only. Do not assume every Party Mix generation uses the same MIDI map; verify with the **MIDI monitor**.

### Audio routing status
| Path | Status |
|---|---|
| Master → Party Mix channels 1/2 | Works (Windows meter 0.85 peak). |
| Headphone cue → another output device (e.g. Realtek/laptop jack) | Works (Windows meter 0.79 peak, no leakage into master). |
| Headphone cue → Party Mix channels 3/4 | **Works with the native engine (M1)**: cue reaches ch 3/4 only (Windows meter 0.87, ch 1/2 0.00). Not possible in the Web Audio fallback (folded to ch 1/2). Chosen automatically when the Party Mix is detected; also selectable under Audio settings. Not yet confirmed by ear on the real headphone jack. |
| Master → Party Mix ch 1/2 with native engine | Works (0.87, ch 3/4 0.00). Output latency 31.8 ms (fixed 10 ms WASAPI period of this device), 0 underruns. |

### MIDI map in use (source: Mixxx Party Mix preset; not an official Numark document)
Deck channel = MIDI channel 1 (deck A, status 0x90/0x80/0xB0) and 2 (deck B, 0x91/0x81/0xB1). Library/global = channel 16 (0x9F/0xBF). Pads = channels 5/6 (0x94/0x95).

| Control | Message | Action in app |
|---|---|---|
| Play | Note 0x00 | Play / pause |
| Cue | Note 0x01 (press+release) | Cue; hold = preview |
| Sync | Note 0x02 | Tempo + beat sync |
| Scratch toggle | Note 0x07 | Scratch mode |
| Headphone (PFL) | Note 0x1B | Cue to headphones |
| Jog wheel | CC 0x06, relative (0x01–0x06 clockwise, 0x7F–0x7A counter) | Nudge / search / basic scratch |
| Pitch fader | CC 0x09 (7-bit) | Pitch ±8 % (Invert option) |
| Gain / Treble / Bass / Volume | CC 0x17 / 0x18 / 0x19 / 0x1C | Trim / high EQ / low EQ / fader |
| Crossfader | CC 0x08 on ch 16 | Crossfader |
| Master / HP level / Cue-mix | CC 0x0A / 0x0C / 0x0D on ch 16 | Master / headphone level / cue-master mix |
| Browse knob | CC 0x00 on ch 16 (relative; >0x40 = up) | Playlist selection |
| Load A / Load B | Note 0x02 / 0x03 on ch 16 | Load selected track |
| Pad mode buttons | Notes 0x00 (Hot cue), 0x0B (Loop), 0x0E (Sampler→Jump), 0x18 (FX→Roll) on ch 5/6 | Pad mode |
| Pads 1–4 | Notes 0x14–0x17 on ch 5/6 | Per mode |
| LEDs (output) | Same notes, velocity 0x7F on / 0x01 dim; pads on ch 5/6 | Play, Cue, Sync, Scratch, PFL, pad modes, pad state |

### Verification status
* Verified by the in-app self-test with **simulated** messages (volume, crossfader, pitch, gain, PFL, pad modes, hot cue, play, jog, loops).
* The user reported the physical controller "looks good" in the first browser version. Not yet individually confirmed with the real hardware: pitch fader direction/range, jog sensitivity, scratch feel, LED behaviour, browse knob press, pad modes 0x0E/0x18, LOAD buttons, whether the knobs/faders send 7-bit or 14-bit values.
* Physical knobs only report their position when moved; there is no known state-dump request, so on-screen controls catch up on first touch.

### Planned (Phase 3 work)
1. **MIDI Learn** and custom assignments (note/CC, relative/absolute, channel) with per-control capture.
2. **Profiles** saved to `%APPDATA%\Party Mix DJ\controllers\*.json`, auto-loaded by port name when the device connects; the Party Mix ships as a predefined profile.
3. **Controller configuration screen**: picture of the controller with each control's current assignment.
4. **Generic mapping** so other MIDI controllers can be added without code.
5. Detect controller generation by comparing observed messages to the profile and warn on mismatch.
6. Browse press = switch browse mode; pads configurable per bank (Phase 5).

## Other hardware on this PC
| Device | Role |
|---|---|
| Speakers (Realtek High Definition Audio) | Works as master or cue output (signal confirmed at the endpoint) |
| Dell USB Audio (×2) | Listed as outputs; not tested as cue targets with real signal |

## Test procedure for real hardware
1. Open **MIDI monitor**, move/press each control, compare with the table above, report differences.
2. Use **Test sound** in the output pickers to confirm which physical output each device is.
3. Windows endpoint meter harness (kept in the dev scratch scripts) proves which channels receive signal without needing ears.
