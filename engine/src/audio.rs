//! Audio device management. Streams live on one dedicated manager thread (cpal streams are not `Send`).
//! The audio callbacks only call `Mixer::render`, copy samples, and touch atomics/lock-free queues.
use crate::core::{Mixer, Shared};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, Device, ErrorKind, SampleFormat, Stream, StreamConfig, SupportedBufferSize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAXF: usize = 2048;

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum CueSetting {
    #[default]
    Off,
    /// Same device, channels 3/4 (e.g. the Numark Party Mix headphone jack).
    Same4,
    /// A second output device (stereo).
    Device { device: String },
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub master: Option<String>,
    #[serde(default)]
    pub cue: CueSetting,
    #[serde(default)]
    pub sample_rate: u32,
    #[serde(default)]
    pub buffer: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub max_channels: u16,
    pub default_rate: u32,
    pub rates: Vec<u32>,
    pub buffer_min: u32,
    pub buffer_max: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub master_name: String,
    pub channels: u16,
    pub sample_rate: u32,
    pub requested_buffer: u32,
    pub cue: String,
    pub cue_name: String,
}

fn dev_id(d: &Device) -> String { d.id().map(|i| i.to_string()).unwrap_or_default() }
fn dev_name(d: &Device) -> String { d.description().map(|x| x.name().to_string()).unwrap_or_else(|_| "?".into()) }

pub fn list_devices() -> Vec<DeviceInfo> {
    let host = cpal::default_host();
    let default_id = host.default_output_device().map(|d| dev_id(&d));
    let mut out = Vec::new();
    let Ok(devs) = host.output_devices() else { return out };
    for d in devs {
        let cfgs: Vec<_> = d.supported_output_configs().map(|c| c.collect()).unwrap_or_default();
        let f32s: Vec<_> = cfgs.iter().filter(|c| c.sample_format() == SampleFormat::F32).collect();
        if f32s.is_empty() { continue; }
        let max_channels = f32s.iter().map(|c| c.channels()).max().unwrap_or(2);
        let rates: Vec<u32> = [44100u32, 48000, 88200, 96000].into_iter()
            .filter(|r| f32s.iter().any(|c| c.min_sample_rate() <= *r && c.max_sample_rate() >= *r)).collect();
        let (mut bmin, mut bmax) = (0, 0);
        for c in &f32s { if let SupportedBufferSize::Range { min, max } = c.buffer_size() { if bmin == 0 || *min < bmin { bmin = *min; } if *max > bmax { bmax = *max; } } }
        let id = dev_id(&d);
        out.push(DeviceInfo {
            is_default: Some(&id) == default_id.as_ref(), id, name: dev_name(&d), max_channels,
            default_rate: d.default_output_config().map(|c| c.sample_rate()).unwrap_or(44100), rates, buffer_min: bmin, buffer_max: bmax,
        });
    }
    out
}

fn find_device(host: &cpal::Host, id: &Option<String>) -> Result<Device, String> {
    match id.as_deref() {
        None | Some("") | Some("default") => host.default_output_device().ok_or_else(|| "no default output device".to_string()),
        Some(s) => {
            let parsed: cpal::DeviceId = s.parse().map_err(|_| format!("bad device id '{s}'"))?;
            host.device_by_id(&parsed).ok_or_else(|| format!("device not found: {s}"))
        }
    }
}

/// Choose an f32 config with at least `min_ch` channels (smallest such) that supports `rate`.
fn pick_config(d: &Device, min_ch: u16, rate: u32, buffer: u32) -> Result<(StreamConfig, u16), String> {
    let mut best: Option<cpal::SupportedStreamConfigRange> = None;
    for c in d.supported_output_configs().map_err(|e| e.to_string())? {
        if c.sample_format() != SampleFormat::F32 || c.channels() < min_ch || c.min_sample_rate() > rate || c.max_sample_rate() < rate { continue; }
        if best.as_ref().map(|b| c.channels() < b.channels()).unwrap_or(true) { best = Some(c); }
    }
    let r = best.ok_or_else(|| format!("device has no {rate} Hz f32 format with {min_ch}+ channels"))?;
    let mut cfg = r.with_sample_rate(rate).config();
    if buffer > 0 { if let SupportedBufferSize::Range { min, max } = r.buffer_size() { if buffer >= *min && buffer <= *max { cfg.buffer_size = BufferSize::Fixed(buffer); } } }
    let ch = cfg.channels;
    Ok((cfg, ch))
}

pub struct Io {
    mixer: Arc<Mutex<Mixer>>,
    shared: Arc<Shared>,
    streams: Vec<Stream>,
    failed: Arc<AtomicBool>,
    pub settings: Option<Settings>,
}

