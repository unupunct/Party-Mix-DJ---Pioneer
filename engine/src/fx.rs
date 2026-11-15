//! Per-deck FX unit: 8 slots, 36 effects to choose from. A pad (PAD MODE = SAMPLER) holds one slot on while it is pressed.
//! Everything is pre-allocated when the sample rate is set (never in the audio callback). Tempo-synced effects follow the BPM
//! the UI sends (`set_bpm`).
use std::f32::consts::PI;

pub const NUM_FX: usize = 36;
/// Slots 0-3 = the SAMPLER pad bank, slots 4-6 = the EFFECT pad bank (pads 1-3), slot 7 spare.
pub const SLOTS: usize = 13;   // 0-3 SAMPLER pads, 4-6 second pad bank, 7-9 FX1 SELECT 1-3, 10-12 FX2 SELECT 1-3
pub const NAMES: [&str; NUM_FX] = [
    "Flanger", "Phaser", "Echo", "Ping-Pong", "Reverb", "Bit Crusher", "Gater", "Auto-Pan",
    "Ring Mod", "Auto-Wah", "Chorus", "Overdrive", "Stutter", "Dub Echo", "Telephone", "Filter Sweep",
    "Tape Stop", "Spinback", "Reverse", "Trance Gate", "Machine Gun", "Beat Roll", "Tape Echo", "Vibrato", "Sidechain Pump", "Lo-Fi",
    "Megaphone", "Underwater", "Noise Riser", "Robot", "Jet", "HP Sweep", "Bass Kill", "Lows Only", "Octave Down", "Octave Up",
];
/// How much of the effect replaces the dry signal at full "on" (time effects blend, insert effects replace).
const MIX: [f32; NUM_FX] = [0.55, 0.7, 0.55, 0.6, 0.38, 1.0, 1.0, 1.0, 0.55, 1.0, 0.5, 1.0, 1.0, 0.6, 1.0, 1.0,
    1.0, 1.0, 0.9, 1.0, 1.0, 1.0, 0.65, 1.0, 1.0, 1.0, 1.0, 1.0, 0.85, 0.8, 0.7, 1.0, 1.0, 1.0, 0.85, 0.85];

pub(crate) struct Rev { comb: Vec<(Vec<f32>, usize, f32)>, ap: Vec<(Vec<f32>, usize)>, fb: f32, damp: f32 }
impl Rev {
    pub(crate) fn new(sr: f32, spread: usize) -> Self {
        let k = sr / 44100.0;
        Self {
            comb: [1116usize, 1188, 1277, 1356].iter().map(|&n| (vec![0.0; ((n + spread) as f32 * k) as usize + 1], 0, 0.0)).collect(),
            ap: [556usize, 441].iter().map(|&n| (vec![0.0; ((n + spread) as f32 * k) as usize + 1], 0)).collect(),
            fb: 0.82, damp: 0.65,
        }
    }
    /// Room size 0..1: decay (comb feedback) and brightness (less damping in a bigger room). The default 0.82 / 0.65 sits at about 0.44.
    pub(crate) fn set_room(&mut self, room: f32) { let r = room.clamp(0.0, 1.0); self.fb = 0.7 + 0.28 * r; self.damp = 0.8 - 0.45 * r; }
    /// Direct control of the decay (comb feedback) and the damping.
    pub(crate) fn set_params(&mut self, fb: f32, damp: f32) { self.fb = fb.clamp(0.0, 0.985); self.damp = damp.clamp(0.05, 0.98); }
    pub(crate) fn clear(&mut self) { for c in &mut self.comb { c.0.fill(0.0); c.1 = 0; c.2 = 0.0; } for a in &mut self.ap { a.0.fill(0.0); a.1 = 0; } }
    #[inline]
    pub(crate) fn process(&mut self, x: f32) -> f32 {
        let mut s = 0.0; let (fb, damp) = (self.fb, self.damp);
        for (b, i, lp) in self.comb.iter_mut() {
            let y = b[*i];
            *lp = y * damp + *lp * (1.0 - damp);       // damping
            b[*i] = x * 0.3 + *lp * fb;
            *i += 1; if *i >= b.len() { *i = 0; }
            s += y;
        }
        for (b, i) in self.ap.iter_mut() {
            let y = b[*i];
            let o = -s + y;
            b[*i] = s + y * 0.5;
            *i += 1; if *i >= b.len() { *i = 0; }
            s = o;
        }
        s * 0.5
    }
}

