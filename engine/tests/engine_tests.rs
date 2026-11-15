//! Offline tests of the real-time mixer (no audio device needed). Run: `cargo test --release`
use djengine::analysis::analyze;
use djengine::core::*;
use djengine::decode::decode_file;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::f32::consts::TAU;
use std::sync::Arc;

// ------------------------------------------------------------ allocation counter (per thread, only while armed)
struct Counting;
thread_local! { static ARMED: Cell<bool> = const { Cell::new(false) }; static ALLOCS: Cell<usize> = const { Cell::new(0) }; }
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 { ARMED.with(|a| if a.get() { ALLOCS.with(|n| n.set(n.get() + 1)) }); unsafe { System.alloc(l) } }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) { ARMED.with(|a| if a.get() { ALLOCS.with(|n| n.set(n.get() + 1)) }); unsafe { System.dealloc(p, l) } }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, s: usize) -> *mut u8 { ARMED.with(|a| if a.get() { ALLOCS.with(|n| n.set(n.get() + 1)) }); unsafe { System.realloc(p, l, s) } }
}
#[global_allocator]
static A: Counting = Counting;

// ------------------------------------------------------------ helpers
fn sine(sr: u32, secs: f32, freq: f32, amp: f32) -> Arc<Track> {
    let n = (sr as f32 * secs) as usize;
    let mut d = Vec::with_capacity(n * 2);
    for i in 0..n { let v = (TAU * freq * i as f32 / sr as f32).sin() * amp; d.push(v); d.push(v); }
    Arc::new(Track::new(d, sr))
}
struct Rig { m: Mixer, tx: rtrb::Producer<Command>, _g: rtrb::Consumer<Arc<Track>>, sh: Arc<Shared>, sr: u32 }
fn rig(sr: u32) -> Rig { let (m, tx, g, sh) = new_engine(sr); Rig { m, tx, _g: g, sh, sr } }
impl Rig {
    fn cmd(&mut self, c: Command) { self.tx.push(c).ok().expect("queue full"); }
    fn p(&mut self, id: ParamId, v: f32) { self.cmd(Command::Param(id, v)); }
    fn run(&mut self, frames: usize) -> (Vec<f32>, Vec<f32>) {
        let (mut m, mut c) = (vec![0f32; frames * 2], vec![0f32; frames * 2]);
        self.m.render(&mut m, &mut c, frames); (m, c)
    }
    fn settle(&mut self) { self.run(self.sr as usize / 2); }
    fn open_levels(&mut self, decks: &[u8]) { // unity everything, master 1
        self.p(ParamId::Master, 1.0); self.p(ParamId::Xf, 0.0);
        for &d in decks { self.p(ParamId::Vol(d), 1.0); self.p(ParamId::Trim(d), 1.0); }
        self.settle();
    }
}
fn rms(v: &[f32]) -> f32 { (v.iter().map(|x| x * x).sum::<f32>() / v.len().max(1) as f32).sqrt() }
fn peak(v: &[f32]) -> f32 { v.iter().fold(0f32, |a, x| a.max(x.abs())) }

// ------------------------------------------------------------ tests
#[test]
fn playback_is_sample_exact() {
    let mut r = rig(44100);
    let t = sine(44100, 3.0, 440.0, 0.5);
    r.cmd(Command::Load { deck: 0, track: t.clone() }); r.open_levels(&[0]);
    r.cmd(Command::Play(0));
    let (m, _) = r.run(20000);
    let mut worst = 0f32;
    for k in 6000..20000 { worst = worst.max((m[k * 2] - t.data[k * 2]).abs()); }
    assert!(worst < 1e-3, "output differs from source by {worst}");
}

#[test]
fn rate_scales_position() {
    let mut r = rig(44100);
    r.cmd(Command::Load { deck: 0, track: sine(44100, 10.0, 220.0, 0.3) }); r.open_levels(&[0]);
    r.cmd(Command::Rate { deck: 0, rate: 2.0 }); r.cmd(Command::Play(0)); r.run(44100);
    let pos = r.sh.deck_pos(0);
    assert!((pos - 2.0).abs() < 0.002, "pos {pos}");
}

