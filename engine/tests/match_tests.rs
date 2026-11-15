//! Tests for the matching engine (H3): pure scoring on constructed profiles. Run: `cargo test --release`
mod common;
use common::Rng;
use djengine::features::camelot as feat_camelot;
use djengine::matching::*;
use std::time::Instant;

fn base() -> Profile {
    Profile {
        id: 1, path: "src.mp3".into(), artist: Some("A".into()), title: Some("T".into()), camelot: Some((8, true)), key_conf: 1.0, bpm: 126.0, bpm_conf: 1.0, energy: 8, danceability: 0.8,
        genre: Some("House".into()), mood: Some("Energetic / uplifting".into()), mood_conf: 0.5, onset_density: 4.0, beat_strength: 0.6, tempo_stability: 0.95, time_sig: 4,
        low: 0.4, mid: 0.5, high: 0.1, centroid: 1500.0, vocal: 0.1, vocal_conf: 0.3,
    }
}
fn with(id: i64, f: impl FnOnce(&mut Profile)) -> Profile { let mut p = base(); p.id = id; p.path = format!("t{id}.mp3"); f(&mut p); p }
fn st() -> Settings { Settings::default() }
fn k(s: &str) -> (u8, bool) { parse_camelot(s).unwrap() }

#[test]
fn camelot_parsing_tonics_and_scale_overlap() {
    assert_eq!(parse_camelot("8A"), Some((8, true)));
    assert_eq!(parse_camelot("12b"), Some((12, false)));
    for bad in ["", "13A", "0B", "8C", "A8", "8"] { assert_eq!(parse_camelot(bad), None, "{bad:?}"); }
    // the matcher's key arithmetic agrees with the analyser's Camelot naming for all 24 keys
    for t in 0..12u8 { for minor in [false, true] { let c = parse_camelot(&feat_camelot(t, minor)).unwrap(); assert_eq!(tonic_pc(c), t, "tonic of {}", feat_camelot(t, minor)); assert_eq!(c.1, minor); } }
    assert_eq!(scale_overlap(k("8A"), k("8B")), 7, "relative keys share every note");
    assert_eq!(scale_overlap(k("8A"), k("9A")), 6);
    assert_eq!(scale_overlap(k("8A"), k("7A")), 6);
    assert_eq!(scale_overlap(k("8A"), k("9B")), 6);
    assert_eq!(scale_overlap(k("8A"), k("10A")), 5);
    assert_eq!(scale_overlap(k("8A"), k("2A")), 2);
    assert_eq!(scale_overlap(k("8A"), k("8A")), 7);
    assert_eq!(transpose(k("8A"), 1), (3, true), "up a semitone = +7 steps on the wheel");
    assert_eq!(transpose(k("8B"), 12), (8, false));
    assert_eq!(transpose(transpose(k("5A"), 5), -5), (5, true));
}

#[test]
fn camelot_relations_from_8a() {
    let rel = |b: &str, boost: bool| harmonic_relation(k("8A"), k(b), boost);
    assert_eq!(rel("8A", false).0, 1.00);
    assert_eq!((rel("7A", false).0, rel("9A", false).0), (0.88, 0.88));
    assert_eq!(rel("8B", false).0, 0.92);
    assert_eq!((rel("9B", false).0, rel("7B", false).0), (0.60, 0.60));
    assert_eq!(rel("10A", true).0, 0.72, "energy boost when the energy rises");
    assert_eq!(rel("10A", false).0, 0.45, "no boost without rising energy");
    assert_eq!(rel("6A", true).0, 0.45, "going down two steps is never a boost");
    assert!(rel("2A", false).0 < 0.2 && rel("2B", false).0 < 0.2);
    for (s, want) in [(1.0, "Excellent"), (0.92, "Excellent"), (0.88, "Very Good"), (0.72, "Compatible"), (0.60, "Compatible"), (0.45, "Experimental"), (0.06, "Not Recommended")] { assert_eq!(label(s), want, "{s}"); }
    // the example from the brief: 8A is a perfect match for 8A, 7A/9A and 8B are good transitions
    for good in ["8A", "7A", "9A", "8B"] { assert!(rel(good, false).0 >= 0.88, "{good}"); }
}

