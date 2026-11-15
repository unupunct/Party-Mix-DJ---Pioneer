//! Intelligent track matching (H3): harmonic compatibility, tempo compatibility and a configurable weighted score.
//!
//! Design rules:
//! * Every sub-score is a number in 0..1 with a short human-readable explanation, so a DJ can see *why* a track ranks where it does.
//! * Uncertain inputs (low key / tempo / mood / vocal confidence) are not trusted: their sub-score keeps its honest value but counts
//!   with a reduced weight (`reliability`), so shaky estimates neither reward nor punish a track as much as solid ones.
//! * Tempo is never judged by closeness alone: the pitch change needed, the pitch limit, half/double-time and the effect of that
//!   pitch change on the key (when key-lock is off) are all part of the result.
//! * Pure functions, no I/O: testable on synthetic profiles and fast enough for libraries of tens of thousands of tracks.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default)]
pub struct Profile {
    pub id: i64,
    pub path: String,
    pub artist: Option<String>,
    pub title: Option<String>,
    pub camelot: Option<(u8, bool)>, // (1..12, minor = 'A')
    pub key_conf: f32,
    pub bpm: f32,
    pub bpm_conf: f32,
    pub energy: u8,
    pub danceability: f32,
    pub genre: Option<String>,
    pub mood: Option<String>,
    pub mood_conf: f32,
    pub onset_density: f32,
    pub beat_strength: f32,
    pub tempo_stability: f32,
    pub time_sig: u8,
    pub low: f32,
    pub mid: f32,
    pub high: f32,
    pub centroid: f32,
    pub vocal: f32,
    pub vocal_conf: f32,
}

pub fn parse_camelot(s: &str) -> Option<(u8, bool)> {
    let s = s.trim();
    let letter = s.chars().last()?.to_ascii_uppercase();
    let n: u8 = s[..s.len() - 1].parse().ok()?;
    if !(1..=12).contains(&n) || (letter != 'A' && letter != 'B') { return None; }
    Some((n, letter == 'A'))
}
pub fn camelot_str(k: (u8, bool)) -> String { format!("{}{}", k.0, if k.1 { 'A' } else { 'B' }) }

/// Tonic pitch class (C = 0) of a Camelot key.
pub fn tonic_pc(k: (u8, bool)) -> u8 {
    let pos = (k.0 as i32 - 1 + 12 - 7) % 12;         // circle-of-fifths position, C major = 0
    let major = (pos * 7) % 12;
    (if k.1 { major + 9 } else { major }) as u8 % 12
}
fn scale_mask(k: (u8, bool)) -> u16 {
    let t = tonic_pc(k) as u16;
    let steps: [u16; 7] = if k.1 { [0, 2, 3, 5, 7, 8, 10] } else { [0, 2, 4, 5, 7, 9, 11] }; // natural minor / major
    steps.iter().fold(0u16, |m, s| m | (1 << ((t + s) % 12)))
}
/// Number of diatonic pitch classes two keys share (0..=7).
pub fn scale_overlap(a: (u8, bool), b: (u8, bool)) -> u32 { (scale_mask(a) & scale_mask(b)).count_ones() }
/// Transpose a Camelot key by `semitones` (one semitone = 7 steps round the wheel).
pub fn transpose(k: (u8, bool), semitones: i32) -> (u8, bool) { ((((k.0 as i32 - 1) + 7 * semitones).rem_euclid(12) + 1) as u8, k.1) }

pub fn label(score01: f32) -> &'static str {
    if score01 >= 0.90 { "Excellent" } else if score01 >= 0.75 { "Very Good" } else if score01 >= 0.55 { "Compatible" } else if score01 >= 0.30 { "Experimental" } else { "Not Recommended" }
}

