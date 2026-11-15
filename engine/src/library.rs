//! Music library database (SQLite) and background analysis queue (H2).
//!
//! Rules this module keeps:
//! * Music files are only ever opened read-only; nothing is written, moved, renamed or deleted.
//! * Schema changes are numbered, reversible migrations; the database file is backed up first.
//! * Unchanged files (same size + modification time + engine version) are never analysed twice.
//! * Missing files are marked `missing`, never deleted from the library.
//! * Analysis runs on low-priority worker threads that can be paused, limited in number and in CPU share.
use crate::analysis::analyze;
use crate::decode::decode_file;
use crate::features::{compute, ENGINE_VERSION};
use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering::Relaxed};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const SCHEMA_VERSION: i64 = 3;
pub const MAX_WORKERS: usize = 4;
const AUDIO_EXT: [&str; 11] = ["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "aif", "aiff", "wma", "alac"];

struct Migration { up: &'static str, down: &'static str }
const MIGRATIONS: [Migration; 3] = [
    // v1: tracks with analysis results
    Migration {
        up: "CREATE TABLE tracks (
                id INTEGER PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                size INTEGER NOT NULL,
                mtime INTEGER NOT NULL,
                fingerprint TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                error TEXT,
                artist TEXT, title TEXT, album TEXT, genre TEXT,
                duration REAL, bpm REAL, bpm_conf REAL,
                key_name TEXT, camelot TEXT, key_conf REAL,
                energy INTEGER, danceability REAL, mood TEXT,
                features TEXT,
                analyzed_at INTEGER, engine_version INTEGER,
                added_at INTEGER NOT NULL
             );
             CREATE INDEX idx_tracks_status ON tracks(status);
             CREATE INDEX idx_tracks_bpm ON tracks(bpm);
             CREATE INDEX idx_tracks_camelot ON tracks(camelot);
             CREATE INDEX idx_tracks_energy ON tracks(energy);
             CREATE INDEX idx_tracks_fingerprint ON tracks(fingerprint);
             CREATE INDEX idx_tracks_artist_title ON tracks(artist, title);",
        down: "DROP TABLE tracks;",
    },
    // v2: listening history and favourites
    Migration {
        up: "ALTER TABLE tracks ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE tracks ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE tracks ADD COLUMN last_played INTEGER;
             CREATE INDEX idx_tracks_favorite ON tracks(favorite);",
        down: "DROP INDEX idx_tracks_favorite;
               ALTER TABLE tracks DROP COLUMN favorite;
               ALTER TABLE tracks DROP COLUMN play_count;
               ALTER TABLE tracks DROP COLUMN last_played;",
    },
    // v3: numeric feature columns for matching (backfilled from the stored feature JSON of already-analysed tracks)
    Migration {
        up: "ALTER TABLE tracks ADD COLUMN onset_density REAL;
             ALTER TABLE tracks ADD COLUMN beat_strength REAL;
             ALTER TABLE tracks ADD COLUMN tempo_stability REAL;
             ALTER TABLE tracks ADD COLUMN time_sig INTEGER;
             ALTER TABLE tracks ADD COLUMN spec_low REAL;
             ALTER TABLE tracks ADD COLUMN spec_mid REAL;
             ALTER TABLE tracks ADD COLUMN spec_high REAL;
             ALTER TABLE tracks ADD COLUMN centroid REAL;
             ALTER TABLE tracks ADD COLUMN vocal REAL;
             ALTER TABLE tracks ADD COLUMN vocal_conf REAL;
             ALTER TABLE tracks ADD COLUMN mood_conf REAL;
             ALTER TABLE tracks ADD COLUMN intro_end REAL;
             ALTER TABLE tracks ADD COLUMN outro_start REAL;
             UPDATE tracks SET
                 onset_density = json_extract(features, '$.onsetDensity'), beat_strength = json_extract(features, '$.beatStrength'),
                 tempo_stability = json_extract(features, '$.tempoStability'), time_sig = json_extract(features, '$.timeSignature'),
                 spec_low = json_extract(features, '$.low'), spec_mid = json_extract(features, '$.mid'), spec_high = json_extract(features, '$.high'),
                 centroid = json_extract(features, '$.centroidHz'), vocal = json_extract(features, '$.vocalPresence'), vocal_conf = json_extract(features, '$.vocalConfidence'),
                 mood_conf = json_extract(features, '$.moodConfidence'), intro_end = json_extract(features, '$.introEndS'), outro_start = json_extract(features, '$.outroStartS')
             WHERE features IS NOT NULL;",
        down: "ALTER TABLE tracks DROP COLUMN onset_density;
               ALTER TABLE tracks DROP COLUMN beat_strength;
               ALTER TABLE tracks DROP COLUMN tempo_stability;
               ALTER TABLE tracks DROP COLUMN time_sig;
               ALTER TABLE tracks DROP COLUMN spec_low;
               ALTER TABLE tracks DROP COLUMN spec_mid;
               ALTER TABLE tracks DROP COLUMN spec_high;
               ALTER TABLE tracks DROP COLUMN centroid;
               ALTER TABLE tracks DROP COLUMN vocal;
               ALTER TABLE tracks DROP COLUMN vocal_conf;
               ALTER TABLE tracks DROP COLUMN mood_conf;
               ALTER TABLE tracks DROP COLUMN intro_end;
               ALTER TABLE tracks DROP COLUMN outro_start;",
    },
];

