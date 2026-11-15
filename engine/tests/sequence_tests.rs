//! Tests for the playlist/set overview (H4): distributions, transitions and problem detection. Run: `cargo test --release`
mod common;
use common::temp_dir;
use djengine::library::*;
use djengine::matching::{Settings, Weights};
use rusqlite::params;

/// (path, camelot, bpm, energy, genre, duration, status)
type Row = (&'static str, Option<&'static str>, f64, i64, Option<&'static str>, f64, &'static str);

fn lib_with(rows: &[Row]) -> (Library, std::path::PathBuf) {
    let d = temp_dir("seq");
    {
        let c = open_db(&d.join("library.db")).unwrap();
        for (i, r) in rows.iter().enumerate() {
            c.execute("INSERT INTO tracks (path,size,mtime,added_at,status,camelot,key_conf,bpm,bpm_conf,energy,danceability,genre,mood,mood_conf,onset_density,beat_strength,tempo_stability,time_sig,spec_low,spec_mid,spec_high,centroid,vocal,vocal_conf,duration,title) VALUES (?1,1,1,1,?2,?3,1.0,?4,1.0,?5,0.8,?6,'Energetic / uplifting',0.5,4.0,0.6,0.95,4,0.4,0.5,0.1,1500,0.1,0.3,?7,?8)",
                params![r.0, r.6, r.1, r.2, r.3, r.4, r.5, format!("T{i}")]).unwrap();
        }
    }
    (Library::open(&d.join("library.db")).unwrap(), d)
}
fn paths(rows: &[Row]) -> Vec<String> { rows.iter().map(|r| r.0.to_string()).collect() }

const SET: [Row; 6] = [
    ("p0", Some("8A"), 126.0, 7, Some("House"), 200.0, "done"),
    ("p1", Some("9A"), 128.0, 7, Some("House"), 210.0, "done"),
    ("p2", Some("9A"), 90.0, 3, Some("House"), 180.0, "done"),     // tempo gap + energy drop after p1
    ("p3", Some("2B"), 128.0, 8, Some("Techno"), 190.0, "done"),   // tempo gap + harmonic clash + energy jump after p2
    ("p4", Some("2B"), 128.0, 8, Some("Techno"), 205.0, "done"),   // identical to p3: perfect
    ("p5", None, 0.0, 0, None, 0.0, "pending"),                    // queued, not analysed yet
];

