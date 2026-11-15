//! XY multi-FX on the master bus: Filter, Echo, Reverb and Flanger as four parallel paths, blended by the weights the UI computes from the pad position.
//!
//! Mixing (so the level never grows): out = dry * (1 - act) + act * (w0*P0 + w1*P1 + w2*P2 + w3*P3), with w0+w1+w2+w3 = 1.
//! Each path P_i already contains its own dry/wet balance, so every term is a signal of about the same loudness as the dry signal: a convex blend, never a sum of four wet signals.
//! `act` (0..1) is the overall activation. It moves at most 1/4 ms-ramp per sample (linear, 4 ms end to end): a release is a 4 ms fade to the exact dry signal,
//! after which the unit is completely idle (bit-exact pass-through, no tails: every buffer is cleared).
//! No allocation happens after `new` (buffers are sized for the sample rate), parameters are smoothed per sample (no zipper noise), everything is stereo.
use crate::fx::Rev;
use std::f32::consts::PI;

/// Parameter vector sent by the UI: cutoff Hz, resonance 0..1, echo delay seconds, echo feedback 0..1, reverb room 0..1, reverb wet 0..1, flanger rate Hz, flanger depth 0..1.
pub const N_P: usize = 8;
const LIM: [(f32, f32); N_P] = [(20.0, 20000.0), (0.0, 0.98), (0.0005, 1.9), (0.0, 0.95), (0.0, 1.0), (0.0, 1.0), (0.02, 20.0), (0.0, 1.0)];
/// Smoothing time constants (seconds) per parameter: cutoff and rate are smoothed in the log domain.
const TC: [f32; N_P] = [0.012, 0.012, 0.09, 0.02, 0.08, 0.015, 0.04, 0.02];
const REV_GAIN: f32 = 2.2;

/// Variants per family. FILTER: 0 low-pass, 1 high-pass, 2 band-pass, 3 notch, 4 comb, 5 vowel (formants), 6 peak boost.
/// ECHO: 0 echo, 1 ping-pong, 2 tape, 3 dub (dotted, dark), 4 slapback, 5 reverse, 6 triplet.
/// REVERB: 0 room, 1 hall (pre-delay), 2 plate (bright), 3 spring, 4 gated, 5 swell, 6 dark.
/// FLANGER: 0 flanger, 1 phaser, 2 chorus, 3 vibrato, 4 tremolo, 5 auto-pan, 6 ring modulator.
pub const NV: u8 = 7;

/// Zero-delay-feedback state variable filter (one channel). tick returns (low-pass, band-pass, high-pass).
#[derive(Clone, Copy, Default)]
struct Zdf { s1: f32, s2: f32 }
impl Zdf {
    #[inline]
    fn tick(&mut self, x: f32, g: f32, k: f32) -> (f32, f32, f32) {
        let a1 = 1.0 / (1.0 + g * (g + k)); let a2 = g * a1; let a3 = g * a2;
        let v3 = x - self.s2; let v1 = a1 * self.s1 + a2 * v3; let v2 = self.s2 + a2 * self.s1 + a3 * v3;
        self.s1 = 2.0 * v1 - self.s1; self.s2 = 2.0 * v2 - self.s2;
        (v2, v1, x - k * v1 - v2)
    }
}
/// Interpolated read `d` samples behind the write position of a circular buffer.
#[inline]
fn rd(b: &[f32], wp: usize, d: f32) -> f32 {
    let len = b.len(); let d = d.clamp(1.0, (len - 3) as f32);
    let rp = wp as f32 - d; let rp = if rp < 0.0 { rp + len as f32 } else { rp };
    let i0 = (rp as usize).min(len - 1); let fr = rp - i0 as f32; let i1 = if i0 + 1 >= len { 0 } else { i0 + 1 };
    b[i0] * (1.0 - fr) + b[i1] * fr
}

pub struct XyFx {
    sr: f32,
    live: bool,
    var: [u8; 4],   // chosen variant of FILTER, ECHO, REVERB, FLANGER (see NV)
    act: f32, act_t: f32, act_step: f32,
    w: [f32; 4], w_t: [f32; 4], cw: f32,
    p: [f32; N_P], p_t: [f32; N_P], cp: [f32; N_P],   // p[0] and p[6] hold ln(value)
    f: [Zdf; 2], fv1: [Zdf; 2], fv2: [Zdf; 2],         // filter state (main, formant 1, formant 2)
    cb: [Vec<f32>; 2], cbp: usize,                     // comb filter
    eb: [Vec<f32>; 2], ep: usize, elp: [f32; 2], ecnt: f32, ewow: f32, // echo
    rev: [Rev; 2], rn: u32, last_room: f32, last_var: u8, // reverb
    pd: Vec<f32>, pdp: usize, sp: Vec<f32>, spp: usize, renv: f32, rlp: [f32; 2], rph: f32,
    fl: [Vec<f32>; 2], fp: usize, ph: f32, fph2: f32, fbs: [f32; 2], ap: [[f32; 4]; 2], // flanger family
}