#[test]
fn sample_rate_conversion_keeps_time() {
    let mut r = rig(44100);
    r.cmd(Command::Load { deck: 0, track: sine(48000, 10.0, 220.0, 0.3) }); r.open_levels(&[0]);
    r.cmd(Command::Play(0)); r.run(44100);
    let pos = r.sh.deck_pos(0);
    assert!((pos - 1.0).abs() < 0.001, "48k track played at 44.1k: pos {pos}");
}

#[test]
fn seek_then_play() {
    let mut r = rig(44100);
    r.cmd(Command::Load { deck: 0, track: sine(44100, 10.0, 220.0, 0.3) }); r.open_levels(&[0]);
    r.cmd(Command::Seek { deck: 0, pos: 1.5 }); r.cmd(Command::Play(0)); r.run(22050);
    let pos = r.sh.deck_pos(0);
    assert!((pos - 2.0).abs() < 2.0 / 44100.0, "pos {pos}");
}

#[test]
fn track_end_stops_deck() {
    let mut r = rig(44100);
    r.cmd(Command::Load { deck: 0, track: sine(44100, 0.5, 220.0, 0.3) }); r.open_levels(&[0]);
    r.cmd(Command::Play(0)); r.run(44100);
    assert!(!r.sh.decks[0].playing.load(std::sync::atomic::Ordering::Relaxed));
    assert!((r.sh.deck_pos(0) - 0.5).abs() < 1e-3);
}

#[test]
fn crossfader_assigns_sides() {
    // decks 0/2 = side A, 1/3 = side B
    let level = |deck: u8, xf: f32| {
        let mut r = rig(44100);
        r.cmd(Command::Load { deck, track: sine(44100, 5.0, 440.0, 0.4) }); r.open_levels(&[deck]);
        r.p(ParamId::Xf, xf); r.settle(); r.cmd(Command::Play(deck)); r.run(4000);
        rms(&r.run(20000).0)
    };
    let full = level(0, -1.0);
    assert!(full > 0.25);
    assert!(level(0, 0.0) > full * 0.98 && level(0, 1.0) < 1e-4, "deck A");
    assert!(level(1, 1.0) > full * 0.98 && level(1, -1.0) < 1e-4, "deck B");
    assert!(level(1, 0.0) > full * 0.98, "deck B centre");
}

#[test]
fn loop_wraps_inside_region() {
    let mut r = rig(44100);
    r.cmd(Command::Load { deck: 0, track: sine(44100, 5.0, 330.0, 0.3) }); r.open_levels(&[0]);
    r.cmd(Command::Loop { deck: 0, start: 1.0, end: 1.25, on: true }); r.cmd(Command::Seek { deck: 0, pos: 1.2 });
    r.cmd(Command::Play(0));
    for _ in 0..40 {
        r.run(2205);
        let p = r.sh.deck_pos(0);
        assert!(p >= 1.0 - 1e-6 && p < 1.25 + 0.001, "pos {p} left the loop");
    }
    r.cmd(Command::Loop { deck: 0, start: 1.0, end: 1.25, on: false }); r.run(22050);
    assert!(r.sh.deck_pos(0) > 1.5, "loop did not release");
}

#[test]
fn headphone_cue_routing() {
    let mut r = rig(44100);
    r.cmd(Command::Load { deck: 0, track: sine(44100, 5.0, 440.0, 0.4) }); r.open_levels(&[0]);
    r.p(ParamId::Vol(0), 0.0); r.p(ParamId::HeadMix, 0.0); r.p(ParamId::HeadGain, 1.0); r.p(ParamId::Pfl(0), 1.0); r.settle();
    r.cmd(Command::Play(0)); r.run(4000);
    let (m, c) = r.run(20000);
    assert!(peak(&m) < 1e-4, "PFL deck leaked into master: {}", peak(&m));
    assert!(peak(&c) > 0.3, "cue silent: {}", peak(&c));
    r.p(ParamId::Pfl(0), 0.0); r.settle();
    let (_, c2) = r.run(10000);
    assert!(peak(&c2) < 1e-3, "cue still audible without PFL");
    r.p(ParamId::HeadMix, 1.0); r.p(ParamId::Vol(0), 1.0); r.settle();
    let (_, c4) = r.run(10000);
    assert!(peak(&c4) < 1e-3, "with no CUE on the headphones must stay silent even with HEADPHONES MIX at master");
    r.p(ParamId::Pfl(0), 1.0); r.settle();
    let (m3, c3) = r.run(10000);
    assert!(peak(&c3) > 0.3 && (rms(&c3) / rms(&m3) - 1.0).abs() < 0.2, "master mix into cue");
}