fn now_s() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) }
fn user_version(c: &Connection) -> Result<i64> { Ok(c.pragma_query_value(None, "user_version", |r| r.get(0))?) }

/// Move the schema to `target` one reversible step at a time (each step is its own transaction).
pub fn migrate_to(conn: &Connection, target: i64) -> Result<()> {
    let mut cur = user_version(conn)?;
    while cur < target {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(MIGRATIONS[cur as usize].up).with_context(|| format!("migration {} -> {} failed", cur, cur + 1))?;
        tx.pragma_update(None, "user_version", cur + 1)?;
        tx.commit()?;
        cur += 1;
    }
    while cur > target {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(MIGRATIONS[cur as usize - 1].down).with_context(|| format!("rollback {} -> {} failed", cur, cur - 1))?;
        tx.pragma_update(None, "user_version", cur - 1)?;
        tx.commit()?;
        cur -= 1;
    }
    Ok(())
}

/// Copy the database file next to itself before a schema change; keeps the five newest backups.
fn backup_before_migration(path: &Path, conn: &Connection, from: i64) -> Result<PathBuf> {
    let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("library.db");
    let dest = path.with_file_name(format!("{name}.bak-v{from}-{}", now_s()));
    std::fs::copy(path, &dest).with_context(|| "could not back up the library before migrating")?;
    // keep the five newest backups (ordered by the timestamp in the name, not alphabetically); never fail the upgrade over this
    let dir = path.parent().unwrap_or(Path::new("."));
    let prefix = format!("{name}.bak-");
    let stamp = |p: &PathBuf| -> i64 { p.file_name().and_then(|n| n.to_str()).and_then(|n| n.rsplit('-').next()).and_then(|t| t.parse().ok()).unwrap_or(0) };
    let mut baks: Vec<PathBuf> = std::fs::read_dir(dir)?.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with(&prefix)).unwrap_or(false)).collect();
    baks.sort_by_key(|p| stamp(p));
    let excess = baks.len().saturating_sub(5);
    for p in baks.iter().take(excess) { let _ = std::fs::remove_file(p); }
    Ok(dest)
}

pub fn open_db(path: &Path) -> Result<Connection> {
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).ok(); }
    let existed = path.exists();
    let conn = Connection::open(path).with_context(|| format!("cannot open library {}", path.display()))?;
    conn.busy_timeout(Duration::from_secs(5))?;
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    let cur = user_version(&conn)?;
    if cur > SCHEMA_VERSION { return Err(anyhow!("library was created by a newer version of the app (schema {cur}); refusing to open it")); }
    if cur < SCHEMA_VERSION {
        if existed && cur > 0 { backup_before_migration(path, &conn, cur)?; }
        migrate_to(&conn, SCHEMA_VERSION)?;
    }
    Ok(conn)
}

// ---------------------------------------------------------------- fingerprint / file helpers
/// Cheap content fingerprint: size + three 64 KB samples (start, middle, end), FNV-1a 64. Read-only.
pub fn fingerprint(path: &str) -> Result<String> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let mut h: u64 = 0xcbf29ce484222325;
    let mut feed = |b: &[u8]| { for &x in b { h ^= x as u64; h = h.wrapping_mul(0x100000001b3); } };
    feed(&len.to_le_bytes());
    let mut buf = vec![0u8; 65536];
    for off in [0, len.saturating_sub(65536) / 2, len.saturating_sub(65536)] {
        f.seek(SeekFrom::Start(off))?;
        let n = f.read(&mut buf)?;
        feed(&buf[..n]);
    }
    Ok(format!("{h:016x}"))
}
fn stat(path: &str) -> Option<(i64, i64)> {
    let m = std::fs::metadata(path).ok()?;
    if !m.is_file() { return None; }
    let mt = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64;
    Some((m.len() as i64, mt))
}
pub fn is_audio(p: &str) -> bool { Path::new(p).extension().and_then(|e| e.to_str()).map(|e| AUDIO_EXT.contains(&e.to_lowercase().as_str())).unwrap_or(false) }

pub fn walk_audio(dirs: &[String], depth: usize, out: &mut Vec<String>) {
    for d in dirs {
        let p = Path::new(d);
        if p.is_file() { if is_audio(d) { out.push(d.clone()); } continue; }
        if depth > 8 { continue; }
        let mut names: Vec<String> = std::fs::read_dir(p).map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path().to_string_lossy().to_string())).collect()).unwrap_or_default();
        names.sort();
        walk_audio(&names, depth + 1, out);
    }
}

