//! H3 through the real stack: schema v3 migration with backfill, analysis -> database -> matching. Run: `cargo test --release`
mod common;
use common::*;
use djengine::analysis::analyze;
use djengine::features::compute;
use djengine::decode::decode_file;
use djengine::library::*;
use djengine::matching::{Filter, Settings, Weights};
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn version(c: &Connection) -> i64 { c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap() }
fn cols(c: &Connection) -> Vec<String> { let mut s = c.prepare("PRAGMA table_info(tracks)").unwrap(); s.query_map([], |r| r.get::<_, String>(1)).unwrap().filter_map(|x| x.ok()).collect() }

#[test]
fn schema_v3_backfills_numeric_columns_from_the_stored_feature_json() {
    let d = temp_dir("v3"); let wav = d.join("a.wav"); write_wav(&wav, 22050, &tonal_with_beat(22050, 20.0, 9, true, 126.0, 3));
    let track = decode_file(wav.to_str().unwrap()).unwrap();
    let f = compute(&track, &analyze(&track));
    let json = serde_json::to_string(&f).unwrap();
    let p = d.join("library.db");
    {   // a library exactly as the previous version of the app left it (schema 2)
        let c = Connection::open(&p).unwrap(); migrate_to(&c, 2).unwrap();
        c.execute("INSERT INTO tracks (path,size,mtime,added_at,status,bpm,camelot,energy,features) VALUES ('done.wav',1,1,1,'done',?1,'8A',?2,?3)", rusqlite::params![f.bpm as f64, f.energy as i64, json]).unwrap();
        c.execute("INSERT INTO tracks (path,size,mtime,added_at,status) VALUES ('pending.wav',1,1,1,'pending')", []).unwrap();
    }
    let c = open_db(&p).unwrap();
    assert_eq!(version(&c), SCHEMA_VERSION);
    let baks = std::fs::read_dir(&d).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().contains(".bak-v2-")).count();
    assert_eq!(baks, 1, "the schema-2 library is backed up before it is migrated");
    let row = |c: &Connection, path: &str| c.query_row("SELECT onset_density, beat_strength, tempo_stability, time_sig, spec_low, spec_mid, spec_high, centroid, vocal, vocal_conf, mood_conf FROM tracks WHERE path=?1", [path], |r| Ok((0..11).map(|i| r.get::<_, Option<f64>>(i).unwrap()).collect::<Vec<_>>())).unwrap();
    let want = [f.onset_density as f64, f.beat_strength as f64, f.tempo_stability as f64, f.time_signature as f64, f.low as f64, f.mid as f64, f.high as f64, f.centroid_hz as f64, f.vocal_presence as f64, f.vocal_confidence as f64, f.mood_confidence as f64];
    let got = row(&c, "done.wav");
    for (i, w) in want.iter().enumerate() { assert!((got[i].expect("backfilled") - w).abs() < 1e-4, "column {i}: {:?} vs {w}", got[i]); }
    assert!(row(&c, "pending.wav").iter().all(|x| x.is_none()), "rows without analysis stay empty");
    // roll back and forward again: nothing else is lost, the backfill repeats
    migrate_to(&c, 2).unwrap();
    assert!(!cols(&c).contains(&"onset_density".to_string()) && cols(&c).contains(&"favorite".to_string()));
    assert_eq!(c.query_row("SELECT camelot FROM tracks WHERE path='done.wav'", [], |r| r.get::<_, String>(0)).unwrap(), "8A");
    migrate_to(&c, 3).unwrap();
    assert!((row(&c, "done.wav")[0].unwrap() - want[0]).abs() < 1e-4);
    let _ = std::fs::remove_dir_all(&d);
}

fn lib_with(dir: &PathBuf, workers: usize) -> Library {
    let lib = Library::open(&dir.join("library.db")).unwrap(); lib.set_workers(workers);
    let (tx, rx) = mpsc::channel(); lib.start_workers(tx); std::mem::forget(rx); lib
}

