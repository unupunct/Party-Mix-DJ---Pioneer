//! Tests for the SQLite library and the analysis queue (H2). Run: `cargo test --release`
mod common;
use common::*;
use djengine::features::camelot;
use djengine::library::*;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn cols(c: &Connection) -> Vec<String> {
    let mut s = c.prepare("PRAGMA table_info(tracks)").unwrap();
    s.query_map([], |r| r.get::<_, String>(1)).unwrap().filter_map(|x| x.ok()).collect()
}
fn version(c: &Connection) -> i64 { c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap() }
fn meta(p: &PathBuf) -> TrackMeta { TrackMeta { path: p.to_string_lossy().to_string(), ..Default::default() } }
fn lib_with_workers(dir: &PathBuf, workers: usize) -> (Library, mpsc::Receiver<serde_json::Value>) {
    let lib = Library::open(&dir.join("library.db")).unwrap();
    lib.set_workers(workers);
    let (tx, rx) = mpsc::channel();
    lib.start_workers(tx);
    (lib, rx)
}
fn make_tracks(dir: &PathBuf, n: usize, secs: f32) -> Vec<PathBuf> {
    (0..n).map(|i| {
        let p = dir.join(format!("t{i:03}.wav"));
        write_wav(&p, 22050, &click(22050, secs, 100.0 + i as f32 * 2.0, 0.1, 0.7));
        p
    }).collect()
}

