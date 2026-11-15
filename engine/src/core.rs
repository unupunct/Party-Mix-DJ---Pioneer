//! Real-time mixer core. Everything reachable from `Mixer::render` is real-time safe:
//! no allocation, no locks, no I/O, no logging. The UI talks to it through a lock-free SPSC command queue
//! and reads meters/positions from atomics.
use rtrb::{Consumer, Producer};
use std::f32::consts::PI;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering::Relaxed};
use std::sync::Arc;

pub const MAX_DECKS: usize = 4;
const BLOCK: usize = 256;
const LIMIT_THRESHOLD: f32 = 0.891; // -1 dBFS

/// A fully decoded track: interleaved stereo f32 at its own sample rate. Immutable once shared with the audio thread.
pub struct Track {
    pub data: Vec<f32>,
    pub sample_rate: u32,
    pub frames: usize,
}
impl Track {
    pub fn new(data: Vec<f32>, sample_rate: u32) -> Self {
        let frames = data.len() / 2;
        Self { data, sample_rate, frames }
    }
    pub fn duration(&self) -> f64 {
        self.frames as f64 / self.sample_rate as f64
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ParamId {
    Trim(u8),     // linear gain
    Low(u8),      // dB
    Mid(u8),      // dB
    High(u8),     // dB
    Vol(u8),      // linear gain (channel fader)
    Pfl(u8),      // 0/1 headphone cue
    Xf,           // crossfader -1..1
    Master,       // linear
    HeadMix,      // 0 = cue only .. 1 = master only
    HeadGain,     // linear
    DFilter(u8),  // per-channel DJ filter (the FILTER knob of each channel): -1 low-pass .. 0 off .. +1 high-pass
    Filter,       // master DJ filter: -1 = full low-pass .. 0 = off .. +1 = full high-pass
}

pub enum Command {
    Load { deck: u8, track: Arc<Track> },
    Unload(u8),
    Play(u8),
    Pause(u8),
    /// Pause with a vinyl-style brake: the deck slows to a stop over ~0.8 s (pitch falls) instead of stopping at once.
    Brake(u8),
    Seek { deck: u8, pos: f64 }, // seconds
    Rate { deck: u8, rate: f32 },
    Loop { deck: u8, start: f64, end: f64, on: bool }, // seconds
    Param(ParamId, f32),
    /// Short two-tone test beep on the master (0) or headphone cue (1) output, so a user can identify an output.
    Beep(u8),
    /// FX unit: choose the effect of a slot, hold a slot on/off, set the tempo the synced effects follow.
    FxEffect { slot: u8, effect: u8 },
    FxOn { deck: u8, slot: u8, on: bool },
    FxMode { deck: u8, additive: bool },
    FxBpm(f32),
    FxLevel { deck: u8, level: f32 },
    KeyLock { deck: u8, on: bool },
    /// XY multi-FX pad on the master bus: overall activation (0 = released), the four path weights and the eight parameters.
    Xy { act: f32, w: [f32; 4], p: [f32; 8], var: [u8; 4] },
    /// Loop slicer of a deck (times in seconds of the track): source region, slice count, mode, trigger quantisation, repeat interval, beat-grid origin, reverse mask.
    SliceCfg { deck: u8, on: bool, start: f64, end: f64, n: u8, mode: u8, quant: f64, repeat: f64, grid: f64, rev: u16 },
    SlicePad { deck: u8, idx: u8, down: bool },
    SliceStop(u8),
}

fn f2u(v: f32) -> u32 { v.to_bits() }
fn u2f(v: u32) -> f32 { f32::from_bits(v) }

#[derive(Default)]
pub struct DeckShared {
    pub pos_bits: AtomicU64, // f64 seconds
    pub playing: AtomicBool,
    pub loaded: AtomicBool,
    pub peak: [AtomicU32; 2], // running max since last take (non-negative floats compare as u32)
    pub slice_cur: std::sync::atomic::AtomicI32,  // slice being played (-1 = none)
    pub slice_pend: std::sync::atomic::AtomicI32, // slice waiting for the grid (-1 = none)
}

#[derive(Default)]
pub struct Shared {
    pub decks: [DeckShared; MAX_DECKS],
    pub master_peak: [AtomicU32; 2],
    pub cue_peak: [AtomicU32; 2],
    pub clips: AtomicU32,
    pub xruns: AtomicU32,
    pub cpu_x1000: AtomicU32,     // callback time / buffer time, x1000
    pub latency_us: AtomicU32,    // reported output latency
    pub cue_lat_us: AtomicU32,    // measured delay of the headphone cue (device latency + cue buffer), smoothed
    pub sync_trim_us: std::sync::atomic::AtomicI32, // manual trim of the speaker/headphone alignment
    pub buffer_frames: AtomicU32, // last callback size
    pub frames_rendered: AtomicU64,
}
impl Shared {
    pub fn take_peak(a: &[AtomicU32; 2]) -> [f32; 2] {
        [u2f(a[0].swap(0, Relaxed)), u2f(a[1].swap(0, Relaxed))]
    }
    pub fn deck_pos(&self, d: usize) -> f64 { f64::from_bits(self.decks[d].pos_bits.load(Relaxed)) }
}
#[inline]
fn peak_max(a: &AtomicU32, v: f32) { a.fetch_max(f2u(v.abs()), Relaxed); }

// ---------------------------------------------------------------- DSP primitives
#[derive(Clone, Copy)]
struct Biquad { b0: f32, b1: f32, b2: f32, a1: f32, a2: f32, z1: f32, z2: f32 }
impl Biquad {
    fn identity() -> Self { Self { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0, z1: 0.0, z2: 0.0 } }
    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
    fn set(&mut self, b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) {
        self.b0 = b0 / a0; self.b1 = b1 / a0; self.b2 = b2 / a0; self.a1 = a1 / a0; self.a2 = a2 / a0;
    }
    fn shelf(&mut self, fs: f32, f0: f32, db: f32, high: bool) {
        let a = 10f32.powf(db / 40.0);
        let w0 = 2.0 * PI * f0 / fs;
        let (sw, cw) = (w0.sin(), w0.cos());
        let alpha = sw / 2.0 * ((a + 1.0 / a) * (1.0 / 1.0 - 1.0) + 2.0).sqrt();
        let t = 2.0 * a.sqrt() * alpha;
        if high {
            self.set(a * ((a + 1.0) + (a - 1.0) * cw + t), -2.0 * a * ((a - 1.0) + (a + 1.0) * cw), a * ((a + 1.0) + (a - 1.0) * cw - t),
                     (a + 1.0) - (a - 1.0) * cw + t, 2.0 * ((a - 1.0) - (a + 1.0) * cw), (a + 1.0) - (a - 1.0) * cw - t);
        } else {
            self.set(a * ((a + 1.0) - (a - 1.0) * cw + t), 2.0 * a * ((a - 1.0) - (a + 1.0) * cw), a * ((a + 1.0) - (a - 1.0) * cw - t),
                     (a + 1.0) + (a - 1.0) * cw + t, -2.0 * ((a - 1.0) + (a + 1.0) * cw), (a + 1.0) + (a - 1.0) * cw - t);
        }
    }
    fn peaking(&mut self, fs: f32, f0: f32, q: f32, db: f32) {
        let a = 10f32.powf(db / 40.0);
        let w0 = 2.0 * PI * f0 / fs;
        let (sw, cw) = (w0.sin(), w0.cos());
        let alpha = sw / (2.0 * q);
        self.set(1.0 + alpha * a, -2.0 * cw, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * cw, 1.0 - alpha / a);
    }
}

/// Master DJ filter (like the filter knob of other mixers): left of centre = low-pass (cuts the highs), right of centre = high-pass
/// (cuts the lows), centre = off. 4th-order Butterworth (two cascaded biquads), applied to the summed master, so it works
/// on whatever is playing, whatever the channel faders, crossfader, gains and EQ are doing.
/// Filter knob curve. `v` = -1 (knob fully left) .. 0 (centre) .. +1 (fully right).
/// Returns `None` inside the flat dead zone around the centre, else `(is_high_pass, cutoff_hz)`.
/// Both sides sweep logarithmically (equal knob travel = equal musical interval) across the whole travel:
/// low-pass 18 kHz -> 200 Hz (fully left leaves the bass line, never silence), high-pass 30 Hz -> 6 kHz (fully right leaves only the highs).
/// The start frequencies are outside the audible music band, so there is no click or jump where the dead zone ends.
pub fn filter_cutoff(v: f32) -> Option<(bool, f32)> {
    const DEAD: f32 = 0.05;
    let m = v.abs().min(1.0);
    if m <= DEAD { return None; }
    let u = ((m - DEAD) / (1.0 - DEAD)).clamp(0.0, 1.0);
    Some(if v > 0.0 { (true, 30.0 * (6000.0f32 / 30.0).powf(u)) } else { (false, 18000.0 * (200.0f32 / 18000.0).powf(u)) })
}

/// KEY LOCK (master tempo): the deck plays at its tempo-fader speed (which also moves the pitch); this two-tap crossfaded delay-line shifter moves the pitch
/// back by the inverse ratio, so the tempo changes and the key stays. Latency about half the window (~23 ms at 44.1 kHz).
struct KeyShift { buf: [Vec<f32>; 2], wp: usize, phase: f32, on: f32 }
const KS_WIN: usize = 2048;
impl KeyShift {
    fn new() -> Self { Self { buf: [vec![0.0; KS_WIN * 2], vec![0.0; KS_WIN * 2]], wp: 0, phase: 0.0, on: 0.0 } }
    #[inline]
    fn rd(&self, c: usize, delay: f32) -> f32 {
        let n = KS_WIN * 2; let p = self.wp as f32 + n as f32 - delay; let i = p.floor(); let f = p - i; let i0 = (i as usize) % n; let i1 = (i0 + 1) % n;
        self.buf[c][i0] * (1.0 - f) + self.buf[c][i1] * f
    }
    /// ratio = wanted pitch factor (1 / tempo rate). Returns the pitch-corrected pair.
    #[inline]
    fn process(&mut self, l: f32, r: f32, ratio: f32, active: bool) -> (f32, f32) {
        let n = KS_WIN * 2;
        self.buf[0][self.wp] = l; self.buf[1][self.wp] = r;
        let target = if active && (ratio - 1.0).abs() > 0.0005 { 1.0 } else { 0.0 };
        self.on += (target - self.on) * 0.002;
        let (a, b) = if self.on > 0.001 {
            let w = KS_WIN as f32;
            let (p1, p2) = (self.phase, (self.phase + 0.5).fract());
            let (g1, g2) = ((std::f32::consts::PI * p1).sin().powi(2), (std::f32::consts::PI * p2).sin().powi(2));
            let (d1, d2) = (p1 * w + 8.0, p2 * w + 8.0);
            let o = (self.rd(0, d1) * g1 + self.rd(0, d2) * g2, self.rd(1, d1) * g1 + self.rd(1, d2) * g2);
            self.phase = (self.phase + (1.0 - ratio) / w).rem_euclid(1.0);
            o
        } else { (l, r) };
        self.wp = (self.wp + 1) % n;
        (l * (1.0 - self.on) + a * self.on, r * (1.0 - self.on) + b * self.on)
    }
}

struct MasterFilter { v: f32, target: f32, st: [[Biquad; 2]; 2], active: bool }
impl MasterFilter {
    fn new() -> Self { Self { v: 0.0, target: 0.0, st: [[Biquad::identity(); 2]; 2], active: false } }
    /// Called once per block: glide towards the target and recompute the coefficients.
    fn update(&mut self, sr: f32, n: usize) {
        let a = 1.0 - (-(n as f32) / (0.025 * sr)).exp();
        self.v += (self.target - self.v) * a;
        if (self.target - self.v).abs() < 1e-4 { self.v = self.target; }
        if filter_cutoff(self.v).is_none() {
            if self.active { self.active = false; self.st = [[Biquad::identity(); 2]; 2]; }
            return;
        }
        let high = self.v > 0.0;
        let fc = filter_cutoff(self.v).map(|(_, f)| f).unwrap_or(1000.0).min(sr * 0.45);
        let w0 = 2.0 * PI * fc / sr;
        let (sw, cw) = (w0.sin(), w0.cos());
        for (k, q) in [0.5412f32, 1.3066f32].into_iter().enumerate() {
            let alpha = sw / (2.0 * q);
            let (b0, b1, b2) = if high { ((1.0 + cw) / 2.0, -(1.0 + cw), (1.0 + cw) / 2.0) } else { ((1.0 - cw) / 2.0, 1.0 - cw, (1.0 - cw) / 2.0) };
            for ch in 0..2 { self.st[ch][k].set(b0, b1, b2, 1.0 + alpha, -2.0 * cw, 1.0 - alpha); }
        }
        self.active = true;
    }
    #[inline]
    fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        if !self.active { return (l, r); }
        let l1 = self.st[0][0].process(l);
        let l2 = self.st[0][1].process(l1);
        let r1 = self.st[1][0].process(r);
        let r2 = self.st[1][1].process(r1);
        (l2, r2)
    }
}

#[derive(Clone, Copy)]
struct Smooth { cur: f32, target: f32 }
impl Smooth {
    fn new(v: f32) -> Self { Self { cur: v, target: v } }
    #[inline]
    fn next(&mut self, coef: f32) -> f32 { self.cur += (self.target - self.cur) * coef; self.cur }
}

struct Deck {
    track: Option<Arc<Track>>,
    pos: f64, // frames in the track's own sample rate
    playing: bool,
    rate: f32,
    step_scale: f64,
    loop_on: bool, loop_start: f64, loop_end: f64,
    slicer: crate::slicer::Slicer,
    xf_pos: f64, xf_left: u32,   // cross-fade after a position jump: the old read position fades out over XF_N samples
    trim: Smooth, vol: Smooth, pfl: Smooth, play_gain: Smooth,
    fade_in: f32,
    braking: bool, brake: f32,
    low: [Biquad; 2], mid: [Biquad; 2], high: [Biquad; 2],
    low_db: f32, mid_db: f32, high_db: f32,
    filt: MasterFilter,
    kl: bool, ks: KeyShift,
}
impl Deck {
    fn new() -> Self {
        Self { track: None, pos: 0.0, playing: false, rate: 1.0, step_scale: 1.0, loop_on: false, loop_start: 0.0, loop_end: 0.0, slicer: crate::slicer::Slicer::new(), xf_pos: 0.0, xf_left: 0,
               trim: Smooth::new(1.0), vol: Smooth::new(0.0), pfl: Smooth::new(0.0), play_gain: Smooth::new(0.0), fade_in: 1.0, braking: false, brake: 1.0,
               low: [Biquad::identity(); 2], mid: [Biquad::identity(); 2], high: [Biquad::identity(); 2],
               low_db: 0.0, mid_db: 0.0, high_db: 0.0, filt: MasterFilter::new(), kl: false, ks: KeyShift::new() }
    }
    fn update_eq(&mut self, fs: f32) {
        for c in 0..2 {
            self.low[c].shelf(fs, 250.0, self.low_db, false);
            self.mid[c].peaking(fs, 1000.0, 0.7, self.mid_db);
            self.high[c].shelf(fs, 2500.0, self.high_db, true);
        }
    }
    fn update_step(&mut self, out_rate: f32) {
        self.step_scale = self.track.as_ref().map(|t| t.sample_rate as f64 / out_rate as f64).unwrap_or(1.0);
    }
}

#[inline]
fn hermite(y0: f32, y1: f32, y2: f32, y3: f32, t: f32) -> f32 {
    let c1 = 0.5 * (y2 - y0);
    let c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    let c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    ((c3 * t + c2) * t + c1) * t + y1
}
#[inline]
fn at(d: &[f32], frames: usize, i: isize, ch: usize) -> f32 {
    if i < 0 || i as usize >= frames { 0.0 } else { d[i as usize * 2 + ch] }
}

const XF_N: u32 = 96;   // about 2 ms

pub struct Mixer {
    sr: f32,
    decks: [Deck; MAX_DECKS],
    xf: Smooth, master: Smooth, head_mix: Smooth, head_gain: Smooth,
    mfilter: MasterFilter,
    xy: crate::xyfx::XyFx,   // XY multi-FX pad (master bus, after the master filter, before the limiter)
    fx: [crate::fx::FxUnit; 2],   // one FX unit per channel (decks 1 and 2): a pad of a deck only affects that deck
    lim_gain: f32,
    rx: Consumer<Command>,
    garbage: Producer<Arc<Track>>,
    shared: Arc<Shared>,
    c_fast: f32, c_play: f32,
    cpu: f32,
    beep_left: u32, beep_total: u32, beep_target: u8, beep_phase: f32,
}

impl Mixer {
    pub fn new(sample_rate: u32, rx: Consumer<Command>, garbage: Producer<Arc<Track>>, shared: Arc<Shared>) -> Self {
        let mut m = Self {
            sr: sample_rate as f32, decks: [Deck::new(), Deck::new(), Deck::new(), Deck::new()],
            xf: Smooth::new(0.0), master: Smooth::new(0.8), head_mix: Smooth::new(0.3), head_gain: Smooth::new(0.9),
            mfilter: MasterFilter::new(), xy: crate::xyfx::XyFx::new(sample_rate as f32),
            fx: [crate::fx::FxUnit::new(sample_rate as f32), crate::fx::FxUnit::new(sample_rate as f32)],
            lim_gain: 1.0, rx, garbage, shared, c_fast: 0.0, c_play: 0.0, cpu: 0.0,
            beep_left: 0, beep_total: 1, beep_target: 0, beep_phase: 0.0,
        };
        m.set_sample_rate(sample_rate);
        m
    }
    /// Called only while no stream is running (device (re)open).
    pub fn set_sample_rate(&mut self, sample_rate: u32) {
        self.sr = sample_rate as f32; self.xy = crate::xyfx::XyFx::new(self.sr);
        { let old: Vec<usize> = (0..crate::fx::SLOTS).map(|i| self.fx[0].effect_of(i)).collect(); self.fx = [crate::fx::FxUnit::new(self.sr), crate::fx::FxUnit::new(self.sr)]; for (i, e) in old.into_iter().enumerate() { for f in self.fx.iter_mut() { f.set_effect(i, e); } } }
        self.c_fast = 1.0 - (-1.0 / (0.005 * self.sr)).exp();
        self.c_play = 1.0 - (-1.0 / (0.0015 * self.sr)).exp();
        let sr = self.sr;
        for d in self.decks.iter_mut() { d.update_eq(sr); d.update_step(sr); }
    }