#[test]
fn limiter_holds_ceiling_and_counts_clips() {
    let mut r = rig(44100);
    r.cmd(Command::Load { deck: 0, track: sine(44100, 5.0, 440.0, 3.0) }); r.open_levels(&[0]);
    r.cmd(Command::Play(0)); r.run(2000);
    let (m, _) = r.run(20000);
    assert!(peak(&m) <= 0.8915, "peak {}", peak(&m));
    assert!(r.sh.clips.load(std::sync::atomic::Ordering::Relaxed) > 0, "clip counter did not move");
}

#[test]
fn eq_cuts_bass() {
    let level = |db: f32| {
        let mut r = rig(44100);
        r.cmd(Command::Load { deck: 0, track: sine(44100, 5.0, 100.0, 0.4) }); r.open_levels(&[0]);
        r.p(ParamId::Low(0), db); r.settle(); r.cmd(Command::Play(0)); r.run(8000);
        rms(&r.run(20000).0)
    };
    let (flat, cut, boost) = (level(0.0), level(-26.0), level(10.0));
    assert!(20.0 * (flat / cut).log10() > 15.0, "cut only {} dB", 20.0 * (flat / cut).log10());
    assert!(boost > flat * 1.5, "boost");
}

#[test]
fn parameter_storm_never_produces_nan() {
    let mut r = rig(44100);
    for d in 0..4u8 { r.cmd(Command::Load { deck: d, track: sine(44100, 20.0, 100.0 * (d + 1) as f32, 0.5) }); r.cmd(Command::Play(d)); }
    r.settle();
    let mut seed = 12345u32; let mut rnd = || { seed = seed.wrapping_mul(1664525).wrapping_add(1013904223); (seed >> 8) as f32 / 16777216.0 };
    for _ in 0..400 {
        let d = (rnd() * 4.0) as u8 % 4;
        let id = match (rnd() * 9.0) as u32 { 8 => ParamId::Filter, 0 => ParamId::Vol(d), 1 => ParamId::Trim(d), 2 => ParamId::Low(d), 3 => ParamId::High(d), 4 => ParamId::Xf, 5 => ParamId::HeadMix, 6 => ParamId::Pfl(d), _ => ParamId::Master };
        let v = match id { ParamId::Low(_) | ParamId::High(_) => rnd() * 38.0 - 26.0, ParamId::Xf => rnd() * 2.0 - 1.0, _ => rnd() * 1.5 };
        if r.tx.push(Command::Param(id, v)).is_err() { r.run(512); }
        if rnd() < 0.2 { r.cmd(Command::Seek { deck: d, pos: rnd() as f64 * 15.0 }); }
        if rnd() < 0.1 { r.cmd(Command::Rate { deck: d, rate: 0.5 + rnd() * 1.5 }); }
        let (m, c) = r.run(300 + (rnd() * 400.0) as usize);
        assert!(m.iter().chain(c.iter()).all(|x| x.is_finite() && x.abs() <= 1.0), "bad sample");
    }
}

#[test]
fn render_path_does_not_allocate() {
    let mut r = rig(48000);
    let (a, b) = (sine(44100, 30.0, 220.0, 0.5), sine(48000, 30.0, 330.0, 0.5));
    // everything that allocates (tracks, queues, buffers) happens before arming
    let mut m = vec![0f32; 1024 * 2]; let mut c = vec![0f32; 1024 * 2];
    r.cmd(Command::Load { deck: 0, track: a }); r.cmd(Command::Load { deck: 1, track: b });
    r.m.render(&mut m, &mut c, 1024);
    ALLOCS.with(|n| n.set(0)); ARMED.with(|x| x.set(true));
    r.cmd(Command::Play(0)); r.cmd(Command::Play(1));
    for i in 0..2000 {
        r.cmd(Command::Param(ParamId::Low(0), (i % 20) as f32 - 10.0));
        r.cmd(Command::Param(ParamId::Xf, ((i % 200) as f32 / 100.0) - 1.0));
        if i % 50 == 0 { r.cmd(Command::Seek { deck: 1, pos: (i % 25) as f64 }); r.cmd(Command::Loop { deck: 0, start: 1.0, end: 1.5, on: i % 100 == 0 }); }
        r.m.render(&mut m, &mut c, 1024);
    }
    ARMED.with(|x| x.set(false));
    let n = ALLOCS.with(|n| n.get());
    assert_eq!(n, 0, "render path performed {n} allocations/deallocations");
}

