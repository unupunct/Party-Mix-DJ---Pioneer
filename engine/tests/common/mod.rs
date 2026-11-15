#![allow(dead_code)]
//! Shared helpers for the integration tests: synthetic audio files.
use std::f32::consts::TAU;
use std::path::{Path, PathBuf};

pub struct Rng(pub u32);
impl Rng {
    pub fn next(&mut self) -> f32 { self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223); (self.0 >> 8) as f32 / 16777216.0 }
}

pub fn temp_dir(tag: &str) -> PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    let d = std::env::temp_dir().join(format!("djengine-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&d).unwrap();
    d
}

pub fn write_wav(path: &Path, sr: u32, mono: &[f32]) {
    let mut d = Vec::with_capacity(mono.len() * 4);
    for &v in mono { let s = (v.clamp(-1.0, 1.0) * 32767.0) as i16; d.extend_from_slice(&s.to_le_bytes()); d.extend_from_slice(&s.to_le_bytes()); }
    let mut b = Vec::new();
    b.extend_from_slice(b"RIFF"); b.extend_from_slice(&(36 + d.len() as u32).to_le_bytes()); b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes()); b.extend_from_slice(&1u16.to_le_bytes()); b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&sr.to_le_bytes()); b.extend_from_slice(&(sr * 4).to_le_bytes()); b.extend_from_slice(&4u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes()); b.extend_from_slice(b"data"); b.extend_from_slice(&(d.len() as u32).to_le_bytes()); b.extend_from_slice(&d);
    std::fs::write(path, b).unwrap();
}

/// Kick drum every beat at `bpm`.
pub fn click(sr: u32, secs: f32, bpm: f32, offset: f32, amp: f32) -> Vec<f32> {
    let n = (sr as f32 * secs) as usize;
    let beat = 60.0 / bpm;
    let mut m = vec![0f32; n];
    for k in 0..(((secs - offset) / beat) as usize) {
        let s0 = ((offset + k as f32 * beat) * sr as f32) as usize;
        for i in 0..(0.25 * sr as f32) as usize {
            let idx = s0 + i;
            if idx >= n { break; }
            let t = i as f32 / sr as f32;
            m[idx] += (TAU * (55.0 + 90.0 * (-t * 30.0).exp()) * t).sin() * (-t * 9.0).exp() * amp;
        }
    }
    m
}

fn add_note(buf: &mut [f32], sr: u32, midi: f32, start: f32, len: f32, amp: f32) {
    let f = 440.0 * 2f32.powf((midi - 69.0) / 12.0);
    let (s0, n) = ((start * sr as f32) as usize, (len * sr as f32) as usize);
    for i in 0..n {
        let idx = s0 + i;
        if idx >= buf.len() { break; }
        let t = i as f32 / sr as f32;
        let env = (-t * 2.5).exp() * (1.0 - (-t * 200.0).exp());
        let mut v = 0f32;
        for h in 1..=4 { v += (TAU * f * h as f32 * t).sin() / h as f32; }
        buf[idx] += v * env * amp;
    }
}

/// Simple tonal music in a known key (chords + bass + scale melody) plus a kick at `bpm`.
pub fn tonal_with_beat(sr: u32, secs: f32, tonic: u8, minor: bool, bpm: f32, seed: u32) -> Vec<f32> {
    let mut rng = Rng(seed);
    let mut m = vec![0f32; (sr as f32 * secs) as usize];
    let scale: [i32; 7] = if minor { [0, 2, 3, 5, 7, 8, 10] } else { [0, 2, 4, 5, 7, 9, 11] };
    let roots = [0, 5, 7, 0];
    let base = 60.0 + tonic as f32;
    let (mut t, mut ci) = (0f32, 0);
    while t < secs {
        let r = roots[ci % 4] as f32;
        let third = if minor && roots[ci % 4] != 7 { 3.0 } else { 4.0 };
        for off in [0.0, third, 7.0] { add_note(&mut m, sr, base + r + off - 12.0, t, 2.0, 0.12); }
        add_note(&mut m, sr, base + r - 24.0, t, 2.0, 0.25);
        let mut mt = t;
        while mt < t + 2.0 {
            let deg = scale[(rng.next() * 7.0) as usize % 7];
            add_note(&mut m, sr, base + deg as f32, mt, 0.4, 0.18);
            mt += 0.25;
        }
        t += 2.0;
        ci += 1;
    }
    let k = click(sr, secs, bpm, 0.1, 0.6);
    for (a, b) in m.iter_mut().zip(k) { *a += b; }
    let mx = m.iter().fold(0f32, |a, x| a.max(x.abs())).max(1e-6);
    for v in m.iter_mut() { *v = *v / mx * 0.7; }
    m
}

pub fn file_digest(p: &Path) -> (u64, std::time::SystemTime) {
    let b = std::fs::read(p).unwrap();
    let mut h: u64 = 0xcbf29ce484222325;
    for x in b { h ^= x as u64; h = h.wrapping_mul(0x100000001b3); }
    (h, std::fs::metadata(p).unwrap().modified().unwrap())
}