#[test]
fn harmony_is_symmetric_ordered_and_not_just_wheel_distance() {
    let all: Vec<(u8, bool)> = (1..=12).flat_map(|n| [(n, true), (n, false)]).collect();
    for &a in &all { for &b in &all {
        assert_eq!(harmonic_relation(a, b, false).0, harmonic_relation(b, a, false).0, "{a:?} vs {b:?} must be symmetric without the boost");
        let s = harmonic_relation(a, b, false).0;
        assert!((0.0..=1.0).contains(&s));
        if a == b { assert_eq!(s, 1.0); } else { assert!(s < 1.0); }
    } }
    // keys outside the named relations are ranked by how many scale notes they really share, not by wheel number
    let a = k("8A");
    let mut far: Vec<(u32, f32)> = all.iter().filter(|&&b| harmonic_relation(a, b, false).1.starts_with("distant")).map(|&b| (scale_overlap(a, b), harmonic_relation(a, b, false).0)).collect();
    assert!(far.len() > 10);
    far.sort_by_key(|x| x.0);
    for w in far.windows(2) { assert!(w[0].1 <= w[1].1 + 1e-6, "more shared notes must never score lower: {w:?}"); }
    assert!(far.iter().all(|x| x.1 <= 0.35));
    // and the named relations beat every distant key
    assert!(far.iter().all(|x| x.1 < 0.45));
}

#[test]
fn tempo_matching_pitch_limit_half_and_double_time() {
    let t = |src_bpm: f32, cand_bpm: f32, s: &Settings| { let src = with(1, |p| p.bpm = src_bpm); let c = with(2, |p| p.bpm = cand_bpm); score_pair(&src, &c, s).unwrap().tempo };
    let d = t(124.0, 128.0, &st());
    assert_eq!(d.mode, "direct");
    assert!((d.adjust_pct + 3.125).abs() < 0.01, "slow the 128 BPM track by 3.125 %: {}", d.adjust_pct);
    assert!(d.within_limit && (d.score - (1.0 - (3.125f32 / 8.0).powf(1.5))).abs() < 0.01, "{}", d.score);
    assert_eq!(d.target_bpm, 124.0); assert_eq!(d.original_bpm, 128.0);
    assert!((d.key_shift_semitones + 0.54).abs() < 0.02, "{}", d.key_shift_semitones);
    assert_eq!(t(126.0, 126.0, &st()).score, 1.0);
    let dbl = t(128.0, 64.0, &st()); assert_eq!((dbl.mode, dbl.adjust_pct.abs() < 0.01, (dbl.score - 0.85).abs() < 0.01), ("double-time", true, true));
    let half = t(64.0, 128.0, &st()); assert_eq!(half.mode, "half-time");
    let far = t(128.0, 90.0, &st()); assert!(!far.within_limit && far.score == 0.0, "{far:?}");
    assert_eq!(far.mode, "direct", "when nothing is within the limit the advice is the plain direct change, not a half/double-time guess");
    let wide = Settings { pitch_limit: 16.0, ..st() };
    assert!(t(128.0, 112.0, &wide).within_limit && !t(128.0, 112.0, &st()).within_limit, "the pitch limit is configurable");
    // score falls as the required adjustment grows
    let scores: Vec<f32> = [0.0, 1.0, 2.0, 4.0, 6.0, 7.9].iter().map(|pct| t(126.0, 126.0 * (1.0 + pct / 100.0), &st()).score).collect();
    for w in scores.windows(2) { assert!(w[0] > w[1], "{scores:?}"); }
    // the source's own pitch fader moves the target
    let s = Settings { source_pitch: 4.0, ..st() };
    let r = t(124.0, 129.0, &s); assert!((r.target_bpm - 128.96).abs() < 0.01 && r.adjust_pct.abs() < 0.1, "{r:?}");
}