#[derive(Clone, Debug, Default)]
pub struct TrackMeta { pub path: String, pub artist: Option<String>, pub title: Option<String>, pub album: Option<String>, pub genre: Option<String> }

#[derive(Debug, Default, Clone, PartialEq)]
pub struct ScanReport { pub added: usize, pub changed: usize, pub unchanged: usize, pub missing: usize, pub queued: usize }

// ---------------------------------------------------------------- queue
struct Queue {
    pending: Mutex<VecDeque<i64>>,
    cv: Condvar,
    paused: AtomicBool,
    workers: AtomicUsize,
    cpu_limit: AtomicU32, // percent of one core a worker may use
    shutdown: AtomicBool,
    running: AtomicUsize,
    done: AtomicUsize,
    errors: AtomicUsize,
    started: AtomicBool,
    busy_ms: AtomicU64,     // total time workers spent analysing
    throttle_ms: AtomicU64, // total time workers deliberately slept because of the CPU limit
}

#[derive(Debug, Clone, PartialEq)]
pub struct Progress { pub pending: usize, pub running: usize, pub done: usize, pub errors: usize, pub paused: bool, pub workers: usize, pub cpu_limit: u32, pub busy_ms: u64, pub throttle_ms: u64 }

pub struct Library {
    pub path: PathBuf,
    conn: Arc<Mutex<Connection>>,
    q: Arc<Queue>,
}

#[cfg(windows)]
fn lower_thread_priority() {
    use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN, THREAD_PRIORITY_LOWEST};
    // background mode lowers CPU, disk and memory priority of this thread; fall back to the lowest CPU priority if refused
    unsafe { if SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN) == 0 { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_LOWEST); } }
}
#[cfg(not(windows))]
fn lower_thread_priority() {}

const COLS: &str = "id, path, status, error, artist, title, album, genre, duration, bpm, bpm_conf, key_name, camelot, key_conf, energy, danceability, mood, analyzed_at, engine_version, favorite, play_count, size, mtime, fingerprint";
fn row_json(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, i64>(0)?, "path": r.get::<_, String>(1)?, "status": r.get::<_, String>(2)?, "error": r.get::<_, Option<String>>(3)?,
        "artist": r.get::<_, Option<String>>(4)?, "title": r.get::<_, Option<String>>(5)?, "album": r.get::<_, Option<String>>(6)?, "genre": r.get::<_, Option<String>>(7)?,
        "duration": r.get::<_, Option<f64>>(8)?, "bpm": r.get::<_, Option<f64>>(9)?, "bpmConf": r.get::<_, Option<f64>>(10)?,
        "keyName": r.get::<_, Option<String>>(11)?, "camelot": r.get::<_, Option<String>>(12)?, "keyConf": r.get::<_, Option<f64>>(13)?,
        "energy": r.get::<_, Option<i64>>(14)?, "danceability": r.get::<_, Option<f64>>(15)?, "mood": r.get::<_, Option<String>>(16)?,
        "analyzedAt": r.get::<_, Option<i64>>(17)?, "engineVersion": r.get::<_, Option<i64>>(18)?, "favorite": r.get::<_, i64>(19)? != 0, "playCount": r.get::<_, i64>(20)?,
        "size": r.get::<_, i64>(21)?, "mtime": r.get::<_, i64>(22)?, "fingerprint": r.get::<_, Option<String>>(23)?,
    }))
}