impl XyFx {
    pub fn new(sr: f32) -> Self {
        let mut p = [0f32; N_P];
        for (i, v) in p.iter_mut().enumerate() { *v = if i == 0 || i == 6 { LIM[i].1.ln() } else { LIM[i].0 }; }
        let eb = (sr * 2.0) as usize + 8; let fl = (sr * 0.03) as usize + 8;
        Self {
            sr, live: false, var: [0; 4], act: 0.0, act_t: 0.0, act_step: 1.0 / (0.004 * sr),
            w: [0.0; 4], w_t: [0.0; 4], cw: 1.0 - (-1.0 / (0.008 * sr)).exp(),
            p, p_t: p, cp: std::array::from_fn(|i| 1.0 - (-1.0 / (TC[i] * sr)).exp()),
            f: [Zdf::default(); 2], fv1: [Zdf::default(); 2], fv2: [Zdf::default(); 2],
            cb: [vec![0.0; fl], vec![0.0; fl]], cbp: 0,
            eb: [vec![0.0; eb], vec![0.0; eb]], ep: 0, elp: [0.0; 2], ecnt: 1.0, ewow: 0.0,
            rev: [Rev::new(sr, 0), Rev::new(sr, 23)], rn: 0, last_room: -1.0, last_var: 255,
            pd: vec![0.0; (sr * 0.06) as usize + 8], pdp: 0, sp: vec![0.0; (sr * 0.02) as usize + 8], spp: 0, renv: 0.0, rlp: [0.0; 2], rph: 0.0,
            fl: [vec![0.0; fl], vec![0.0; fl]], fp: 0, ph: 0.0, fph2: 0.0, fbs: [0.0; 2], ap: [[0.0; 4]; 2],
        }
    }
    fn reset(&mut self) {
        self.f = [Zdf::default(); 2]; self.fv1 = [Zdf::default(); 2]; self.fv2 = [Zdf::default(); 2];
        for b in self.eb.iter_mut().chain(self.fl.iter_mut()).chain(self.cb.iter_mut()) { b.fill(0.0); }
        self.pd.fill(0.0); self.sp.fill(0.0);
        self.ep = 0; self.fp = 0; self.cbp = 0; self.pdp = 0; self.spp = 0; self.elp = [0.0; 2]; self.ecnt = 1.0; self.ewow = 0.0; self.fbs = [0.0; 2]; self.ap = [[0.0; 4]; 2];
        self.ph = 0.0; self.fph2 = 0.0; self.renv = 0.0; self.rlp = [0.0; 2]; self.rph = 0.0;
        for r in self.rev.iter_mut() { r.clear(); } self.last_room = -1.0; self.last_var = 255;
    }
    /// Control message from the UI (may arrive many times a second): activation, the four path weights and the eight parameters. act = 0 releases.
    pub fn set(&mut self, act: f32, w: [f32; 4], p: [f32; N_P]) {
        let act = if act.is_finite() { act.clamp(0.0, 1.0) } else { 0.0 };
        let sum: f32 = w.iter().map(|x| if x.is_finite() { x.max(0.0) } else { 0.0 }).sum();
        self.act_t = if act > 1e-4 && sum > 1e-6 { act } else { 0.0 };
        for i in 0..4 { self.w_t[i] = if sum > 1e-6 && w[i].is_finite() { w[i].max(0.0) / sum } else { 0.0 }; }
        for i in 0..N_P {
            let v = if p[i].is_finite() { p[i] } else { LIM[i].0 }.clamp(LIM[i].0, LIM[i].1);
            self.p_t[i] = if i == 0 || i == 6 { v.ln() } else { v };
        }
        if self.act_t > 0.0 && !self.live { self.live = true; self.reset(); self.w = self.w_t; self.p = self.p_t; }   // start from the asked values: nothing sweeps in from stale ones
    }
    pub fn is_idle(&self) -> bool { !self.live }
    /// Choose the effect of each family: [filter, echo, reverb, flanger], each 0 .. NV-1.
    pub fn set_variants(&mut self, v: [u8; 4]) { for i in 0..4 { self.var[i] = v[i].min(NV - 1); } }

    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        if !self.live { return (l, r); }
        // 4 ms linear activation ramp: the release and the attack are click-free and (almost) immediate
        if self.act < self.act_t { self.act = (self.act + self.act_step).min(self.act_t); } else if self.act > self.act_t { self.act = (self.act - self.act_step).max(self.act_t); }
        if self.act_t == 0.0 && self.act <= 0.0 { self.live = false; self.reset(); return (l, r); }
        for i in 0..4 { self.w[i] += (self.w_t[i] - self.w[i]) * self.cw; }
        for i in 0..N_P { self.p[i] += (self.p_t[i] - self.p[i]) * self.cp[i]; }
        let sr = self.sr; let x = [l, r];
        let wsum = self.w[0] + self.w[1] + self.w[2] + self.w[3];
        if wsum < 1e-6 { return (l, r); }
        let inv = 1.0 / wsum;
        let (mut o0, mut o1) = (0.0f32, 0.0f32);

