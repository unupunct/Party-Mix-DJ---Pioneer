//! Tests for the feature extractor (H1) on synthetic audio with known ground truth. Run: `cargo test --release`
use djengine::analysis::analyze;
use djengine::core::Track;
use djengine::features::{camelot, compute, key_from_chroma, Features};
use std::f32::consts::TAU;

struct Rng(u32);
impl Rng {
    fn next(&mut self) -> f32 { self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223); (self.0 >> 8) as f32 / 16777216.0 }
    fn pick(&mut self, w: &[f32]) -> usize { let s: f32 = w.iter().sum(); let mut x = self.next() * s; for (i, v) in w.iter().enumerate() { if x < *v { return i; } x -= v; } w.len() - 1 }
}
fn feats(t: &Track) -> Features { compute(t, &analyze(t)) }

fn add_note(buf: &mut [f32], sr: u32, midi: f32, start: f32, len: f32, amp: f32) {
    let f = 440.0 * 2f32.powf((midi - 69.0) / 12.0);
    let (s0, n) = ((start * sr as f32) as usize, (len * sr as f32) as usize);
    for i in 0..n {
        let idx = s0 + i; if idx >= buf.len() { break; }
        let t = i as f32 / sr as f32;
        let env = (-t * 2.5).exp() * (1.0 - (-t * 200.0).exp());
        let mut v = 0f32;
        for h in 1..=4 { v += (TAU * f * h as f32 * t).sin() / h as f32; }
        buf[idx] += v * env * amp;
    }
}
/// Tonal music in a known key: chords I-IV-V-I (or i-iv-V-i), bass root, melody drawn from the scale (tonic/dominant favoured).
fn tonal(sr: u32, secs: f32, tonic: u8, minor: bool, seed: u32, detune_cents: f32, drums: bool) -> Track {
    let mut rng = Rng(seed);
    let mut m = vec![0f32; (sr as f32 * secs) as usize];
    let scale: [i32; 7] = if minor { [0, 2, 3, 5, 7, 8, 10] } else { [0, 2, 4, 5, 7, 9, 11] };
    let w = [3.0, 1.0, 2.0, 1.0, 2.5, 1.0, 0.7];
    let roots = [0, 5, 7, 0];
    let base = 60.0 + tonic as f32 + detune_cents / 100.0;
    let mut t = 0f32; let mut ci = 0;
    while t < secs {
        let r = roots[ci % 4] as f32;
        let third = if minor && roots[ci % 4] != 7 { 3.0 } else { 4.0 };
        for off in [0.0, third, 7.0] { add_note(&mut m, sr, base + r + off - 12.0, t, 2.0, 0.12); }
        add_note(&mut m, sr, base + r - 24.0, t, 2.0, 0.25);
        let mut mt = t;
        while mt < t + 2.0 { let deg = scale[rng.pick(&w)]; add_note(&mut m, sr, base + deg as f32 + if rng.next() < 0.5 { 0.0 } else { 12.0 }, mt, 0.4, 0.18); mt += 0.25; }
        t += 2.0; ci += 1;
    }
    if drums { // kick + hats at 120 BPM
        for k in 0..((secs * 2.0) as usize) {
            let st = k as f32 * 0.5; let s0 = (st * sr as f32) as usize;
            for i in 0..(0.2 * sr as f32) as usize { let idx = s0 + i; if idx >= m.len() { break; } let tt = i as f32 / sr as f32; m[idx] += (TAU * (55.0 + 90.0 * (-tt * 30.0).exp()) * tt).sin() * (-tt * 9.0).exp() * 0.7 + (rng.next() - 0.5) * (-tt * 60.0).exp() * 0.2; }
        }
    }
    let mx = m.iter().fold(0f32, |a, x| a.max(x.abs())).max(1e-6);
    let mut d = Vec::with_capacity(m.len() * 2);
    for v in m { let s = v / mx * 0.7; d.push(s); d.push(s); }
    Track::new(d, sr)
}
/// Same camelot "neighbourhood" the harmonic mixer treats as compatible: same, +-1 on the wheel, relative major/minor.
fn compatible(a: &str, b: &str) -> bool {
    let p = |s: &str| (s[..s.len() - 1].parse::<i32>().unwrap(), s.chars().last().unwrap());
    let ((na, la), (nb, lb)) = (p(a), p(b));
    let d = ((na - nb).rem_euclid(12)).min((nb - na).rem_euclid(12));
    (la == lb && d <= 1) || (la != lb && d == 0)
}