#[test]
fn close_bpm_alone_is_not_enough() {
    // same BPM, but a clashing key, wrong energy and a different meter: must not rank as a great match
    let src = base();
    let bad = with(2, |p| { p.camelot = Some((2, false)); p.energy = 2; p.time_sig = 3; p.genre = Some("Pop".into()); p.mood = Some("Mellow / melancholic".into()); p.danceability = 0.2; p.vocal = 0.9; p.onset_density = 0.5; });
    let r = score_pair(&src, &bad, &st()).unwrap();
    println!("same BPM, otherwise unlike: {:.1}", r.score);
    assert!(r.tempo.score > 0.95 && r.score < 50.0, "score {}", r.score);
    // and a tempo that cannot be matched drags a harmonically perfect track down
    let slow = with(3, |p| p.bpm = 90.0);
    let r2 = score_pair(&src, &slow, &st()).unwrap();
    let r2_nogate = score_pair(&src, &slow, &Settings { gates: false, ..st() }).unwrap();
    assert!(r2.score < r2_nogate.score * 0.65 && r2.notes.iter().any(|n| n.contains("pitch limit")), "{} vs {}", r2.score, r2_nogate.score);
}

#[test]
fn without_keylock_a_big_tempo_change_moves_the_key() {
    let src = base(); // 8A at 126
    let cand = with(2, |p| p.bpm = 136.0); // same key, needs -7.4 %
    let off = score_pair(&src, &cand, &Settings { keylock: false, ..st() }).unwrap();
    let on = score_pair(&src, &cand, &Settings { keylock: true, ..st() }).unwrap();
    println!("same key, 7.4 % tempo change: keylock off {:.1} (key after shift {:?}, {}), on {:.1}", off.score, off.harmonic.candidate_key_after_shift, off.harmonic.label, on.score);
    assert!((off.tempo.key_shift_semitones + 1.3).abs() < 0.1);
    assert_eq!(off.harmonic.candidate_key.as_deref(), Some("8A"));
    assert_eq!(off.harmonic.candidate_key_after_shift.as_deref(), Some("1A"), "one semitone down = 7 steps back round the wheel");
    assert_eq!(off.harmonic.label, "Not Recommended");
    assert!(off.notes.iter().any(|n| n.contains("no key-lock")));
    assert!(on.harmonic.score > 0.99 && on.score > off.score + 8.0);
    // a small change leaves the key where it is
    let near = score_pair(&src, &with(3, |p| p.bpm = 127.0), &Settings { keylock: false, ..st() }).unwrap();
    assert_eq!(near.harmonic.candidate_key_after_shift.as_deref(), Some("8A"));
}