#[test]
fn migrations_go_up_down_and_up_again_without_losing_data() {
    let d = temp_dir("mig");
    let p = d.join("library.db");
    let c = open_db(&p).unwrap();
    assert_eq!(version(&c), SCHEMA_VERSION);
    c.execute("INSERT INTO tracks (path,size,mtime,added_at,artist,bpm) VALUES ('a.mp3',1,1,1,'Art',124.0)", []).unwrap();
    c.execute("UPDATE tracks SET favorite=1, play_count=3", []).unwrap();
    migrate_to(&c, 1).unwrap();
    assert_eq!(version(&c), 1);
    assert!(!cols(&c).contains(&"favorite".to_string()), "v2 columns must be gone after rollback");
    assert_eq!(c.query_row("SELECT bpm FROM tracks", [], |r| r.get::<_, f64>(0)).unwrap(), 124.0, "v1 data survives rolling back v2");
    migrate_to(&c, 2).unwrap();
    assert!(cols(&c).contains(&"favorite".to_string()));
    assert_eq!(c.query_row("SELECT favorite FROM tracks", [], |r| r.get::<_, i64>(0)).unwrap(), 0, "re-applied column starts at its default");
    migrate_to(&c, 0).unwrap();
    assert_eq!(version(&c), 0);
    assert!(c.prepare("SELECT 1 FROM tracks").is_err(), "table removed at version 0");
    migrate_to(&c, SCHEMA_VERSION).unwrap();
    assert_eq!(version(&c), SCHEMA_VERSION);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn upgrading_an_existing_database_makes_a_backup_first() {
    let d = temp_dir("bak");
    let p = d.join("library.db");
    {
        let c = Connection::open(&p).unwrap();
        migrate_to(&c, 1).unwrap();
        c.execute("INSERT INTO tracks (path,size,mtime,added_at,artist) VALUES ('x.mp3',5,5,5,'Keep Me')", []).unwrap();
    }
    let c = open_db(&p).unwrap();
    assert_eq!(version(&c), SCHEMA_VERSION);
    let baks: Vec<_> = std::fs::read_dir(&d).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().contains(".bak-v1-")).collect();
    assert_eq!(baks.len(), 1, "exactly one backup of the v1 database expected");
    let b = Connection::open(baks[0].path()).unwrap();
    assert_eq!(version(&b), 1, "the backup is the pre-migration state");
    assert_eq!(b.query_row("SELECT artist FROM tracks", [], |r| r.get::<_, String>(0)).unwrap(), "Keep Me");
    assert_eq!(c.query_row("SELECT artist FROM tracks", [], |r| r.get::<_, String>(0)).unwrap(), "Keep Me");
    drop(b);
    drop(c);
    for _ in 0..7 {
        { let c = Connection::open(&p).unwrap(); migrate_to(&c, 1).unwrap(); }
        std::thread::sleep(Duration::from_millis(1100));
        drop(open_db(&p).unwrap());
    }
    let n = std::fs::read_dir(&d).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().contains(".bak-")).count();
    assert!(n <= 5, "old backups are pruned, found {n}");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn a_database_from_a_newer_app_is_refused_not_damaged() {
    let d = temp_dir("new");
    let p = d.join("library.db");
    { let c = open_db(&p).unwrap(); c.pragma_update(None, "user_version", 99).unwrap(); }
    let err = open_db(&p).err().expect("must refuse").to_string();
    assert!(err.contains("newer"), "{err}");
    let c = Connection::open(&p).unwrap();
    assert_eq!(version(&c), 99, "left untouched");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn incremental_scan_analyses_each_file_once_and_tracks_changes() {
    let d = temp_dir("scan");
    let music = d.join("music");
    std::fs::create_dir_all(&music).unwrap();
    let files = make_tracks(&music, 5, 12.0);
    let (lib, _rx) = lib_with_workers(&d, 2);
    let items: Vec<_> = files.iter().map(meta).collect();
    let r = lib.scan(&items, false).unwrap();
    assert_eq!((r.added, r.queued, r.unchanged), (5, 5, 0));
    assert!(lib.wait_idle(Duration::from_secs(60)));
    assert_eq!(lib.progress().done, 5);
    // second scan: nothing to do
    let r = lib.scan(&items, false).unwrap();
    assert_eq!((r.added, r.changed, r.unchanged, r.queued), (0, 0, 5, 0), "unchanged files must not be re-analysed");
    assert!(lib.is_idle());
    // modify one file: exactly that one is re-queued
    std::thread::sleep(Duration::from_millis(20));
    write_wav(&files[2], 22050, &click(22050, 12.0, 133.0, 0.1, 0.7));
    let r = lib.scan(&items, false).unwrap();
    assert_eq!((r.changed, r.unchanged, r.queued), (1, 4, 1));
    assert!(lib.wait_idle(Duration::from_secs(60)));
    let row = &lib.rows_by_paths(&[files[2].to_string_lossy().to_string()]).unwrap()[0];
    assert!((row["bpm"].as_f64().unwrap() - 133.0).abs() < 1.0, "re-analysed at the new tempo: {}", row["bpm"]);
    // delete one: marked missing, row kept
    std::fs::remove_file(&files[0]).unwrap();
    let r = lib.scan(&items, false).unwrap();
    assert_eq!(r.missing, 1);
    assert_eq!(lib.stats()["missing"], 1);
    assert_eq!(lib.stats()["tracks"], 5, "missing files stay in the library");
    // it comes back: analysed again
    write_wav(&files[0], 22050, &click(22050, 12.0, 100.0, 0.1, 0.7));
    let r = lib.scan(&items, false).unwrap();
    assert_eq!(r.changed, 1);
    assert!(lib.wait_idle(Duration::from_secs(60)));
    assert_eq!(lib.stats()["analyzed"], 5);
    // forced re-scan re-queues everything
    assert_eq!(lib.scan(&items, true).unwrap().queued, 5);
    assert!(lib.wait_idle(Duration::from_secs(60)));
    lib.shutdown();
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn stored_results_are_the_real_analysis() {
    let d = temp_dir("res");
    let music = d.join("m");
    std::fs::create_dir_all(&music).unwrap();
    let p = music.join("a_minor_126.wav");
    write_wav(&p, 22050, &tonal_with_beat(22050, 30.0, 9, true, 126.0, 5));
    let (lib, rx) = lib_with_workers(&d, 1);
    lib.scan(&[TrackMeta { path: p.to_string_lossy().to_string(), artist: Some("Tester".into()), title: Some("Am groove".into()), genre: Some("House".into()), ..Default::default() }], false).unwrap();
    assert!(lib.wait_idle(Duration::from_secs(60)));
    let r = &lib.rows_by_paths(&[p.to_string_lossy().to_string()]).unwrap()[0];
    println!("{r}");
    assert_eq!(r["status"], "done");
    assert_eq!(r["camelot"], camelot(9, true).as_str(), "key");
    assert!(r["keyConf"].as_f64().unwrap() > 0.4);
    assert!((r["bpm"].as_f64().unwrap() - 126.0).abs() < 0.8, "bpm {}", r["bpm"]);
    assert!((r["duration"].as_f64().unwrap() - 30.0).abs() < 0.1);
    assert!((1..=10).contains(&r["energy"].as_i64().unwrap()));
    assert_eq!((r["artist"].as_str(), r["genre"].as_str()), (Some("Tester"), Some("House")), "tags kept");
    assert_eq!(r["fingerprint"].as_str().unwrap().len(), 16);
    assert_eq!(r["engineVersion"], 1);
    let ev = rx.try_iter().find(|e| e["evt"] == "trackAnalyzed").expect("trackAnalyzed event");
    assert_eq!(ev["row"]["camelot"], "8A");
    lib.shutdown();
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn bad_files_are_reported_not_retried_and_never_touched() {
    let d = temp_dir("bad");
    let m = d.join("m");
    std::fs::create_dir_all(&m).unwrap();
    let junk = m.join("junk.mp3");
    std::fs::write(&junk, vec![0x42u8; 4000]).unwrap();
    let wma = m.join("old.wma");
    std::fs::write(&wma, b"not really a wma file").unwrap();
    let empty = m.join("empty.wav");
    std::fs::write(&empty, b"").unwrap();
    let good = m.join("ok.wav");
    write_wav(&good, 22050, &click(22050, 12.0, 120.0, 0.1, 0.7));
    let all = [&junk, &wma, &empty, &good];
    let before: Vec<_> = all.iter().map(|p| file_digest(p)).collect();
    let (lib, _rx) = lib_with_workers(&d, 2);
    let items: Vec<_> = all.iter().map(|p| meta(p)).collect();
    lib.scan(&items, false).unwrap();
    assert!(lib.wait_idle(Duration::from_secs(60)));
    let st = lib.stats();
    assert_eq!((st["analyzed"].as_i64(), st["errors"].as_i64()), (Some(1), Some(3)), "{st}");
    for p in [&junk, &wma, &empty] {
        let r = &lib.rows_by_paths(&[p.to_string_lossy().to_string()]).unwrap()[0];
        assert_eq!(r["status"], "error");
        assert!(!r["error"].as_str().unwrap().is_empty(), "reason for {p:?}");
    }
    let r = lib.scan(&items, false).unwrap();
    assert_eq!((r.queued, r.unchanged), (0, 4), "failed files are not retried until they change");
    assert_eq!(lib.reanalyze(&[junk.to_string_lossy().to_string()]).unwrap(), 1, "but the user can retry explicitly");
    assert!(lib.wait_idle(Duration::from_secs(30)));
    let after: Vec<_> = all.iter().map(|p| file_digest(p)).collect();
    assert_eq!(before, after, "original files must be byte-identical with unchanged modification times");
    assert_eq!(std::fs::read_dir(&m).unwrap().count(), 4, "no files created next to the music");
    lib.shutdown();
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn pause_holds_the_queue_and_resume_finishes_it() {
    let d = temp_dir("pause");
    let m = d.join("m");
    std::fs::create_dir_all(&m).unwrap();
    let files = make_tracks(&m, 6, 15.0);
    let items: Vec<_> = files.iter().map(meta).collect();
    let (lib, _rx) = lib_with_workers(&d, 2);
    lib.pause();
    lib.scan(&items, false).unwrap();
    std::thread::sleep(Duration::from_millis(700));
    let p = lib.progress();
    assert_eq!((p.done, p.running, p.pending, p.paused), (0, 0, 6, true), "nothing runs while paused");
    lib.resume();
    assert!(lib.wait_idle(Duration::from_secs(60)));
    assert_eq!(lib.progress().done, 6);
    lib.pause();
    lib.scan(&items, true).unwrap();
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(lib.progress().pending, 6);
    lib.resume();
    assert!(lib.wait_idle(Duration::from_secs(60)));
    lib.shutdown();
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn several_workers_really_run_in_parallel_and_respect_the_limit() {
    let d = temp_dir("par");
    let m = d.join("m");
    std::fs::create_dir_all(&m).unwrap();
    let files = make_tracks(&m, 12, 40.0);
    let items: Vec<_> = files.iter().map(meta).collect();
    let (lib, _rx) = lib_with_workers(&d, 1);
    lib.pause();
    lib.scan(&items, false).unwrap();
    lib.resume();
    let (mut max1, t0) = (0, Instant::now());
    while !lib.is_idle() && t0.elapsed() < Duration::from_secs(120) { max1 = max1.max(lib.progress().running); std::thread::sleep(Duration::from_millis(3)); }
    let one = t0.elapsed();
    assert_eq!(max1, 1, "a worker limit of 1 must never run two analyses");
    lib.set_workers(3);
    lib.pause();
    lib.scan(&items, true).unwrap();
    lib.resume();
    let (mut max3, t1) = (0, Instant::now());
    while !lib.is_idle() && t1.elapsed() < Duration::from_secs(120) { max3 = max3.max(lib.progress().running); std::thread::sleep(Duration::from_millis(3)); }
    let three = t1.elapsed();
    println!("12 tracks x 40 s: 1 worker {:.2}s, 3 workers {:.2}s (max concurrent {max3})", one.as_secs_f32(), three.as_secs_f32());
    assert!((2..=3).contains(&max3), "expected parallelism, saw {max3}");
    assert_eq!(lib.progress().done, 24);
    lib.shutdown();
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn cpu_limit_makes_workers_rest_in_proportion() {
    // deterministic (independent of how busy the PC is): at a 25 % limit every worker sleeps 3x as long as it worked
    let d = temp_dir("cpu");
    let m = d.join("m");
    std::fs::create_dir_all(&m).unwrap();
    let files = make_tracks(&m, 6, 20.0);
    let items: Vec<_> = files.iter().map(meta).collect();
    let (lib, _rx) = lib_with_workers(&d, 1);
    lib.set_cpu_limit(100);
    lib.scan(&items, false).unwrap();
    assert!(lib.wait_idle(Duration::from_secs(120)));
    let full = lib.progress();
    assert_eq!(full.throttle_ms, 0, "no resting at 100 %");
    assert!(full.busy_ms > 0);
    lib.set_cpu_limit(25);
    lib.scan(&items, true).unwrap();
    assert!(lib.wait_idle(Duration::from_secs(300)));
    let lim = lib.progress();
    let (busy, rest) = ((lim.busy_ms - full.busy_ms) as f64, lim.throttle_ms as f64);
    println!("cpu limit 25 %: worked {busy:.0} ms, rested {rest:.0} ms (ratio {:.2}, expected 3.0)", rest / busy);
    assert!((rest / busy - 3.0).abs() < 0.15, "rest/work ratio {}", rest / busy);
    lib.shutdown();
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn fingerprints_detect_changes_and_duplicates() {
    let d = temp_dir("fp");
    let m = d.join("m");
    std::fs::create_dir_all(&m).unwrap();
    let a = m.join("a.wav");
    write_wav(&a, 22050, &click(22050, 12.0, 120.0, 0.1, 0.7));
    let b = m.join("copy_of_a.wav");
    std::fs::copy(&a, &b).unwrap();
    let c = m.join("other.wav");
    write_wav(&c, 22050, &click(22050, 12.0, 90.0, 0.1, 0.7));
    assert_eq!(fingerprint(a.to_str().unwrap()).unwrap(), fingerprint(b.to_str().unwrap()).unwrap());
    assert_ne!(fingerprint(a.to_str().unwrap()).unwrap(), fingerprint(c.to_str().unwrap()).unwrap());
    let (lib, _rx) = lib_with_workers(&d, 2);
    lib.scan(&[meta(&a), meta(&b), meta(&c)], false).unwrap();
    assert!(lib.wait_idle(Duration::from_secs(60)));
    let dups = lib.duplicates().unwrap();
    assert_eq!(dups.len(), 1);
    assert_eq!(dups[0].len(), 2);
    assert!(dups[0].iter().any(|p| p.ends_with("a.wav")) && dups[0].iter().any(|p| p.ends_with("copy_of_a.wav")));
    lib.shutdown();
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn unfinished_work_resumes_after_a_crash_and_user_data_survives_reanalysis() {
    let d = temp_dir("crash");
    let m = d.join("m");
    std::fs::create_dir_all(&m).unwrap();
    let files = make_tracks(&m, 3, 12.0);
    let items: Vec<_> = files.iter().map(meta).collect();
    { let lib = Library::open(&d.join("library.db")).unwrap(); lib.scan(&items, false).unwrap(); lib.shutdown(); } // queued, never analysed: "crash"
    { let c = Connection::open(d.join("library.db")).unwrap(); c.execute("UPDATE tracks SET status='analyzing' WHERE id=1", []).unwrap(); } // died mid-analysis
    let (lib, _rx) = lib_with_workers(&d, 2);
    assert!(lib.wait_idle(Duration::from_secs(60)));
    assert_eq!(lib.stats()["analyzed"], 3, "queued and half-done work is picked up again after a restart");
    let p = files[1].to_string_lossy().to_string();
    lib.set_favorite(&p, true).unwrap();
    lib.mark_played(&p).unwrap();
    lib.mark_played(&p).unwrap();
    lib.reanalyze(&[p.clone()]).unwrap();
    assert!(lib.wait_idle(Duration::from_secs(30)));
    let r = &lib.rows_by_paths(&[p]).unwrap()[0];
    assert_eq!((r["favorite"].as_bool(), r["playCount"].as_i64()), (Some(true), Some(2)), "favourites and play counts survive re-analysis");
    lib.shutdown();
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn a_20000_track_library_stays_fast() {
    let d = temp_dir("big");
    let p = d.join("library.db");
    {
        let c = open_db(&p).unwrap();
        let tx = c.unchecked_transaction().unwrap();
        let cam = ["1A", "2A", "3A", "4A", "5A", "6A", "7A", "8A", "9A", "10A", "11A", "12A", "1B", "2B", "3B", "4B", "5B", "6B", "7B", "8B", "9B", "10B", "11B", "12B"];
        let mut rng = Rng(77);
        {
            let mut s = tx.prepare("INSERT INTO tracks (path,size,mtime,added_at,status,artist,title,bpm,camelot,energy,fingerprint) VALUES (?1,?2,?3,?4,'done',?5,?6,?7,?8,?9,?10)").unwrap();
            for i in 0..20000i64 {
                s.execute(rusqlite::params![format!("C:\\music\\t{i}.mp3"), 5_000_000 + i, 1_700_000_000_000i64 + i, 1, format!("Artist {}", i % 700), format!("Title {i}"),
                    70.0 + rng.next() as f64 * 110.0, cam[(rng.next() * 24.0) as usize % 24], 1 + (rng.next() * 10.0) as i64 % 10, format!("{:016x}", i)]).unwrap();
            }
        }
        tx.commit().unwrap();
    }
    let lib = Library::open(&p).unwrap();
    assert_eq!(lib.track_count(), 20000);
    let f = serde_json::json!({"bpmMin": 120.0, "bpmMax": 128.0, "camelot": "8A", "energyMin": 6});
    let t = Instant::now();
    let hits = lib.rows(0, 100, "bpm", &f).unwrap();
    let q1 = t.elapsed();
    let c = Connection::open(&p).unwrap();
    let want: i64 = c.query_row("SELECT COUNT(*) FROM tracks WHERE bpm>=120 AND bpm<=128 AND camelot='8A' AND energy>=6", [], |r| r.get(0)).unwrap();
    assert_eq!(hits.len() as i64, want.min(100));
    assert!(hits.iter().all(|r| r["camelot"] == "8A" && r["bpm"].as_f64().unwrap() >= 120.0));
    let paths: Vec<String> = (0..500).map(|i| format!("C:\\music\\t{}.mp3", i * 37)).collect();
    let t = Instant::now();
    let got = lib.rows_by_paths(&paths).unwrap();
    let q2 = t.elapsed();
    assert_eq!(got.len(), 500);
    let t = Instant::now();
    let _ = lib.stats();
    let q3 = t.elapsed();
    let t = Instant::now();
    let page = lib.rows(10000, 200, "artist", &serde_json::json!({})).unwrap();
    let q4 = t.elapsed();
    assert_eq!(page.len(), 200);
    println!("20k tracks: filter query {q1:?}, 500 path lookups {q2:?}, stats {q3:?}, sorted page {q4:?}");
    assert!(q1 < Duration::from_millis(150) && q2 < Duration::from_millis(250) && q3 < Duration::from_millis(150) && q4 < Duration::from_millis(250));
    lib.shutdown();
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn scanning_querying_and_analysing_at_the_same_time_is_safe() {
    let d = temp_dir("conc");
    let m = d.join("m");
    std::fs::create_dir_all(&m).unwrap();
    let files = make_tracks(&m, 20, 12.0);
    let items: Vec<_> = files.iter().map(meta).collect();
    let (lib, _rx) = lib_with_workers(&d, 3);
    let lib = std::sync::Arc::new(lib);
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let readers: Vec<_> = (0..3).map(|_| {
        let (l, s, it) = (lib.clone(), stop.clone(), items.clone());
        std::thread::spawn(move || {
            let mut n = 0;
            while !s.load(std::sync::atomic::Ordering::Relaxed) {
                l.stats();
                l.rows(0, 50, "bpm", &serde_json::json!({})).unwrap();
                l.rows_by_paths(&[it[n % it.len()].path.clone()]).unwrap();
                n += 1;
            }
            n
        })
    }).collect();
    lib.scan(&items, false).unwrap();
    lib.scan(&items, false).unwrap();
    lib.reanalyze(&[items[3].path.clone()]).unwrap();
    assert!(lib.wait_idle(Duration::from_secs(120)));
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let reads: usize = readers.into_iter().map(|h| h.join().expect("reader panicked")).sum();
    assert!(reads > 50);
    assert_eq!(lib.stats()["analyzed"], 20);
    lib.shutdown();
    let _ = std::fs::remove_dir_all(&d);
}