#[test]
fn camelot_table_is_correct() {
    let major = [("C", 0, "8B"), ("G", 7, "9B"), ("D", 2, "10B"), ("A", 9, "11B"), ("E", 4, "12B"), ("B", 11, "1B"), ("F#", 6, "2B"), ("Db", 1, "3B"), ("Ab", 8, "4B"), ("Eb", 3, "5B"), ("Bb", 10, "6B"), ("F", 5, "7B")];
    for (n, pc, c) in major { assert_eq!(camelot(pc, false), c, "{n} major"); }
    let minor = [("A", 9, "8A"), ("E", 4, "9A"), ("B", 11, "10A"), ("F#", 6, "11A"), ("C#", 1, "12A"), ("Ab", 8, "1A"), ("Eb", 3, "2A"), ("Bb", 10, "3A"), ("F", 5, "4A"), ("C", 0, "5A"), ("G", 7, "6A"), ("D", 2, "7A")];
    for (n, pc, c) in minor { assert_eq!(camelot(pc, true), c, "{n} minor"); }
}

#[test]
fn ideal_profiles_are_recognised_in_all_24_keys() {
    let maj = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88f32];
    let min = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17f32];
    for t in 0..12u8 { for minor in [false, true] {
        let mut c = [0f32; 12]; for i in 0..12 { c[(i + t as usize) % 12] = if minor { min[i] } else { maj[i] }; }
        let k = key_from_chroma(&c).unwrap();
        assert_eq!((k.tonic, k.minor), (t, minor));
        assert!(k.confidence > 0.5, "ideal profile confidence {}", k.confidence);
    } }
    assert!(key_from_chroma(&[0.0; 12]).is_none());
    assert!(key_from_chroma(&[1.0; 12]).map(|k| k.confidence < 0.05).unwrap_or(true), "flat chroma must not be confident");
}

#[test]
fn key_detection_on_synthetic_music_all_24_keys() {
    let (mut exact, mut near, mut conf) = (0, 0, 0f32);
    for tonic in 0..12u8 { for minor in [false, true] {
        let t = tonal(22050, 24.0, tonic, minor, 7 + tonic as u32 * 3 + minor as u32, 0.0, false);
        let k = feats(&t).key.expect("key");
        let want = camelot(tonic, minor);
        if k.camelot == want { exact += 1; }
        if compatible(&k.camelot, &want) { near += 1; } else { eprintln!("far miss: want {want} got {} (conf {:.2})", k.camelot, k.confidence); }
        conf += k.confidence;
    } }
    println!("clean synthetic: exact {exact}/24, within compatible set {near}/24, mean confidence {:.2}", conf / 24.0);
    assert!(exact >= 20, "exact only {exact}/24");
    assert!(near >= 23, "compatible-or-better only {near}/24");
}

#[test]
fn key_detection_with_drums_and_detune() {
    let (mut exact, mut near) = (0, 0);
    for i in 0..12u32 {
        let (tonic, minor) = ((i * 5 % 12) as u8, i % 2 == 1);
        let k = feats(&tonal(22050, 30.0, tonic, minor, 100 + i, 0.0, true)).key.unwrap();
        let want = camelot(tonic, minor);
        if k.camelot == want { exact += 1; } if compatible(&k.camelot, &want) { near += 1; }
    }
    println!("with drums: exact {exact}/12, compatible {near}/12");
    assert!(exact >= 8 && near >= 11, "with drums exact {exact}, near {near}");
    for (tonic, minor) in [(9u8, true), (3, false), (6, true)] {
        let f = feats(&tonal(22050, 24.0, tonic, minor, 55, 35.0, false));
        assert_eq!(f.key.as_ref().unwrap().camelot, camelot(tonic, minor), "detuned +35 cents");
        assert!((f.tuning_cents - 35.0).abs() < 15.0, "tuning estimate {} cents", f.tuning_cents);
    }
}