/// Chamberlin state-variable filter.
#[derive(Clone, Copy, Default)]
struct Svf { lo: f32, bp: f32 }
impl Svf {
    #[inline]
    fn run(&mut self, x: f32, f: f32, q: f32) -> (f32, f32, f32) {
        let g = 2.0 * (PI * f.min(18000.0)).sin();      // f is already freq/sr
        self.lo += g * self.bp;
        let hi = x - self.lo - q * self.bp;
        self.bp += g * hi;
        (self.lo, self.bp, hi)
    }
}

struct Slot {
    effect: usize, on: bool, was_on: bool, wet: f32,
    bl: Vec<f32>, br: Vec<f32>, wp: usize, len: usize,
    ph: f32, ap: [[f32; 4]; 2], fbs: [f32; 2], hold: [f32; 2], cnt: f32, gate: f32,
    svf: [Svf; 2], lp1: [f32; 2], hp1: [f32; 2],
    frozen: bool, st_start: usize, st_len: usize, st_pos: usize,
    rev: [Rev; 2],
    a: f32, b: f32, seed: u32,   // scratch state of the newer effects (tape speed / delay, riser time, noise)
}

pub struct FxUnit { sr: f32, beat: f32, c: f32, additive: bool, level: f32, slots: Vec<Slot> }

impl FxUnit {
    pub fn new(sr: f32) -> Self {
        let len = (sr * 3.0) as usize + 8;
        let slots = (0..SLOTS).map(|i| Slot {
            effect: i, on: false, was_on: false, wet: 0.0,
            bl: vec![0.0; len], br: vec![0.0; len], wp: 0, len,
            ph: 0.0, ap: [[0.0; 4]; 2], fbs: [0.0; 2], hold: [0.0; 2], cnt: 1.0, gate: 1.0,
            svf: [Svf::default(); 2], lp1: [0.0; 2], hp1: [0.0; 2],
            frozen: false, st_start: 0, st_len: 1, st_pos: 0,
            rev: [Rev::new(sr, 0), Rev::new(sr, 23)],
            a: 1.0, b: 1.0, seed: 0x1234_5678 ^ (i as u32 * 7919),
        }).collect();
        Self { sr, beat: 0.5, additive: false, level: 1.0, c: 1.0 - (-1.0 / (0.012 * sr)).exp(), slots }
    }
    pub fn set_effect(&mut self, slot: usize, effect: usize) {
        if let Some(s) = self.slots.get_mut(slot) { if effect < NUM_FX && s.effect != effect { s.effect = effect; s.reset(); s.bl.fill(0.0); s.br.fill(0.0); } }
    }
    pub fn set_on(&mut self, slot: usize, on: bool) { if let Some(s) = self.slots.get_mut(slot) { s.on = on; } }
    /// false = Dry/Wet (the effect replaces part of the dry signal), true = Dry+Wet (dry stays, the effect is added on top).
    pub fn set_additive(&mut self, add: bool) { self.additive = add; }
    /// FX LEVEL knob: how much of the effect is heard (0 = none, 1 = full).
    pub fn set_level(&mut self, level: f32) { self.level = level.clamp(0.0, 1.0); }
    pub fn set_bpm(&mut self, bpm: f32) { if bpm.is_finite() && bpm > 40.0 && bpm < 240.0 { self.beat = 60.0 / bpm; } }
    pub fn effect_of(&self, slot: usize) -> usize { self.slots.get(slot).map(|s| s.effect).unwrap_or(0) }
    pub fn any_active(&self) -> bool { self.slots.iter().any(|s| s.on || s.wet > 1e-3) }

    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        let (mut l, mut r) = (l, r);
        let (sr, beat, c) = (self.sr, self.beat, self.c);
        for s in self.slots.iter_mut() {
            if s.on && !s.was_on { s.reset(); }
            s.was_on = s.on;
            let target = if s.on { 1.0 } else { 0.0 };
            s.wet += (target - s.wet) * c;
            if !s.on && s.wet < 1e-3 { s.wet = 0.0; s.frozen = false; s.wr(l, r); continue; }   // idle slots keep recording what passes, so Stutter / Roll / Spinback / Reverse have audio to work with the moment the pad goes down
            let (wl, wr) = s.run(l, r, sr, beat);
            let w = s.wet * MIX[s.effect] * self.level;
            if self.additive { l += wl * w * 0.8; r += wr * w * 0.8; } else { l = l * (1.0 - w) + wl * w; r = r * (1.0 - w) + wr * w; }
        }
        (l, r)
    }
}