#[test]
fn weights_are_configurable_validated_and_normalised() {
    let w = Weights::default();
    let sum = w.harmonic + w.bpm + w.energy + w.rhythm + w.genre + w.mood + w.danceability + w.spectral + w.vocal;
    assert_eq!(sum, 100.0);
    assert_eq!((w.harmonic, w.bpm, w.energy, w.rhythm, w.genre, w.mood, w.danceability, w.spectral, w.vocal), (20.0, 15.0, 15.0, 15.0, 10.0, 10.0, 5.0, 5.0, 5.0));
    let src = base(); let cand = with(2, |p| { p.camelot = Some((9, true)); p.bpm = 128.0; p.energy = 6 });
    let none = Weights { harmonic: 0.0, bpm: 0.0, energy: 0.0, rhythm: 0.0, genre: 0.0, mood: 0.0, danceability: 0.0, spectral: 0.0, vocal: 0.0 };
    let only_h = Settings { weights: Weights { harmonic: 1.0, ..none.clone() }, gates: false, ..st() };
    let r = score_pair(&src, &cand, &only_h).unwrap();
    assert!((r.score - r.harmonic.score * 100.0).abs() < 0.01, "harmonic-only weights must give the harmonic score");
    let only_b = Settings { weights: Weights { bpm: 7.0, ..none.clone() }, gates: false, ..st() };
    assert!((score_pair(&src, &cand, &only_b).unwrap().score - r.tempo.score * 100.0).abs() < 0.01);
    let scaled = Settings { weights: Weights { harmonic: 60.0, bpm: 45.0, energy: 45.0, rhythm: 45.0, genre: 30.0, mood: 30.0, danceability: 15.0, spectral: 15.0, vocal: 15.0 }, ..st() };
    assert!((score_pair(&src, &cand, &scaled).unwrap().score - score_pair(&src, &cand, &st()).unwrap().score).abs() < 0.001, "weights are relative, not absolute");
    for bad in [Weights { energy: -1.0, ..Weights::default() }, Weights { bpm: f32::NAN, ..Weights::default() }, none.clone()] {
        assert!(score_pair(&src, &cand, &Settings { weights: bad.clone(), ..st() }).is_err() && rank(&src, &[cand.clone()], &Settings { weights: bad, ..st() }, &Filter::default()).is_err());
    }
    // priorities change the order
    let a = with(10, |p| { p.camelot = Some((8, true)); p.bpm = 133.0; p.energy = 8 });   // perfect key, 5.3 % tempo change
    let b = with(11, |p| { p.camelot = Some((9, true)); p.bpm = 126.0; p.energy = 8 });   // neighbouring key, perfect tempo
    let harmonic_first = Settings { weights: Weights { harmonic: 90.0, bpm: 5.0, ..Weights::default() }, keylock: true, ..st() };
    let tempo_first = Settings { weights: Weights { harmonic: 5.0, bpm: 90.0, ..Weights::default() }, keylock: true, ..st() };
    let top = |s: &Settings| rank(&src, &[a.clone(), b.clone()], s, &Filter::default()).unwrap()[0].id;
    assert_eq!((top(&harmonic_first), top(&tempo_first)), (10, 11));
}

#[test]
fn component_scores_behave() {
    let src = base();
    let part = |f: &dyn Fn(&mut Profile)| score_pair(&src, &with(2, |p| f(p)), &st()).unwrap();
    // energy: symmetric and monotone
    let e: Vec<f32> = (0..=7).map(|d| part(&|p| p.energy = (8 - d).max(1) as u8).energy_part.score).collect();
    for w in e.windows(2) { assert!(w[0] >= w[1]); } assert_eq!(e[0], 1.0); assert!(e[3] < 0.7);
    let up = score_pair(&with(3, |p| p.energy = 4), &with(4, |p| p.energy = 9), &st()).unwrap().energy_part.score;
    let down = score_pair(&with(3, |p| p.energy = 9), &with(4, |p| p.energy = 4), &st()).unwrap().energy_part.score;
    assert_eq!(up, down);
    // identical spectra = 1, opposite = low
    assert_eq!(part(&|_| {}).spectral.score, 1.0);
    assert!(part(&|p| { p.low = 0.05; p.mid = 0.15; p.high = 0.8; p.centroid = 6000.0 }).spectral.score < 0.3);
    // rhythm: a different meter halves it
    let same = part(&|_| {}).rhythm.score; let waltz = part(&|p| p.time_sig = 3).rhythm.score;
    assert_eq!(same, 1.0); assert!((waltz - same * 0.5).abs() < 0.01);
    // danceability
    assert_eq!(part(&|p| p.danceability = 0.3).danceability_part.score, 0.5);
    // genre
    let g = |a: Option<&str>, b: Option<&str>| score_pair(&with(5, |p| p.genre = a.map(String::from)), &with(6, |p| p.genre = b.map(String::from)), &st()).unwrap().genre_part.score;
    assert_eq!(g(Some("House"), Some("house")), 1.0);
    assert_eq!(g(Some("House, Disco"), Some("Disco")), 1.0, "any shared tag counts");
    assert_eq!(g(Some("Deep House"), Some("Tech House")), 0.7, "related genres");
    assert_eq!(g(Some("Drum & Bass"), Some("Jungle")), 0.7);
    assert_eq!(g(Some("Techno"), Some("Pop")), 0.0);
    assert_eq!(g(None, Some("House")), 0.5, "unknown genre is neutral, not a penalty or a bonus");
    // mood: same close to 1, opposite lower, unknown neutral
    let m = |a: &str, b: &str| score_pair(&with(5, |p| p.mood = Some(a.into())), &with(6, |p| p.mood = Some(b.into())), &st()).unwrap().mood_part.score;
    assert!(m("Energetic / uplifting", "Energetic / uplifting") > 0.99 && m("Energetic / uplifting", "Mellow / melancholic") < 0.45 && m("Dark / intense", "Energetic / uplifting") < m("Dark / intense", "Dark / intense"));
    assert_eq!(part(&|p| p.mood = None).mood_part.score, 0.5);
    // vocals are a rough estimate: the mismatch is reported honestly but its weight is reduced
    let v = part(&|p| p.vocal = 1.0).vocal_part; assert!((v.score - 0.1).abs() < 1e-5 && v.reliability < 1.0, "a vocal mismatch is real but counts for less: {} / {}", v.score, v.reliability);
}

