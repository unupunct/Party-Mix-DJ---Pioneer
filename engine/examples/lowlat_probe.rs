//! Asks each output device what the lowest shared-mode period is (IAudioClient3). Dev tool, not shipped.
use windows::core::*;
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::*;

fn main() -> Result<()> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let coll = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        for i in 0..coll.GetCount()? {
            let dev = coll.Item(i)?;
            let id = dev.GetId()?.to_string()?;
            let name = {
                let ps = dev.OpenPropertyStore(STGM_READ)?;
                let v = ps.GetValue(&windows::Win32::Foundation::PROPERTYKEY { fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0), pid: 14 })?;
                v.to_string()
            };
            print!("{name}: ");
            if let Ok(c1) = dev.Activate::<IAudioClient>(CLSCTX_ALL, None) {
                let (mut dp, mut mp) = (0i64, 0i64);
                if c1.GetDevicePeriod(Some(&mut dp), Some(&mut mp)).is_ok() { print!("[exclusive-mode periods: default {:.2} ms, MIN {:.2} ms] ", dp as f64 / 10000.0, mp as f64 / 10000.0); }
            }
            match dev.Activate::<IAudioClient3>(CLSCTX_ALL, None) {
                Ok(c) => {
                    let fmt = c.GetMixFormat()?;
                    let (mut d, mut f, mut mn, mut mx) = (0u32, 0u32, 0u32, 0u32);
                    match c.GetSharedModeEnginePeriod(fmt, &mut d, &mut f, &mut mn, &mut mx) {
                        Ok(()) => { let sr = (*fmt).nSamplesPerSec as f32; println!("sample rate {sr}, default period {d} frames ({:.2} ms), fundamental {f}, MIN {mn} frames ({:.2} ms), max {mx}", d as f32 * 1000.0 / sr, mn as f32 * 1000.0 / sr); }
                        Err(e) => println!("GetSharedModeEnginePeriod failed: {e}"),
                    }
                }
                Err(e) => println!("IAudioClient3 not available ({e})"),
            }
            let _ = id;
        }
    }
    Ok(())
}