    fn apply(&mut self, cmd: Command) {
        let sr = self.sr;
        match cmd {
            Command::Load { deck, track } => {
                let d = &mut self.decks[deck as usize % MAX_DECKS];
                if let Some(old) = d.track.replace(track) { if let Err(rtrb::PushError::Full(a)) = self.garbage.push(old) { std::mem::forget(a); } }
                d.pos = 0.0; d.playing = false; d.loop_on = false; d.fade_in = 0.0; d.play_gain.cur = 0.0; d.play_gain.target = 0.0;
                d.update_step(sr);
                self.shared.decks[deck as usize].loaded.store(true, Relaxed);
                self.shared.decks[deck as usize].playing.store(false, Relaxed);
            }
            Command::Unload(deck) => {
                let d = &mut self.decks[deck as usize % MAX_DECKS];
                if let Some(old) = d.track.take() { if let Err(rtrb::PushError::Full(a)) = self.garbage.push(old) { std::mem::forget(a); } }
                d.playing = false; d.pos = 0.0;
                self.shared.decks[deck as usize].loaded.store(false, Relaxed);
                self.shared.decks[deck as usize].playing.store(false, Relaxed);
            }
            Command::Play(deck) => {
                let d = &mut self.decks[deck as usize % MAX_DECKS];
                if let Some(t) = &d.track {
                    if d.pos >= t.frames as f64 - 1.0 { d.pos = 0.0; }
                    d.playing = true; d.braking = false; d.play_gain.target = 1.0;
                    self.shared.decks[deck as usize].playing.store(true, Relaxed);
                }
            }
            Command::Pause(deck) => {
                let d = &mut self.decks[deck as usize % MAX_DECKS];
                d.playing = false; d.braking = false; d.play_gain.target = 0.0;
                self.shared.decks[deck as usize].playing.store(false, Relaxed);
            }
            Command::Brake(deck) => {
                let d = &mut self.decks[deck as usize % MAX_DECKS];
                if d.playing && d.track.is_some() { d.braking = true; d.brake = 1.0; }
            }
            Command::Seek { deck, pos } => {
                let d = &mut self.decks[deck as usize % MAX_DECKS];
                if let Some(t) = &d.track {
                    d.pos = (pos * t.sample_rate as f64).clamp(0.0, t.frames as f64);
                    d.fade_in = 0.0; // short ramp-up hides the discontinuity
                }
            }
            Command::Rate { deck, rate } => self.decks[deck as usize % MAX_DECKS].rate = rate.clamp(0.0, 4.0),
            Command::Loop { deck, start, end, on } => {
                let d = &mut self.decks[deck as usize % MAX_DECKS];
                if let Some(t) = &d.track {
                    let r = t.sample_rate as f64;
                    d.loop_start = start * r; d.loop_end = end * r;
                    d.loop_on = on && d.loop_end > d.loop_start + 16.0;
                }
            }
            Command::FxEffect { slot, effect } => for f in self.fx.iter_mut() { f.set_effect(slot as usize, effect as usize) },
            Command::FxOn { deck, slot, on } => if let Some(f) = self.fx.get_mut(deck as usize) { f.set_on(slot as usize, on) },
            Command::FxMode { deck, additive } => if let Some(f) = self.fx.get_mut(deck as usize) { f.set_additive(additive) },
            Command::KeyLock { deck, on } => self.decks[deck as usize % MAX_DECKS].kl = on,
            Command::FxLevel { deck, level } => if let Some(f) = self.fx.get_mut(deck as usize) { f.set_level(level) },
            Command::FxBpm(b) => for f in self.fx.iter_mut() { f.set_bpm(b) },
            Command::Xy { act, w, p, var } => { self.xy.set_variants(var); self.xy.set(act, w, p) }
            Command::SliceCfg { deck, on, start, end, n, mode, quant, repeat, grid, rev } => {
                let d = &mut self.decks[deck as usize % MAX_DECKS];
                if let Some(t) = &d.track { let r = t.sample_rate as f64;
                    if let Some(old) = d.slicer.configure(on, start * r, end * r, n as u32, mode, quant * r, repeat * r, grid * r, rev, &mut d.pos) { d.xf_pos = old; d.xf_left = XF_N; }
                    if d.slicer.on { d.loop_on = false; }
                    if !on { self.shared.decks[deck as usize % MAX_DECKS].slice_cur.store(-1, Relaxed); } }
            }
            Command::SlicePad { deck, idx, down } => {
                let d = &mut self.decks[deck as usize % MAX_DECKS];
                let j = if down { d.slicer.press(idx as u32, &mut d.pos) } else { d.slicer.release(idx as u32, &mut d.pos) };
                if let Some(old) = j { d.xf_pos = old; d.xf_left = XF_N; }
            }
            Command::SliceStop(deck) => { let d = &mut self.decks[deck as usize % MAX_DECKS]; if let Some(old) = d.slicer.stop(&mut d.pos) { d.xf_pos = old; d.xf_left = XF_N; } }
            Command::Beep(target) => { self.beep_target = target; self.beep_total = (self.sr * 0.7) as u32; self.beep_left = self.beep_total; self.beep_phase = 0.0; }
            Command::Param(id, v) => match id {
                ParamId::Trim(i) => self.decks[i as usize % MAX_DECKS].trim.target = v,
                ParamId::Vol(i) => self.decks[i as usize % MAX_DECKS].vol.target = v,
                ParamId::Pfl(i) => self.decks[i as usize % MAX_DECKS].pfl.target = if v > 0.5 { 1.0 } else { 0.0 },
                ParamId::Low(i) => { let d = &mut self.decks[i as usize % MAX_DECKS]; d.low_db = v; d.update_eq(sr); }
                ParamId::Mid(i) => { let d = &mut self.decks[i as usize % MAX_DECKS]; d.mid_db = v; d.update_eq(sr); }
                ParamId::High(i) => { let d = &mut self.decks[i as usize % MAX_DECKS]; d.high_db = v; d.update_eq(sr); }
                ParamId::Xf => self.xf.target = v.clamp(-1.0, 1.0),
                ParamId::Master => self.master.target = v,
                ParamId::HeadMix => self.head_mix.target = v.clamp(0.0, 1.0),
                ParamId::HeadGain => self.head_gain.target = v,
                ParamId::DFilter(i) => self.decks[i as usize % MAX_DECKS].filt.target = v.clamp(-1.0, 1.0),
                ParamId::Filter => self.mfilter.target = v.clamp(-1.0, 1.0),
            },
        }
    }