        // 0: FILTER family (zero-delay-feedback state variable filter: stable up to the top of the range)
        if self.w[0] > 1e-5 {
            let (fc, res) = (self.p[0].exp().min(sr * 0.45), self.p[1]);
            let g = (PI * fc / sr).tan(); let k = 2.0 - 1.97 * res; /* damping 2 .. 0.06: a gentle slope up to a screaming resonance */ let comp = 1.0 / (1.0 + 2.8 * res * res);
            let mut y = [0f32; 2];
            match self.var[0] {
                4 => {   // comb: feedback comb, the cutoff sets the pitch of the comb (50 Hz .. 3 kHz), the resonance the feedback
                    let len = self.cb[0].len(); let d = (sr / fc.clamp(40.0, 3000.0)).clamp(2.0, (len - 3) as f32); let fb = (0.05 + 0.88 * res).min(0.93);
                    for c in 0..2 { let yv = (x[c] + fb * rd(&self.cb[c], self.cbp, d)).clamp(-4.0, 4.0); self.cb[c][self.cbp] = yv; y[c] = yv * (1.0 - 0.85 * fb); }
                    self.cbp += 1; if self.cbp >= len { self.cbp = 0; }
                }
                5 => {   // vowel: two band-pass formants whose positions glide from "oo" through "ah" to "ee" as the cutoff moves
                    let t = ((fc / 50.0).ln() / (400.0f32).ln()).clamp(0.0, 1.0); let (f1, f2) = (300.0 + 450.0 * (PI * t).sin(), 800.0 + 1500.0 * t);
                    let (g1, g2) = ((PI * f1 / sr).tan(), (PI * f2 / sr).tan()); let kq = 1.3 - 1.1 * res;
                    for c in 0..2 { let (_, b1, _) = self.fv1[c].tick(x[c], g1, kq); let (_, b2, _) = self.fv2[c].tick(x[c], g2, kq); y[c] = ((b1 + b2 * 0.7) * kq * 0.9 + x[c] * 0.1).clamp(-3.0, 3.0); }
                }
                6 => {   // peak: the dry sound with a resonant boost at the cutoff
                    for c in 0..2 { let (_, b, _) = self.f[c].tick(x[c], g, k); y[c] = x[c] * 0.8 + b * k * (0.4 + 2.2 * res); }
                }
                v => {
                    for c in 0..2 { let (lp, b, hp) = self.f[c].tick(x[c], g, k); y[c] = match v { 1 => hp * comp, 2 => b * k * comp, 3 => (x[c] - k * b) * comp.sqrt(), _ => lp * comp }; }   // HP, BP (unity at the centre), notch, LP
                }
            }
            o0 += self.w[0] * y[0]; o1 += self.w[0] * y[1];
        }
        // 1: ECHO family: tempo delay with a darkening, soft-limited feedback
        {
            let ev = self.var[1]; let len = self.eb[0].len(); let (fb, base) = (self.p[3], self.p[2] * sr);
            let mut d = match ev { 3 => base * 0.75, 4 => (0.03 + 0.12 * (self.p[2] / 1.9).min(1.0)) * sr, 6 => base * (2.0 / 3.0), _ => base };
            if ev == 2 { self.ewow += 0.6 / sr; if self.ewow >= 1.0 { self.ewow -= 1.0; } d *= 1.0 + 0.004 * (self.ewow * 2.0 * PI).sin(); }   // tape: a little wow
            let d = d.clamp(1.0, (len - 3) as f32); let lpc = match ev { 2 => 0.35, 3 => 0.22, _ => 0.8 }; let fbe = if ev == 4 { fb * 0.2 } else { fb };
            let mut y = [0f32; 2];
            match ev {
                1 => {   // ping-pong: the repeats bounce between the sides
                    let dl = [rd(&self.eb[0], self.ep, d), rd(&self.eb[1], self.ep, d)];
                    self.elp[0] += (dl[1] - self.elp[0]) * lpc; self.elp[1] += (dl[0] - self.elp[1]) * lpc; let mono = (x[0] + x[1]) * 0.5;
                    self.eb[0][self.ep] = mono + (self.elp[0] * fb).tanh(); self.eb[1][self.ep] = (self.elp[1] * fb).tanh();
                    for c in 0..2 { y[c] = x[c] * 0.7 + dl[c] * (1.0 - fb).sqrt(); }
                }
                5 => {   // reverse: the last stretch played backwards (the delay time sets its length), cross-faded
                    let half = (d * 0.5).clamp(512.0, len as f32 * 0.45); let cn = self.ecnt; self.ecnt = if cn + 1.0 >= half { 1.0 } else { cn + 1.0 }; let gw = (PI * cn / half).sin();
                    for c in 0..2 { let dl = rd(&self.eb[c], self.ep, 1.0 + 2.0 * cn); self.elp[c] += (dl - self.elp[c]) * 0.6; self.eb[c][self.ep] = x[c] + (self.elp[c] * fb * 0.5).tanh(); y[c] = x[c] * 0.6 + dl * gw; }
                }
                _ => {
                    let wg = if ev == 3 { 1.2 } else { 1.0 };
                    for c in 0..2 { let dl = rd(&self.eb[c], self.ep, d); self.elp[c] += (dl - self.elp[c]) * lpc; self.eb[c][self.ep] = x[c] + (self.elp[c] * fbe * if ev == 2 { 1.4 } else { 1.0 }).tanh(); y[c] = x[c] * 0.7 + dl * wg * (1.0 - fbe).sqrt(); }
                }
            }
            self.ep += 1; if self.ep >= len { self.ep = 0; }
            if self.w[1] > 1e-5 { o0 += self.w[1] * y[0]; o1 += self.w[1] * y[1]; }
        }
        // 2: REVERB family (the engine's own Schroeder reverb with a different character per variant)
        {
            let rv = self.var[2]; let room = self.p[4]; self.rn = self.rn.wrapping_add(1);
            if (self.rn & 63 == 0 && (room - self.last_room).abs() > 0.004) || rv != self.last_var {
                self.last_room = room; self.last_var = rv;
                let (fb, damp) = match rv { 1 => (0.8 + 0.185 * room, 0.55 - 0.25 * room), 2 => (0.72 + 0.24 * room, 0.25), 3 => (0.74 + 0.2 * room, 0.5), 6 => (0.76 + 0.22 * room, 0.92), _ => (0.7 + 0.28 * room, 0.8 - 0.45 * room) };
                for r in self.rev.iter_mut() { r.set_params(fb, damp); }
            }
            let mut m = (x[0] + x[1]) * 0.5;
            if rv == 1 { let len = self.pd.len(); let dd = rd(&self.pd, self.pdp, 0.025 * sr); self.pd[self.pdp] = m; self.pdp += 1; if self.pdp >= len { self.pdp = 0; } m = dd; }   // hall: 25 ms pre-delay
            if rv == 3 { let len = self.sp.len(); let dd = rd(&self.sp, self.spp, 0.0073 * sr); m += 0.55 * dd; self.sp[self.spp] = m.clamp(-4.0, 4.0); self.spp += 1; if self.spp >= len { self.spp = 0; } }   // spring: a short metallic echo in front
            let (mut rl, mut rr) = (self.rev[0].process(m), self.rev[1].process(m));
            match rv {
                4 => { self.renv = (x[0].abs().max(x[1].abs())).max(self.renv * (-1.0 / (0.18 * sr)).exp()); let gt = (self.renv * 10.0).min(1.0); rl *= gt; rr *= gt; }   // gated: the tail is cut about 180 ms after the sound stops
                5 => { self.rph += 0.4 / sr; if self.rph >= 1.0 { self.rph -= 1.0; } let ramp = 0.12 + 0.88 * (0.5 - 0.5 * (self.rph * 2.0 * PI).cos()); rl *= ramp; rr *= ramp; }   // swell: the tail breathes in and out
                6 => { self.rlp[0] += (rl - self.rlp[0]) * 0.18; self.rlp[1] += (rr - self.rlp[1]) * 0.18; rl = self.rlp[0]; rr = self.rlp[1]; }   // dark: the tail is rolled off
                _ => {}
            }
            if self.w[2] > 1e-5 {
                let wet = self.p[5]; let dry = 1.0 - wet * 0.92;
                let g = wet * REV_GAIN * (1.0 - 0.72 * room) * match rv { 1 => 0.9, 4 => 1.3, 5 => 1.2, 6 => 1.3, _ => 1.0 };   // a bigger room rings louder: compensate so the level stays about the same
                o0 += self.w[2] * (x[0] * dry + rl * g); o1 += self.w[2] * (x[1] * dry + rr * g);
            }
        }
        // 3: FLANGER family: modulation effects driven by rate (log) and depth
        {
            let lv = self.var[3]; let len = self.fl[0].len(); self.ph += self.p[6].exp() / sr; if self.ph >= 1.0 { self.ph -= 1.0; }
            let depth = self.p[7]; let s = (self.ph * 2.0 * PI).sin(); let m = 0.5 + 0.5 * s; let mut y = [0f32; 2];
            match lv {
                1 => {   // phaser: four all-pass stages swept between 200 Hz and 4 kHz
                    let f = 200.0 * 20.0f32.powf(m); let t = (PI * f / sr).tan(); let a = (t - 1.0) / (t + 1.0); let mx = 0.5 + 0.5 * depth;
                    for c in 0..2 { let mut v = x[c] + self.fbs[c] * (0.4 + 0.45 * depth); for k in 0..4 { let z = self.ap[c][k]; let o = a * v + z; self.ap[c][k] = v - a * o; v = o; } self.fbs[c] = v.clamp(-4.0, 4.0); y[c] = (x[c] + v * mx) / (1.0 + mx * 0.6); }
                }
                2 => {   // chorus: two slowly modulated voices
                    let s2 = ((self.ph + 0.33) * 2.0 * PI).sin(); let (d1, d2) = ((0.016 + 0.007 * depth * s) * sr, (0.022 - 0.006 * depth * s2) * sr); let mx = 0.5 + 0.5 * depth;
                    for c in 0..2 { let a = rd(&self.fl[c], self.fp, d1); let b = rd(&self.fl[c], self.fp, d2); self.fl[c][self.fp] = x[c]; y[c] = (x[c] * 0.7 + (a + b) * 0.5 * mx) / (0.7 + 0.5 * mx * 0.9); }
                    self.fp += 1; if self.fp >= len { self.fp = 0; }
                }
                3 => {   // vibrato: the pitch wobbles (wet only)
                    let d = (0.0045 + 0.0035 * depth * s).max(0.0006) * sr;
                    for c in 0..2 { y[c] = rd(&self.fl[c], self.fp, d); self.fl[c][self.fp] = x[c]; }
                    self.fp += 1; if self.fp >= len { self.fp = 0; }
                }
                4 => { let gn = (1.0 - depth * m) * (1.0 + 0.35 * depth); y = [x[0] * gn, x[1] * gn]; }   // tremolo
                5 => { let a = PI * 0.25 * (1.0 + depth * s); y = [x[0] * a.cos() * 1.41, x[1] * a.sin() * 1.41]; }   // auto-pan
                6 => {   // ring modulator: the rate sets the carrier (about 20 Hz .. 1.1 kHz), the depth how much of it is mixed in
                    self.fph2 += (self.p[6].exp() * 80.0).clamp(20.0, 2000.0) / sr; if self.fph2 >= 1.0 { self.fph2 -= 1.0; } let cs = (self.fph2 * 2.0 * PI).sin();
                    for c in 0..2 { y[c] = x[c] * (1.0 - depth) + x[c] * cs * depth * 1.2; }
                }
                _ => {   // flanger: swept short delay with feedback
                    let d = ((0.0006 + 0.0095 * depth * m + 0.0004) * sr).clamp(1.0, (len - 3) as f32);
                    let g = 0.5 + 0.5 * depth; let fbk = 0.45 + 0.4 * depth;
                    for c in 0..2 { let dl = rd(&self.fl[c], self.fp, d); self.fl[c][self.fp] = (x[c] + dl * fbk).clamp(-4.0, 4.0); y[c] = (x[c] + dl * g) / (1.0 + g); }
                    self.fp += 1; if self.fp >= len { self.fp = 0; }
                }
            }
            if self.w[3] > 1e-5 { o0 += self.w[3] * y[0]; o1 += self.w[3] * y[1]; }
        }
        let a = self.act;
        (l * (1.0 - a) + o0 * inv * a, r * (1.0 - a) + o1 * inv * a)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SR: f32 = 44100.0;
    fn p(cut: f32, res: f32, delay: f32, fb: f32, room: f32, wet: f32, rate: f32, depth: f32) -> [f32; N_P] { [cut, res, delay, fb, room, wet, rate, depth] }
    fn rnd(s: &mut u32) -> f32 { *s = s.wrapping_mul(1664525).wrapping_add(1013904223); (*s >> 9) as f32 / 4194304.0 - 1.0 }
    fn rms(v: &[f32]) -> f32 { (v.iter().map(|x| x * x).sum::<f32>() / v.len() as f32).sqrt() }