#[test]
fn track_swap_returns_old_track_via_garbage_queue() {
    let mut r = rig(44100);
    r.cmd(Command::Load { deck: 0, track: sine(44100, 1.0, 220.0, 0.3) });
    r.run(256);
    r.cmd(Command::Load { deck: 0, track: sine(44100, 1.0, 330.0, 0.3) });
    r.run(256);
    assert!(r._g.pop().is_ok(), "old track must be handed back, not freed on the audio thread");
}

#[test]
fn realtime_headroom_four_decks() {
    let mut r = rig(44100);
    for d in 0..4u8 { r.cmd(Command::Load { deck: d, track: sine(44100, 70.0, 110.0 * (d + 1) as f32, 0.2) }); r.p(ParamId::Vol(d), 1.0); r.p(ParamId::Pfl(d), 1.0); r.cmd(Command::Play(d)); r.p(ParamId::Low(d), -6.0); r.p(ParamId::High(d), 3.0); }
    let frames = 44100 * 60;
    let (mut m, mut c) = (vec![0f32; 512 * 2], vec![0f32; 512 * 2]);
    let t0 = std::time::Instant::now();
    for _ in 0..(frames / 512) { r.m.render(&mut m, &mut c, 512); }
    let used = t0.elapsed().as_secs_f64() / 60.0;
    println!("4 decks + EQ + cue: {:.2} % of real time", used * 100.0);
    assert!(used < 0.10, "uses {:.1} % of real time (debug build? run with --release)", used * 100.0);
}

fn click_track(sr: u32, secs: f32, bpm: f32, offset: f32) -> Track {
    let n = (sr as f32 * secs) as usize; let beat = 60.0 / bpm;
    let mut d = vec![0f32; n * 2]; let mut seed = 1u32;
    for i in 0..n {
        let t = i as f32 / sr as f32 - offset; if t < 0.0 { continue; }
        let bt = t % beat; let bi = (t / beat) as u32;
        let mut x = (TAU * (55.0 + 90.0 * (-bt * 30.0).exp()) * bt).sin() * (-bt * 9.0).exp() * 0.9;
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let noise = (seed >> 8) as f32 / 16777216.0 - 0.5;
        if bi % 2 == 1 { x += noise * (-bt * 18.0).exp() * 0.5; }
        d[i * 2] = x * 0.8; d[i * 2 + 1] = x * 0.8;
    }
    Track::new(d, sr)
}

#[test]
fn tempo_and_grid_detection() {
    for (bpm, off) in [(120.0f32, 0.25f32), (128.0, 0.1), (98.0, 0.3), (140.0, 0.2)] {
        let a = analyze(&click_track(44100, 60.0, bpm, off));
        assert!((a.bpm - bpm).abs() < 0.6, "expected {bpm}, got {}", a.bpm);
        let per = 60.0 / bpm; let phase = ((a.grid - off) % per + per) % per; let phase = phase.min(per - phase);
        assert!(phase < 0.03, "grid off by {phase}s at {bpm} BPM");
        assert_eq!(a.col.len(), a.n * 3);
    }
}

fn write_wav(path: &std::path::Path, sr: u32, ch: u16, frames: usize, f: impl Fn(usize, u16) -> f32) {
    let mut d = Vec::new();
    for i in 0..frames { for c in 0..ch { d.extend_from_slice(&((f(i, c) * 32767.0) as i16).to_le_bytes()); } }
    let mut b = Vec::new();
    b.extend_from_slice(b"RIFF"); b.extend_from_slice(&(36 + d.len() as u32).to_le_bytes()); b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes()); b.extend_from_slice(&1u16.to_le_bytes()); b.extend_from_slice(&ch.to_le_bytes());
    b.extend_from_slice(&sr.to_le_bytes()); b.extend_from_slice(&(sr * ch as u32 * 2).to_le_bytes()); b.extend_from_slice(&(ch * 2).to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes()); b.extend_from_slice(b"data"); b.extend_from_slice(&(d.len() as u32).to_le_bytes()); b.extend_from_slice(&d);
    std::fs::write(path, b).unwrap();
}