impl Library {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = open_db(path)?;
        // crash recovery: anything that was mid-analysis when the app died goes back to the queue
        conn.execute("UPDATE tracks SET status='pending' WHERE status='analyzing'", [])?;
        let q = Arc::new(Queue {
            pending: Mutex::new(VecDeque::new()), cv: Condvar::new(), paused: AtomicBool::new(false), workers: AtomicUsize::new(1), cpu_limit: AtomicU32::new(100),
            shutdown: AtomicBool::new(false), running: AtomicUsize::new(0), done: AtomicUsize::new(0), errors: AtomicUsize::new(0), started: AtomicBool::new(false), busy_ms: AtomicU64::new(0), throttle_ms: AtomicU64::new(0),
        });
        let lib = Self { path: path.to_path_buf(), conn: Arc::new(Mutex::new(conn)), q };
        lib.requeue_pending()?;
        Ok(lib)
    }
    fn db(&self) -> std::sync::MutexGuard<'_, Connection> { self.conn.lock().unwrap_or_else(|e| e.into_inner()) }

    fn requeue_pending(&self) -> Result<()> {
        let ids: Vec<i64> = { let c = self.db(); let mut s = c.prepare("SELECT id FROM tracks WHERE status='pending' ORDER BY id")?; let v = s.query_map([], |r| r.get(0))?.filter_map(|x| x.ok()).collect(); v };
        let mut g = self.q.pending.lock().unwrap();
        for id in ids { if !g.contains(&id) { g.push_back(id); } }
        self.q.cv.notify_all();
        Ok(())
    }
    pub fn schema_version(&self) -> i64 { user_version(&self.db()).unwrap_or(0) }
    pub fn track_count(&self) -> i64 { self.db().query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0)).unwrap_or(0) }

    /// Register files (incremental): new files are queued, changed files are re-queued, unchanged files are left alone.
    pub fn scan(&self, items: &[TrackMeta], force: bool) -> Result<ScanReport> {
        let mut rep = ScanReport::default();
        let mut to_queue: Vec<i64> = Vec::new();
        {
            let c = self.db();
            let tx = c.unchecked_transaction()?;
            for it in items {
                let existing: Option<(i64, i64, i64, String, Option<i64>)> = tx.query_row("SELECT id, size, mtime, status, engine_version FROM tracks WHERE path=?1", [&it.path], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).optional()?;
                match (stat(&it.path), existing) {
                    (None, Some((id, ..))) => { tx.execute("UPDATE tracks SET status='missing' WHERE id=?1 AND status!='missing'", [id])?; rep.missing += 1; }
                    (None, None) => { rep.missing += 1; }
                    (Some((size, mtime)), None) => {
                        tx.execute("INSERT INTO tracks (path, size, mtime, status, artist, title, album, genre, added_at) VALUES (?1,?2,?3,'pending',?4,?5,?6,?7,?8)", params![it.path, size, mtime, it.artist, it.title, it.album, it.genre, now_s()])?;
                        to_queue.push(tx.last_insert_rowid()); rep.added += 1;
                    }
                    (Some((size, mtime)), Some((id, osize, omtime, status, ever))) => {
                        // refresh tags supplied by the caller without touching analysis results
                        tx.execute("UPDATE tracks SET artist=COALESCE(?2,artist), title=COALESCE(?3,title), album=COALESCE(?4,album), genre=COALESCE(?5,genre) WHERE id=?1", params![id, it.artist, it.title, it.album, it.genre])?;
                        let file_changed = size != osize || mtime != omtime;
                        let outdated = status == "done" && ever.unwrap_or(0) < ENGINE_VERSION as i64;
                        if file_changed || force || outdated || status == "missing" || status == "pending" {
                            tx.execute("UPDATE tracks SET size=?2, mtime=?3, status='pending', error=NULL WHERE id=?1", params![id, size, mtime])?;
                            to_queue.push(id); rep.changed += 1;
                        } else { rep.unchanged += 1; }
                    }
                }
            }
            tx.commit()?;
        }
        rep.queued = to_queue.len();
        let mut g = self.q.pending.lock().unwrap();
        for id in to_queue { if !g.contains(&id) { g.push_back(id); } }
        self.q.cv.notify_all();
        Ok(rep)
    }
    pub fn scan_dirs(&self, dirs: &[String]) -> Result<ScanReport> {
        let mut files = Vec::new(); walk_audio(dirs, 0, &mut files);
        let items: Vec<TrackMeta> = files.into_iter().map(|path| TrackMeta { path, ..Default::default() }).collect();
        self.scan(&items, false)
    }
    pub fn reanalyze(&self, paths: &[String]) -> Result<usize> {
        let mut ids = Vec::new();
        { let c = self.db(); for p in paths { if let Some(id) = c.query_row("SELECT id FROM tracks WHERE path=?1", [p], |r| r.get::<_, i64>(0)).optional()? { c.execute("UPDATE tracks SET status='pending', error=NULL WHERE id=?1", [id])?; ids.push(id); } } }
        let n = ids.len();
        let mut g = self.q.pending.lock().unwrap(); for id in ids { if !g.contains(&id) { g.push_back(id); } }
        self.q.cv.notify_all();
        Ok(n)
    }

    pub fn rows_by_paths(&self, paths: &[String]) -> Result<Vec<Value>> {
        let c = self.db(); let mut s = c.prepare(&format!("SELECT {COLS} FROM tracks WHERE path=?1"))?;
        let mut out = Vec::new();
        for p in paths { if let Some(v) = s.query_row([p], row_json).optional()? { out.push(v); } }
        Ok(out)
    }
    /// Paged listing with simple filters (the base for the Harmonic Match queries in H3).
    pub fn rows(&self, offset: i64, limit: i64, sort: &str, filter: &Value) -> Result<Vec<Value>> {
        let order = match sort { "bpm" => "bpm", "camelot" => "camelot, bpm", "energy" => "energy DESC", "artist" => "artist, title", "added" => "added_at DESC", _ => "id" };
        let mut sql = format!("SELECT {COLS} FROM tracks WHERE status!='missing'");
        let mut args: Vec<rusqlite::types::Value> = Vec::new();
        let mut add = |cond: &str, v: rusqlite::types::Value, sql: &mut String| { args.push(v); sql.push_str(&format!(" AND {cond}?{}", args.len())); };
        if let Some(x) = filter["bpmMin"].as_f64() { add("bpm>=", x.into(), &mut sql); }
        if let Some(x) = filter["bpmMax"].as_f64() { add("bpm<=", x.into(), &mut sql); }
        if let Some(x) = filter["energyMin"].as_i64() { add("energy>=", x.into(), &mut sql); }
        if let Some(x) = filter["energyMax"].as_i64() { add("energy<=", x.into(), &mut sql); }
        if let Some(x) = filter["camelot"].as_str() { add("camelot=", x.to_string().into(), &mut sql); }
        if let Some(x) = filter["status"].as_str() { add("status=", x.to_string().into(), &mut sql); }
        if filter["favorite"].as_bool() == Some(true) { sql.push_str(" AND favorite=1"); }
        sql.push_str(&format!(" ORDER BY {order} LIMIT {} OFFSET {}", limit.clamp(1, 5000), offset.max(0)));
        let c = self.db(); let mut s = c.prepare(&sql)?;
        let v = s.query_map(rusqlite::params_from_iter(args.iter()), row_json)?.filter_map(|x| x.ok()).collect();
        Ok(v)
    }
    pub fn stats(&self) -> Value {
        let c = self.db();
        let n = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0);
        json!({"tracks": n("SELECT COUNT(*) FROM tracks"), "analyzed": n("SELECT COUNT(*) FROM tracks WHERE status='done'"), "pending": n("SELECT COUNT(*) FROM tracks WHERE status IN ('pending','analyzing')"),
               "errors": n("SELECT COUNT(*) FROM tracks WHERE status='error'"), "missing": n("SELECT COUNT(*) FROM tracks WHERE status='missing'"), "schema": user_version(&c).unwrap_or(0)})
    }
    /// Groups of paths whose content fingerprint and size match (candidate duplicates).
    pub fn duplicates(&self) -> Result<Vec<Vec<String>>> {
        let c = self.db();
        let mut s = c.prepare("SELECT fingerprint FROM tracks WHERE fingerprint IS NOT NULL AND status='done' GROUP BY fingerprint, size HAVING COUNT(*)>1")?;
        let fps: Vec<String> = s.query_map([], |r| r.get(0))?.filter_map(|x| x.ok()).collect();
        let mut out = Vec::new();
        for fp in fps { let mut s2 = c.prepare("SELECT path FROM tracks WHERE fingerprint=?1 ORDER BY path")?; out.push(s2.query_map([fp], |r| r.get(0))?.filter_map(|x| x.ok()).collect()); }
        Ok(out)
    }
    pub fn mark_played(&self, path: &str) -> Result<()> { self.db().execute("UPDATE tracks SET play_count=play_count+1, last_played=?2 WHERE path=?1", params![path, now_s()])?; Ok(()) }
    pub fn set_favorite(&self, path: &str, fav: bool) -> Result<()> { self.db().execute("UPDATE tracks SET favorite=?2 WHERE path=?1", params![path, fav as i64])?; Ok(()) }

    // ---------------------------------------------------------------- queue control
    pub fn progress(&self) -> Progress {
        Progress { pending: self.q.pending.lock().unwrap().len(), running: self.q.running.load(Relaxed), done: self.q.done.load(Relaxed), errors: self.q.errors.load(Relaxed),
                   paused: self.q.paused.load(Relaxed), workers: self.q.workers.load(Relaxed), cpu_limit: self.q.cpu_limit.load(Relaxed), busy_ms: self.q.busy_ms.load(Relaxed), throttle_ms: self.q.throttle_ms.load(Relaxed) }
    }
    pub fn pause(&self) { self.q.paused.store(true, Relaxed); }
    pub fn resume(&self) { self.q.paused.store(false, Relaxed); self.q.cv.notify_all(); }
    pub fn set_workers(&self, n: usize) { self.q.workers.store(n.clamp(1, MAX_WORKERS), Relaxed); self.q.cv.notify_all(); }
    pub fn set_cpu_limit(&self, pct: u32) { self.q.cpu_limit.store(pct.clamp(10, 100), Relaxed); }
    pub fn is_idle(&self) -> bool { self.q.pending.lock().unwrap().is_empty() && self.q.running.load(Relaxed) == 0 }
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        let t0 = Instant::now();
        while t0.elapsed() < timeout { if self.is_idle() { return true; } std::thread::sleep(Duration::from_millis(20)); }
        false
    }
    pub fn shutdown(&self) { self.q.shutdown.store(true, Relaxed); self.q.cv.notify_all(); }

    /// Spawn the worker pool (once). Results are reported through `sink` as JSON events.
    pub fn start_workers(&self, sink: Sender<Value>) {
        if self.q.started.swap(true, Relaxed) { return; }
        for idx in 0..MAX_WORKERS {
            let (q, conn, sink) = (self.q.clone(), self.conn.clone(), sink.clone());
            std::thread::Builder::new().name(format!("analysis-{idx}")).spawn(move || {
                lower_thread_priority();
                loop {
                    let id = {
                        let mut g = q.pending.lock().unwrap();
                        loop {
                            if q.shutdown.load(Relaxed) { return; }
                            if !q.paused.load(Relaxed) && idx < q.workers.load(Relaxed) { if let Some(id) = g.pop_front() { break id; } }
                            g = q.cv.wait_timeout(g, Duration::from_millis(200)).unwrap().0;
                        }
                    };
                    q.running.fetch_add(1, Relaxed);
                    let t0 = Instant::now();
                    let path: Option<String> = { let c = conn.lock().unwrap_or_else(|e| e.into_inner()); let _ = c.execute("UPDATE tracks SET status='analyzing' WHERE id=?1 AND status='pending'", [id]); c.query_row("SELECT path FROM tracks WHERE id=?1", [id], |r| r.get(0)).optional().ok().flatten() };
                    if let Some(path) = path {
                        let res = std::panic::catch_unwind(|| analyze_file(&path)).unwrap_or_else(|_| Err(anyhow!("analysis crashed on this file")));
                        let c = conn.lock().unwrap_or_else(|e| e.into_inner());
                        match res {
                            Ok((fp, f)) => {
                                let (k, kc, kn) = f.key.as_ref().map(|k| (Some(k.camelot.clone()), Some(k.confidence as f64), Some(k.name.clone()))).unwrap_or((None, None, None));
                                let feat_json = serde_json::to_string(&f).unwrap_or_default();
                                let ok = c.execute("UPDATE tracks SET status='done', error=NULL, fingerprint=?2, duration=?3, bpm=?4, bpm_conf=?5, key_name=?6, camelot=?7, key_conf=?8, energy=?9, danceability=?10, mood=?11, features=?12, analyzed_at=?13, engine_version=?14, onset_density=?15, beat_strength=?16, tempo_stability=?17, time_sig=?18, spec_low=?19, spec_mid=?20, spec_high=?21, centroid=?22, vocal=?23, vocal_conf=?24, mood_conf=?25, intro_end=?26, outro_start=?27 WHERE id=?1",
                                    params![id, fp, f.duration_s, f.bpm as f64, f.bpm_confidence as f64, kn, k, kc, f.energy as i64, f.danceability as f64, f.mood, feat_json, now_s(), ENGINE_VERSION as i64,
                                            f.onset_density as f64, f.beat_strength as f64, f.tempo_stability as f64, f.time_signature as i64, f.low as f64, f.mid as f64, f.high as f64, f.centroid_hz as f64, f.vocal_presence as f64, f.vocal_confidence as f64, f.mood_confidence as f64, f.intro_end_s.map(|x| x as f64), f.outro_start_s.map(|x| x as f64)]);
                                if ok.is_ok() { q.done.fetch_add(1, Relaxed); let row = c.query_row(&format!("SELECT {COLS} FROM tracks WHERE id=?1"), [id], row_json).ok(); let _ = sink.send(json!({"evt": "trackAnalyzed", "path": path, "row": row})); }
                            }
                            Err(e) => {
                                let msg = e.to_string();
                                let _ = c.execute("UPDATE tracks SET status='error', error=?2 WHERE id=?1", params![id, msg]);
                                q.errors.fetch_add(1, Relaxed);
                                let _ = sink.send(json!({"evt": "trackError", "path": path, "message": msg}));
                            }
                        }
                    }
                    q.running.fetch_sub(1, Relaxed);
                    let lim = q.cpu_limit.load(Relaxed);
                    let worked = t0.elapsed();
                    q.busy_ms.fetch_add(worked.as_millis() as u64, Relaxed);
                    if lim < 100 { let nap = worked.mul_f64((100.0 / lim as f64) - 1.0); q.throttle_ms.fetch_add(nap.as_millis() as u64, Relaxed); std::thread::sleep(nap); }
                }
            }).expect("spawn analysis worker");
        }
        // progress reporter
        let (q, sink2) = (self.q.clone(), sink);
        std::thread::Builder::new().name("analysis-progress".into()).spawn(move || {
            let mut last = (usize::MAX, 0usize, 0usize, 0usize, false);
            loop {
                std::thread::sleep(Duration::from_millis(400));
                if q.shutdown.load(Relaxed) { return; }
                let cur = (q.pending.lock().unwrap().len(), q.running.load(Relaxed), q.done.load(Relaxed), q.errors.load(Relaxed), q.paused.load(Relaxed));
                if cur != last {
                    last = cur;
                    let _ = sink2.send(json!({"evt": "libraryProgress", "pending": cur.0, "running": cur.1, "done": cur.2, "errors": cur.3, "paused": cur.4, "workers": q.workers.load(Relaxed), "cpuLimit": q.cpu_limit.load(Relaxed)}));
                }
            }
        }).ok();
    }
}

