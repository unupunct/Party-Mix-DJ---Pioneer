//! File decoding (MP3, FLAC, WAV, AIFF, AAC/M4A, OGG, ALAC) to interleaved stereo f32. Runs on worker threads only.
use crate::core::Track;
use anyhow::{anyhow, Context, Result};
use std::fs::File;
use std::path::Path;
use symphonia::core::audio::sample::Sample;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

pub fn decode_file(path: &str) -> Result<Track> {
    let file = File::open(path).with_context(|| format!("cannot open {path}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) { hint.with_extension(ext); }
    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| anyhow!("unsupported or damaged file: {e}"))?;
    let track = format.default_track(TrackType::Audio).ok_or_else(|| anyhow!("no audio track"))?;
    let params = track.codec_params.as_ref().and_then(|p| p.audio()).ok_or_else(|| anyhow!("no audio parameters"))?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .map_err(|e| anyhow!("no decoder for this codec: {e}"))?;
    let track_id = track.id;

    let mut out: Vec<f32> = Vec::new();
    let mut tmp: Vec<f32> = Vec::new();
    let mut rate = 0u32;
    let mut errors = 0;
    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(Error::ResetRequired) => break,
            Err(e) => { if out.is_empty() { return Err(anyhow!("read error: {e}")); } else { break; } }
        };
        if packet.track_id != track_id { continue; }
        match decoder.decode(&packet) {
            Ok(buf) => {
                let ch = buf.spec().channels().count().max(1);
                rate = buf.spec().rate();
                tmp.resize(buf.samples_interleaved(), f32::MID);
                buf.copy_to_slice_interleaved(&mut tmp);
                match ch {
                    1 => for &s in &tmp { out.push(s); out.push(s); },
                    2 => out.extend_from_slice(&tmp),
                    _ => for f in tmp.chunks(ch) { out.push(f[0]); out.push(f[1]); },
                }
            }
            Err(Error::DecodeError(_)) => { errors += 1; if errors > 200 { return Err(anyhow!("too many decode errors")); } }
            Err(e) => { if out.is_empty() { return Err(anyhow!("decode error: {e}")); } else { break; } }
        }
    }
    if out.is_empty() || rate == 0 { return Err(anyhow!("no audio decoded")); }
    Ok(Track::new(out, rate))
}