#[test]
fn atonal_and_noise_material_is_not_reported_with_confidence() {
    // uniformly random chromatic notes: no tonal centre
    let sr = 22050; let mut rng = Rng(9); let mut m = vec![0f32; sr as usize * 24];
    let mut t = 0f32; while t < 23.0 { for _ in 0..3 { add_note(&mut m, sr, 48.0 + (rng.next() * 36.0).floor(), t, 0.4, 0.2); } t += 0.25; }
    let mx = m.iter().fold(0f32, |a, x| a.max(x.abs())); let d: Vec<f32> = m.iter().flat_map(|v| [v / mx * 0.7, v / mx * 0.7]).collect();
    let k = feats(&Track::new(d, sr)).key.unwrap();
    println!("chromatic random: {} conf {:.2}", k.camelot, k.confidence);
    assert!(k.confidence < 0.35, "atonal material reported with confidence {}", k.confidence);
    let noise: Vec<f32> = (0..sr as usize * 20 * 2).map(|_| (rng.next() - 0.5) * 0.5).collect();
    let f = feats(&Track::new(noise, sr));
    assert!(f.key.as_ref().map(|k| k.confidence < 0.2).unwrap_or(true), "noise key confidence {:?}", f.key.map(|k| k.confidence));
}

fn drums(sr: u32, secs: f32, bpm: f32, offset: f32, kick_amp: f32, hats: bool, accent: Option<(usize, f32)>) -> Track {
    let n = (sr as f32 * secs) as usize; let beat = 60.0 / bpm; let mut d = vec![0f32; n * 2]; let mut rng = Rng(3);
    let nb = ((secs - offset) / beat) as usize;
    for k in 0..nb {
        let a = match accent { Some((m, ac)) => if k % m == 0 { kick_amp * ac } else { kick_amp }, None => kick_amp };
        let s0 = ((offset + k as f32 * beat) * sr as f32) as usize;
        for i in 0..(0.25 * sr as f32) as usize { let idx = s0 + i; if idx >= n { break; } let t = i as f32 / sr as f32; let v = (TAU * (55.0 + 90.0 * (-t * 30.0).exp()) * t).sin() * (-t * 9.0).exp() * a; d[idx * 2] += v; d[idx * 2 + 1] += v; }
        if hats { for q in 0..4 { let s1 = s0 + (q as f32 * beat / 4.0 * sr as f32) as usize; for i in 0..(0.03 * sr as f32) as usize { let idx = s1 + i; if idx >= n { break; } let v = (rng.next() - 0.5) * (-(i as f32 / sr as f32) * 150.0).exp() * 0.5 * kick_amp; d[idx * 2] += v; d[idx * 2 + 1] += v; } } }
    }
    Track::new(d, sr)
}

#[test]
fn energy_orders_dense_loud_above_sparse_quiet() {
    let loud = feats(&drums(44100, 60.0, 128.0, 0.1, 0.9, true, None));
    let quiet = {   // sparse and quiet: a kick every 2 beats at -24 dB
        let mut t = drums(44100, 60.0, 64.0, 0.1, 0.06, false, None); for v in t.data.iter_mut() { *v *= 1.0; } feats(&t)
    };
    println!("energy loud {} quiet {}  (rms {:.1} / {:.1} dB, onsets/s {:.1} / {:.1})", loud.energy, quiet.energy, loud.rms_db, quiet.rms_db, loud.onset_density, quiet.onset_density);
    assert!(loud.energy >= quiet.energy + 3, "energy {} vs {}", loud.energy, quiet.energy);
    assert!((1..=10).contains(&loud.energy) && (1..=10).contains(&quiet.energy));
    assert!(loud.onset_density > quiet.onset_density);
}

#[test]
fn intro_and_outro_detection() {
    // pad: quiet 0-16 s, full 16-48 s, quiet 48-60 s
    let sr = 22050; let mut m = vec![0f32; sr as usize * 60];
    for (i, v) in m.iter_mut().enumerate() { let t = i as f32 / sr as f32; let a = if t < 16.0 || t >= 48.0 { 0.02 } else { 0.5 }; *v = ((TAU * 220.0 * t).sin() + 0.5 * (TAU * 330.0 * t).sin()) * a; }
    let d: Vec<f32> = m.iter().flat_map(|v| [*v, *v]).collect();
    let f = feats(&Track::new(d, sr));
    println!("intro_end {:?} outro_start {:?}", f.intro_end_s, f.outro_start_s);
    assert!(f.intro_end_s.map(|x| (x - 16.0).abs() <= 3.5).unwrap_or(false), "intro {:?}", f.intro_end_s);
    assert!(f.outro_start_s.map(|x| (x - 48.0).abs() <= 3.5).unwrap_or(false), "outro {:?}", f.outro_start_s);
}

