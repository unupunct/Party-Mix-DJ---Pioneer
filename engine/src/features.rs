//! Musical and audio feature extraction (H1). Background threads only, never the audio callback.
//!
//! Everything here is an *estimate*. Fields that are unreliable by nature carry a confidence value, and the
//! vocal / mood outputs are heuristics (no trained model), clearly flagged by low, capped confidences.
use crate::analysis::{Analysis, BPS};
use crate::core::Track;
use rustfft::{num_complex::Complex, FftPlanner};
use serde::Serialize;

/// Bump when the algorithms change so stored results can be recomputed.
pub const ENGINE_VERSION: u32 = 1;

const NOTE_MAJOR: [&str; 12] = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const NOTE_MINOR: [&str; 12] = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "Abm", "Am", "Bbm", "Bm"];
// Krumhansl–Kessler tonal hierarchy profiles (published perceptual key profiles)
const KK_MAJOR: [f32; 12] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR: [f32; 12] = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/// Camelot notation for a key: major keys are "B", minor keys "A"; 8B = C major, 8A = A minor.
pub fn camelot(tonic: u8, minor: bool) -> String {
    let major_tonic = if minor { (tonic as u32 + 3) % 12 } else { tonic as u32 };
    let pos = (major_tonic * 7) % 12; // position on the circle of fifths, C = 0
    format!("{}{}", (pos + 7) % 12 + 1, if minor { 'A' } else { 'B' })
}
pub fn key_name(tonic: u8, minor: bool) -> String {
    if minor { NOTE_MINOR[tonic as usize % 12].to_string() } else { NOTE_MAJOR[tonic as usize % 12].to_string() }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub tonic: u8,
    pub minor: bool,
    pub name: String,
    pub camelot: String,
    /// 0..1. Low when the best key barely beats the runner-up or fits the music poorly (atonal, noisy, key changes).
    pub confidence: f32,
    pub runner_up: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    pub engine_version: u32,
    pub duration_s: f64,
    pub key: Option<KeyInfo>,
    pub tuning_cents: f32,
    pub bpm: f32,
    pub bpm_confidence: f32,
    pub grid_offset_s: f32,
    pub time_signature: u8,        // beats per bar (3 or 4)
    pub downbeat_offset_s: f32,    // time of the first downbeat
    pub downbeat_confidence: f32,
    pub rms_db: f32,
    pub peak_db: f32,
    pub dynamic_range_db: f32,
    pub centroid_hz: f32,
    pub low: f32,                  // share of spectral power below 250 Hz
    pub mid: f32,                  // 250 Hz – 4 kHz
    pub high: f32,                 // above 4 kHz
    pub onset_density: f32,        // onsets per second
    pub beat_strength: f32,        // 0..1
    pub tempo_stability: f32,      // 0..1, share of grid beats that coincide with an onset
    pub energy: u8,                // 1..10 (heuristic)
    pub energy_confidence: f32,
    pub danceability: f32,         // 0..1 (heuristic: stability x beat strength x tempo suitability)
    pub intro_end_s: Option<f32>,
    pub outro_start_s: Option<f32>,
    pub vocal_presence: f32,       // 0..1 (heuristic estimate, no model)
    pub vocal_confidence: f32,     // capped low on purpose
    pub mood: String,              // heuristic category
    pub mood_confidence: f32,      // capped low on purpose
    pub genre: Option<String>,     // not classified here (needs a trained model); filled from file tags later
}

fn pearson(a: &[f32; 12], b: &[f32; 12]) -> f32 {
    let (ma, mb) = (a.iter().sum::<f32>() / 12.0, b.iter().sum::<f32>() / 12.0);
    let (mut num, mut da, mut db) = (0f32, 0f32, 0f32);
    for i in 0..12 { let (x, y) = (a[i] - ma, b[i] - mb); num += x * y; da += x * x; db += y * y; }
    if da <= 1e-12 || db <= 1e-12 { 0.0 } else { num / (da.sqrt() * db.sqrt()) }
}

