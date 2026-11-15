//! Waveform colour data and tempo/beat-grid estimate. Background thread only. Same algorithm the UI used before,
//! now off the UI thread: 150 buckets/s of amplitude + 3-band colour, BPM 75-175 by onset autocorrelation.
use crate::core::Track;

pub const BPS: usize = 150;

pub struct Analysis {
    pub n: usize,
    pub amp: Vec<u8>,
    pub col: Vec<u8>, // n*3 RGB
    pub bpm: f32,
    pub grid: f32,
    /// 0..1: how clearly the onset envelope supports the tempo (best autocorrelation vs the average over all tempi)
    pub bpm_conf: f32,
    /// onset envelope at BPS frames per second (used by the feature extractor)
    pub env: Vec<f32>,
}

pub fn analyze(t: &Track) -> Analysis {
    let sr = t.sample_rate as f32;
    let b = ((sr / BPS as f32).round() as usize).max(1);
    let n = t.frames.div_ceil(b);
    let (mut amp, mut lo, mut mi, mut hi) = (vec![0f32; n], vec![0f32; n], vec![0f32; n], vec![0f32; n]);
    let a1 = 1.0 - (-2.0 * std::f32::consts::PI * 250.0 / sr).exp();
    let a2 = 1.0 - (-2.0 * std::f32::consts::PI * 2500.0 / sr).exp();
    let (mut l1, mut l2) = (0f32, 0f32);
    for k in 0..n {
        let (s0, s1) = (k * b, ((k + 1) * b).min(t.frames));
        let (mut pa, mut pl, mut pm, mut ph) = (0f32, 0f32, 0f32, 0f32);
        for i in s0..s1 {
            let (l, r) = (t.data[i * 2], t.data[i * 2 + 1]);
            let x = (l + r) * 0.5;
            l1 += a1 * (x - l1);
            l2 += a2 * (x - l2);
            pl += l1.abs(); pm += (l2 - l1).abs(); ph += (x - l2).abs();
            pa = pa.max(l.abs().max(r.abs()));
        }
        let c = (s1 - s0).max(1) as f32;
        amp[k] = pa; lo[k] = pl / c; mi[k] = pm / c; hi[k] = ph / c;
    }
    let mx = |v: &[f32]| v.iter().cloned().fold(1e-9f32, f32::max);
    let (ma, ml, mm, mh) = (mx(&amp), mx(&lo), mx(&mi), mx(&hi));
    let mut a8 = vec![0u8; n];
    let mut col = vec![0u8; n * 3];
    for k in 0..n {
        a8[k] = (255.0 * (amp[k] / ma).powf(0.8)).round() as u8;
        let (bl, bm, bh) = ((lo[k] / ml).powf(0.6), (mi[k] / mm).powf(0.6), (hi[k] / mh).powf(0.6));
        let m = bl.max(bm).max(bh).max(1e-3);
        col[k * 3] = (40.0 + 215.0 * bl / m) as u8;
        col[k * 3 + 1] = (40.0 + 215.0 * bm / m) as u8;
        col[k * 3 + 2] = (40.0 + 215.0 * bh / m) as u8;
    }
    // tempo from onset envelope
    let mut env = vec![0f32; n];
    for k in 1..n { env[k] = ((lo[k] - lo[k - 1]) + 0.5 * (mi[k] - mi[k - 1])).max(0.0); }
    let s0 = (10 * BPS).min(n.saturating_sub(20 * BPS));
    let s1 = (n.saturating_sub(1)).min(s0 + 120 * BPS);
    let (mut best, mut best_bpm) = (0f32, 0f32);
    let (mut sum_sc, mut cnt_sc) = (0f32, 0f32);
    if s1 > s0 + 8 * BPS {
        let mut bpm = 75.0f32;
        while bpm <= 175.0 {
            let lag = BPS as f32 * 60.0 / bpm;
            let mut sc = 0f32;
            let end = s1.saturating_sub(lag.ceil() as usize + 1);
            for i in s0..end {
                let j = i as f32 + lag;
                let jf = j.floor() as usize;
                let fr = j - jf as f32;
                sc += env[i] * (env[jf] * (1.0 - fr) + env[jf + 1] * fr);
            }
            sc /= (s1 - s0) as f32;
            sum_sc += sc; cnt_sc += 1.0;
            if sc > best { best = sc; best_bpm = bpm; }
            bpm += 0.1;
        }
    }
    let mut grid = 0f32;
    if best_bpm > 0.0 {
        // Refine: a beat grid that fits many beats pins the tempo far more precisely than the coarse autocorrelation.
        let comb = |bpm: f32| -> (f32, f32) {
            let p = BPS as f32 * 60.0 / bpm;
            let (mut bs, mut bp, mut ph) = (-1f32, 0f32, 0f32);
            while ph < p {
                let mut sc = 0f32;
                let mut t = s0 as f32 + ph;
                while t < s1 as f32 { sc += env[(t.round() as usize).min(n - 1)]; t += p; }
                if sc > bs { bs = sc; bp = ph; }
                ph += 0.5;
            }
            (bs, bp)
        };
        let (mut top, mut top_bpm, mut top_phase) = (-1f32, best_bpm, 0f32);
        let mut cand = best_bpm - 1.5;
        while cand <= best_bpm + 1.5 {
            if (75.0..=175.0).contains(&cand) {
                let (sc, ph) = comb(cand);
                if sc > top { top = sc; top_bpm = cand; top_phase = ph; }
            }
            cand += 0.02;
        }
        best_bpm = top_bpm;
        let p = BPS as f32 * 60.0 / best_bpm;
        // beats fall at s0 + top_phase + k*p frames, so the first beat offset modulo the period is (s0 + phase) mod p
        grid = ((s0 as f32 + top_phase) % p) / BPS as f32;
    }
    let bpm_conf = if cnt_sc > 0.0 && sum_sc > 0.0 { (((best / (sum_sc / cnt_sc)) - 1.5) / 3.0).clamp(0.0, 1.0) } else { 0.0 };
    Analysis { n, amp: a8, col, bpm_conf, env, bpm: if best_bpm > 0.0 { (best_bpm * 10.0).round() / 10.0 } else { 0.0 }, grid }
}
