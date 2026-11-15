//! djengine: native audio engine for Party Mix DJ. Controlled by the UI over stdin/stdout, one JSON object per line.
use base64::Engine as _;
use djengine::analysis::analyze;
use djengine::audio::{list_devices, spawn_manager, Req, Settings};
use djengine::core::{new_engine, Command, ParamId, Shared};
use djengine::decode::decode_file;
use djengine::features::compute;
use djengine::library::{Library, TrackMeta};
use rtrb::Producer;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::atomic::Ordering::Relaxed;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

type CmdTx = Arc<Mutex<Producer<Command>>>;

fn parse_param(name: &str) -> Option<ParamId> {
    match name {
        "xf" => return Some(ParamId::Xf),
        "master" => return Some(ParamId::Master),
        "sampleVol" => return Some(ParamId::SampleVol),
        "headMix" => return Some(ParamId::HeadMix),
        "headGain" => return Some(ParamId::HeadGain),
        "filter" => return Some(ParamId::Filter),
        _ => {}
    }
    let rest = name.strip_prefix('d')?;
    let (n, key) = rest.split_once('.')?;
    let d: u8 = n.parse().ok()?;
    if d as usize >= djengine::core::MAX_DECKS { return None; }
    Some(match key { "trim" => ParamId::Trim(d), "low" => ParamId::Low(d), "mid" => ParamId::Mid(d), "high" => ParamId::High(d), "vol" => ParamId::Vol(d), "pfl" => ParamId::Pfl(d), "filter" => ParamId::DFilter(d), _ => return None })
}

fn push(tx: &CmdTx, ev: &Sender<Value>, c: Command) {
    let ok = tx.lock().map(|mut p| p.push(c).is_ok()).unwrap_or(false);
    if !ok { let _ = ev.send(json!({"evt": "warning", "message": "command queue full, command dropped"})); }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("devices") {
        println!("{}", serde_json::to_string_pretty(&list_devices()).unwrap());
        return;
    }
    run_server();
}