    #[test]
    fn idle_is_a_bit_exact_passthrough() {
        let mut x = XyFx::new(SR); let mut s = 7;
        for _ in 0..5000 { let (a, b) = (rnd(&mut s), rnd(&mut s)); assert_eq!(x.process(a, b), (a, b)); }
        assert!(x.is_idle());
    }
    #[test]
    fn filter_corner_removes_the_highs_and_keeps_the_lows() {
        let level = |f0: f32| { let mut x = XyFx::new(SR); x.set(1.0, [1.0, 0.0, 0.0, 0.0], p(300.0, 0.0, 0.2, 0.0, 0.5, 0.0, 1.0, 0.0));
            let mut o = Vec::new(); for i in 0..(SR as usize) { let s = (2.0 * PI * f0 * i as f32 / SR).sin() * 0.5; let (l, _) = x.process(s, s); if i > 8000 { o.push(l); } } rms(&o) };
        let (lo, hi) = (level(80.0), level(8000.0));
        assert!(lo > 0.3, "lows must pass: {lo}"); assert!(hi < 0.02, "highs must be removed: {hi}");
    }
    #[test]
    fn every_corner_is_finite_stereo_and_does_not_get_louder() {
        let corners = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0], [0.25, 0.25, 0.25, 0.25], [0.5625, 0.1875, 0.1875, 0.0625]];
        let extremes = [p(60.0, 0.95, 1.9, 0.92, 1.0, 1.0, 14.0, 1.0), p(18000.0, 0.0, 0.01, 0.0, 0.0, 0.0, 0.05, 0.0), p(1500.0, 0.5, 0.25, 0.5, 0.5, 0.5, 1.0, 0.5)];
        for w in corners { for pp in extremes {
            let mut x = XyFx::new(SR); x.set(1.0, w, pp); let mut s = 99;
            let (mut inp, mut outl, mut outr, mut peak) = (Vec::new(), Vec::new(), Vec::new(), 0.0f32);
            for i in 0..(SR as usize * 2) { let a = rnd(&mut s) * 0.4; let b = (2.0 * PI * 440.0 * i as f32 / SR).sin() * 0.4; let (l, r) = x.process(a, b); assert!(l.is_finite() && r.is_finite());
                if i > 30000 { inp.push(a); outl.push(l); outr.push(r); peak = peak.max(l.abs()).max(r.abs()); } }
            assert!(peak < 3.0, "{w:?} {pp:?}: peak {peak}");
            let ratio = rms(&outl) / rms(&inp); assert!(ratio < 2.4, "{w:?} {pp:?}: noise channel level x{ratio}");
            let tone: Vec<f32> = (30001..SR as usize * 2).map(|i| (2.0 * PI * 440.0 * i as f32 / SR).sin() * 0.4).collect();
            assert!(rms(&outr) / rms(&tone) < 3.2, "{w:?} {pp:?}: tone channel level (a pure tone on a comb or filter resonance may gain up to 10 dB: the master limiter catches the peaks)");
        } }
    }
    #[test]
    fn release_returns_to_the_exact_dry_signal_within_4ms_and_leaves_no_tail() {
        let mut x = XyFx::new(SR); x.set(1.0, [0.0, 0.5, 0.5, 0.0], p(800.0, 0.3, 0.3, 0.8, 1.0, 1.0, 1.0, 0.5)); let mut s = 5;
        for _ in 0..30000 { let a = rnd(&mut s) * 0.5; x.process(a, a); }
        x.set(0.0, [0.0; 4], p(800.0, 0.3, 0.3, 0.8, 1.0, 1.0, 1.0, 0.5));
        let n = (0.004 * SR) as usize + 3; for _ in 0..n { let a = rnd(&mut s) * 0.5; x.process(a, a); }
        for _ in 0..200 { let a = rnd(&mut s) * 0.5; assert_eq!(x.process(a, -a), (a, -a), "must be the exact dry signal after 4 ms"); }
        assert!(x.is_idle());
        // pressing again on silence must not replay the old reverb / echo tails
        x.set(1.0, [0.0, 0.5, 0.5, 0.0], p(800.0, 0.3, 0.3, 0.8, 1.0, 1.0, 1.0, 0.5));
        let mut e = 0.0f32; for _ in 0..20000 { let (l, r) = x.process(0.0, 0.0); e += l.abs() + r.abs(); }
        assert!(e < 1e-6, "tails survived the release: {e}");
    }
    #[test]
    fn attack_and_release_are_click_free() {
        let mut x = XyFx::new(SR); let mut worst = 0.0f32; let mut prev = 0.0f32; let mut at = 0usize;
        let dry = |i: usize| (2.0 * PI * 200.0 * i as f32 / SR).sin() * 0.5;
        for i in 0..4000 { x.process(dry(i), dry(i)); } prev = dry(3999);
        x.set(1.0, [1.0, 0.0, 0.0, 0.0], p(300.0, 0.0, 0.2, 0.0, 0.5, 0.0, 1.0, 0.0));
        for i in 4000..12000 { let (l, _) = x.process(dry(i), dry(i)); if (l - prev).abs() > worst { worst = (l - prev).abs(); at = i; } prev = l; }
        x.set(0.0, [0.0; 4], p(300.0, 0.0, 0.2, 0.0, 0.5, 0.0, 1.0, 0.0));
        for i in 12000..20000 { let (l, _) = x.process(dry(i), dry(i)); if (l - prev).abs() > worst { worst = (l - prev).abs(); at = i; } prev = l; }
        assert!(worst < 0.06, "a 200 Hz sine moves by at most 0.03 per sample: step {worst} at {at}");
    }
    #[test]
    fn moving_between_zones_blends_smoothly() {
        let mut x = XyFx::new(SR); let mut prev = 0.0f32; let mut worst = 0.0f32;
        let src = |i: usize| (2.0 * PI * 330.0 * i as f32 / SR).sin() * 0.5 + (2.0 * PI * 2500.0 * i as f32 / SR).sin() * 0.2;
        x.set(1.0, [1.0, 0.0, 0.0, 0.0], p(2000.0, 0.2, 0.2, 0.4, 0.5, 0.4, 0.5, 0.5));
        for i in 0..8000 { let (l, _) = x.process(src(i), src(i)); prev = l; }
        for step in 0..400 { let t = step as f32 / 399.0;   // sweep Filter -> Echo -> Reverb -> Flanger
            let w = if t < 0.33 { let u = t / 0.33; [1.0 - u, u, 0.0, 0.0] } else if t < 0.66 { let u = (t - 0.33) / 0.33; [0.0, 1.0 - u, u, 0.0] } else { let u = (t - 0.66) / 0.34; [0.0, 0.0, 1.0 - u, u] };
            x.set(1.0, w, p(2000.0, 0.2, 0.2, 0.4, 0.5, 0.4, 0.5, 0.5));
            for k in 0..110 { let i = 8000 + step * 110 + k; let (l, _) = x.process(src(i), src(i)); worst = worst.max((l - prev).abs()); prev = l; } }
        assert!(worst < 0.25, "no jumps between zones: {worst}");
    }
    #[test]
    fn filter_types_high_pass_band_pass_and_notch() {
        let level = |ft: u8, f0: f32, cut: f32| { let mut x = XyFx::new(SR); x.set_variants([ft, 0, 0, 0]); x.set(1.0, [1.0, 0.0, 0.0, 0.0], p(cut, 0.3, 0.2, 0.0, 0.5, 0.0, 1.0, 0.0));
            let mut o = Vec::new(); for i in 0..(SR as usize) { let s = (2.0 * PI * f0 * i as f32 / SR).sin() * 0.5; let (l, _) = x.process(s, s); if i > 8000 { o.push(l); } } rms(&o) };
        assert!(level(1, 80.0, 1500.0) < 0.02 && level(1, 8000.0, 1500.0) > 0.25, "high-pass: lows removed, highs kept");
        assert!(level(2, 1500.0, 1500.0) > 0.2 && level(2, 80.0, 1500.0) < 0.05 && level(2, 12000.0, 1500.0) < 0.1, "band-pass: only the band");
        assert!(level(3, 1500.0, 1500.0) < 0.08 && level(3, 80.0, 1500.0) > 0.25 && level(3, 9000.0, 1500.0) > 0.25, "notch: the band is removed, the rest stays");
        assert!(level(0, 80.0, 1500.0) > 0.25 && level(0, 8000.0, 1500.0) < 0.05, "low-pass unchanged");
    }
    #[test]
    fn bad_input_is_ignored_safely() {
        let mut x = XyFx::new(SR);
        x.set(f32::NAN, [f32::NAN; 4], [f32::INFINITY; N_P]); assert!(x.is_idle());
        x.set(2.0, [1.0, 1.0, 1.0, 1.0], [f32::NAN; N_P]); let mut s = 3;
        for _ in 0..20000 { let a = rnd(&mut s) * 0.5; let (l, r) = x.process(a, a); assert!(l.is_finite() && r.is_finite()); }
    }
    #[test]
    fn all_28_variants_are_finite_bounded_audible_and_different_from_the_base_effect() {
        let mk = |fam: usize, var: u8| { let mut v = [0u8; 4]; v[fam] = var; v };
        let run = |fam: usize, var: u8| -> Vec<f32> {
            let mut x = XyFx::new(SR); x.set_variants(mk(fam, var)); let mut w = [0.0f32; 4]; w[fam] = 1.0;
            x.set(1.0, w, p(800.0, 0.7, 0.25, 0.5, 0.6, 0.8, 1.5, 0.8)); let mut s = 11; let mut out = Vec::new();
            for i in 0..(SR as usize * 2) { let a = rnd(&mut s) * 0.3 + (2.0 * PI * 330.0 * i as f32 / SR).sin() * 0.25; let b = rnd(&mut s) * 0.3 + (2.0 * PI * 495.0 * i as f32 / SR).sin() * 0.25; let (l, r) = x.process(a, b); assert!(l.is_finite() && r.is_finite(), "fam {fam} var {var} not finite"); out.push(l); out.push(r); }
            out
        };
        let input_rms = 0.25f32;
        for fam in 0..4usize {
            let base = run(fam, 0);
            for var in 0..NV {
                let o = run(fam, var); let peak = o.iter().fold(0.0f32, |m, v| m.max(v.abs()));
                assert!(peak < 4.0, "fam {fam} var {var}: peak {peak}");
                let level = rms(&o[SR as usize..]) / input_rms; assert!(level > 0.05 && level < 4.0, "fam {fam} var {var}: level x{level}");
                if var > 0 { let diff: f32 = o[SR as usize..].iter().zip(&base[SR as usize..]).map(|(a, b)| (a - b).abs()).sum::<f32>() / (o.len() - SR as usize) as f32; assert!(diff > 0.005, "fam {fam} var {var} sounds like the base effect: {diff}"); }
            }
        }
    }
    #[test]
    fn variants_release_cleanly_like_the_base_effects() {
        for fam in 0..4usize { for var in 0..NV {
            let mut x = XyFx::new(SR); let mut v = [0u8; 4]; v[fam] = var; x.set_variants(v); let mut w = [0.0f32; 4]; w[fam] = 1.0; let pp = p(900.0, 0.6, 0.3, 0.7, 0.8, 0.8, 2.0, 0.7); x.set(1.0, w, pp);
            let mut s = 3; for _ in 0..20000 { let a = rnd(&mut s) * 0.5; x.process(a, a); }
            x.set(0.0, [0.0; 4], pp); for _ in 0..((0.004 * SR) as usize + 3) { let a = rnd(&mut s) * 0.5; x.process(a, a); }
            for _ in 0..100 { let a = rnd(&mut s) * 0.5; assert_eq!(x.process(a, -a), (a, -a), "fam {fam} var {var} did not return to the dry signal"); }
            x.set(1.0, w, pp); let mut e = 0.0f32; for _ in 0..8000 { let (l, rr) = x.process(0.0, 0.0); e += l.abs() + rr.abs(); } assert!(e < 1e-6, "fam {fam} var {var}: tail survived the release ({e})");
        } }
    }
}