impl Slot {
    fn reset(&mut self) {
        self.ph = 0.0; self.ap = [[0.0; 4]; 2]; self.fbs = [0.0; 2];
        self.hold = [0.0; 2]; self.cnt = 1.0; self.gate = 1.0; self.svf = [Svf::default(); 2]; self.lp1 = [0.0; 2]; self.hp1 = [0.0; 2];
        self.frozen = false; self.rev[0].clear(); self.rev[1].clear(); self.a = 1.0; self.b = 1.0;
    }
    #[inline]
    fn rd(&self, ch: usize, d: f32) -> f32 {
        let d = d.clamp(1.0, (self.len - 2) as f32);
        let p = self.wp as f32 - d; let p = if p < 0.0 { p + self.len as f32 } else { p };
        let p = if p >= self.len as f32 { p - self.len as f32 } else { p }; let i = (p as usize).min(self.len - 1); let f = (p - i as f32).max(0.0); let j = if i + 1 >= self.len { 0 } else { i + 1 };
        let b = if ch == 0 { &self.bl } else { &self.br };
        b[i] * (1.0 - f) + b[j] * f
    }
    #[inline]
    fn wr(&mut self, l: f32, r: f32) { self.bl[self.wp] = l; self.br[self.wp] = r; self.wp += 1; if self.wp >= self.len { self.wp = 0; } }
    #[inline]
    fn lfo(&mut self, hz: f32, sr: f32) -> f32 { self.ph += hz / sr; if self.ph >= 1.0 { self.ph -= 1.0; } (self.ph * 2.0 * PI).sin() }

    /// Freeze the last `factor` beats and repeat them while the pad is held (stutter / roll).
    #[inline]
    fn roll(&mut self, beat: f32, sr: f32, factor: f32) -> (f32, f32) {
        if !self.frozen {
            self.frozen = true; self.st_len = ((beat * factor * sr) as usize).clamp(64, self.len - 2);
            self.st_start = (self.wp + self.len - self.st_len) % self.len; self.st_pos = 0;
        }
        let i = (self.st_start + self.st_pos) % self.len; self.st_pos += 1; if self.st_pos >= self.st_len { self.st_pos = 0; }
        let fade = (self.st_pos.min(self.st_len - self.st_pos) as f32 / 48.0).min(1.0);   // tiny fade at the seam: no clicks
        (self.bl[i] * fade, self.br[i] * fade)
    }
    /// Two overlapping read heads with a Hann window: shifts the pitch by playing the buffer at `rate` (0.5 = octave down, 2 = octave up).
    #[inline]
    fn pshift(&mut self, l: f32, r: f32, sr: f32, rate: f32) -> (f32, f32) {
        self.wr(l, r);
        let w = 0.06 * sr;
        self.ph += (1.0 - rate) / w; self.ph -= self.ph.floor();
        let (pa, pb) = (self.ph, (self.ph + 0.5).fract());
        let (ga, gb) = ((PI * pa).sin().powi(2), (PI * pb).sin().powi(2));
        let (da, db) = (1.0 + pa * w, 1.0 + pb * w);
        (self.rd(0, da) * ga + self.rd(0, db) * gb, self.rd(1, da) * ga + self.rd(1, db) * gb)
    }
    #[inline]
    fn noise(&mut self) -> f32 { self.seed = self.seed.wrapping_mul(1664525).wrapping_add(1013904223); (self.seed >> 9) as f32 / 4194304.0 - 1.0 }