// ---------------------------------------------------------------- settings
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Weights { pub harmonic: f32, pub bpm: f32, pub energy: f32, pub rhythm: f32, pub genre: f32, pub mood: f32, pub danceability: f32, pub spectral: f32, pub vocal: f32 }
impl Default for Weights {
    fn default() -> Self { Self { harmonic: 20.0, bpm: 15.0, energy: 15.0, rhythm: 15.0, genre: 10.0, mood: 10.0, danceability: 5.0, spectral: 5.0, vocal: 5.0 } }
}
impl Weights {
    fn all(&self) -> [f32; 9] { [self.harmonic, self.bpm, self.energy, self.rhythm, self.genre, self.mood, self.danceability, self.spectral, self.vocal] }
    pub fn validate(&self) -> Result<(), String> {
        if self.all().iter().any(|w| !w.is_finite() || *w < 0.0) { return Err("weights must be finite and not negative".into()); }
        if self.all().iter().sum::<f32>() <= 0.0 { return Err("at least one weight must be above zero".into()); }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub weights: Weights,
    /// largest tempo change (percent) the DJ is willing to apply to a track
    pub pitch_limit: f32,
    /// with key-lock the key does not move when tempo changes; without it a tempo change also transposes the track
    pub keylock: bool,
    /// down-weight pairs that cannot be tempo-matched or clash harmonically (shown in the notes)
    pub gates: bool,
    /// tempo change (percent) currently applied to the source (e.g. its pitch fader)
    pub source_pitch: f32,
}
impl Default for Settings { fn default() -> Self { Self { weights: Weights::default(), pitch_limit: 8.0, keylock: false, gates: true, source_pitch: 0.0 } } }

// ---------------------------------------------------------------- result types
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Part { pub score: f32, pub reliability: f32, pub detail: String }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Harmonic { pub score: f32, pub reliability: f32, pub label: &'static str, pub relation: String, pub uncertain: bool, pub source_key: Option<String>, pub candidate_key: Option<String>, pub candidate_key_after_shift: Option<String> }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoInfo {
    pub score: f32,
    pub reliability: f32,
    pub mode: &'static str,       // direct | double-time | half-time | unknown
    pub original_bpm: f32,        // candidate's BPM as analysed
    pub target_bpm: f32,          // the source's current BPM
    pub adjust_pct: f32,          // tempo change to apply to the candidate to reach the target (in the chosen mode)
    pub within_limit: bool,
    pub key_shift_semitones: f32, // how far that tempo change moves the key when key-lock is off
    pub uncertain: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchResult {
    pub id: i64, pub path: String, pub artist: Option<String>, pub title: Option<String>,
    pub score: f32, pub label: &'static str,
    pub bpm: f32, pub camelot: Option<String>, pub energy: u8, pub genre: Option<String>, pub mood: Option<String>, pub vocal: f32,
    pub harmonic: Harmonic, pub tempo: TempoInfo,
    pub energy_part: Part, pub rhythm: Part, pub genre_part: Part, pub mood_part: Part, pub danceability_part: Part, pub spectral: Part, pub vocal_part: Part,
    pub notes: Vec<String>,
}

fn clamp01(x: f32) -> f32 { x.clamp(0.0, 1.0) }

// ---------------------------------------------------------------- harmony
/// Raw Camelot relation score (0..1) and its name; `boost_ok` enables the energy-boost relation (+2 on the wheel).
pub fn harmonic_relation(a: (u8, bool), b: (u8, bool), boost_ok: bool) -> (f32, String) {
    let dn = (b.0 as i32 - a.0 as i32).rem_euclid(12);
    if a.1 == b.1 {
        match dn {
            0 => return (1.00, "same key".into()),
            1 => return (0.88, "next key on the wheel (+1)".into()),
            11 => return (0.88, "previous key on the wheel (-1)".into()),
            2 => return if boost_ok { (0.72, "energy boost (+2, rising energy)".into()) } else { (0.45, "two steps up the wheel".into()) },
            10 => return (0.45, "two steps down the wheel".into()),
            _ => {}
        }
    } else {
        match dn {
            0 => return (0.92, "relative major/minor".into()),
            1 | 11 => return (0.60, format!("diagonal mix ({}1 and mode change)", if dn == 1 { "+" } else { "-" })),
            _ => {}
        }
    }
    // everything else is judged by how many scale notes the two keys actually share
    let ov = scale_overlap(a, b);
    let s = match ov { 6 | 7 => 0.35, 5 => 0.30, 4 => 0.20, 3 => 0.12, 2 => 0.06, _ => 0.02 };
    (s, format!("distant keys ({ov} of 7 scale notes shared)"))
}

fn semis(ratio_pct: f32) -> f32 { 12.0 * (1.0 + ratio_pct / 100.0).max(0.01).log2() }

fn harmonic(src: &Profile, cand: &Profile, cand_adjust_pct: f32, s: &Settings, notes: &mut Vec<String>) -> Harmonic {
    let (Some(ka), Some(kb)) = (src.camelot, cand.camelot) else {
        return Harmonic { score: 0.5, reliability: 0.25, label: "Experimental", relation: "key unknown".into(), uncertain: true, source_key: src.camelot.map(camelot_str), candidate_key: cand.camelot.map(camelot_str), candidate_key_after_shift: None };
    };
    // without key-lock a tempo change transposes the track by whole semitones (nearest)
    let (shift_src, shift_cand) = if s.keylock { (0, 0) } else { (semis(s.source_pitch).round() as i32, semis(cand_adjust_pct).round() as i32) };
    let (ka2, kb2) = (transpose(ka, shift_src), transpose(kb, shift_cand));
    let boost_ok = cand.energy > src.energy;
    let (raw, relation) = harmonic_relation(ka2, kb2, boost_ok);
    let reliability = clamp01(src.key_conf.min(cand.key_conf) / 0.5).max(0.25);
    let uncertain = src.key_conf < 0.35 || cand.key_conf < 0.35;
    if uncertain { notes.push("key confidence is low on at least one track: harmonic score is only a rough guide".into()); }
    if shift_cand != 0 || shift_src != 0 { notes.push(format!("no key-lock: the tempo change moves the candidate by {shift_cand:+} semitone(s) and the source by {shift_src:+}")); }
    Harmonic { score: raw, reliability, label: label(raw), relation, uncertain, source_key: Some(camelot_str(ka)), candidate_key: Some(camelot_str(kb)), candidate_key_after_shift: Some(camelot_str(kb2)) }
}

// ---------------------------------------------------------------- tempo
fn tempo(src: &Profile, cand: &Profile, s: &Settings, notes: &mut Vec<String>) -> TempoInfo {
    let target = src.bpm * (1.0 + s.source_pitch / 100.0);
    if src.bpm <= 0.0 || cand.bpm <= 0.0 {
        return TempoInfo { score: 0.5, reliability: 0.25, mode: "unknown", original_bpm: cand.bpm, target_bpm: target, adjust_pct: 0.0, within_limit: false, key_shift_semitones: 0.0, uncertain: true };
    }
    let limit = s.pitch_limit.max(0.1);
    let mut best: Option<(f32, &'static str, f32)> = None; // (score, mode, adjust)
    for (mode, ratio, penalty) in [("direct", 1.0f32, 1.0f32), ("double-time", 2.0, 0.85), ("half-time", 0.5, 0.85)] {
        let eff = cand.bpm * ratio;
        let adj = (target / eff - 1.0) * 100.0;
        let raw = if adj.abs() <= limit { 1.0 - (adj.abs() / limit).powf(1.5) } else { 0.0 } * penalty;
        let better = match best { None => true, Some((bs, _, ba)) => raw > bs + 1e-6 || ((raw - bs).abs() <= 1e-6 && raw > 0.0 && adj.abs() < ba.abs()) };
        if better { best = Some((raw, mode, adj)); }
    }
    let (mut score, mode, adj) = best.unwrap();
    let within = score > 0.0;
    if !within { notes.push(format!("tempo cannot be matched within the {limit:.0} % pitch limit ({:.1} -> {target:.1} BPM)", cand.bpm)); }
    if mode != "direct" && within { notes.push(format!("{mode} match: beats line up every {} beat", if mode == "half-time" { "second" } else { "other" })); }
    if cand.tempo_stability < 0.5 && cand.bpm > 0.0 { score = score.min(0.6); notes.push("candidate's tempo is not steady: a single BPM may not hold through the track".into()); }
    let uncertain = src.bpm_conf.min(cand.bpm_conf) < 0.3;
    let reliability = if uncertain { notes.push("tempo confidence is low on at least one track".into()); clamp01(src.bpm_conf.min(cand.bpm_conf) / 0.3).max(0.3) } else { 1.0 };
    TempoInfo { score, reliability, mode, original_bpm: cand.bpm, target_bpm: target, adjust_pct: adj, within_limit: within, key_shift_semitones: semis(adj), uncertain }
}

// ---------------------------------------------------------------- other components
fn energy_part(a: &Profile, b: &Profile) -> Part {
    let d = (a.energy as i32 - b.energy as i32).abs() as f32;
    Part { score: clamp01(1.0 - (d / 6.0).powf(1.2)), reliability: 1.0, detail: format!("energy {} vs {}", a.energy, b.energy) }
}
fn rhythm_part(a: &Profile, b: &Profile) -> Part {
    let dens = 1.0 - ((a.onset_density - b.onset_density).abs() / 8.0).min(1.0);
    let beat = 1.0 - (a.beat_strength - b.beat_strength).abs().min(1.0);
    let stab = 1.0 - (a.tempo_stability - b.tempo_stability).abs().min(1.0);
    let mut s = 0.4 * dens + 0.3 * beat + 0.3 * stab;
    let same_meter = a.time_sig == b.time_sig || a.time_sig == 0 || b.time_sig == 0;
    if !same_meter { s *= 0.5; }
    Part { score: clamp01(s), reliability: 1.0, detail: format!("onsets {:.1}/s vs {:.1}/s, steadiness {:.0}% vs {:.0}%{}", a.onset_density, b.onset_density, a.tempo_stability * 100.0, b.tempo_stability * 100.0, if same_meter { "" } else { ", different meter" }) }
}
fn tokens(g: &str) -> Vec<String> { g.to_lowercase().split(|c: char| matches!(c, ',' | ';' | '/' | '&' | '|')).map(|t| t.trim().replace('-', " ")).filter(|t| !t.is_empty()).collect() }
fn family(t: &str) -> Option<&'static str> {
    const FAMS: [(&str, &[&str]); 11] = [
        ("house", &["house", "garage", "disco"]), ("techno", &["techno", "minimal", "tech house"]), ("trance", &["trance", "psy"]),
        ("breaks", &["drum and bass", "dnb", "drum n bass", "jungle", "breakbeat", "breaks", "dubstep", "bass"]),
        ("hiphop", &["hip hop", "hiphop", "rap", "trap", "r&b", "rnb"]), ("pop", &["pop", "dance", "eurodance", "synth"]),
        ("rock", &["rock", "metal", "punk", "indie", "alternative"]), ("latin", &["latin", "reggaeton", "salsa", "bachata", "cumbia"]),
        ("reggae", &["reggae", "dancehall", "ska", "dub"]), ("electronic", &["electro", "edm", "electronic", "ambient", "downtempo", "chill"]), ("soul", &["soul", "funk", "jazz", "blues"]),
    ];
    for (f, keys) in FAMS { if keys.iter().any(|k| t == *k || t.contains(k)) { return Some(f); } }
    None
}
fn genre_part(a: &Profile, b: &Profile) -> Part {
    let (Some(ga), Some(gb)) = (&a.genre, &b.genre) else { return Part { score: 0.5, reliability: 0.5, detail: "genre unknown (taken from file tags)".into() } };
    let (ta, tb) = (tokens(ga), tokens(gb));
    if ta.is_empty() || tb.is_empty() { return Part { score: 0.5, reliability: 0.5, detail: "genre unknown (taken from file tags)".into() }; }
    if ta.iter().any(|x| tb.contains(x)) { return Part { score: 1.0, reliability: 1.0, detail: format!("same genre ({gb})") }; }
    let (fa, fb): (Vec<_>, Vec<_>) = (ta.iter().filter_map(|t| family(t)).collect(), tb.iter().filter_map(|t| family(t)).collect());
    if fa.iter().any(|f| fb.contains(f)) { return Part { score: 0.7, reliability: 1.0, detail: format!("related genres ({ga} / {gb})") }; }
    Part { score: 0.0, reliability: 1.0, detail: format!("different genres ({ga} / {gb})") }
}
fn mood_xy(m: &str) -> Option<(f32, f32)> {
    let m = m.to_lowercase();
    if m.starts_with("energetic") { Some((0.75, 0.8)) } else if m.starts_with("dark") { Some((0.25, 0.8)) } else if m.starts_with("chill") { Some((0.75, 0.3)) } else if m.starts_with("mellow") { Some((0.25, 0.3)) } else { None }
}
fn mood_part(a: &Profile, b: &Profile) -> Part {
    let (Some(ma), Some(mb)) = (a.mood.as_deref().and_then(mood_xy), b.mood.as_deref().and_then(mood_xy)) else { return Part { score: 0.5, reliability: 0.5, detail: "mood unknown".into() } };
    let d = ((ma.0 - mb.0).powi(2) + (ma.1 - mb.1).powi(2)).sqrt() / 1.0;
    let raw = clamp01(1.0 - d / 0.8);
    let rel = clamp01(a.mood_conf.min(b.mood_conf) / 0.5).max(0.3);
    Part { score: raw, reliability: rel, detail: format!("{} vs {} (rough estimates)", a.mood.as_deref().unwrap_or("?"), b.mood.as_deref().unwrap_or("?")) }
}
fn dance_part(a: &Profile, b: &Profile) -> Part { Part { score: clamp01(1.0 - (a.danceability - b.danceability).abs()), reliability: 1.0, detail: format!("danceability {:.0}% vs {:.0}%", a.danceability * 100.0, b.danceability * 100.0) } }
fn spectral_part(a: &Profile, b: &Profile) -> Part {
    let l1 = (a.low - b.low).abs() + (a.mid - b.mid).abs() + (a.high - b.high).abs();
    let cent = if a.centroid > 0.0 && b.centroid > 0.0 { 1.0 - ((a.centroid / b.centroid).log2().abs() / 1.5).min(1.0) } else { 0.5 };
    Part { score: clamp01(0.6 * (1.0 - l1 / 2.0) + 0.4 * cent), reliability: 1.0, detail: format!("brightness {:.0} Hz vs {:.0} Hz", a.centroid, b.centroid) }
}
fn vocal_part(a: &Profile, b: &Profile) -> Part {
    let raw = clamp01(1.0 - (a.vocal - b.vocal).abs());
    let rel = clamp01(a.vocal_conf.min(b.vocal_conf) / 0.6).max(0.3);
    Part { score: raw, reliability: rel, detail: format!("vocal presence {:.0}% vs {:.0}% (rough estimate)", a.vocal * 100.0, b.vocal * 100.0) }
}

// ---------------------------------------------------------------- scoring
pub fn score_pair(src: &Profile, cand: &Profile, s: &Settings) -> Result<MatchResult, String> {
    s.weights.validate()?;
    let mut notes = Vec::new();
    let tempo = tempo(src, cand, s, &mut notes);
    // a tempo change only moves the key if it can really be applied (within the pitch limit) and key-lock is off
    let applied_adjust = if s.keylock || !tempo.within_limit { 0.0 } else { tempo.adjust_pct };
    let harm = harmonic(src, cand, applied_adjust, s, &mut notes);
    let (en, rh, ge, mo, da, sp, vo) = (energy_part(src, cand), rhythm_part(src, cand), genre_part(src, cand), mood_part(src, cand), dance_part(src, cand), spectral_part(src, cand), vocal_part(src, cand));
    let w = &s.weights;
    // (weight x reliability, score): evidence we trust less counts for less
    let parts = [(w.harmonic * harm.reliability, harm.score), (w.bpm * tempo.reliability, tempo.score), (w.energy * en.reliability, en.score), (w.rhythm * rh.reliability, rh.score), (w.genre * ge.reliability, ge.score),
                 (w.mood * mo.reliability, mo.score), (w.danceability * da.reliability, da.score), (w.spectral * sp.reliability, sp.score), (w.vocal * vo.reliability, vo.score)];
    let wsum: f32 = parts.iter().map(|p| p.0).sum();
    if wsum <= 0.0 { return Err("every weighted component is unavailable for this pair".into()); }
    let mut total = parts.iter().map(|p| p.0 * p.1).sum::<f32>() / wsum;
    if s.gates {
        if tempo.mode != "unknown" && !tempo.within_limit { total *= 0.6; }
        if harm.score < 0.30 && !harm.uncertain { total *= 0.85; notes.push("harmonic clash: score reduced".into()); }
    }
    let score = (total * 100.0).clamp(0.0, 100.0);
    Ok(MatchResult {
        id: cand.id, path: cand.path.clone(), artist: cand.artist.clone(), title: cand.title.clone(), score, label: label(score / 100.0),
        bpm: cand.bpm, camelot: cand.camelot.map(camelot_str), energy: cand.energy, genre: cand.genre.clone(), mood: cand.mood.clone(), vocal: cand.vocal,
        harmonic: harm, tempo, energy_part: en, rhythm: rh, genre_part: ge, mood_part: mo, danceability_part: da, spectral: sp, vocal_part: vo, notes,
    })
}

// ---------------------------------------------------------------- ranking
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Filter {
    pub min_score: f32,
    pub bpm_min: Option<f32>, pub bpm_max: Option<f32>,
    pub max_bpm_diff: Option<f32>,
    pub energy_min: Option<u8>, pub energy_max: Option<u8>,
    pub genres: Vec<String>,
    /// "any" | "only" (vocal tracks) | "none" (instrumental)
    pub vocals: String,
    pub limit: usize,
    /// "score" | "bpm" | "key" | "energy" | "genre"
    pub sort: String,
}
impl Default for Filter { fn default() -> Self { Self { min_score: 0.0, bpm_min: None, bpm_max: None, max_bpm_diff: None, energy_min: None, energy_max: None, genres: vec![], vocals: "any".into(), limit: 50, sort: "score".into() } } }

pub fn passes(src: &Profile, c: &Profile, f: &Filter, s: &Settings) -> bool {
    if let Some(x) = f.bpm_min { if c.bpm < x { return false; } }
    if let Some(x) = f.bpm_max { if c.bpm > x { return false; } }
    if let Some(d) = f.max_bpm_diff { if (c.bpm - src.bpm * (1.0 + s.source_pitch / 100.0)).abs() > d { return false; } }
    if let Some(x) = f.energy_min { if c.energy < x { return false; } }
    if let Some(x) = f.energy_max { if c.energy > x { return false; } }
    if !f.genres.is_empty() {
        let Some(g) = &c.genre else { return false };
        let cg = tokens(g);
        if !f.genres.iter().any(|w| { let w = w.to_lowercase(); cg.iter().any(|t| t.contains(&w) || w.contains(t.as_str())) }) { return false; }
    }
    match f.vocals.as_str() { "only" => if c.vocal < 0.35 { return false; }, "none" => if c.vocal >= 0.35 { return false; }, _ => {} }
    true
}

pub fn rank(src: &Profile, cands: &[Profile], s: &Settings, f: &Filter) -> Result<Vec<MatchResult>, String> {
    s.weights.validate()?;
    let mut out: Vec<MatchResult> = Vec::new();
    for c in cands {
        if c.id == src.id || c.path == src.path || !passes(src, c, f, s) { continue; }
        let r = score_pair(src, c, s)?;
        if r.score >= f.min_score { out.push(r); }
    }
    let key = |r: &MatchResult| r.camelot.as_deref().and_then(parse_camelot).map(|k| (k.0 as i32, k.1)).unwrap_or((99, false));
    match f.sort.as_str() {
        "bpm" => out.sort_by(|a, b| a.bpm.partial_cmp(&b.bpm).unwrap_or(std::cmp::Ordering::Equal)),
        "key" => out.sort_by_key(|r| key(r)),
        "energy" => out.sort_by(|a, b| b.energy.cmp(&a.energy)),
        "genre" => out.sort_by(|a, b| a.genre.cmp(&b.genre)),
        _ => out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then(a.id.cmp(&b.id))),
    }
    out.truncate(f.limit.clamp(1, 1000));
    Ok(out)
}