/// Where to look for match candidates.
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Scope {
    /// only these tracks (e.g. the current playlist)
    pub paths: Option<Vec<String>>,
    /// only tracks inside this folder
    pub folder: Option<String>,
    /// never suggest these (e.g. tracks already in a playlist, to find tracks that are not in one)
    pub exclude: Vec<String>,
}

const PROFILE_COLS: &str = "id, path, artist, title, camelot, key_conf, bpm, bpm_conf, energy, danceability, genre, mood, mood_conf, onset_density, beat_strength, tempo_stability, time_sig, spec_low, spec_mid, spec_high, centroid, vocal, vocal_conf";
fn profile_row(r: &rusqlite::Row) -> rusqlite::Result<crate::matching::Profile> {
    let f = |i: usize| -> rusqlite::Result<f32> { Ok(r.get::<_, Option<f64>>(i)?.unwrap_or(0.0) as f32) };
    Ok(crate::matching::Profile {
        id: r.get(0)?, path: r.get(1)?, artist: r.get(2)?, title: r.get(3)?,
        camelot: r.get::<_, Option<String>>(4)?.and_then(|c| crate::matching::parse_camelot(&c)),
        key_conf: f(5)?, bpm: f(6)?, bpm_conf: f(7)?, energy: r.get::<_, Option<i64>>(8)?.unwrap_or(0) as u8, danceability: f(9)?,
        genre: r.get(10)?, mood: r.get(11)?, mood_conf: f(12)?,
        onset_density: f(13)?, beat_strength: f(14)?, tempo_stability: f(15)?, time_sig: r.get::<_, Option<i64>>(16)?.unwrap_or(0) as u8,
        low: f(17)?, mid: f(18)?, high: f(19)?, centroid: f(20)?, vocal: f(21)?, vocal_conf: f(22)?,
    })
}