#[test]
fn decode_wav_stereo_and_mono_and_errors() {
    let dir = std::env::temp_dir().join(format!("djengine-test-{}", std::process::id())); std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("st.wav"); write_wav(&p, 48000, 2, 4800, |i, c| ((i as f32 * 0.05) + c as f32).sin() * 0.5);
    let t = decode_file(p.to_str().unwrap()).unwrap();
    assert_eq!((t.sample_rate, t.frames), (48000, 4800));
    assert!((t.data[200 * 2] - ((200.0f32 * 0.05).sin() * 0.5)).abs() < 1e-3 && (t.data[200 * 2 + 1] - ((200.0f32 * 0.05 + 1.0).sin() * 0.5)).abs() < 1e-3);
    let p2 = dir.join("mono.wav"); write_wav(&p2, 22050, 1, 2205, |i, _| (i as f32 * 0.1).sin() * 0.4);
    let t2 = decode_file(p2.to_str().unwrap()).unwrap();
    assert_eq!((t2.sample_rate, t2.frames), (22050, 2205)); assert_eq!(t2.data[100 * 2], t2.data[100 * 2 + 1]);
    assert!(decode_file(dir.join("missing.wav").to_str().unwrap()).is_err());
    let junk = dir.join("junk.mp3"); std::fs::write(&junk, vec![0x42u8; 5000]).unwrap();
    assert!(decode_file(junk.to_str().unwrap()).is_err(), "garbage must fail cleanly, not panic");
    let trunc = dir.join("trunc.wav"); let mut bytes = std::fs::read(&p).unwrap(); bytes.truncate(2000); std::fs::write(&trunc, bytes).unwrap();
    let _ = decode_file(trunc.to_str().unwrap()); // must not panic; partial audio is acceptable
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_beep_goes_to_the_chosen_output_only() {
    let mut r = rig(44100);
    r.settle();
    r.cmd(Command::Beep(1));
    let (m, c) = r.run(20000);
    assert!(peak(&m) < 1e-4 && peak(&c) > 0.2, "cue beep leaked: master {} cue {}", peak(&m), peak(&c));
    r.run(30000);
    r.cmd(Command::Beep(0));
    let (m, c) = r.run(20000);
    assert!(peak(&c) < 1e-4 && peak(&m) > 0.2, "master beep leaked: master {} cue {}", peak(&m), peak(&c));
    r.run(15000); // let the rest of the 0.7 s beep play out
    let (m2, c2) = r.run(10000);
    assert!(peak(&m2) < 1e-4 && peak(&c2) < 1e-4, "beep did not end");
}

// ------------------------------------------------------------ master DJ filter
fn filtered_rms(deck: u8, freq: f32, filter: f32, vol: f32, trim: f32, xf: f32) -> f32 {
    let mut r = rig(44100);
    r.cmd(Command::Load { deck, track: sine(44100, 6.0, freq, 0.4) }); r.open_levels(&[deck]);
    r.p(ParamId::Vol(deck), vol); r.p(ParamId::Trim(deck), trim); r.p(ParamId::Xf, xf); r.p(ParamId::Filter, filter); r.settle();
    r.cmd(Command::Play(deck)); r.run(6000);
    rms(&r.run(20000).0)
}
fn db(a: f32, b: f32) -> f32 { 20.0 * (a / b.max(1e-9)).log10() }

#[test]
fn filter_centre_is_transparent() {
    let off = filtered_rms(0, 1000.0, 0.0, 1.0, 1.0, 0.0);
    let dz = filtered_rms(0, 1000.0, 0.03, 1.0, 1.0, 0.0);
    assert!((off - dz).abs() < 1e-4, "{off} vs {dz}");
}

#[test]
fn filter_left_is_low_pass_right_is_high_pass() {
    let hi_clean = filtered_rms(0, 6000.0, 0.0, 1.0, 1.0, 0.0);
    let hi_lp = filtered_rms(0, 6000.0, -1.0, 1.0, 1.0, 0.0);
    assert!(db(hi_lp, hi_clean) < -30.0, "low-pass should cut 6 kHz: {} dB", db(hi_lp, hi_clean));
    let lo_clean = filtered_rms(0, 80.0, 0.0, 1.0, 1.0, 0.0);
    let lo_hp = filtered_rms(0, 80.0, 1.0, 1.0, 1.0, 0.0);
    assert!(db(lo_hp, lo_clean) < -30.0, "high-pass should cut 80 Hz: {} dB", db(lo_hp, lo_clean));
    // the pass band stays: a low-pass leaves bass alone, a high-pass leaves treble alone
    let bass40 = filtered_rms(0, 40.0, 0.0, 1.0, 1.0, 0.0);
    assert!(db(filtered_rms(0, 40.0, -1.0, 1.0, 1.0, 0.0), bass40) > -3.0, "low-pass changed the bass");
    let treble15 = filtered_rms(0, 15000.0, 0.0, 1.0, 1.0, 0.0);
    assert!(db(filtered_rms(0, 15000.0, 1.0, 1.0, 1.0, 0.0), treble15) > -3.0, "high-pass changed the treble");
}

#[test]
fn filter_sweeps_smoothly_and_monotonically() {
    let base = filtered_rms(0, 2000.0, 0.0, 1.0, 1.0, 0.0);
    let mut last = f32::MAX;
    for k in 0..=10 {
        let v = -(k as f32) / 10.0;
        let l = filtered_rms(0, 2000.0, v, 1.0, 1.0, 0.0) / base;
        assert!(l <= last + 0.02, "low-pass not monotonic at {v}: {l} > {last}");
        last = l;
    }
    assert!(last < 0.05, "full low-pass should remove 2 kHz, left {last}");
}

#[test]
fn filter_works_on_any_channel_and_any_volume_setting() {
    for &(deck, vol, trim, xf) in &[(0u8, 1.0f32, 1.0f32, 0.0f32), (1, 0.3, 0.5, 0.0), (2, 0.6, 1.5, -1.0), (3, 0.8, 0.7, 1.0), (1, 1.0, 1.0, 1.0)] {
        let clean = filtered_rms(deck, 6000.0, 0.0, vol, trim, xf);
        let cut = filtered_rms(deck, 6000.0, -1.0, vol, trim, xf);
        assert!(clean > 1e-3, "deck {deck} silent");
        assert!(db(cut, clean) < -30.0, "deck {deck} vol {vol} trim {trim} xf {xf}: only {} dB", db(cut, clean));
    }
}

// ------------------------------------------------------------ EQ behaviour (what the knobs really do)
fn eq_gain_db(freq: f32, low: f32, mid: f32, high: f32) -> f32 {
    let mut r = rig(44100);
    r.cmd(Command::Load { deck: 0, track: sine(44100, 6.0, freq, 0.2) }); r.open_levels(&[0]);
    r.p(ParamId::Low(0), low); r.p(ParamId::Mid(0), mid); r.p(ParamId::High(0), high); r.settle();
    r.cmd(Command::Play(0)); r.run(6000);
    let out = rms(&r.run(20000).0);
    db(out, 0.2 * std::f32::consts::FRAC_1_SQRT_2)
}

#[test]
fn eq_knobs_cut_and_boost_only_their_own_band() {
    // treble: highs only
    assert!(eq_gain_db(100.0, 0.0, 0.0, -26.0).abs() < 0.5, "treble cut touched the bass");
    assert!(eq_gain_db(10000.0, 0.0, 0.0, -26.0) < -20.0, "treble cut did not cut the highs");
    assert!(eq_gain_db(10000.0, 0.0, 0.0, 12.0) > 10.0, "treble boost did not boost the highs");
    assert!(eq_gain_db(100.0, 0.0, 0.0, 12.0).abs() < 0.5, "treble boost touched the bass");
    // bass: lows only
    assert!(eq_gain_db(10000.0, -26.0, 0.0, 0.0).abs() < 0.5, "bass cut touched the highs");
    assert!(eq_gain_db(60.0, -26.0, 0.0, 0.0) < -20.0, "bass cut did not cut the lows");
    assert!(eq_gain_db(60.0, 12.0, 0.0, 0.0) > 10.0, "bass boost did not boost the lows");
}

#[test]
fn brake_slows_the_deck_to_a_stop_instead_of_cutting_it() {
    let mut r = rig(44100);
    r.open_levels(&[0]);
    r.cmd(Command::Load { deck: 0, track: sine(44100, 20.0, 220.0, 0.5) });
    r.cmd(Command::Play(0)); r.settle();
    let pos = |r: &Rig| f64::from_bits(r.sh.decks[0].pos_bits.load(std::sync::atomic::Ordering::Relaxed));
    let p0 = pos(&r);
    r.cmd(Command::Brake(0));
    r.run(22050);                                        // 0.5 s into the brake: still sounding and still moving, but slower than normal speed
    let (p1, playing_mid) = (pos(&r), r.sh.decks[0].playing.load(std::sync::atomic::Ordering::Relaxed));
    assert!(playing_mid, "still playing half-way through the brake");
    assert!(p1 - p0 > 0.05 && p1 - p0 < 0.5, "moved {} s in 0.5 s of braking", p1 - p0);
    r.run(44100);                                        // well past the brake time
    assert!(!r.sh.decks[0].playing.load(std::sync::atomic::Ordering::Relaxed), "stopped after the brake");
    let p2 = pos(&r); r.run(11025);
    assert!((pos(&r) - p2).abs() < 1e-6, "no movement once stopped");
    assert!(p2 - p0 < 0.6, "the brake stops within about 0.3 s of extra travel, got {}", p2 - p0);
}

// ------------------------------------------------------------ loop slicer on the real mixer
fn ramp(sr: u32, secs: f32) -> Arc<Track> {   // the sample value is the position: value = t / 40 (so the output tells where the deck is reading)
    let n = (sr as f32 * secs) as usize; let mut d = Vec::with_capacity(n * 2);
    for i in 0..n { let v = i as f32 / sr as f32 / 40.0; d.push(v); d.push(v); }
    Arc::new(Track::new(d, sr))
}
fn at_time(block: &[f32], i: usize) -> f64 { block[i * 2] as f64 * 40.0 }

#[test]
fn slicer_plays_the_chosen_slice_sample_accurately_inside_its_boundaries_and_rejoins_the_timeline() {
    let mut r = rig(44100); r.open_levels(&[0]);
    r.cmd(Command::Load { deck: 0, track: ramp(44100, 20.0) });
    r.cmd(Command::Seek { deck: 0, pos: 2.0 }); r.cmd(Command::Play(0)); r.settle();
    r.cmd(Command::SliceCfg { deck: 0, on: true, start: 2.0, end: 6.0, n: 8, mode: 0, quant: 0.0, repeat: 0.0, grid: 2.0, rev: 0 });
    r.run(2000);
    r.cmd(Command::SlicePad { deck: 0, idx: 5, down: true });    // slice 6 = 4.5 .. 5.0 s
    let (blk, _) = r.run(22050 + 4000);                            // longer than the slice (0.5 s)
    // 2 ms cross-fade after the jump, then exactly the slice: the output is the ramp of 4.5 s + elapsed time
    for k in [400usize, 5000, 12000, 20000] { let want = 4.5 + k as f64 / 44100.0; assert!((at_time(&blk, k) - want).abs() < 0.002, "frame {k}: read {} s, expected {want} s", at_time(&blk, k)); }
    for k in 300..21000 { let t = at_time(&blk, k); assert!((4.49..5.01).contains(&t), "left the slice at frame {k}: {t}"); }
    // one-shot finished: it plays on in the region (timeline), never outside 2..6 s
    let (blk2, _) = r.run(44100 * 3);
    for k in 200..blk2.len() / 2 { let t = at_time(&blk2, k); assert!((1.99..6.01).contains(&t), "timeline left the region at {k}: {t}"); }
    assert_eq!(r.sh.decks[0].slice_cur.load(std::sync::atomic::Ordering::Relaxed), -1);
}

#[test]
fn slicer_reverse_slice_runs_backwards_and_the_deck_survives_commands_while_looping() {
    let mut r = rig(44100); r.open_levels(&[0]);
    r.cmd(Command::Load { deck: 0, track: ramp(44100, 20.0) });
    r.cmd(Command::Seek { deck: 0, pos: 2.0 }); r.cmd(Command::Play(0)); r.settle();
    r.cmd(Command::SliceCfg { deck: 0, on: true, start: 2.0, end: 6.0, n: 8, mode: 1, quant: 0.0, repeat: 0.0, grid: 2.0, rev: 1 << 2 });
    r.run(1000);
    r.cmd(Command::SlicePad { deck: 0, idx: 2, down: true });    // slice 3 = 3.0 .. 3.5 s, reversed
    let (blk, _) = r.run(8000);
    let (a, b) = (at_time(&blk, 1000), at_time(&blk, 3000)); assert!(b < a - 0.03, "must run backwards: {a} -> {b}");
    for k in 300..8000 { let t = at_time(&blk, k); assert!((2.99..3.51).contains(&t), "reverse slice left its boundaries at {k}: {t}"); }
    r.cmd(Command::SlicePad { deck: 0, idx: 2, down: false });   // LOOP mode: release returns to the timeline
    let (blk, _) = r.run(6000); assert_eq!(r.sh.decks[0].slice_cur.load(std::sync::atomic::Ordering::Relaxed), -1);
    for k in 200..6000 { let t = at_time(&blk, k); assert!((1.99..6.01).contains(&t)); }
}

#[test]
fn xy_pad_on_the_master_bus_works_next_to_the_slicer_and_releases_to_the_exact_dry_signal() {
    let mut r = rig(44100); r.open_levels(&[0]);
    r.cmd(Command::Load { deck: 0, track: sine(44100, 20.0, 220.0, 0.4) }); r.cmd(Command::Play(0)); r.settle();
    r.cmd(Command::SliceCfg { deck: 0, on: true, start: 1.0, end: 5.0, n: 8, mode: 2, quant: 0.0, repeat: 0.0, grid: 1.0, rev: 0 });
    r.cmd(Command::SlicePad { deck: 0, idx: 1, down: true });
    let (dry, _) = r.run(8000);
    r.cmd(Command::Xy { var: [0; 4], act: 1.0, w: [1.0, 0.0, 0.0, 0.0], p: [200.0, 0.2, 0.2, 0.3, 0.5, 0.3, 1.0, 0.5] });
    let (fx, _) = r.run(22050);
    let rms = |v: &[f32]| (v.iter().map(|x| x * x).sum::<f32>() / v.len() as f32).sqrt();
    assert!(rms(&fx[2000..]) > 0.05 && rms(&fx[2000..]) < 0.8, "fx audio present and not louder: {} vs dry {}", rms(&fx[2000..]), rms(&dry));
    r.cmd(Command::Xy { var: [0; 4], act: 0.0, w: [0.0; 4], p: [200.0, 0.2, 0.2, 0.3, 0.5, 0.3, 1.0, 0.5] });
    r.run(1000);
    assert_eq!(r.sh.decks[0].slice_cur.load(std::sync::atomic::Ordering::Relaxed), 1, "the slicer keeps playing while the XY pad is used and released");
    let (after, _) = r.run(4000); assert!(rms(&after) > 0.05 && after.iter().all(|x| x.is_finite() && x.abs() <= 1.0));
}

fn freq_of(left: &[f32], sr: u32) -> f32 {   // zero-crossing frequency of the (mono) left channel
    let mut z = 0; for w in left.windows(2) { if w[0] <= 0.0 && w[1] > 0.0 { z += 1; } }
    z as f32 / (left.len() as f32 / sr as f32)
}
#[test]
fn key_lock_keeps_the_pitch_when_the_tempo_changes() {
    let sr = 44100;
    let measure = |kl: bool| {
        let mut r = rig(sr);
        r.cmd(Command::Load { deck: 0, track: sine(sr, 20.0, 440.0, 0.4) }); r.open_levels(&[0]);
        r.cmd(Command::Rate { deck: 0, rate: 1.08 }); r.cmd(Command::KeyLock { deck: 0, on: kl }); r.p(ParamId::Vol(0), 1.0); r.settle();
        r.cmd(Command::Play(0)); r.run(30000);
        let (m, _) = r.run(44100); let left: Vec<f32> = m.iter().step_by(2).copied().collect();
        freq_of(&left, sr)
    };
    let (plain, locked) = (measure(false), measure(true));
    assert!((plain - 440.0 * 1.08).abs() < 8.0, "without key lock the pitch follows the tempo: {plain}");
    assert!((locked - 440.0).abs() < 12.0, "with key lock the pitch stays: {locked}");
}