#[test]
fn uncertain_inputs_are_not_trusted() {
    let src = base();
    let sure = score_pair(&src, &with(2, |_| {}), &st()).unwrap();
    let shaky = score_pair(&src, &with(2, |p| p.key_conf = 0.1), &st()).unwrap();
    assert!(sure.harmonic.score == 1.0 && !sure.harmonic.uncertain);
    assert!(shaky.harmonic.uncertain && shaky.harmonic.reliability < 1.0 && shaky.harmonic.score == 1.0, "{} / {}", shaky.harmonic.score, shaky.harmonic.reliability);
    // a clashing key is punished less when the key estimate is shaky than when it is solid
    let clash_sure = score_pair(&src, &with(2, |p| p.camelot = Some((2, false))), &st()).unwrap().score;
    let clash_shaky = score_pair(&src, &with(2, |p| { p.camelot = Some((2, false)); p.key_conf = 0.1 }), &st()).unwrap().score;
    assert!(clash_shaky > clash_sure + 1.0, "shaky {clash_shaky} vs sure {clash_sure}");
    assert!(shaky.notes.iter().any(|n| n.contains("key confidence")));
    let nokey = score_pair(&src, &with(2, |p| p.camelot = None), &st()).unwrap();
    assert_eq!((nokey.harmonic.score, nokey.harmonic.uncertain, nokey.harmonic.relation.as_str()), (0.5, true, "key unknown")); assert!(nokey.harmonic.reliability < 0.5);
    let notempo = score_pair(&src, &with(2, |p| p.bpm = 0.0), &st()).unwrap();
    assert_eq!((notempo.tempo.score, notempo.tempo.mode), (0.5, "unknown"));
    let fuzzy = score_pair(&with(1, |p| p.bpm_conf = 0.05), &with(2, |_| {}), &st()).unwrap();
    assert!(fuzzy.tempo.uncertain && fuzzy.tempo.reliability < 0.5 && fuzzy.tempo.score == 1.0, "{} / {}", fuzzy.tempo.score, fuzzy.tempo.reliability);
    let drifting = score_pair(&src, &with(2, |p| p.tempo_stability = 0.3), &st()).unwrap();
    assert!(drifting.tempo.score <= 0.6 && drifting.notes.iter().any(|n| n.contains("not steady")));
}