    #[inline]
    fn run(&mut self, l: f32, r: f32, sr: f32, beat: f32) -> (f32, f32) {
        let x = [l, r];
        match self.effect {
            0 => { // Flanger
                let m = 0.5 + 0.5 * self.lfo(0.28, sr);
                let d = (0.0007 + 0.004 * m) * sr;
                let (dl, dr) = (self.rd(0, d), self.rd(1, d));
                self.wr(l + dl * 0.62, r + dr * 0.62);
                ((l + dl) * 0.75, (r + dr) * 0.75)
            }
            1 => { // Phaser: 4 all-pass stages swept by an LFO, with feedback
                let m = 0.5 + 0.5 * self.lfo(0.35, sr);
                let f = 250.0 * (14.0f32).powf(m);
                let t = (PI * f / sr).tan(); let a = (t - 1.0) / (t + 1.0);
                let mut o = [0f32; 2];
                for ch in 0..2 {
                    let mut y = x[ch] + self.fbs[ch] * 0.55;
                    for k in 0..4 { let z = self.ap[ch][k]; let out = a * y + z; self.ap[ch][k] = y - a * out; y = out; }
                    self.fbs[ch] = y; o[ch] = (x[ch] + y) * 0.6;
                }
                (o[0], o[1])
            }
            2 => { // Echo: one beat, feedback
                let d = (beat * sr).min(self.len as f32 - 4.0);
                let (dl, dr) = (self.rd(0, d), self.rd(1, d));
                self.wr(l + dl * 0.5, r + dr * 0.5);
                (dl + l * 0.3, dr + r * 0.3)
            }
            3 => { // Ping-pong: eighth notes bouncing between the sides
                let d = (beat * 0.5 * sr).min(self.len as f32 - 4.0);
                let (dl, dr) = (self.rd(0, d), self.rd(1, d));
                self.wr((l + r) * 0.5 + dr * 0.55, dl * 0.55);
                (dl, dr)
            }
            4 => { // Reverb
                let m = (l + r) * 0.5;
                (self.rev[0].process(m) + l * 0.2, self.rev[1].process(m) + r * 0.2)
            }
            5 => { // Bit crusher: 6 bits, 1/6 sample rate
                self.cnt += 1.0 / 6.0;
                if self.cnt >= 1.0 { self.cnt -= 1.0; for ch in 0..2 { self.hold[ch] = (x[ch] * 32.0).round() / 32.0; } }
                (self.hold[0], self.hold[1])
            }
            6 => { // Gater: chops the sound on eighth notes
                let ph = (self.ph + 1.0 / (beat * 0.5 * sr)).fract(); self.ph = ph;
                let tgt = if ph < 0.5 { 1.0 } else { 0.03 };
                self.gate += (tgt - self.gate) * 0.01;
                (l * self.gate, r * self.gate)
            }
            7 => { // Auto-pan: once per two beats
                let p = self.lfo(0.5 / beat, sr);
                let a = (p + 1.0) * PI / 4.0;
                (l * a.cos() * 1.41, r * a.sin() * 1.41)
            }
            8 => { // Ring modulator
                let s = self.lfo(330.0, sr);
                (l * s, r * s)
            }
            9 => { // Auto-wah: band-pass swept once per beat
                let m = 0.5 + 0.5 * self.lfo(1.0 / beat, sr);
                let f = 380.0 * (7.0f32).powf(m) / sr;
                let mut o = [0f32; 2];
                for ch in 0..2 { let (_, bp, _) = self.svf[ch].run(x[ch], f, 0.28); o[ch] = (bp * 1.8).clamp(-2.0, 2.0); }
                (o[0], o[1])
            }
            10 => { // Chorus
                let a = self.lfo(0.7, sr);
                let (d1, d2) = ((0.016 + 0.005 * a) * sr, (0.021 - 0.005 * a) * sr);
                let (dl, dr) = (self.rd(0, d1), self.rd(1, d2));
                self.wr(l, r);
                (l * 0.6 + dl, r * 0.6 + dr)
            }
            11 => ((x[0] * 7.0).tanh() * 0.55, (x[1] * 7.0).tanh() * 0.55), // Overdrive
            12 => self.roll(beat, sr, 0.5),   // Stutter: freezes the last 1/8 beat and repeats it while the pad is held
            13 => { // Dub echo: dotted, dark repeats that smear
                let d = (beat * 0.75 * sr).min(self.len as f32 - 4.0);
                let (dl, dr) = (self.rd(0, d), self.rd(1, d));
                self.lp1[0] += (dl - self.lp1[0]) * 0.28; self.lp1[1] += (dr - self.lp1[1]) * 0.28;
                self.wr(l + self.lp1[0] * 0.7, r + self.lp1[1] * 0.7);
                (self.lp1[0] * 1.1 + l * 0.4, self.lp1[1] * 1.1 + r * 0.4)
            }
            14 => { // Telephone: band-limited and slightly gritty
                let mut o = [0f32; 2];
                for ch in 0..2 {
                    self.lp1[ch] += (x[ch] - self.lp1[ch]) * 0.33;                // ~2.5 kHz low-pass
                    self.hp1[ch] += (self.lp1[ch] - self.hp1[ch]) * 0.055;        // ~400 Hz high-pass
                    o[ch] = ((self.lp1[ch] - self.hp1[ch]) * 3.0).tanh() * 0.7;
                }
                (o[0], o[1])
            }
            16 => { // Tape stop: the "record" slows down until it stops
                self.wr(l, r);
                self.a *= 1.0 - 5.0 / (sr * 0.9); self.b += 1.0 - self.a;
                let d = self.b.min(self.len as f32 - 3.0); let g = self.a.sqrt();
                (self.rd(0, d) * g, self.rd(1, d) * g)
            }
            17 => { // Spinback: the record is pulled backwards and winds down
                self.wr(l, r);
                let s = 2.6 * self.a; self.a *= 1.0 - 1.0 / (sr * 0.28); self.b += 1.0 + s;
                let d = self.b.min(self.len as f32 - 3.0); let g = (s / 2.6).min(1.0).sqrt();
                (self.rd(0, d) * g, self.rd(1, d) * g)
            }
            18 => { // Reverse: the last beat played backwards, over and over
                self.wr(l, r);
                let half = (beat * sr * 0.5).clamp(1024.0, self.len as f32 * 0.45);
                let c = self.cnt; self.cnt = if c + 1.0 >= half { 1.0 } else { c + 1.0 };
                let g = (PI * c / half).sin();
                let d = 1.0 + 2.0 * c;
                (self.rd(0, d) * g, self.rd(1, d) * g)
            }
            19 => { // Trance gate: a 16-step rhythm of 16th notes chops the sound
                self.ph += 1.0 / (beat * 0.25 * sr); if self.ph >= 16.0 { self.ph -= 16.0; }
                let on = (0b1011_0110_1011_0101u16 >> (self.ph as u32 & 15)) & 1 == 1;
                self.gate += ((if on { 1.0 } else { 0.04 }) - self.gate) * 0.03;
                (l * self.gate, r * self.gate)
            }
            20 => self.roll(beat, sr, 0.25),   // Machine gun: the last 1/16 repeated
            21 => self.roll(beat, sr, 1.0),    // Beat roll: the last beat repeated
            22 => { // Tape echo: dotted, warm repeats with a little wow
                let w = self.lfo(0.55, sr);
                let d = (beat * 0.75 * sr + w * 0.0018 * sr).min(self.len as f32 - 4.0);
                let (dl, dr) = (self.rd(0, d), self.rd(1, d));
                self.lp1[0] += (dl - self.lp1[0]) * 0.42; self.lp1[1] += (dr - self.lp1[1]) * 0.42;
                self.wr(l + self.lp1[0] * 0.62, r + self.lp1[1] * 0.62);
                (self.lp1[0] + l * 0.35, self.lp1[1] + r * 0.35)
            }
            23 => { // Vibrato: the pitch wobbles
                self.wr(l, r);
                let d = (0.005 + 0.0035 * self.lfo(5.5, sr)) * sr;
                (self.rd(0, d), self.rd(1, d))
            }
            24 => { // Sidechain pump: the sound ducks on every beat, like a kick pushing it down
                self.ph = (self.ph + 1.0 / (beat * sr)).fract();
                let g = 1.0 - 0.9 * (-self.ph * 5.0).exp();
                (l * g * 1.1, r * g * 1.1)
            }
            25 => { // Lo-Fi: 8-bit, a quarter of the sample rate, dull
                self.cnt += 0.25;
                if self.cnt >= 1.0 { self.cnt -= 1.0; for ch in 0..2 { self.hold[ch] = (x[ch] * 64.0).round() / 64.0; } }
                let mut o = [0f32; 2];
                for ch in 0..2 { self.lp1[ch] += (self.hold[ch] - self.lp1[ch]) * 0.45; o[ch] = self.lp1[ch]; }
                (o[0], o[1])
            }
            26 => { // Megaphone: narrow, loud, a bit rude
                let mut o = [0f32; 2];
                for ch in 0..2 {
                    self.lp1[ch] += (x[ch] - self.lp1[ch]) * 0.4;
                    self.hp1[ch] += (self.lp1[ch] - self.hp1[ch]) * 0.09;
                    o[ch] = ((self.lp1[ch] - self.hp1[ch]) * 5.0).tanh() * 0.6;
                }
                (o[0], o[1])
            }
            27 => { // Underwater: dull, wobbling, as if heard from outside a pool
                self.wr(l, r);
                let m = self.lfo(0.45, sr);
                let d = (0.006 + 0.0025 * m) * sr;
                let f = (450.0 + 250.0 * m) / sr;
                let (a, b) = (self.rd(0, d), self.rd(1, d));
                let (lo0, _, _) = self.svf[0].run(a, f, 0.9); let (lo1, _, _) = self.svf[1].run(b, f, 0.9);
                ((lo0 * 1.4).clamp(-2.0, 2.0), (lo1 * 1.4).clamp(-2.0, 2.0))
            }
            28 => { // Noise riser: a rising band of noise over 8 beats, the music steps back
                let total = beat * 8.0 * sr; let t = (self.a / total).min(1.0); self.a += 1.0;
                let f = (200.0 * 40.0f32.powf(t)) / sr;
                let (n0, n1) = (self.noise(), self.noise());
                let (_, b0, _) = self.svf[0].run(n0, f, 0.15); let (_, b1, _) = self.svf[1].run(n1, f, 0.15);
                let amp = (0.15 + 0.85 * t * t) * 1.3;
                ((l * (1.0 - 0.5 * t) + b0 * amp).clamp(-2.5, 2.5), (r * (1.0 - 0.5 * t) + b1 * amp).clamp(-2.5, 2.5))
            }
            29 => { // Robot: a short resonant comb gives the voice a metallic pitch
                let d = sr / 140.0;
                let (dl, dr) = (self.rd(0, d), self.rd(1, d));
                self.wr(l + dl * 0.85, r + dr * 0.85);
                (l * 0.4 + dl * 0.5, r * 0.4 + dr * 0.5)
            }
            30 => { // Jet: a slow, deep, resonant flanger sweep
                let m = 0.5 + 0.5 * self.lfo(0.12, sr);
                let d = (0.0005 + 0.006 * m) * sr;
                let (dl, dr) = (self.rd(0, d), self.rd(1, d));
                self.wr(l + dl * 0.8, r + dr * 0.8);
                ((l + dl) * 0.45, (r + dr) * 0.45)
            }
            31 => { // HP sweep: a resonant high-pass climbing and falling over two bars
                let p = self.lfo(0.125 / beat, sr); let m = 0.5 + 0.5 * p;
                let f = 120.0 * 60.0f32.powf(m) / sr;
                let mut o = [0f32; 2];
                for ch in 0..2 { let (_, _, hi) = self.svf[ch].run(x[ch], f, 0.4); o[ch] = hi.clamp(-2.0, 2.0); }
                (o[0], o[1])
            }
            32 => { // Bass kill: everything under ~300 Hz removed (a DJ isolator)
                let c = 1.0 - (-2.0 * PI * 300.0 / sr).exp();
                let mut o = [0f32; 2];
                for ch in 0..2 {
                    self.lp1[ch] += (x[ch] - self.lp1[ch]) * c; let y1 = x[ch] - self.lp1[ch];
                    self.hp1[ch] += (y1 - self.hp1[ch]) * c; o[ch] = (y1 - self.hp1[ch]) * 1.15;
                }
                (o[0], o[1])
            }
            33 => { // Lows only: only the bass and low mids stay (everything above ~700 Hz removed)
                let c = 1.0 - (-2.0 * PI * 700.0 / sr).exp();
                let mut o = [0f32; 2];
                for ch in 0..2 {
                    self.lp1[ch] += (x[ch] - self.lp1[ch]) * c;
                    self.hp1[ch] += (self.lp1[ch] - self.hp1[ch]) * c; o[ch] = self.hp1[ch] * 1.25;
                }
                (o[0], o[1])
            }
            34 => self.pshift(l, r, sr, 0.5),   // Octave down
            35 => self.pshift(l, r, sr, 2.0),   // Octave up
            _ => { // Filter sweep (15): resonant low-pass rising and falling over two bars
                let m = 0.5 + 0.5 * self.lfo(0.125 / beat, sr);
                let f = 140.0 * (70.0f32).powf(m) / sr;
                let mut o = [0f32; 2];
                for ch in 0..2 { let (lo, _, _) = self.svf[ch].run(x[ch], f, 0.45); o[ch] = lo.clamp(-2.0, 2.0); }
                (o[0], o[1])
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tone(i: usize, sr: f32) -> f32 { (2.0 * PI * 220.0 * i as f32 / sr).sin() * 0.5 + (2.0 * PI * 3300.0 * i as f32 / sr).sin() * 0.2 }

    #[test]
    fn off_is_bit_exact_passthrough() {
        let mut fx = FxUnit::new(44100.0);
        for i in 0..2000 { let x = tone(i, 44100.0); assert_eq!(fx.process(x, -x), (x, -x)); }
    }
    #[test]
    fn every_effect_is_finite_bounded_and_audible() {
        for e in 0..NUM_FX {
            let mut fx = FxUnit::new(44100.0); fx.set_bpm(124.0);
            fx.set_effect(0, e);
            for i in 0..20000 { let x = tone(i, 44100.0); fx.process(x, x); }   // idle: the unit records what passes
            fx.set_on(0, true);
            let (mut diff, mut peak, mut energy) = (0.0f32, 0.0f32, 0.0f32);
            for i in 20000..108200 {
                let x = tone(i, 44100.0); let (l, r) = fx.process(x, x);
                assert!(l.is_finite() && r.is_finite(), "{} not finite", NAMES[e]);
                peak = peak.max(l.abs()).max(r.abs());
                if i > 50000 { diff += (l - x).abs(); energy += l.abs() + r.abs(); }
            }
            assert!(peak < 3.5, "{} too loud: {peak}", NAMES[e]);
            assert!(diff > 50.0, "{} changes nothing: {diff}", NAMES[e]);
            if ![16usize, 17].contains(&e) { assert!(energy > 300.0, "{} is (nearly) silent: {energy}", NAMES[e]); }   // tape stop / spinback legitimately wind down to silence
            // releasing returns to a clean pass-through
            fx.set_on(0, false);
            for i in 0..44100 { let x = tone(i, 44100.0); fx.process(x, x); }
            let x = 0.3; assert_eq!(fx.process(x, x), (x, x), "{} did not release", NAMES[e]);
        }
    }
    #[test]
    fn dry_plus_wet_keeps_the_dry_signal() {
        let (mut a, mut b) = (FxUnit::new(44100.0), FxUnit::new(44100.0));
        for u in [&mut a, &mut b] { u.set_effect(4, 0); u.set_on(4, true); }
        b.set_additive(true);
        let (mut ea, mut eb, mut dry) = (0.0f32, 0.0f32, 0.0f32);
        for i in 0..40000 { let x = tone(i, 44100.0); let (la, _) = a.process(x, x); let (lb, _) = b.process(x, x); if i > 20000 { ea += la * la; eb += lb * lb; dry += x * x; } }
        assert!(eb > dry * 0.9, "Dry+Wet must not lose the dry signal"); assert!(eb > ea, "Dry+Wet is louder than Dry/Wet for the same effect");
    }
    #[test]
    fn four_slots_chain_and_pick_effects() {
        let mut fx = FxUnit::new(48000.0);
        for s in 0..4 { fx.set_effect(s, 4 + s * 3); fx.set_on(s, true); }
        assert_eq!((fx.effect_of(0), fx.effect_of(1), fx.effect_of(3)), (4, 7, 13));
        for i in 0..20000 { let (l, r) = fx.process(tone(i, 48000.0), 0.0); assert!(l.is_finite() && r.is_finite()); }
        assert!(fx.any_active());
    }
    fn crossings(v: &[f32]) -> usize { v.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count() }
    #[test]
    fn octave_shift_halves_and_doubles_the_pitch() {
        let sr = 48000.0;
        let run = |e: usize| { let mut fx = FxUnit::new(sr); fx.set_additive(false); fx.set_effect(0, e); fx.set_on(0, true);
            let mut out = Vec::new(); for i in 0..96000 { let x = (2.0 * PI * 440.0 * i as f32 / sr).sin() * 0.5; let (l, _) = fx.process(x, x); if i >= 48000 { out.push(l); } } out };
        let (dn, up) = (crossings(&run(34)), crossings(&run(35)));
        // 440 Hz over 1 s = 440 crossings; one octave down about 220, one octave up about 880
        assert!((190..250).contains(&dn), "octave down gave {dn}"); assert!((800..960).contains(&up), "octave up gave {up}");
    }
    #[test]
    fn tape_stop_and_spinback_wind_down_to_silence_and_noise_riser_grows() {
        let sr = 44100.0;
        for e in [16usize, 17] {
            let mut fx = FxUnit::new(sr); fx.set_effect(0, e);
            for i in 0..20000 { let x = tone(i, sr); fx.process(x, x); }
            fx.set_on(0, true);
            let (mut early, mut late) = (0.0f32, 0.0f32);
            for i in 0..(sr as usize * 3) { let i = i + 20000; let x = tone(i, sr); let (l, _) = fx.process(x, x); if (24000..28000).contains(&i) { early += l.abs(); } if i > sr as usize * 2 + 20000 { late += l.abs(); } }
            assert!(early > 20.0, "{} is silent at the start", NAMES[e]); assert!(late < early * 0.4, "{} did not wind down: early {early} late {late}", NAMES[e]);
        }
        let mut fx = FxUnit::new(sr); fx.set_bpm(120.0); fx.set_effect(0, 28); fx.set_on(0, true);
        let (mut a, mut b) = (0.0f32, 0.0f32);
        for i in 0..(sr as usize * 4) { let (l, _) = fx.process(0.0, 0.0); if (20000..40000).contains(&i) { a += l * l; } if i > sr as usize * 3 { b += l * l; } }
        assert!(b > a, "the riser must get louder over time: {a} -> {b}");
    }
    #[test]
    fn pump_ducks_on_the_beat_and_bass_kill_removes_the_lows() {
        let sr = 44100.0;
        let mut fx = FxUnit::new(sr); fx.set_bpm(120.0); fx.set_effect(0, 24); fx.set_on(0, true);
        let mut v = Vec::new(); for i in 0..(sr as usize * 2) { let (l, _) = fx.process(0.5, 0.5); v.push(l); }
        let (mn, mx) = v[30000..].iter().fold((9.0f32, 0.0f32), |(a, b), &x| (a.min(x), b.max(x)));
        assert!(mn < mx * 0.4, "pump must duck: min {mn} max {mx}");
        let level = |f0: f32| { let mut fx = FxUnit::new(sr); fx.set_effect(0, 32); fx.set_on(0, true); let mut s = 0.0f32; for i in 0..(sr as usize * 2) { let x = (2.0 * PI * f0 * i as f32 / sr).sin() * 0.5; let (l, _) = fx.process(x, x); if i > 20000 { s += l.abs(); } } s };
        let (bass, treble) = (level(60.0), level(3000.0));
        assert!(bass < treble * 0.25, "bass kill must remove the lows: 60 Hz {bass} vs 3 kHz {treble}");
    }
}
