# Samples Windows' own per-channel peak meters for audio endpoints (IAudioMeterInformation) and writes
# "epoch_ms Name=ch1/ch2/.. Name2=..." rows. Used by scripts/engine-hw-test.js to prove which channels receive audio.
param([string[]]$Names = @('Party Mix'), [int]$Seconds = 30, [string]$OutFile, [int]$IntervalMs = 50)
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Collections.Generic; using System.Threading;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumeratorCom {}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator { int EnumAudioEndpoints(int f, int m, out IntPtr d); int GetDefaultAudioEndpoint(int f, int r, out IMMDevice d); int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice d); }
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice { int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioMeterInformation { int GetPeakValue(out float v); int GetMeterChannelCount(out uint n); int GetChannelsPeakValues(uint n, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] float[] v); }
public class Meter {
  public static IAudioMeterInformation Open(string id) { var e = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom(); IMMDevice d; e.GetDevice(id, out d); Guid g = new Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"); object o; d.Activate(ref g, 23, IntPtr.Zero, out o); return (IAudioMeterInformation)o; }
  public static void Run(string[] names, string[] ids, int ms, int seconds, string file) {
    var meters = new List<IAudioMeterInformation>(); foreach (var id in ids) meters.Add(Open(id));
    Console.WriteLine("METER_READY"); Console.Out.Flush();
    var rows = new List<string>(); var end = DateTime.UtcNow.AddSeconds(seconds);
    while (DateTime.UtcNow < end) {
      long t = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; var parts = new List<string> { t.ToString() };
      for (int i = 0; i < meters.Count; i++) { uint n; meters[i].GetMeterChannelCount(out n); var a = new float[Math.Max(n, 1)]; meters[i].GetChannelsPeakValues(n, a); parts.Add(names[i].Replace(' ', '_') + "=" + string.Join("/", Array.ConvertAll(a, x => x.ToString("0.00")))); }
      rows.Add(string.Join(" ", parts)); Thread.Sleep(ms);
    }
    System.IO.File.WriteAllLines(file, rows);
  }
}
'@
$ids = foreach ($n in $Names) {
  $d = Get-PnpDevice -Class AudioEndpoint -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match [regex]::Escape($n) -and $_.InstanceId -match '\{0\.0\.0\.' } | Select-Object -First 1
  if (-not $d) { Write-Error "no render endpoint matching '$n'"; exit 2 }
  '{0.0.0.00000000}.' + ($d.InstanceId -split '\.')[-1]
}
[Meter]::Run($Names, [string[]]$ids, $IntervalMs, $Seconds, $OutFile)