impl Library {
    /// Profile of one analysed track, or None if it is unknown / not analysed yet.
    pub fn profile_for_path(&self, path: &str) -> Result<Option<crate::matching::Profile>> {
        let c = self.db();
        Ok(c.query_row(&format!("SELECT {PROFILE_COLS} FROM tracks WHERE path=?1 AND status='done'"), [path], profile_row).optional()?)
    }
    /// Analysed tracks inside a scope, as match profiles.
    pub fn profiles(&self, scope: &Scope) -> Result<Vec<crate::matching::Profile>> {
        let c = self.db();
        let mut v: Vec<crate::matching::Profile> = match &scope.folder {
            Some(f) if !f.is_empty() => {
                let mut s = c.prepare(&format!("SELECT {PROFILE_COLS} FROM tracks WHERE status='done' AND lower(substr(path,1,?2))=lower(?1)"))?;
                let r = s.query_map(params![f, f.chars().count() as i64], profile_row)?.filter_map(|x| x.ok()).collect(); r
            }
            _ => { let mut s = c.prepare(&format!("SELECT {PROFILE_COLS} FROM tracks WHERE status='done'"))?; let r = s.query_map([], profile_row)?.filter_map(|x| x.ok()).collect(); r }
        };
        if let Some(paths) = &scope.paths { let set: std::collections::HashSet<&String> = paths.iter().collect(); v.retain(|p| set.contains(&p.path)); }
        if !scope.exclude.is_empty() { let ex: std::collections::HashSet<&String> = scope.exclude.iter().collect(); v.retain(|p| !ex.contains(&p.path)); }
        Ok(v)
    }
    /// Rank the library against a source track. The source must have been analysed.
    pub fn match_for(&self, source_path: &str, settings: &crate::matching::Settings, filter: &crate::matching::Filter, scope: &Scope) -> Result<Value> {
        settings.weights.validate().map_err(|e| anyhow!(e))?;
        let src = self.profile_for_path(source_path)?.ok_or_else(|| anyhow!("the source track has not been analysed yet"))?;
        let cands = self.profiles(scope)?;
        let n = cands.len();
        let matches = crate::matching::rank(&src, &cands, settings, filter).map_err(|e| anyhow!(e))?;
        let (total, analysed): (i64, i64) = { let c = self.db(); (c.query_row("SELECT COUNT(*) FROM tracks WHERE status!='missing'", [], |r| r.get(0))?, c.query_row("SELECT COUNT(*) FROM tracks WHERE status='done'", [], |r| r.get(0))?) };
        Ok(json!({
            "source": {"path": src.path, "artist": src.artist, "title": src.title, "bpm": src.bpm, "camelot": src.camelot.map(crate::matching::camelot_str), "keyConfidence": src.key_conf, "energy": src.energy, "genre": src.genre},
            "candidates": n, "libraryTracks": total, "unanalysed": total - analysed, "matches": matches,
        }))
    }
}