fn run_server() {
    #[cfg(windows)]
    unsafe {   // above-normal priority: controller commands and audio are answered promptly even when the PC is busy
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, SetPriorityClass, ABOVE_NORMAL_PRIORITY_CLASS};
        SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS);
    }
    let (events, ev_rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        let out = std::io::stdout();
        for v in ev_rx {
            let mut l = out.lock();
            if writeln!(l, "{v}").is_err() || l.flush().is_err() { std::process::exit(0); } // UI went away
        }
    });

    let (mixer, cmd_tx, mut garbage, shared) = new_engine(44100);
    let mixer = Arc::new(Mutex::new(mixer));
    let cmd_tx: CmdTx = Arc::new(Mutex::new(cmd_tx));
    let manager = spawn_manager(mixer, shared.clone(), events.clone());
    let started = Instant::now();

    // 30 Hz state feed + garbage collection of retired tracks (their deallocation must not happen on the audio thread)
    {
        let (shared, events) = (shared.clone(), events.clone());
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(33));
            while garbage.pop().is_ok() {}
            let decks: Vec<Value> = (0..2usize).map(|d| {
                let s = &shared.decks[d];
                let pk = Shared::take_peak(&s.peak);
                json!({"pos": shared.deck_pos(d), "playing": s.playing.load(Relaxed), "loaded": s.loaded.load(Relaxed), "peak": pk, "slice": s.slice_cur.load(Relaxed), "slicePend": s.slice_pend.load(Relaxed)})
            }).collect();
            let _ = events.send(json!({
                "evt": "state", "t": started.elapsed().as_secs_f64() * 1000.0, "decks": decks,
                "master": Shared::take_peak(&shared.master_peak), "cue": Shared::take_peak(&shared.cue_peak),
                "cpu": shared.cpu_x1000.load(Relaxed) as f64 / 1000.0, "xruns": shared.xruns.load(Relaxed), "clips": shared.clips.load(Relaxed),
                "samplesPlaying": shared.samples_playing.load(Relaxed), "framesRendered": shared.frames_rendered.load(Relaxed), "latencyMs": shared.latency_us.load(Relaxed) as f64 / 1000.0, "cueLatencyMs": shared.cue_lat_us.load(Relaxed) as f64 / 1000.0, "bufferFrames": shared.buffer_frames.load(Relaxed),
            }));
        });
    }

    // music library (SQLite) + background analysis queue; opened on request or from DJ_LIBRARY
    let library: Arc<Mutex<Option<Arc<Library>>>> = Arc::new(Mutex::new(None));
    let open_library = {
        let (library, events) = (library.clone(), events.clone());
        move |path: String| match Library::open(std::path::Path::new(&path)) {
            Ok(lib) => {
                let lib = Arc::new(lib);
                lib.start_workers(events.clone());
                let _ = events.send(json!({"evt": "libraryReady", "path": path, "schema": lib.schema_version(), "stats": lib.stats()}));
                if let Some(old) = library.lock().unwrap().replace(lib) { old.shutdown(); }
            }
            Err(e) => { let _ = events.send(json!({"evt": "libraryError", "message": format!("{e:#}")})); }
        }
    };
    if let Ok(p) = std::env::var("DJ_LIBRARY") { if !p.is_empty() { open_library(p); } }
    let with_lib = {
        let (library, events) = (library.clone(), events.clone());
        move |f: Box<dyn FnOnce(Arc<Library>, &Sender<Value>) + Send>| {
            let lib = library.lock().unwrap().clone();
            match lib { Some(l) => f(l, &events), None => { let _ = events.send(json!({"evt": "libraryError", "message": "library is not open"})); } }
        }
    };
    let _ = events.send(json!({"evt": "ready", "version": env!("CARGO_PKG_VERSION"), "pid": std::process::id()}));
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let v: Value = match serde_json::from_str(&line) { Ok(v) => v, Err(e) => { let _ = events.send(json!({"evt": "error", "message": format!("bad json: {e}")})); continue; } };
        let cmd = v["cmd"].as_str().unwrap_or("");
        let deck = v["deck"].as_u64().unwrap_or(0) as u8;
        let num = |k: &str| v[k].as_f64().unwrap_or(0.0);
        match cmd {
            "devices" => { let _ = events.send(json!({"evt": "devices", "devices": list_devices()})); }
            "open" => match serde_json::from_value::<Settings>(v.clone()) {
                Ok(s) => { let (rtx, _rrx) = mpsc::channel(); let _ = manager.send(Req::Open(s, rtx)); }
                Err(e) => { let _ = events.send(json!({"evt": "audioError", "message": format!("bad settings: {e}")})); }
            },
            "close" => { let _ = manager.send(Req::Close); }
            "simulateLoss" => { let _ = manager.send(Req::SimulateLoss); }
            "play" => push(&cmd_tx, &events, Command::Play(deck)),
            "pause" => push(&cmd_tx, &events, Command::Pause(deck)),
            "brake" => push(&cmd_tx, &events, Command::Brake(deck)),
            "unload" => push(&cmd_tx, &events, Command::Unload(deck)),
            "seek" => push(&cmd_tx, &events, Command::Seek { deck, pos: num("pos") }),
            "rate" => push(&cmd_tx, &events, Command::Rate { deck, rate: num("value") as f32 }),
            "loop" => push(&cmd_tx, &events, Command::Loop { deck, start: num("start"), end: num("end"), on: v["on"].as_bool().unwrap_or(false) }),
            "syncTrim" => shared.sync_trim_us.store((num("ms") * 1000.0) as i32, std::sync::atomic::Ordering::Relaxed),
            "param" => match v["name"].as_str().and_then(parse_param) {
                Some(id) => push(&cmd_tx, &events, Command::Param(id, num("value") as f32)),
                None => { let _ = events.send(json!({"evt": "error", "message": format!("unknown param {}", v["name"])})); }
            },
            "load" => {
                let (path, id) = (v["path"].as_str().unwrap_or("").to_string(), v["id"].clone());
                let (events, cmd_tx) = (events.clone(), cmd_tx.clone());
                std::thread::spawn(move || match decode_file(&path) {
                    Ok(track) => {
                        let a = analyze(&track);
                        let feat = compute(&track, &a);
                        let b64 = base64::engine::general_purpose::STANDARD;
                        let (dur, sr, frames) = (track.duration(), track.sample_rate, track.frames);
                        push(&cmd_tx, &events, Command::Load { deck, track: Arc::new(track) });
                        let _ = events.send(json!({
                            "evt": "loaded", "deck": deck, "id": id, "path": path, "duration": dur, "sampleRate": sr, "frames": frames,
                            "bpm": a.bpm, "grid": a.grid, "features": feat, "n": a.n, "amp": b64.encode(&a.amp), "col": b64.encode(&a.col),
                        }));
                    }
                    Err(e) => { let _ = events.send(json!({"evt": "loadError", "deck": deck, "id": id, "path": path, "message": e.to_string()})); }
                });
            }
            "fxEffect" => push(&cmd_tx, &events, Command::FxEffect { slot: v["slot"].as_u64().unwrap_or(0) as u8, effect: v["effect"].as_u64().unwrap_or(0) as u8 }),
            "fxOn" => push(&cmd_tx, &events, Command::FxOn { deck: v["deck"].as_u64().unwrap_or(0) as u8, slot: v["slot"].as_u64().unwrap_or(0) as u8, on: v["on"].as_bool().unwrap_or(false) }),
            "fxMode" => push(&cmd_tx, &events, Command::FxMode { deck: v["deck"].as_u64().unwrap_or(0) as u8, additive: v["additive"].as_bool().unwrap_or(false) }),
            "sampleLoad" => {
                let (slot, path) = (v["slot"].as_u64().unwrap_or(0) as u8, v["path"].as_str().unwrap_or("").to_string());
                let (events, cmd_tx) = (events.clone(), cmd_tx.clone());
                std::thread::spawn(move || match decode_file(&path) {
                    Ok(track) => { let dur = track.duration(); push(&cmd_tx, &events, Command::SampleLoad { slot, track: Arc::new(track) }); let _ = events.send(json!({"evt": "sampleLoaded", "slot": slot, "path": path, "duration": dur})); }
                    Err(e) => { let _ = events.send(json!({"evt": "sampleError", "slot": slot, "path": path, "message": e.to_string()})); }
                });
            }
            "samplePlay" => push(&cmd_tx, &events, Command::SamplePlay(v["slot"].as_u64().unwrap_or(0) as u8)),
            "sampleStop" => push(&cmd_tx, &events, Command::SampleStop(v["slot"].as_u64().unwrap_or(0) as u8)),
            "sampleUnload" => push(&cmd_tx, &events, Command::SampleUnload(v["slot"].as_u64().unwrap_or(0) as u8)),
            "keyLock" => push(&cmd_tx, &events, Command::KeyLock { deck, on: v["on"].as_bool().unwrap_or(false) }),
            "fxLevel" => push(&cmd_tx, &events, Command::FxLevel { deck: v["deck"].as_u64().unwrap_or(0) as u8, level: num("value") as f32 }),
            "fxBpm" => push(&cmd_tx, &events, Command::FxBpm(num("value") as f32)),
            "sliceCfg" => push(&cmd_tx, &events, Command::SliceCfg { deck, on: v["on"].as_bool().unwrap_or(false), start: num("start"), end: num("end"), n: v["n"].as_u64().unwrap_or(8) as u8, mode: v["mode"].as_u64().unwrap_or(0) as u8, quant: num("quant"), repeat: num("repeat"), grid: num("grid"), rev: v["rev"].as_u64().unwrap_or(0) as u16 }),
            "slicePad" => push(&cmd_tx, &events, Command::SlicePad { deck, idx: v["idx"].as_u64().unwrap_or(0) as u8, down: v["down"].as_bool().unwrap_or(false) }),
            "sliceStop" => push(&cmd_tx, &events, Command::SliceStop(deck)),
            "xy" => { let arr = |k: &str, n: usize| -> Vec<f32> { let mut o = vec![0.0f32; n]; if let Some(a) = v[k].as_array() { for (i, e) in a.iter().take(n).enumerate() { o[i] = e.as_f64().unwrap_or(0.0) as f32; } } o };
                let (w, p) = (arr("w", 4), arr("p", 8)); push(&cmd_tx, &events, Command::Xy { var: { let vv = arr("var", 4); if v["var"].is_array() { [vv[0] as u8, vv[1] as u8, vv[2] as u8, vv[3] as u8] } else { [v["ft"].as_u64().unwrap_or(0) as u8, 0, 0, 0] } }, act: num("act") as f32, w: [w[0], w[1], w[2], w[3]], p: [p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7]] }); }
            "beep" => push(&cmd_tx, &events, Command::Beep(if v["target"].as_str() == Some("cue") { 1 } else { 0 })),
            "features" => {
                // analysis only (no playback): decode + features on a worker thread, result as an event
                let (path, id) = (v["path"].as_str().unwrap_or("").to_string(), v["id"].clone());
                let events = events.clone();
                std::thread::spawn(move || match decode_file(&path) {
                    Ok(track) => { let a = analyze(&track); let f = compute(&track, &a); let _ = events.send(json!({"evt": "features", "id": id, "path": path, "features": f})); }
                    Err(e) => { let _ = events.send(json!({"evt": "featuresError", "id": id, "path": path, "message": e.to_string()})); }
                });
            }
            // ---- library
            "libraryOpen" => open_library(v["path"].as_str().unwrap_or("").to_string()),
            "libraryScan" => {
                let force = v["force"].as_bool().unwrap_or(false);
                let items: Vec<TrackMeta> = v["items"].as_array().map(|a| a.iter().map(|i| TrackMeta {
                    path: i["path"].as_str().unwrap_or("").to_string(), artist: i["artist"].as_str().map(String::from), title: i["title"].as_str().map(String::from),
                    album: i["album"].as_str().map(String::from), genre: i["genre"].as_str().map(String::from) }).collect()).unwrap_or_default();
                let id = v["id"].clone();
                with_lib(Box::new(move |lib, ev| { let ev = ev.clone(); std::thread::spawn(move || match lib.scan(&items, force) {
                    Ok(r) => { let _ = ev.send(json!({"evt": "libraryScanned", "id": id, "added": r.added, "changed": r.changed, "unchanged": r.unchanged, "missing": r.missing, "queued": r.queued})); }
                    Err(e) => { let _ = ev.send(json!({"evt": "libraryError", "message": format!("{e:#}")})); } }); }));
            }
            "libraryScanDirs" => {
                let dirs: Vec<String> = v["paths"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                let id = v["id"].clone();
                with_lib(Box::new(move |lib, ev| { let ev = ev.clone(); std::thread::spawn(move || match lib.scan_dirs(&dirs) {
                    Ok(r) => { let _ = ev.send(json!({"evt": "libraryScanned", "id": id, "added": r.added, "changed": r.changed, "unchanged": r.unchanged, "missing": r.missing, "queued": r.queued})); }
                    Err(e) => { let _ = ev.send(json!({"evt": "libraryError", "message": format!("{e:#}")})); } }); }));
            }
            "libraryReanalyze" => {
                let paths: Vec<String> = v["paths"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                with_lib(Box::new(move |lib, ev| { match lib.reanalyze(&paths) { Ok(n) => { let _ = ev.send(json!({"evt": "libraryReanalyzing", "count": n})); } Err(e) => { let _ = ev.send(json!({"evt": "libraryError", "message": format!("{e:#}")})); } } }));
            }
            "libraryGet" => {
                let paths: Vec<String> = v["paths"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                let id = v["id"].clone();
                with_lib(Box::new(move |lib, ev| { match lib.rows_by_paths(&paths) { Ok(rows) => { let _ = ev.send(json!({"evt": "libraryRows", "id": id, "rows": rows})); } Err(e) => { let _ = ev.send(json!({"evt": "libraryError", "message": format!("{e:#}")})); } } }));
            }
            "libraryRows" => {
                let (off, lim, sort, filter, id) = (v["offset"].as_i64().unwrap_or(0), v["limit"].as_i64().unwrap_or(200), v["sort"].as_str().unwrap_or("id").to_string(), v["filter"].clone(), v["id"].clone());
                with_lib(Box::new(move |lib, ev| { match lib.rows(off, lim, &sort, &filter) { Ok(rows) => { let _ = ev.send(json!({"evt": "libraryPage", "id": id, "rows": rows})); } Err(e) => { let _ = ev.send(json!({"evt": "libraryError", "message": format!("{e:#}")})); } } }));
            }
            "libraryStats" => { let id = v["id"].clone(); with_lib(Box::new(move |lib, ev| { let _ = ev.send(json!({"evt": "libraryStats", "id": id, "stats": lib.stats()})); })); }
            "libraryDuplicates" => { let id = v["id"].clone(); with_lib(Box::new(move |lib, ev| { let _ = ev.send(json!({"evt": "libraryDuplicates", "id": id, "groups": lib.duplicates().unwrap_or_default()})); })); }
            "libraryMatch" => {
                // rank the library against one analysed track (runs on a worker thread, never blocks audio or the command loop)
                let (path, id) = (v["path"].as_str().unwrap_or("").to_string(), v["id"].clone());
                let settings: djengine::matching::Settings = serde_json::from_value(v["settings"].clone()).unwrap_or_default();
                let filter: djengine::matching::Filter = serde_json::from_value(v["filter"].clone()).unwrap_or_default();
                let scope: djengine::library::Scope = serde_json::from_value(v["scope"].clone()).unwrap_or_default();
                with_lib(Box::new(move |lib, ev| { let ev = ev.clone(); std::thread::spawn(move || match lib.match_for(&path, &settings, &filter, &scope) {
                    Ok(mut r) => { r["id"] = id; r["evt"] = json!("libraryMatches"); let _ = ev.send(r); }
                    Err(e) => { let _ = ev.send(json!({"evt": "libraryMatchError", "id": id, "message": format!("{e:#}")})); } }); }));
            }
            "libraryAnalyzeSequence" => {
                let paths: Vec<String> = v["paths"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                let settings: djengine::matching::Settings = serde_json::from_value(v["settings"].clone()).unwrap_or_default();
                let id = v["id"].clone();
                with_lib(Box::new(move |lib, ev| { let ev = ev.clone(); std::thread::spawn(move || match lib.analyze_sequence(&paths, &settings) {
                    Ok(mut r) => { r["id"] = id; r["evt"] = json!("librarySequence"); let _ = ev.send(r); }
                    Err(e) => { let _ = ev.send(json!({"evt": "librarySequenceError", "id": id, "message": format!("{e:#}")})); } }); }));
            }
            "libraryPause" => with_lib(Box::new(|lib, _| lib.pause())),
            "libraryResume" => with_lib(Box::new(|lib, _| lib.resume())),
            "libraryConfig" => {
                let (w, c) = (v["workers"].as_u64(), v["cpuLimit"].as_u64());
                with_lib(Box::new(move |lib, _| { if let Some(w) = w { lib.set_workers(w as usize); } if let Some(c) = c { lib.set_cpu_limit(c as u32); } }));
            }
            "libraryFavorite" => { let (p, f) = (v["path"].as_str().unwrap_or("").to_string(), v["favorite"].as_bool().unwrap_or(false)); with_lib(Box::new(move |lib, _| { let _ = lib.set_favorite(&p, f); })); }
            "libraryPlayed" => { let p = v["path"].as_str().unwrap_or("").to_string(); with_lib(Box::new(move |lib, _| { let _ = lib.mark_played(&p); })); }
            "ping" => { let _ = events.send(json!({"evt": "pong", "id": v["id"]})); }
            "quit" => break,
            other => { let _ = events.send(json!({"evt": "error", "message": format!("unknown command '{other}'")})); }
        }
    }
    let _ = manager.send(Req::Close);
    std::thread::sleep(Duration::from_millis(100));
}