    /// Render `frames` of interleaved-stereo master and cue (headphone) audio. Real-time safe.
    pub fn render(&mut self, master: &mut [f32], cue: &mut [f32], frames: usize) {
        for _ in 0..128 { match self.rx.pop() { Ok(c) => self.apply(c), Err(_) => break } }
        let mut done = 0;
        while done < frames {
            let n = (frames - done).min(BLOCK);
            self.render_block(&mut master[done * 2..(done + n) * 2], &mut cue[done * 2..(done + n) * 2], n);
            done += n;
        }
        self.shared.frames_rendered.fetch_add(frames as u64, Relaxed);
    }

    fn render_block(&mut self, master: &mut [f32], cue: &mut [f32], n: usize) {
        let (cf, cp) = (self.c_fast, self.c_play); let sr_hz = self.sr;
        let mut bm = [0f32; BLOCK * 2];   // post-fader sum
        let mut bc = [0f32; BLOCK * 2];   // PFL sum
        let mut mpk = [0f32; 2];
        let _ = &mut mpk;
        // crossfader values per frame (shared by all decks)
        let mut xa = [0f32; BLOCK];
        let mut xb = [0f32; BLOCK];
        for i in 0..n {
            let x = (self.xf.next(cf) + 1.0) * 0.5;
            xa[i] = (2.0 * (1.0 - x)).min(1.0);
            xb[i] = (2.0 * x).min(1.0);
        }
        for (di, d) in self.decks.iter_mut().enumerate() {
            let Some(track) = d.track.clone_ref() else {
                continue;
            };
            let frames_f = track.frames as f64;
            let step = d.rate as f64 * d.step_scale;
            let brake_dec = 1.0 / (0.8 * sr_hz);
            let mut dpk = [0f32; 2];
            d.filt.update(sr_hz, n);
            for i in 0..n {
                let gain_play = d.play_gain.next(cp);
                if !d.playing && gain_play < 1e-4 { break; }
                let ip = d.pos.floor();
                let t = (d.pos - ip) as f32;
                let idx = ip as isize;
                let g = d.trim.next(cf) * gain_play * d.fade_in;
                if d.fade_in < 1.0 { d.fade_in = (d.fade_in + 1.0 / 24.0).min(1.0); }
                let mut s = [0f32; 2];
                let (xi, xt, xfa) = if d.xf_left > 0 { let p = d.xf_pos.floor(); (p as isize, (d.xf_pos - p) as f32, d.xf_left as f32 / XF_N as f32) } else { (0, 0.0, 0.0) };
                for c in 0..2 {
                    let mut v = hermite(at(&track.data, track.frames, idx - 1, c), at(&track.data, track.frames, idx, c),
                                    at(&track.data, track.frames, idx + 1, c), at(&track.data, track.frames, idx + 2, c), t);
                    if xfa > 0.0 { let o = hermite(at(&track.data, track.frames, xi - 1, c), at(&track.data, track.frames, xi, c), at(&track.data, track.frames, xi + 1, c), at(&track.data, track.frames, xi + 2, c), xt); v = v * (1.0 - xfa) + o * xfa; }
                    let v = v * g;
                    let v = d.low[c].process(v);
                    let v = d.mid[c].process(v);
                    s[c] = d.high[c].process(v);
                }
                { let ratio = 1.0 / d.rate.max(0.05); let (kl2, kr2) = d.ks.process(s[0], s[1], ratio, d.kl && !d.braking); s[0] = kl2; s[1] = kr2; }   // KEY LOCK
                { let (fl2, fr2) = d.filt.process(s[0], s[1]); s[0] = fl2; s[1] = fr2; }   // channel DJ filter
                for c in 0..2 { dpk[c] = dpk[c].max(s[c].abs()); }
                let pfl = d.pfl.next(cf);
                let vol = d.vol.next(cf) * if di % 2 == 0 { xa[i] } else { xb[i] };
                let (fl, fr) = if di < 2 { self.fx[di].process(s[0] * vol, s[1] * vol) } else { (s[0] * vol, s[1] * vol) };   // FX on this channel only
                bm[i * 2] += fl; bm[i * 2 + 1] += fr;
                bc[i * 2] += s[0] * pfl; bc[i * 2 + 1] += s[1] * pfl;
                if d.braking {
                    d.brake -= brake_dec; let b = d.brake.max(0.0);
                    d.pos += step * (b * b) as f64;                     // quadratic: a fast drop at first, like a platter losing speed
                    if d.brake <= 0.03 { d.braking = false; d.playing = false; d.play_gain.target = 0.0; self.shared.decks[di].playing.store(false, Relaxed); }
                } else if d.slicer.on {
                    if let Some(old) = d.slicer.step(&mut d.pos, step) { d.xf_pos = old; d.xf_left = XF_N; }
                } else { d.pos += step; }
                if d.xf_left > 0 { d.xf_pos += step; d.xf_left -= 1; }
                if !d.slicer.on && d.loop_on && d.pos >= d.loop_end { d.xf_pos = d.pos; d.xf_left = XF_N; d.pos -= d.loop_end - d.loop_start; if d.pos < d.loop_start { d.pos = d.loop_start; } }
                if d.pos >= frames_f { d.pos = frames_f; d.playing = false; d.play_gain.target = 0.0; self.shared.decks[di].playing.store(false, Relaxed); }
            }
            let sh = &self.shared.decks[di];
            sh.slice_cur.store(d.slicer.current(), Relaxed); sh.slice_pend.store(d.slicer.pending(), Relaxed);
            sh.pos_bits.store((d.pos / track.sample_rate as f64).to_bits(), Relaxed);
            peak_max(&sh.peak[0], dpk[0]); peak_max(&sh.peak[1], dpk[1]);
        }
        // master section: master gain, limiter, cue mix
        let mut clip = 0u32;
        let (mut mp, mut cpk) = ([0f32; 2], [0f32; 2]);
        self.mfilter.update(self.sr, n);
        let any_pfl = self.decks.iter().any(|d| d.pfl.target > 0.5);   // the headphones play only what is cued: with no CUE button on they stay silent whatever the HEADPHONES MIX knob says
        for i in 0..n {
            let mg = self.master.next(cf);
            let hm = if any_pfl { self.head_mix.next(cf) } else { self.head_mix.cur = self.head_mix.target; 0.0 };
            let hg = self.head_gain.next(cf);
            let (l, r) = self.mfilter.process(bm[i * 2] * mg, bm[i * 2 + 1] * mg);
            let (l, r) = self.xy.process(l, r);
            let pk = l.abs().max(r.abs());
            if pk > 1.0 { clip += 1; }
            // limiter: instant attack, ~120 ms release
            let need = if pk * self.lim_gain > LIMIT_THRESHOLD { LIMIT_THRESHOLD / pk } else { 1.0 };
            if need < self.lim_gain { self.lim_gain = need; } else { self.lim_gain += (1.0 - self.lim_gain) * 0.0002; }
            // test beep (identifies an output); independent of deck faders
            let mut tone = 0f32;
            if self.beep_left > 0 {
                let elapsed = self.beep_total - self.beep_left;
                let f = if elapsed < self.beep_total / 2 { 523.0 } else { 659.0 };
                self.beep_phase = (self.beep_phase + f / self.sr).fract();
                let env = (elapsed as f32 / (0.01 * self.sr)).min(1.0).min(self.beep_left as f32 / (0.01 * self.sr));
                tone = (self.beep_phase * 2.0 * PI).sin() * 0.3 * env;
                self.beep_left -= 1;
            }
            let (tm, tc) = if self.beep_target == 0 { (tone, 0.0) } else { (0.0, tone) };
            let (ol, or) = (((l * self.lim_gain) + tm).clamp(-1.0, 1.0), ((r * self.lim_gain) + tm).clamp(-1.0, 1.0));
            master[i * 2] = ol; master[i * 2 + 1] = or;
            mp[0] = mp[0].max(ol.abs()); mp[1] = mp[1].max(or.abs());
            let (cl, cr) = (((bc[i * 2] * (1.0 - hm)) + l * hm) * hg, ((bc[i * 2 + 1] * (1.0 - hm)) + r * hm) * hg);
            let (cl, cr) = (soft_clip(cl + tc), soft_clip(cr + tc));   // the headphone feed is louder now: round off the peaks instead of hard clipping
            cue[i * 2] = cl; cue[i * 2 + 1] = cr;
            cpk[0] = cpk[0].max(cl.abs()); cpk[1] = cpk[1].max(cr.abs());
        }
        peak_max(&self.shared.master_peak[0], mp[0]); peak_max(&self.shared.master_peak[1], mp[1]);
        peak_max(&self.shared.cue_peak[0], cpk[0]); peak_max(&self.shared.cue_peak[1], cpk[1]);
        if clip > 0 { self.shared.clips.fetch_add(clip, Relaxed); }
    }