impl Io {
    pub fn new(mixer: Arc<Mutex<Mixer>>, shared: Arc<Shared>) -> Self {
        Self { mixer, shared, streams: Vec::new(), failed: Arc::new(AtomicBool::new(false)), settings: None }
    }
    pub fn close(&mut self) { self.streams.clear(); }

    pub fn open(&mut self, s: &Settings) -> Result<Status, String> {
        self.streams.clear();
        self.failed.store(false, Relaxed);
        let host = cpal::default_host();
        let master = find_device(&host, &s.master)?;
        let rate = if s.sample_rate > 0 { s.sample_rate } else { master.default_output_config().map_err(|e| e.to_string())?.sample_rate() };
        let same4 = matches!(s.cue, CueSetting::Same4);
        let (cfg, ch) = pick_config(&master, if same4 { 4 } else { 2 }, rate, s.buffer)?;
        // A separate cue device. If it is the Numark Party Mix (4 channels: 1/2 = line out, 3/4 = headphone jack) the cue is written to channels 3/4, so it is heard in the controller's headphone jack.
        let mut cue_ofs = 0usize;
        let (cue_dev, cue_cfg) = match &s.cue {
            CueSetting::Device { device } => {
                let d = find_device(&host, &Some(device.clone()))?;
                let nm = dev_name(&d).to_lowercase(); let is_party_mix = nm.contains("party mix") || nm.contains("ddj-sb") || nm.contains("ddj sb");   // (a 4-channel controller: 1/2 = master out, 3/4 = headphones)
                let (c, _) = match (is_party_mix, pick_config(&d, 4, rate, 0)) { (true, Ok(x)) => { cue_ofs = 2; x } _ => pick_config(&d, 2, rate, 0).map_err(|e| format!("cue device: {e}"))? };
                (Some(d), Some(c))
            }
            _ => (None, None),
        };
        self.mixer.lock().map_err(|_| "mixer poisoned".to_string())?.set_sample_rate(rate);

        // cue ring (master callback -> cue callback), ~0.5 s of stereo
        let (mut cue_tx, mut cue_rx) = rtrb::RingBuffer::<f32>::new((rate as usize) * 2 / 2 + 8);
        let use_ring = cue_dev.is_some();

        let (mixer, shared, failed) = (self.mixer.clone(), self.shared.clone(), self.failed.clone());
        let (mut mb, mut cb) = (vec![0f32; MAXF * 2], vec![0f32; MAXF * 2]);
        let chn = ch as usize;
        let err_failed = failed.clone();
        let err_shared = shared.clone();
        let on_err = move |e: cpal::Error| match e.kind() {
            ErrorKind::Xrun => { err_shared.xruns.fetch_add(1, Relaxed); }
            ErrorKind::DeviceChanged | ErrorKind::RealtimeDenied => {}
            _ => { err_failed.store(true, Relaxed); }
        };
        let ratef = rate as f32;
        let shared_cue = self.shared.clone();
        shared_cue.cue_lat_us.store(0, Relaxed);
        // speaker/headphone sync: the cue goes through its own device and a small buffer, so it lags the speakers; the master output is delayed by the difference (measured live) so both are heard together
        let mut dl = vec![0f32; (rate as usize / 2) * 2];
        let (mut dw, mut dcur, mut dtick) = (0usize, 0usize, 0u32);
        let dl_frames = rate as usize / 2;
        let master_stream = master.build_output_stream(cfg, move |data: &mut [f32], info| {
            let t0 = Instant::now();
            let frames = data.len() / chn;
            shared.buffer_frames.store(frames as u32, Relaxed);
            let ts = info.timestamp();
            let lat = ts.playback.duration_since(ts.callback).as_micros().min(u32::MAX as u128) as u32;
            if lat > 0 { shared.latency_us.store(lat, Relaxed); } // the first callback after (re)opening can report 0; keep the last good value
            let Ok(mut mx) = mixer.try_lock() else { data.fill(0.0); return };
            let mut done = 0;
            while done < frames {
                let n = (frames - done).min(MAXF);
                mx.render(&mut mb[..n * 2], &mut cb[..n * 2], n);
                let dtarget = if use_ring { (((shared.cue_lat_us.load(Relaxed) as i64 - shared.latency_us.load(Relaxed) as i64 + shared.sync_trim_us.load(Relaxed) as i64).max(0) as f64 / 1e6) * rate as f64) as usize } else { 0 }.min(dl_frames - 1);
                for i in 0..n {
                    let o = &mut data[(done + i) * chn..(done + i + 1) * chn];
                    o.fill(0.0);
                    dtick += 1; if dtick >= 24 { dtick = 0; if dcur < dtarget { dcur += 1 } else if dcur > dtarget { dcur -= 1 } }   // glide to the target (a tiny pitch bend while it settles)
                    dl[dw * 2] = mb[i * 2]; dl[dw * 2 + 1] = mb[i * 2 + 1];
                    let rp = (dw + dl_frames - dcur) % dl_frames;
                    o[0] = dl[rp * 2]; o[1] = dl[rp * 2 + 1];
                    dw = (dw + 1) % dl_frames;
                    if same4 && chn >= 4 { o[2] = cb[i * 2]; o[3] = cb[i * 2 + 1]; }
                    else if use_ring { let _ = cue_tx.push(cb[i * 2]); let _ = cue_tx.push(cb[i * 2 + 1]); }
                }
                done += n;
            }
            mx.report_cpu(t0.elapsed().as_secs_f32() / (frames as f32 / ratef));
        }, on_err.clone(), None).map_err(|e| format!("cannot open master output: {e}"))?;
        master_stream.play().map_err(|e| format!("cannot start master output: {e}"))?;
        self.streams.push(master_stream);

        let mut cue_name = String::new();
        if let (Some(d), Some(c)) = (cue_dev, cue_cfg) {
            let cch = c.channels as usize;
            let (hi, target) = ((rate as usize * 2) * 20 / 100, (rate as usize * 2) * 4 / 100);   // ~40 ms jitter cushion, trimmed back if the clocks drift past ~300 ms
            let mut primed = false;
            let cue_shared = shared_cue;
            let st = d.build_output_stream(c, move |data: &mut [f32], info| {
                // keep the cue latency bounded when the two devices' clocks drift
                let avail = cue_rx.slots();
                { let ts = info.timestamp(); let dev = ts.playback.duration_since(ts.callback).as_micros().min(2_000_000) as f32; let tot = dev + (avail as f32 / 2.0 / ratef) * 1e6; let old = cue_shared.cue_lat_us.load(Relaxed) as f32; cue_shared.cue_lat_us.store(if old == 0.0 { tot } else { old * 0.98 + tot * 0.02 } as u32, Relaxed); }
                if avail > hi { for _ in 0..((avail - target) & !1) { let _ = cue_rx.pop(); } }
                if !primed && avail >= target { primed = true; }   // wait for the cushion before playing, so the two devices' different buffer sizes cannot make gaps
                for frame in data.chunks_mut(cch) {
                    frame.fill(0.0);
                    if primed {
                        if cue_rx.slots() >= 2 { frame[cue_ofs] = cue_rx.pop().unwrap_or(0.0); frame[cue_ofs + 1] = cue_rx.pop().unwrap_or(0.0); } else { primed = false; }
                    }
                }
            }, on_err, None).map_err(|e| format!("cannot open cue output: {e}"))?;
            st.play().map_err(|e| format!("cannot start cue output: {e}"))?;
            cue_name = dev_name(&d);
            self.streams.push(st);
        }
        self.settings = Some(s.clone());
        Ok(Status {
            master_name: dev_name(&master), channels: ch, sample_rate: rate, requested_buffer: s.buffer,
            cue: match &s.cue { CueSetting::Off => "off", CueSetting::Same4 => "same4", CueSetting::Device { .. } => "device" }.into(),
            cue_name,
        })
    }
}
pub enum Req {
    Open(Settings, Sender<Result<Status, String>>),
    Close,
    SimulateLoss, // test hook: behave as if the device vanished
}