/// Best key from a 12-bin chroma vector, plus confidence.
pub fn key_from_chroma(chroma: &[f32; 12]) -> Option<KeyInfo> {
    if chroma.iter().sum::<f32>() <= 1e-9 { return None; }
    let mut scores: Vec<(f32, u8, bool)> = Vec::with_capacity(24);
    for t in 0..12u8 {
        let (mut maj, mut min) = ([0f32; 12], [0f32; 12]);
        for i in 0..12 { maj[(i + t as usize) % 12] = KK_MAJOR[i]; min[(i + t as usize) % 12] = KK_MINOR[i]; }
        scores.push((pearson(chroma, &maj), t, false));
        scores.push((pearson(chroma, &min), t, true));
    }
    scores.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let (r1, t1, m1) = scores[0];
    let (r2, t2, m2) = scores[1];
    let confidence = (((r1 - r2) / 0.12).clamp(0.0, 1.0)) * (((r1 - 0.35) / 0.35).clamp(0.0, 1.0));
    Some(KeyInfo { tonic: t1, minor: m1, name: key_name(t1, m1), camelot: camelot(t1, m1), confidence, runner_up: camelot(t2, m2) })
}

fn percentile(v: &mut Vec<f32>, p: f32) -> f32 {
    if v.is_empty() { return 0.0; }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    v[((v.len() - 1) as f32 * p) as usize]
}
fn db(x: f32) -> f32 { 20.0 * x.max(1e-9).log10() }