#[test]
fn analysis_to_database_to_ranking_with_scopes_and_errors() {
    let d = temp_dir("e2e"); let m = d.join("music"); std::fs::create_dir_all(&m).unwrap();
    let make = |name: &str, tonic: u8, minor: bool, bpm: f32, seed: u32| -> String { let p = m.join(format!("{name}.wav")); write_wav(&p, 22050, &tonal_with_beat(22050, 24.0, tonic, minor, bpm, seed)); p.to_string_lossy().to_string() };
    let src = make("src_Am_126", 9, true, 126.0, 1);
    let same = make("same_Am_128", 9, true, 128.0, 2);
    let rel = make("relative_C_124", 0, false, 124.0, 3);
    let nb = make("neighbour_Em_126", 4, true, 126.0, 4);
    let far_key = make("far_key_Fsharp_126", 6, false, 126.0, 5);
    let far_tempo = make("far_tempo_Am_160", 9, true, 160.0, 6);
    let all = [&src, &same, &rel, &nb, &far_key, &far_tempo];
    let lib = lib_with(&d, 2);
    lib.scan(&all.iter().map(|p| TrackMeta { path: p.to_string(), genre: Some("House".into()), ..Default::default() }).collect::<Vec<_>>(), false).unwrap();
    assert!(lib.wait_idle(Duration::from_secs(120)));
    assert_eq!(lib.stats()["analyzed"], 6);

    let res = lib.match_for(&src, &Settings::default(), &Filter::default(), &Scope::default()).unwrap();
    let ms = res["matches"].as_array().unwrap();
    for x in ms { println!("{:<22} {:>5.1}%  {:?} {:.1} BPM  harmonic: {} ({}), tempo {} {:+.1}%", x["path"].as_str().unwrap().rsplit('\\').next().unwrap(), x["score"].as_f64().unwrap(), x["camelot"], x["bpm"].as_f64().unwrap(), x["harmonic"]["label"], x["harmonic"]["relation"], x["tempo"]["mode"], x["tempo"]["adjustPct"].as_f64().unwrap()); }
    assert_eq!(res["source"]["camelot"], "8A");
    assert_eq!((res["candidates"].as_i64(), res["unanalysed"].as_i64()), (Some(6), Some(0)), "the library holds 6 analysed tracks; the source is excluded from the results");
    assert_eq!(ms.len(), 5, "the source never matches itself");
    let name = |i: usize| ms[i]["path"].as_str().unwrap().rsplit('\\').next().unwrap().to_string();
    let top: Vec<String> = (0..3).map(name).collect(); let bottom: Vec<String> = (3..5).map(name).collect();
    for want in ["same_Am_128.wav", "relative_C_124.wav", "neighbour_Em_126.wav"] { assert!(top.contains(&want.to_string()), "{want} should be among the best matches: {top:?}"); }
    for want in ["far_key_Fsharp_126.wav", "far_tempo_Am_160.wav"] { assert!(bottom.contains(&want.to_string()), "{want} should rank last: {bottom:?}"); }
    let by = |n: &str| ms.iter().find(|x| x["path"].as_str().unwrap().ends_with(n)).unwrap().clone();
    assert_eq!(by("same_Am_128.wav")["camelot"], "8A"); assert_eq!(by("relative_C_124.wav")["camelot"], "8B"); assert_eq!(by("neighbour_Em_126.wav")["camelot"], "9A"); assert_eq!(by("far_key_Fsharp_126.wav")["camelot"], "2B");
    assert_eq!(by("far_tempo_Am_160.wav")["tempo"]["withinLimit"], false);
    assert_eq!(by("far_tempo_Am_160.wav")["harmonic"]["label"], "Excellent", "an impossible tempo change is not also punished as a key change");
    assert_eq!(by("far_key_Fsharp_126.wav")["harmonic"]["label"], "Not Recommended");
    assert!(by("same_Am_128.wav")["tempo"]["adjustPct"].as_f64().unwrap() < -1.0, "slow the 128 BPM track down to 126");
    assert!(by("same_Am_128.wav")["score"].as_f64().unwrap() > 85.0);

    // scopes
    let only = lib.match_for(&src, &Settings::default(), &Filter::default(), &Scope { paths: Some(vec![same.clone(), nb.clone()]), ..Default::default() }).unwrap();
    assert_eq!(only["matches"].as_array().unwrap().len(), 2, "playlist scope");
    let excl = lib.match_for(&src, &Settings::default(), &Filter::default(), &Scope { exclude: vec![same.clone(), rel.clone()], ..Default::default() }).unwrap();
    assert_eq!(excl["matches"].as_array().unwrap().len(), 3, "tracks already in a playlist can be left out");
    let folder = lib.match_for(&src, &Settings::default(), &Filter::default(), &Scope { folder: Some(m.to_string_lossy().to_string().to_uppercase()), ..Default::default() }).unwrap();
    assert_eq!(folder["matches"].as_array().unwrap().len(), 5, "folder scope ignores case");
    let nowhere = lib.match_for(&src, &Settings::default(), &Filter::default(), &Scope { folder: Some("Z:\\nowhere".into()), ..Default::default() }).unwrap();
    assert_eq!(nowhere["matches"].as_array().unwrap().len(), 0);
    // filters through the library
    let f = Filter { min_score: 80.0, ..Filter::default() };
    assert!(lib.match_for(&src, &Settings::default(), &f, &Scope::default()).unwrap()["matches"].as_array().unwrap().iter().all(|x| x["score"].as_f64().unwrap() >= 80.0));
    // changing the weights changes the answer; key-lock makes tempo changes free
    let tempo_only = Settings { weights: Weights { harmonic: 0.0, bpm: 1.0, energy: 0.0, rhythm: 0.0, genre: 0.0, mood: 0.0, danceability: 0.0, spectral: 0.0, vocal: 0.0 }, ..Settings::default() };
    let t = lib.match_for(&src, &tempo_only, &Filter::default(), &Scope::default()).unwrap();
    assert!(t["matches"][0]["tempo"]["score"].as_f64().unwrap() >= t["matches"][4]["tempo"]["score"].as_f64().unwrap());
    assert_eq!(t["matches"][4]["path"].as_str().unwrap().rsplit('\\').next().unwrap(), "far_tempo_Am_160.wav", "tempo-only ranking puts the unmatchable tempo last");

    // errors
    assert!(lib.match_for("C:\\not\\in\\library.wav", &Settings::default(), &Filter::default(), &Scope::default()).unwrap_err().to_string().contains("not been analysed"));
    let bad = Settings { weights: Weights { harmonic: -5.0, ..Weights::default() }, ..Settings::default() };
    assert!(lib.match_for(&src, &bad, &Filter::default(), &Scope::default()).is_err());
    // a track that is still queued cannot be a source, and is not offered as a candidate
    let late = make("late_Dm_120", 2, true, 120.0, 9);
    lib.pause(); lib.scan(&[TrackMeta { path: late.clone(), ..Default::default() }], false).unwrap();
    assert!(lib.match_for(&late, &Settings::default(), &Filter::default(), &Scope::default()).is_err());
    let with_pending = lib.match_for(&src, &Settings::default(), &Filter::default(), &Scope::default()).unwrap();
    assert_eq!((with_pending["matches"].as_array().unwrap().len(), with_pending["unanalysed"].as_i64()), (5, Some(1)), "unanalysed tracks are reported, not guessed");
    lib.resume(); assert!(lib.wait_idle(Duration::from_secs(60)));
    assert_eq!(lib.match_for(&src, &Settings::default(), &Filter::default(), &Scope::default()).unwrap()["matches"].as_array().unwrap().len(), 6);
    lib.shutdown(); let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn matching_a_20000_track_library_through_the_database_is_fast() {
    let d = temp_dir("m20k"); let p = d.join("library.db");
    {
        let c = open_db(&p).unwrap(); let tx = c.unchecked_transaction().unwrap(); let mut rng = Rng(3);
        let cam = ["1A", "2A", "3A", "4A", "5A", "6A", "7A", "8A", "9A", "10A", "11A", "12A", "1B", "2B", "3B", "4B", "5B", "6B", "7B", "8B", "9B", "10B", "11B", "12B"];
        {
            let mut s = tx.prepare("INSERT INTO tracks (path,size,mtime,added_at,status,bpm,bpm_conf,camelot,key_conf,energy,danceability,genre,mood,mood_conf,onset_density,beat_strength,tempo_stability,time_sig,spec_low,spec_mid,spec_high,centroid,vocal,vocal_conf) VALUES (?1,1,1,1,'done',?2,0.9,?3,?4,?5,?6,?7,'Energetic / uplifting',0.4,?8,0.5,0.9,4,0.4,0.5,0.1,1800,?9,0.3)").unwrap();
            for i in 0..20000i64 { s.execute(rusqlite::params![format!("C:\\music\\t{i}.mp3"), 80.0 + rng.next() as f64 * 100.0, cam[(rng.next() * 24.0) as usize % 24], rng.next() as f64, 1 + (rng.next() * 10.0) as i64 % 10, rng.next() as f64, ["House", "Techno", "Pop", "Disco"][(rng.next() * 4.0) as usize % 4], rng.next() as f64 * 8.0, rng.next() as f64]).unwrap(); }
        }
        tx.commit().unwrap();
    }
    let lib = Library::open(&p).unwrap();
    let t = Instant::now();
    let r = lib.match_for("C:\\music\\t7.mp3", &Settings::default(), &Filter { limit: 100, ..Filter::default() }, &Scope::default()).unwrap();
    let el = t.elapsed();
    println!("matched against 20,000 analysed tracks (load + score + sort) in {el:?}");
    assert_eq!(r["candidates"], 20000); assert_eq!(r["matches"].as_array().unwrap().len(), 100);
    assert!(el < Duration::from_millis(2500), "{el:?}");
    lib.shutdown(); let _ = std::fs::remove_dir_all(&d);
}