/// Owns the streams; reopens them after a device loss.
pub fn spawn_manager(mixer: Arc<Mutex<Mixer>>, shared: Arc<Shared>, events: Sender<Value>) -> Sender<Req> {
    let (tx, rx): (Sender<Req>, Receiver<Req>) = mpsc::channel();
    std::thread::Builder::new().name("audio-manager".into()).spawn(move || {
        let mut io = Io::new(mixer, shared);
        let mut lost = false;
        let mut last_try = Instant::now();
        loop {
            match rx.recv_timeout(Duration::from_millis(400)) {
                Ok(Req::Open(s, reply)) => {
                    let r = io.open(&s);
                    match &r {
                        Ok(st) => { lost = false; let _ = events.send(json!({"evt": "audio", "status": st})); }
                        Err(e) => { let _ = events.send(json!({"evt": "audioError", "message": e})); }
                    }
                    let _ = reply.send(r);
                }
                Ok(Req::Close) => { io.close(); io.settings = None; lost = false; }
                Ok(Req::SimulateLoss) => { io.close(); io.failed.store(true, Relaxed); }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if io.settings.is_some() {
                if io.failed.load(Relaxed) && !lost {
                    lost = true; io.close();
                    let _ = events.send(json!({"evt": "audioLost"}));
                }
                if lost && last_try.elapsed() > Duration::from_millis(1000) {
                    last_try = Instant::now();
                    let s = io.settings.clone().unwrap();
                    if let Ok(st) = io.open(&s) { lost = false; let _ = events.send(json!({"evt": "audio", "status": st, "reconnected": true})); }
                }
            }
        }
    }).expect("spawn audio manager");
    tx
}