#[test]
fn the_example_from_the_brief_ranks_in_the_expected_order() {
    // selected: 8A, 126 BPM, energy 8; candidates as in the brief (everything else equal)
    let src = base();
    let alpha = with(2, |p| { p.camelot = Some((8, true)); p.bpm = 126.0; p.energy = 8; p.title = Some("Alpha".into()) });
    let beta = with(3, |p| { p.camelot = Some((7, true)); p.bpm = 128.0; p.energy = 8; p.title = Some("Beta".into()) });
    let gamma = with(4, |p| { p.camelot = Some((8, false)); p.bpm = 124.0; p.energy = 7; p.title = Some("Gamma".into()) });
    let delta = with(5, |p| { p.camelot = Some((3, false)); p.bpm = 142.0; p.energy = 3; p.title = Some("Delta (clash)".into()) });
    let r = rank(&src, &[delta.clone(), gamma.clone(), alpha.clone(), beta.clone()], &st(), &Filter::default()).unwrap();
    for m in &r { println!("{:<14} {:>5.1}%  key {:?}  {} BPM  energy {}  [{}]", m.title.as_deref().unwrap(), m.score, m.camelot, m.bpm, m.energy, m.harmonic.relation); }
    assert_eq!(r.iter().map(|m| m.id).collect::<Vec<_>>(), vec![2, 3, 4, 5]);
    assert!(r[0].score >= 99.0 && (88.0..99.0).contains(&r[1].score) && (85.0..99.0).contains(&r[2].score) && r[3].score < 55.0);
}

#[test]
fn ranking_filters_sorting_and_determinism() {
    let mut rng = Rng(2024);
    let genres = ["House", "Techno", "Deep House", "Pop", "Drum & Bass", "Disco"];
    let cands: Vec<Profile> = (0..400).map(|i| with(100 + i, |p| {
        p.camelot = Some((1 + (rng.next() * 12.0) as u8 % 12, rng.next() < 0.5)); p.bpm = 90.0 + rng.next() * 70.0; p.energy = 1 + (rng.next() * 10.0) as u8 % 10;
        p.genre = Some(genres[(rng.next() * 6.0) as usize % 6].into()); p.vocal = rng.next(); p.danceability = rng.next(); p.onset_density = rng.next() * 8.0; p.key_conf = rng.next();
    })).collect();
    let src = base();
    let all = rank(&src, &cands, &st(), &Filter { limit: 1000, ..Filter::default() }).unwrap();
    assert_eq!(all.len(), 400); assert!(all.windows(2).all(|w| w[0].score >= w[1].score), "sorted best first");
    assert!(all.iter().all(|m| m.id != src.id && (0.0..=100.0).contains(&m.score) && m.score.is_finite()));
    let again = rank(&src, &cands, &st(), &Filter { limit: 1000, ..Filter::default() }).unwrap();
    assert_eq!(all.iter().map(|m| (m.id, m.score.to_bits())).collect::<Vec<_>>(), again.iter().map(|m| (m.id, m.score.to_bits())).collect::<Vec<_>>(), "deterministic");
    // the source itself is never suggested (by id or by path)
    let mut with_src = cands.clone(); with_src.push(src.clone()); with_src.push(Profile { id: 9999, ..src.clone() });
    assert_eq!(rank(&src, &with_src, &st(), &Filter { limit: 1000, ..Filter::default() }).unwrap().len(), 400);
    let f = |f: Filter| rank(&src, &cands, &st(), &Filter { limit: if f.limit == 50 { 1000 } else { f.limit }, ..f }).unwrap();
    assert!(f(Filter { min_score: 70.0, ..Filter::default() }).iter().all(|m| m.score >= 70.0));
    assert!(f(Filter { bpm_min: Some(120.0), bpm_max: Some(130.0), ..Filter::default() }).iter().all(|m| (120.0..=130.0).contains(&m.bpm)));
    assert!(f(Filter { max_bpm_diff: Some(3.0), ..Filter::default() }).iter().all(|m| (m.bpm - 126.0).abs() <= 3.0));
    assert!(f(Filter { energy_min: Some(7), energy_max: Some(9), ..Filter::default() }).iter().all(|m| (7..=9).contains(&m.energy)));
    let h = f(Filter { genres: vec!["house".into()], ..Filter::default() }); assert!(!h.is_empty() && h.iter().all(|m| m.genre.as_deref().unwrap().to_lowercase().contains("house")));
    assert!(f(Filter { vocals: "only".into(), ..Filter::default() }).iter().all(|m| m.vocal >= 0.35));
    assert!(f(Filter { vocals: "none".into(), ..Filter::default() }).iter().all(|m| m.vocal < 0.35));
    assert_eq!(f(Filter { limit: 10, ..Filter::default() }).len(), 10);
    let by_bpm = f(Filter { sort: "bpm".into(), ..Filter::default() }); assert!(by_bpm.windows(2).all(|w| w[0].bpm <= w[1].bpm));
    let by_energy = f(Filter { sort: "energy".into(), ..Filter::default() }); assert!(by_energy.windows(2).all(|w| w[0].energy >= w[1].energy));
    let by_key = f(Filter { sort: "key".into(), ..Filter::default() }); let nums: Vec<u8> = by_key.iter().map(|m| parse_camelot(m.camelot.as_deref().unwrap()).unwrap().0).collect(); assert!(nums.windows(2).all(|w| w[0] <= w[1]));
    let by_genre = f(Filter { sort: "genre".into(), ..Filter::default() }); assert!(by_genre.windows(2).all(|w| w[0].genre <= w[1].genre));
}