    /// Called by the audio callback to publish load figures.
    pub fn report_cpu(&mut self, load: f32) {
        self.cpu = self.cpu * 0.9 + load * 0.1;
        self.shared.cpu_x1000.store((self.cpu * 1000.0) as u32, Relaxed);
    }
}

/// `Option<Arc<Track>>` cloned cheaply without allocation (Arc clone is an atomic increment).
trait CloneRef { fn clone_ref(&self) -> Option<Arc<Track>>; }
impl CloneRef for Option<Arc<Track>> { fn clone_ref(&self) -> Option<Arc<Track>> { self.as_ref().map(Arc::clone) } }

pub fn new_engine(sample_rate: u32) -> (Mixer, Producer<Command>, Consumer<Arc<Track>>, Arc<Shared>) {
    let (ctx, crx) = rtrb::RingBuffer::<Command>::new(1024);
    let (gtx, grx) = rtrb::RingBuffer::<Arc<Track>>::new(32);
    let shared = Arc::new(Shared::default());
    (Mixer::new(sample_rate, crx, gtx, shared.clone()), ctx, grx, shared)
}

#[cfg(test)]
mod filter_curve_tests {
    use super::filter_cutoff;
    #[test]
    fn dead_zone_is_flat() {
        for v in [-0.05f32, -0.02, 0.0, 0.03, 0.05] { assert!(filter_cutoff(v).is_none(), "v={v}"); }
    }
    #[test]
    fn ends_keep_bass_and_highs() {
        let (hp, f) = filter_cutoff(-1.0).unwrap(); assert!(!hp && (f - 200.0).abs() < 1.0, "full left = low-pass at 200 Hz, got {f}");
        let (hp, f) = filter_cutoff(1.0).unwrap(); assert!(hp && (f - 6000.0).abs() < 1.0, "full right = high-pass at 6 kHz, got {f}");
    }
    #[test]
    fn smooth_log_and_monotonic_over_the_travel() {
        let (mut prev_lp, mut prev_hp) = (f32::MAX, 0.0f32);
        let mut worst_ratio = 1.0f32;
        for i in 6..=100 {
            let v = i as f32 / 100.0;
            let (_, lp) = filter_cutoff(-v).unwrap(); let (_, hp) = filter_cutoff(v).unwrap();
            assert!(lp < prev_lp && hp > prev_hp, "monotonic at {v}");
            worst_ratio = worst_ratio.max(prev_lp.min(1e9) / lp).min(1.2).max(1.0);
            prev_lp = lp; prev_hp = hp;
        }
        assert!(worst_ratio <= 1.2, "a 1 % knob step never changes the cutoff by more than 20 %");
        // musically useful middle: half travel is a clearly audible but not extreme filter
        let (_, lp) = filter_cutoff(-0.525).unwrap(); assert!(lp > 1200.0 && lp < 2500.0, "half-way LP {lp}");
        let (_, hp) = filter_cutoff(0.525).unwrap(); assert!(hp > 250.0 && hp < 800.0, "half-way HP {hp}");
        // no jump where the dead zone ends: the first filtered step is outside the music band
        let (_, lp) = filter_cutoff(-0.06).unwrap(); assert!(lp > 14000.0);
        let (_, hp) = filter_cutoff(0.06).unwrap(); assert!(hp < 45.0);
    }
}

/// Linear up to 0.8, then a smooth knee towards 1.0 (headphone cue only).
fn soft_clip(x: f32) -> f32 { let a = x.abs(); if a <= 0.8 { x } else { x.signum() * (0.8 + 0.2 * ((a - 0.8) / 0.2).tanh()) } }
