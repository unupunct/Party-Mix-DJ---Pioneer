//! Loop slicer: one deck's position controller. A source region (a loop of N beats) is cut into `n` equal slices; pads trigger slices.
//!
//! While the slicer is on, the region plays as a loop (the "timeline", `ghost`). A triggered slice plays inside its own boundaries while the timeline keeps running silently,
//! so when a one-shot slice ends (or a held pad is released) playback rejoins the timeline exactly where the loop would have been: the groove never drifts.
//! Everything is measured in frames of the track, per sample, in the audio thread: no timers, no allocation. Every position jump is reported (`Some(old position)`)
//! so the deck can cross-fade it (a 2 ms blend of the old and the new read position): no clicks.
//!
//! Modes: 0 ONE-SHOT (the slice plays once, then the timeline resumes), 1 LOOP (the slice repeats while the pad is held), 2 HOLD (it repeats until another pad or a second press),
//! 3 QUANTIZED (a ONE-SHOT that waits for the next beat-grid line). `quant` > 0 delays any trigger to the next multiple of `quant` frames from `grid`. `repeat` > 0 re-triggers a
//! LOOP / HOLD slice every `repeat` frames (a rhythmic stutter). `rev` (bit per slice) plays that slice backwards.

#[derive(Clone, Debug)]
pub struct Slicer {
    pub on: bool,
    start: f64, end: f64, n: u32, mode: u8, quant: f64, repeat: f64, grid: f64, rev: u16,
    ghost: f64,
    cur: i32, cs: f64, ce: f64, back: bool, since: f64,
    pend: i32,
}

impl Default for Slicer { fn default() -> Self { Self::new() } }

impl Slicer {
    pub fn new() -> Self { Self { on: false, start: 0.0, end: 0.0, n: 8, mode: 0, quant: 0.0, repeat: 0.0, grid: 0.0, rev: 0, ghost: 0.0, cur: -1, cs: 0.0, ce: 0.0, back: false, since: 0.0, pend: -1 } }
    pub fn current(&self) -> i32 { self.cur }
    pub fn pending(&self) -> i32 { self.pend }
    pub fn slice_len(&self) -> f64 { (self.end - self.start) / self.n.max(1) as f64 }
    /// Start and end (frames) of slice `i`.
    pub fn bounds(&self, i: u32) -> (f64, f64) { let l = self.slice_len(); (self.start + i as f64 * l, self.start + (i + 1) as f64 * l) }

    #[allow(clippy::too_many_arguments)]
    pub fn configure(&mut self, on: bool, start: f64, end: f64, n: u32, mode: u8, quant: f64, repeat: f64, grid: f64, rev: u16, pos: &mut f64) -> Option<f64> {
        let valid = on && end > start + 64.0;
        self.start = start; self.end = end; self.n = n.clamp(1, 16); self.mode = mode.min(3); self.quant = quant.max(0.0); self.repeat = repeat.max(0.0); self.grid = grid; self.rev = rev;
        if !valid { return self.stop_all(pos); }
        let was_on = self.on; self.on = true;
        if self.cur >= self.n as i32 { self.cur = -1; self.pend = -1; }
        if self.cur >= 0 {   // keep the running slice but follow the (maybe changed) boundaries
            let (a, b) = self.bounds(self.cur as u32); self.cs = a; self.ce = b; self.back = self.rev >> self.cur & 1 == 1;
        }
        if !was_on || self.ghost < start || self.ghost >= end { self.ghost = pos.clamp(start, end - 1.0); }
        if self.cur < 0 && (*pos < start || *pos >= end) { let old = *pos; *pos = self.ghost.clamp(start, end - 1.0); return Some(old); }
        None
    }
    fn stop_all(&mut self, pos: &mut f64) -> Option<f64> {
        let had = self.on && self.cur >= 0; self.on = false; self.cur = -1; self.pend = -1;
        if had { let old = *pos; *pos = self.ghost; Some(old) } else { None }
    }
    /// Back to the timeline: the running slice (if any) and a pending trigger are dropped.
    pub fn stop(&mut self, pos: &mut f64) -> Option<f64> {
        self.pend = -1; if !self.on || self.cur < 0 { return None; }
        self.cur = -1; let old = *pos; *pos = self.ghost; Some(old)
    }
    fn begin(&mut self, idx: u32, pos: &mut f64) -> Option<f64> {
        let idx = idx.min(self.n - 1); let (a, b) = self.bounds(idx);
        self.cur = idx as i32; self.cs = a; self.ce = b; self.back = self.rev >> idx & 1 == 1; self.since = 0.0; self.pend = -1;
        let old = *pos; *pos = if self.back { b - 1.0 } else { a }; Some(old)
    }
    /// Pad pressed.
    pub fn press(&mut self, idx: u32, pos: &mut f64) -> Option<f64> {
        if !self.on || idx >= self.n { return None; }
        if self.mode == 2 && self.cur == idx as i32 { return self.stop(pos); }   // HOLD: a second press on the playing slice ends it
        if self.quant > 0.0 { self.pend = idx as i32; None } else { self.begin(idx, pos) }
    }
    /// Pad released: LOOP mode ends its slice (back to the timeline) and cancels a trigger that is still waiting for the grid.
    pub fn release(&mut self, idx: u32, pos: &mut f64) -> Option<f64> {
        if !self.on || self.mode != 1 { return None; }
        if self.pend == idx as i32 { self.pend = -1; }
        if self.cur == idx as i32 { return self.stop(pos); }
        None
    }
    fn restart(&mut self, pos: &mut f64) -> Option<f64> { let old = *pos; self.since = 0.0; *pos = if self.back { self.ce - 1.0 } else { self.cs }; Some(old) }