#[test]
fn every_score_is_bounded_and_a_confident_self_match_is_perfect() {
    let mut rng = Rng(5);
    let rand_profile = |rng: &mut Rng, id: i64| with(id, |p| {
        p.camelot = if rng.next() < 0.9 { Some((1 + (rng.next() * 12.0) as u8 % 12, rng.next() < 0.5)) } else { None };
        p.key_conf = rng.next(); p.bpm = if rng.next() < 0.95 { 60.0 + rng.next() * 140.0 } else { 0.0 }; p.bpm_conf = rng.next(); p.energy = 1 + (rng.next() * 10.0) as u8 % 10;
        p.danceability = rng.next(); p.onset_density = rng.next() * 12.0; p.beat_strength = rng.next(); p.tempo_stability = rng.next(); p.time_sig = if rng.next() < 0.8 { 4 } else { 3 };
        p.low = rng.next() * 0.5; p.mid = rng.next() * 0.4; p.high = rng.next() * 0.2; p.centroid = 200.0 + rng.next() * 8000.0; p.vocal = rng.next(); p.genre = if rng.next() < 0.3 { None } else { Some("House".into()) };
    });
    for i in 0..3000 {
        let (a, b) = (rand_profile(&mut rng, 2 * i), rand_profile(&mut rng, 2 * i + 1));
        let s = Settings { keylock: i % 2 == 0, pitch_limit: 4.0 + (i % 5) as f32 * 3.0, source_pitch: (i % 7) as f32 - 3.0, ..st() };
        let r = score_pair(&a, &b, &s).unwrap();
        for v in [r.score / 100.0, r.harmonic.score, r.tempo.score, r.energy_part.score, r.rhythm.score, r.genre_part.score, r.mood_part.score, r.danceability_part.score, r.spectral.score, r.vocal_part.score] { assert!(v.is_finite() && (-1e-6..=1.000001).contains(&v), "pair {i}: {v}"); }
    }
    let p = base(); let me = score_pair(&p, &Profile { id: 2, path: "other.mp3".into(), ..p.clone() }, &st()).unwrap();
    assert!(me.score > 99.9, "{}", me.score);
}

#[test]
fn ranking_20000_candidates_is_fast() {
    let mut rng = Rng(11);
    let cands: Vec<Profile> = (0..20000).map(|i| with(i + 10, |p| { p.camelot = Some((1 + (rng.next() * 12.0) as u8 % 12, rng.next() < 0.5)); p.bpm = 80.0 + rng.next() * 100.0; p.energy = 1 + (rng.next() * 10.0) as u8 % 10; p.vocal = rng.next(); p.danceability = rng.next(); })).collect();
    let t = Instant::now(); let r = rank(&base(), &cands, &st(), &Filter { limit: 100, ..Filter::default() }).unwrap(); let el = t.elapsed();
    println!("ranked 20,000 candidates in {el:?} (best {:.1} %)", r[0].score);
    assert_eq!(r.len(), 100); assert!(el.as_millis() < 1500, "{el:?}");
}