pub fn compute(t: &Track, a: &Analysis) -> Features {
    let sr = t.sample_rate as f32;
    let dur = t.duration();

    // ---- loudness, peak, short-term levels (streamed; no big temporary buffers)
    let (mut sumsq, mut peak) = (0f64, 0f32);
    let blk = t.sample_rate as usize; // 1 s blocks
    let mut blocks: Vec<f32> = Vec::new();
    let mut bsum = 0f64; let mut bn = 0usize;
    for f in 0..t.frames {
        let (l, r) = (t.data[f * 2], t.data[f * 2 + 1]);
        let m = (l + r) * 0.5;
        sumsq += (m * m) as f64; bsum += (m * m) as f64; bn += 1;
        peak = peak.max(l.abs().max(r.abs()));
        if bn == blk { blocks.push((bsum / bn as f64).sqrt() as f32); bsum = 0.0; bn = 0; }
    }
    if bn > blk / 2 { blocks.push((bsum / bn as f64).sqrt() as f32); }
    let rms_db = db(((sumsq / t.frames.max(1) as f64).sqrt()) as f32);
    let peak_db = db(peak);
    let mut live: Vec<f32> = blocks.iter().map(|&b| db(b)).filter(|&d| d > -60.0).collect();
    let dynamic_range_db = if live.len() >= 5 { percentile(&mut live.clone(), 0.95) - percentile(&mut live, 0.10) } else { 0.0 };

    // ---- STFT over (up to) the middle 150 s: spectral shape + key
    const N: usize = 8192;
    const HOP: usize = 4096;
    let seg_len = ((150.0 * sr) as usize).min(t.frames);
    let seg_start = (t.frames - seg_len) / 2;
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(N);
    let window: Vec<f32> = (0..N).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / N as f32).cos()).collect();
    let mut buf = vec![Complex { re: 0f32, im: 0f32 }; N];
    let mut scratch = vec![Complex { re: 0f32, im: 0f32 }; fft.get_inplace_scratch_len()];
    let bin_hz = sr / N as f32;
    let (mut p_low, mut p_mid, mut p_high) = (0f64, 0f64, 0f64);
    let (mut cent_sum, mut cent_n) = (0f64, 0usize);
    let mut peaks: Vec<(f32, f32)> = Vec::new(); // (midi pitch, weight)
    let (mut voc_frames, mut tot_frames) = (0usize, 0usize);
    let mut mags = vec![0f32; N / 2];
    let mut pos = seg_start;
    while pos + N <= seg_start + seg_len {
        for i in 0..N { let f = pos + i; buf[i] = Complex { re: (t.data[f * 2] + t.data[f * 2 + 1]) * 0.5 * window[i], im: 0.0 }; }
        fft.process_with_scratch(&mut buf, &mut scratch);
        let mut maxm = 1e-12f32;
        for k in 0..N / 2 { mags[k] = buf[k].norm(); if mags[k] > maxm { maxm = mags[k]; } }
        let (mut fe, mut fl, mut fm, mut fh, mut cs, mut ce) = (0f64, 0f64, 0f64, 0f64, 0f64, 0f64);
        for k in 1..N / 2 {
            let f = k as f32 * bin_hz; let p = (mags[k] * mags[k]) as f64;
            fe += p;
            if f < 250.0 { fl += p } else if f < 4000.0 { fm += p } else { fh += p }
            if (20.0..16000.0).contains(&f) { cs += p.sqrt() * f as f64; ce += p.sqrt(); }
        }
        if fe > 1e-9 {
            p_low += fl; p_mid += fm; p_high += fh;
            if ce > 0.0 { cent_sum += cs / ce; cent_n += 1; }
            // vocal-ish frame: most power in the voice band and a tonal (non-flat) spectrum there
            let (lo_k, hi_k) = ((300.0 / bin_hz) as usize, (3000.0 / bin_hz) as usize);
            let (mut gm, mut am, mut cnt) = (0f64, 0f64, 0f64);
            for k in lo_k..hi_k { let m = (mags[k] as f64).max(1e-9); gm += m.ln(); am += m; cnt += 1.0; }
            let flat = (gm / cnt).exp() / (am / cnt);
            tot_frames += 1;
            if fm / fe > 0.55 && flat < 0.15 { voc_frames += 1; }
        }
        // spectral peaks 60 Hz .. 3 kHz for chroma
        let (klo, khi) = ((60.0 / bin_hz) as usize + 1, ((3000.0 / bin_hz) as usize).min(N / 2 - 2));
        for k in klo..khi {
            if mags[k] > mags[k - 1] && mags[k] >= mags[k + 1] && mags[k] > 0.02 * maxm {
                let (a, b, c) = (mags[k - 1].max(1e-12).ln(), mags[k].max(1e-12).ln(), mags[k + 1].max(1e-12).ln());
                let d = 0.5 * (a - c) / (a - 2.0 * b + c);
                let f = (k as f32 + d.clamp(-0.5, 0.5)) * bin_hz;
                peaks.push((69.0 + 12.0 * (f / 440.0).log2(), (1.0 + 20.0 * mags[k] / maxm).ln()));
            }
        }
        pos += HOP;
    }
    let pe = p_low + p_mid + p_high;
    let (low, mid, high) = if pe > 0.0 { ((p_low / pe) as f32, (p_mid / pe) as f32, (p_high / pe) as f32) } else { (0.0, 0.0, 0.0) };
    let centroid_hz = if cent_n > 0 { (cent_sum / cent_n as f64) as f32 } else { 0.0 };

    // tuning: weighted histogram of deviations from the equal-tempered grid
    let mut hist = [0f32; 20]; // 0.05-semitone bins over [-0.5, 0.5)
    for &(m, w) in &peaks { let dev = m - m.round(); hist[(((dev + 0.5) * 20.0) as usize).min(19)] += w; }
    let (mut hb, mut hv) = (10usize, -1f32);
    for i in 0..20 { let v = hist[i] + 0.5 * (hist[(i + 1) % 20] + hist[(i + 19) % 20]); if v > hv { hv = v; hb = i; } }
    let shift = (hb as f32 + 0.5) / 20.0 - 0.5; // semitones
    let mut chroma = [0f32; 12];
    for &(m, w) in &peaks { chroma[((m - shift).round() as i64).rem_euclid(12) as usize] += w; }
    let key = key_from_chroma(&chroma);

    // ---- rhythm: onset density, beat strength, tempo stability, meter, downbeat
    let env = &a.env;
    let n = env.len();
    let (mean, var) = if n > 0 { let m = env.iter().sum::<f32>() / n as f32; (m, env.iter().map(|x| (x - m) * (x - m)).sum::<f32>() / n as f32) } else { (0.0, 0.0) };
    let thr = mean + 1.5 * var.sqrt();
    let (mut onsets, mut last) = (0usize, -100i64);
    for i in 1..n.saturating_sub(1) { if env[i] > thr && env[i] >= env[i - 1] && env[i] > env[i + 1] && i as i64 - last >= 5 { onsets += 1; last = i as i64; } }
    let onset_density = if dur > 0.0 { onsets as f32 / dur as f32 } else { 0.0 };

    let mut beat_strengths: Vec<f32> = Vec::new();
    let (mut tempo_stability, mut beat_strength, mut time_signature, mut downbeat_phase, mut downbeat_conf) = (0f32, 0f32, 4u8, 0usize, 0f32);
    if a.bpm > 0.0 && n > 0 {
        let per = 60.0 / a.bpm;
        let mut k = 0usize;
        let hi_ref = { let mut v = env.clone(); percentile(&mut v, 0.95) };
        loop {
            let bt = a.grid + k as f32 * per; let f = (bt * BPS as f32).round() as isize;
            if f >= n as isize - 4 { break; }
            if f >= 3 { let m = (f as usize - 3..=f as usize + 3).map(|i| env[i]).fold(0f32, f32::max); beat_strengths.push(m); }
            k += 1;
        }
        if !beat_strengths.is_empty() {
            let hits = beat_strengths.iter().filter(|&&m| m > 0.35 * hi_ref).count();
            tempo_stability = hits as f32 / beat_strengths.len() as f32;
            let bm = beat_strengths.iter().sum::<f32>() / beat_strengths.len() as f32;
            beat_strength = ((bm / (mean + 1e-9) - 1.0) / 6.0).clamp(0.0, 1.0);
        }
        // meter: which grouping (3 or 4 beats per bar) shows a clear accent, and on which beat
        let accent = |m: usize| -> (f32, usize) {
            let mut sums = vec![0f32; m]; let mut cnts = vec![0f32; m];
            for (i, &s) in beat_strengths.iter().enumerate() { sums[i % m] += s; cnts[i % m] += 1.0; }
            let means: Vec<f32> = (0..m).map(|j| sums[j] / cnts[j].max(1.0)).collect();
            let all = beat_strengths.iter().sum::<f32>() / beat_strengths.len().max(1) as f32;
            let (bj, bv) = means.iter().enumerate().fold((0, 0f32), |acc, (j, &v)| if v > acc.1 { (j, v) } else { acc });
            (bv / (all + 1e-9), bj)
        };
        if beat_strengths.len() >= 16 {
            let ((s3, p3), (s4, p4)) = (accent(3), accent(4));
            // a 4-beat accent pattern also produces a (weaker) 2-beat structure; prefer 4 unless 3 is clearly stronger
            if s3 > s4 + 0.1 { time_signature = 3; downbeat_phase = p3; downbeat_conf = (((s3 - s4) / 0.5).clamp(0.0, 1.0)) * ((s3 - 1.0) / 0.5).clamp(0.0, 1.0); }
            else { time_signature = 4; downbeat_phase = p4; downbeat_conf = ((s4 - 1.0) / 0.5).clamp(0.0, 1.0); }
        }
    }
    let downbeat_offset_s = if a.bpm > 0.0 { a.grid + downbeat_phase as f32 * 60.0 / a.bpm } else { 0.0 };

    // ---- energy / danceability / mood (documented heuristics)
    let loud_n = ((rms_db + 30.0) / 22.0).clamp(0.0, 1.0);
    let cent_n = ((centroid_hz - 500.0) / 3500.0).clamp(0.0, 1.0);
    let dens_n = (onset_density / 6.0).clamp(0.0, 1.0);
    let raw = 0.35 * loud_n + 0.25 * dens_n + 0.20 * cent_n + 0.20 * beat_strength;
    let energy = (1.0 + (raw * 9.0).round()).clamp(1.0, 10.0) as u8;
    let energy_confidence = (0.4 + 0.4 * tempo_stability).clamp(0.0, 0.8);
    let tempo_factor = if a.bpm <= 0.0 { 0.0 } else if (100.0..=135.0).contains(&a.bpm) { 1.0 } else if a.bpm < 100.0 { (0.6 + 0.4 * (a.bpm - 80.0) / 20.0).clamp(0.4, 1.0) } else { (1.0 - 0.4 * (a.bpm - 135.0) / 35.0).clamp(0.4, 1.0) };
    let danceability = (tempo_stability * (0.5 + 0.5 * beat_strength) * tempo_factor).clamp(0.0, 1.0);

    let key_conf = key.as_ref().map(|k| k.confidence).unwrap_or(0.0);
    let major = key.as_ref().map(|k| !k.minor).unwrap_or(true);
    let mode_term = if key_conf >= 0.3 { (if major { 0.25f32 } else { -0.25f32 }) * key_conf } else { 0.0 };
    let valence = 0.5 + mode_term + 0.15 * (cent_n - 0.5);
    let arousal = energy as f32 / 10.0;
    let mood = match (arousal >= 0.6, valence >= 0.5) { (true, true) => "Energetic / uplifting", (true, false) => "Dark / intense", (false, true) => "Chill / warm", (false, false) => "Mellow / melancholic" }.to_string();
    let mood_confidence = (0.15 + 0.25 * key_conf + 0.1 * tempo_stability).clamp(0.0, 0.5);
    let vocal_presence = if tot_frames > 0 { voc_frames as f32 / tot_frames as f32 } else { 0.0 };

    // ---- intro / outro from the smoothed 1-second level curve
    let (mut intro_end_s, mut outro_start_s) = (None, None);
    if blocks.len() >= 30 {
        let sm: Vec<f32> = (0..blocks.len()).map(|i| { let (lo, hi) = (i.saturating_sub(2), (i + 3).min(blocks.len())); blocks[lo..hi].iter().sum::<f32>() / (hi - lo) as f32 }).collect();
        let mut live: Vec<f32> = sm.iter().cloned().filter(|&x| db(x) > -60.0).collect();
        if !live.is_empty() {
            let med = percentile(&mut live, 0.5);
            let ok = |i: usize| sm[i] >= 0.7 * med;
            if let Some(i) = (0..sm.len().saturating_sub(4)).find(|&i| (i..i + 4).all(|j| ok(j))) { if (i as f32) < dur as f32 * 0.5 { intro_end_s = Some(i as f32); } }
            if let Some(j) = (4..sm.len()).rev().find(|&j| (j - 3..=j).all(|q| ok(q))) { let o = (j + 1) as f32; if o > dur as f32 * 0.5 && o < dur as f32 - 1.0 { outro_start_s = Some(o); } }
        }
    }

    Features {
        engine_version: ENGINE_VERSION, duration_s: dur, key, tuning_cents: shift * 100.0, bpm: a.bpm, bpm_confidence: a.bpm_conf, grid_offset_s: a.grid,
        time_signature, downbeat_offset_s, downbeat_confidence: downbeat_conf, rms_db, peak_db, dynamic_range_db, centroid_hz, low, mid, high,
        onset_density, beat_strength, tempo_stability, energy, energy_confidence, danceability, intro_end_s, outro_start_s,
        vocal_presence, vocal_confidence: 0.3, mood, mood_confidence, genre: None,
    }
}