#[test]
fn overview_counts_distributions_and_order() {
    let (lib, d) = lib_with(&SET);
    let mut p = paths(&SET); p.push("never-seen.mp3".into());
    let r = lib.analyze_sequence(&p, &Settings::default()).unwrap();
    assert_eq!((r["total"].as_i64(), r["analysed"].as_i64()), (Some(7), Some(5)));
    let un: Vec<&str> = r["unanalysed"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
    assert_eq!(un, vec!["p5", "never-seen.mp3"], "missing analysis is listed, not guessed");
    assert!((r["durationS"].as_f64().unwrap() - 985.0).abs() < 1e-6);
    let bins = r["bpmBins"].as_array().unwrap(); assert_eq!((r["bpmBinStart"].as_i64(), r["bpmBinWidth"].as_i64()), (Some(60), Some(5)));
    assert_eq!((bins[13].as_i64(), bins[6].as_i64(), bins.iter().map(|b| b.as_i64().unwrap()).sum::<i64>()), (Some(4), Some(1), 5), "126/128/128/128 in the 125-130 bin, 90 in the 90-95 bin");
    assert_eq!((r["keys"]["8A"].as_i64(), r["keys"]["9A"].as_i64(), r["keys"]["2B"].as_i64()), (Some(1), Some(2), Some(2)));
    let e: Vec<i64> = r["energy"].as_array().unwrap().iter().map(|x| x.as_i64().unwrap()).collect();
    assert_eq!((e[6], e[2], e[7]), (2, 1, 2)); assert_eq!(e.iter().sum::<i64>(), 5);
    assert_eq!(r["genres"][0], serde_json::json!(["House", 3])); assert_eq!(r["genres"][1], serde_json::json!(["Techno", 2]));
    let s = r["series"].as_array().unwrap(); assert_eq!(s.len(), 7);
    for (i, want) in ["p0", "p1", "p2", "p3", "p4", "p5", "never-seen.mp3"].iter().enumerate() { assert_eq!(s[i]["path"], *want, "order is kept"); }
    assert!(s[5]["energy"].is_null() && s[0]["camelot"] == "8A");
    lib.shutdown(); let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn transitions_and_problem_detection() {
    let (lib, d) = lib_with(&SET);
    let r = lib.analyze_sequence(&paths(&SET), &Settings::default()).unwrap();
    let t = r["transitions"].as_array().unwrap();
    assert_eq!(r["transitionCount"], 4, "only neighbouring analysed tracks form a transition");
    assert_eq!(t.iter().map(|x| x["index"].as_i64().unwrap()).collect::<Vec<_>>(), vec![0, 1, 2, 3]);
    for x in t { println!("{} -> {}: {:.1}% harmonic {} tempo {} {:+.1}% dE {}", x["index"], x["index"].as_i64().unwrap() + 1, x["score"].as_f64().unwrap(), x["harmonicLabel"], x["tempoMode"], x["tempoAdjustPct"].as_f64().unwrap(), x["energyDelta"]); }
    assert!(t[0]["score"].as_f64().unwrap() > 85.0, "8A 126 -> 9A 128 is smooth");
    assert!(t[3]["score"].as_f64().unwrap() > 99.0, "identical neighbours");
    assert_eq!((t[1]["withinLimit"].as_bool(), t[1]["energyDelta"].as_i64(), t[1]["tempoMode"].as_str()), (Some(false), Some(-4), Some("direct")));
    assert_eq!(t[2]["energyDelta"], 5);
    let problems = r["problems"].as_array().unwrap();
    assert_eq!(problems.iter().map(|x| x["index"].as_i64().unwrap()).collect::<Vec<_>>(), vec![1, 2], "only the two bad transitions are flagged");
    let reasons = |i: usize| problems[i]["reasons"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect::<Vec<_>>().join(" | ");
    assert!(reasons(0).contains("tempo gap") && reasons(0).contains("energy jump -4"), "{}", reasons(0));
    assert!(reasons(1).contains("tempo gap") && reasons(1).contains("harmonic clash (9A -> 2B)") && reasons(1).contains("energy jump +5"), "{}", reasons(1));
    assert_eq!((problems[0]["from"].as_str(), problems[0]["to"].as_str()), (Some("p1"), Some("p2")));
    assert_eq!(r["smoothShare"].as_f64().unwrap(), 0.5);
    let mean = r["meanTransition"].as_f64().unwrap(); assert!((50.0..80.0).contains(&mean), "{mean}");
    lib.shutdown(); let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn settings_change_what_counts_as_a_problem() {
    let (lib, d) = lib_with(&SET);
    let wide = Settings { pitch_limit: 50.0, keylock: true, ..Settings::default() };
    let r = lib.analyze_sequence(&paths(&SET), &wide).unwrap();
    let reasons: String = r["problems"].as_array().unwrap().iter().flat_map(|p| p["reasons"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string())).collect::<Vec<_>>().join(" | ");
    assert!(!reasons.contains("tempo gap"), "a 50 % pitch limit makes 128 <-> 90 BPM matchable: {reasons}");
    assert!(reasons.contains("harmonic clash") && reasons.contains("energy jump"), "{reasons}");
    let bad = Settings { weights: Weights { harmonic: -1.0, ..Weights::default() }, ..Settings::default() };
    assert!(lib.analyze_sequence(&paths(&SET), &bad).is_err());
    lib.shutdown(); let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn empty_and_fully_unanalysed_lists_are_safe() {
    let (lib, d) = lib_with(&SET);
    let r = lib.analyze_sequence(&[], &Settings::default()).unwrap();
    assert_eq!((r["total"].as_i64(), r["analysed"].as_i64(), r["transitionCount"].as_i64()), (Some(0), Some(0), Some(0)));
    assert!(r["meanTransition"].is_null() && r["smoothShare"].is_null() && r["problems"].as_array().unwrap().is_empty());
    let r = lib.analyze_sequence(&["p5".to_string(), "nope".to_string()], &Settings::default()).unwrap();
    assert_eq!((r["analysed"].as_i64(), r["unanalysed"].as_array().unwrap().len()), (Some(0), 2));
    assert!(r["meanTransition"].is_null());
    let single = lib.analyze_sequence(&["p0".to_string()], &Settings::default()).unwrap();
    assert_eq!((single["analysed"].as_i64(), single["transitionCount"].as_i64()), (Some(1), Some(0)));
    lib.shutdown(); let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn a_2000_track_playlist_is_summarised_quickly() {
    let mut rows: Vec<Row> = Vec::new();
    let cam = ["8A", "9A", "10A", "8B", "9B", "3B", "5A", "11B"];
    for i in 0..2000usize { rows.push((Box::leak(format!("t{i}").into_boxed_str()), Some(cam[i % 8]), 100.0 + (i % 40) as f64, 1 + (i % 10) as i64, Some(["House", "Techno", "Disco"][i % 3]), 240.0, "done")); }
    let (lib, d) = lib_with(&rows);
    let t = std::time::Instant::now();
    let r = lib.analyze_sequence(&paths(&rows), &Settings::default()).unwrap();
    let el = t.elapsed();
    println!("2,000-track playlist overview in {el:?}");
    assert_eq!((r["total"].as_i64(), r["transitionCount"].as_i64()), (Some(2000), Some(1999)));
    assert!(el.as_millis() < 2000, "{el:?}");
    lib.shutdown(); let _ = std::fs::remove_dir_all(&d);
}