    /// Advance one sample. Replaces `pos += step` while the slicer is on. Returns the old position when the read position jumped.
    #[inline]
    pub fn step(&mut self, pos: &mut f64, step: f64) -> Option<f64> {
        if !self.on { *pos += step; return None; }
        let len = self.end - self.start; let mut jump = None;
        let prev_t;
        if self.cur < 0 {
            prev_t = *pos; *pos += step;
            if *pos >= self.end { jump = Some(*pos); *pos -= len; }
            if *pos < self.start { *pos = self.start; }
            self.ghost = *pos;
        } else {
            prev_t = self.ghost; self.ghost += step; if self.ghost >= self.end { self.ghost -= len; }
            let adv = step.abs(); self.since += adv;
            if self.back { *pos -= step; } else { *pos += step; }
            let repeating = (self.mode == 1 || self.mode == 2) && self.repeat > 0.0 && self.since >= self.repeat;
            let ended = if self.back { *pos <= self.cs } else { *pos >= self.ce };
            if repeating { jump = self.restart(pos); }
            else if ended {
                if self.mode == 1 || self.mode == 2 { jump = self.restart(pos); }
                else { self.cur = -1; let old = *pos; *pos = self.ghost; jump = Some(old); }   // one-shot done: rejoin the timeline
            }
        }
        if self.pend >= 0 && self.quant > 0.0 {
            let (a, b) = (((prev_t - self.grid) / self.quant).floor(), ((self.ghost - self.grid) / self.quant).floor());
            if a != b { let idx = self.pend as u32; let old = *pos; self.begin(idx, pos); if jump.is_none() { jump = Some(old); } }
        }
        jump
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn mk(n: u32, mode: u8, quant: f64, repeat: f64, rev: u16) -> (Slicer, f64) {
        let mut s = Slicer::new(); let mut pos = 1000.0;
        s.configure(true, 1000.0, 1000.0 + 8000.0, n, mode, quant, repeat, 1000.0, rev, &mut pos); (s, pos)
    }
    #[test]
    fn slice_boundaries_cover_the_region_exactly() {
        for n in [4u32, 8, 16] {
            let (s, _) = mk(n, 0, 0.0, 0.0, 0);
            assert!((s.bounds(0).0 - 1000.0).abs() < 1e-9); assert!((s.bounds(n - 1).1 - 9000.0).abs() < 1e-9);
            for i in 1..n { assert!((s.bounds(i).0 - s.bounds(i - 1).1).abs() < 1e-9); }
            assert!((s.slice_len() * n as f64 - 8000.0).abs() < 1e-9);
        }
    }
    #[test]
    fn the_timeline_loops_inside_the_region() {
        let (mut s, mut pos) = mk(8, 0, 0.0, 0.0, 0);
        for _ in 0..30000 { s.step(&mut pos, 1.0); assert!((1000.0..9000.0).contains(&pos)); }
    }
    #[test]
    fn a_pad_jumps_to_its_slice_and_plays_only_inside_it_then_rejoins_the_timeline() {
        let (mut s, mut pos) = mk(8, 0, 0.0, 0.0, 0);
        for _ in 0..2500 { s.step(&mut pos, 1.0); }               // timeline at 3500
        let t0 = pos; assert!(s.press(3, &mut pos).is_some()); assert_eq!(pos, 4000.0);      // slice 4 = 4000..5000
        let mut ghost = t0;
        let mut ended = false;
        for k in 0..1500 {
            let j = s.step(&mut pos, 1.0); ghost += 1.0; if ghost >= 9000.0 { ghost -= 8000.0; }
            if s.current() == 3 { assert!((4000.0..5000.0).contains(&pos), "left the slice at {k}: {pos}"); }
            else if j.is_some() { ended = true; assert!((pos - ghost).abs() < 1e-9, "must rejoin the timeline: {pos} vs {ghost}"); break; }
        }
        assert!(ended, "a one-shot slice must end after its length"); assert_eq!(s.current(), -1);
    }
    #[test]
    fn loop_mode_repeats_while_held_and_returns_on_release() {
        let (mut s, mut pos) = mk(8, 1, 0.0, 0.0, 0);
        s.press(1, &mut pos); let mut wraps = 0;
        for _ in 0..4000 { if s.step(&mut pos, 1.0).is_some() { wraps += 1; } assert!((2000.0..3000.0).contains(&pos)); }
        assert!(wraps >= 3, "repeated {wraps} times"); let ghost_before = pos;
        assert!(s.release(1, &mut pos).is_some()); assert_eq!(s.current(), -1); assert_ne!(pos, ghost_before);
    }
    #[test]
    fn hold_mode_keeps_repeating_until_another_pad_or_a_second_press() {
        let (mut s, mut pos) = mk(4, 2, 0.0, 0.0, 0);
        s.press(2, &mut pos); assert!(s.release(2, &mut pos).is_none());       // release does nothing in HOLD
        for _ in 0..5000 { s.step(&mut pos, 1.0); } assert_eq!(s.current(), 2);
        s.press(0, &mut pos); assert_eq!(s.current(), 0);
        assert!(s.press(0, &mut pos).is_some()); assert_eq!(s.current(), -1);
    }
    #[test]
    fn reverse_slice_plays_backwards_inside_its_boundaries() {
        let (mut s, mut pos) = mk(8, 1, 0.0, 0.0, 1 << 2);                       // slice 3 reversed: 3000..4000
        s.press(2, &mut pos); assert!(pos >= 3900.0 && pos < 4000.0);
        let mut last = pos; let mut backwards = 0;
        for _ in 0..800 { let j = s.step(&mut pos, 1.0); if j.is_none() { assert!(pos < last); backwards += 1; } last = pos; assert!((3000.0..4000.0).contains(&pos)); }
        assert!(backwards > 700);
        let (mut s2, mut p2) = mk(8, 1, 0.0, 0.0, 1 << 2); s2.press(1, &mut p2); s2.step(&mut p2, 1.0); assert!(p2 > 2000.0, "other slices still play forwards");
    }
    #[test]
    fn quantized_trigger_waits_for_the_next_grid_line() {
        let (mut s, mut pos) = mk(8, 0, 500.0, 0.0, 0);                          // grid lines every 500 frames from 1000
        for _ in 0..120 { s.step(&mut pos, 1.0); }                               // timeline at 1120
        assert!(s.press(5, &mut pos).is_none()); assert_eq!(s.pending(), 5); assert_eq!(s.current(), -1);
        let mut started_at = None;
        for k in 0..600 { s.step(&mut pos, 1.0); if s.current() == 5 { started_at = Some(k); break; } }
        let k = started_at.expect("must start"); assert!((375..=385).contains(&k), "started after {k} frames, expected about 380 (to the line at 1500)");
        assert_eq!(s.pending(), -1);
    }
    #[test]
    fn repeat_retriggers_the_slice_at_the_rhythmic_interval() {
        let (mut s, mut pos) = mk(4, 1, 0.0, 250.0, 0);                          // slice = 2000 frames, repeat every 250
        s.press(0, &mut pos); let mut jumps = 0;
        for _ in 0..2000 { if s.step(&mut pos, 1.0).is_some() { jumps += 1; } assert!(pos < 1250.0 + 1.0); }
        assert!((6..=8).contains(&jumps), "{jumps} retriggers in 2000 frames");
    }
    #[test]
    fn reset_and_off_return_to_the_timeline_and_the_position_never_leaves_the_region() {
        let (mut s, mut pos) = mk(16, 1, 0.0, 0.0, 0xAAAA); let mut seed = 17u32;
        for i in 0..60000 {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223); let r = (seed >> 16) as u32;
            if i % 700 == 0 { match r % 4 { 0 => { s.press(r % 16, &mut pos); } 1 => { s.release(r % 16, &mut pos); } 2 => { s.stop(&mut pos); } _ => {} } }
            s.step(&mut pos, 1.0); assert!((1000.0..9000.0).contains(&pos), "left the region: {pos}");
        }
        s.press(3, &mut pos); assert!(s.stop(&mut pos).is_some()); assert_eq!(s.current(), -1);
        s.press(3, &mut pos); s.configure(false, 1000.0, 9000.0, 16, 0, 0.0, 0.0, 1000.0, 0, &mut pos); assert!(!s.on); assert_eq!(s.current(), -1);
        let mut p = 5.0; assert!(s.step(&mut p, 1.0).is_none()); assert_eq!(p, 6.0);
    }
}