#[test]
fn meter_and_downbeat() {
    for (m, bpm, off) in [(4usize, 120.0f32, 0.30f32), (4, 126.0, 0.12), (3, 120.0, 0.20), (3, 100.0, 0.35)] {
        let f = feats(&drums(44100, 60.0, bpm, off, 0.6, false, Some((m, 1.7))));
        let bar = m as f32 * 60.0 / bpm;
        let err = ((f.downbeat_offset_s - off) % bar + bar) % bar; let err = err.min(bar - err);
        println!("meter {m}/4 @ {bpm}: got {}/4, downbeat err {:.3}s, conf {:.2}, bpm {:.1}", f.time_signature, err, f.downbeat_confidence, f.bpm);
        assert_eq!(f.time_signature as usize, m, "time signature at {bpm} BPM");
        assert!(err < 0.08, "downbeat off by {err}s");
        assert!(f.downbeat_confidence > 0.3);
    }
}

#[test]
fn tempo_stability_steady_vs_drifting() {
    let steady = feats(&drums(44100, 60.0, 124.0, 0.2, 0.8, false, None));
    // tempo ramps 110 -> 140 BPM over the track
    let sr = 44100u32; let n = sr as usize * 60; let mut d = vec![0f32; n * 2]; let mut t = 0.2f32;
    while t < 58.0 { let bpm = 110.0 + 30.0 * t / 60.0; let s0 = (t * sr as f32) as usize; for i in 0..(0.25 * sr as f32) as usize { let idx = s0 + i; if idx >= n { break; } let tt = i as f32 / sr as f32; let v = (TAU * (55.0 + 90.0 * (-tt * 30.0).exp()) * tt).sin() * (-tt * 9.0).exp() * 0.8; d[idx * 2] += v; d[idx * 2 + 1] += v; } t += 60.0 / bpm; }
    let ramp = feats(&Track::new(d, sr));
    println!("tempo stability steady {:.2} (bpm {:.1}) ramp {:.2}", steady.tempo_stability, steady.bpm, ramp.tempo_stability);
    assert!(steady.tempo_stability > 0.85 && (steady.bpm - 124.0).abs() < 0.6, "steady {} / {}", steady.tempo_stability, steady.bpm);
    assert!(ramp.tempo_stability < steady.tempo_stability - 0.25, "ramp {} not clearly lower than steady {}", ramp.tempo_stability, steady.tempo_stability);
    assert!(steady.danceability > ramp.danceability);
}

#[test]
fn loudness_peak_and_spectrum_measurements() {
    let sine = |hz: f32, amp: f32| { let sr = 44100; let d: Vec<f32> = (0..sr * 12).flat_map(|i| { let v = ((std::f64::consts::TAU * hz as f64 * i as f64 / sr as f64).sin() as f32) * amp; [v, v] }).collect(); Track::new(d, sr as u32) };
    let low = feats(&sine(100.0, 0.5));
    assert!((low.rms_db + 9.03).abs() < 0.3, "rms {}", low.rms_db);
    assert!((low.peak_db + 6.02).abs() < 0.1, "peak {}", low.peak_db);
    assert!(low.low > 0.9 && low.high < 0.05, "low {} high {}", low.low, low.high);
    let high = feats(&sine(8000.0, 0.5));
    assert!(high.high > 0.9, "high {}", high.high);
    let mid = feats(&sine(1000.0, 0.5));
    assert!((mid.centroid_hz - 1000.0).abs() < 80.0, "centroid {}", mid.centroid_hz);
    assert!(mid.mid > 0.9);
    assert!((low.low + low.mid + low.high - 1.0).abs() < 0.01);
}

#[test]
fn robust_on_silence_tiny_and_very_short_files() {
    let silent = feats(&Track::new(vec![0.0; 44100 * 5 * 2], 44100));
    assert!(silent.key.is_none() && silent.energy == 1 && silent.rms_db < -80.0);
    for frames in [0usize, 1, 100, 4410, 9000] { let _ = feats(&Track::new(vec![0.1; frames * 2], 44100)); }
    let _ = feats(&Track::new((0..44100 * 3 * 2).map(|i| ((i as f32) * 0.01).sin()).collect(), 8000));
}

#[test]
fn analysis_speed_on_a_long_track() {
    let t = drums(44100, 360.0, 126.0, 0.1, 0.8, true, None);
    let t0 = std::time::Instant::now();
    let a = analyze(&t); let f = compute(&t, &a);
    let s = t0.elapsed().as_secs_f32();
    println!("6-minute track: analysis + features {s:.2} s (bpm {:.1}, energy {})", f.bpm, f.energy);
    assert!(s < 12.0, "took {s} s (about 1 s on an idle machine; the limit is loose so a busy PC does not make the test flaky)");
}