impl Library {
    /// Overview of an ordered list of tracks (a playlist or set): distributions, per-transition scores and problem transitions.
    /// Tracks that are not analysed yet are listed, never guessed; transitions need two neighbouring analysed tracks.
    pub fn analyze_sequence(&self, paths: &[String], settings: &crate::matching::Settings) -> Result<Value> {
        use crate::matching::{camelot_str, score_pair};
        settings.weights.validate().map_err(|e| anyhow!(e))?;
        let mut profiles: Vec<Option<crate::matching::Profile>> = Vec::with_capacity(paths.len());
        let mut durations: Vec<f64> = Vec::with_capacity(paths.len());
        let mut unanalysed: Vec<String> = Vec::new();
        {
            let c = self.db();
            let mut sp = c.prepare(&format!("SELECT {PROFILE_COLS} FROM tracks WHERE path=?1 AND status='done'"))?;
            let mut sd = c.prepare("SELECT COALESCE(duration,0) FROM tracks WHERE path=?1")?;
            for p in paths {
                let prof = sp.query_row([p], profile_row).optional()?;
                if prof.is_none() { unanalysed.push(p.clone()); }
                durations.push(sd.query_row([p], |r| r.get::<_, f64>(0)).optional()?.unwrap_or(0.0));
                profiles.push(prof);
            }
        }
        let total_duration: f64 = durations.iter().sum();
        let analysed = profiles.iter().flatten().count();
        // distributions
        let mut bpm_bins = vec![0u32; 28]; // 60..200 in steps of 5
        let mut keys: std::collections::BTreeMap<String, u32> = std::collections::BTreeMap::new();
        let mut energy = [0u32; 10];
        let mut genres: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
        for p in profiles.iter().flatten() {
            if p.bpm > 0.0 { let i = (((p.bpm - 60.0) / 5.0).floor().max(0.0) as usize).min(27); bpm_bins[i] += 1; }
            if let Some(k) = p.camelot { *keys.entry(camelot_str(k)).or_default() += 1; }
            if (1..=10).contains(&p.energy) { energy[p.energy as usize - 1] += 1; }
            if let Some(g) = &p.genre { let first = g.split([',', ';', '/']).next().unwrap_or("").trim().to_string(); if !first.is_empty() { *genres.entry(first).or_default() += 1; } }
        }
        let mut genre_list: Vec<(String, u32)> = genres.into_iter().collect();
        genre_list.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        genre_list.truncate(12);
        // transitions between neighbouring analysed tracks
        let (mut transitions, mut problems) = (Vec::new(), Vec::new());
        let (mut sum, mut smooth, mut counted) = (0f64, 0usize, 0usize);
        for i in 0..profiles.len().saturating_sub(1) {
            let (Some(a), Some(b)) = (&profiles[i], &profiles[i + 1]) else { continue };
            let r = score_pair(a, b, settings).map_err(|e| anyhow!(e))?;
            let de = b.energy as i32 - a.energy as i32;
            let mut reasons: Vec<String> = Vec::new();
            if !r.tempo.within_limit && r.tempo.mode != "unknown" { reasons.push(format!("tempo gap too large ({:.0} -> {:.0} BPM)", a.bpm, b.bpm)); }
            if r.harmonic.score < 0.30 && !r.harmonic.uncertain { reasons.push(format!("harmonic clash ({} -> {})", r.harmonic.source_key.as_deref().unwrap_or("?"), r.harmonic.candidate_key.as_deref().unwrap_or("?"))); }
            if de.abs() >= 4 { reasons.push(format!("energy jump {de:+}")); }
            if r.score < 55.0 && reasons.is_empty() { reasons.push("low overall compatibility".into()); }
            transitions.push(json!({"index": i, "score": r.score, "label": r.label, "harmonicLabel": r.harmonic.label, "relation": r.harmonic.relation, "tempoMode": r.tempo.mode, "tempoAdjustPct": r.tempo.adjust_pct, "withinLimit": r.tempo.within_limit, "energyDelta": de}));
            sum += r.score as f64; counted += 1; if r.score >= 75.0 { smooth += 1; }
            if !reasons.is_empty() { problems.push(json!({"index": i, "from": a.path, "to": b.path, "score": r.score, "reasons": reasons})); }
        }
        let series: Vec<Value> = profiles.iter().zip(paths).map(|(p, path)| match p {
            Some(p) => json!({"path": path, "energy": p.energy, "bpm": p.bpm, "camelot": p.camelot.map(camelot_str)}),
            None => json!({"path": path, "energy": null, "bpm": null, "camelot": null}),
        }).collect();
        Ok(json!({
            "total": paths.len(), "analysed": analysed, "unanalysed": unanalysed, "durationS": total_duration,
            "bpmBins": bpm_bins, "bpmBinStart": 60, "bpmBinWidth": 5, "keys": keys, "energy": energy, "genres": genre_list,
            "series": series, "transitions": transitions, "transitionCount": counted,
            "meanTransition": if counted > 0 { Some(sum / counted as f64) } else { None }, "smoothShare": if counted > 0 { Some(smooth as f64 / counted as f64) } else { None },
            "problems": problems,
        }))
    }
}

/// Read-only decode + analysis of one file. Returns the fingerprint and the feature set.
fn analyze_file(path: &str) -> Result<(String, crate::features::Features)> {
    let fp = fingerprint(path).map_err(|e| anyhow!("cannot read file: {e}"))?;
    let track = decode_file(path)?;
    let a = analyze(&track);
    let f = compute(&track, &a);
    Ok((fp, f))
}
