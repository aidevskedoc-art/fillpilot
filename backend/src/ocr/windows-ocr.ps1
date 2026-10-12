# Windows built-in OCR (Windows.Media.Ocr) on one image.
# Writes JSON to -OutPath: { lang, width, height, words: [{ t, x, y, w, h, line }] }
# (pixel coordinates, top-left origin) or { error }.
# Runs locally — no network, no data leaves the machine.
param([string]$ImagePath, [string]$OutPath)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Await($op, [Type]$type) {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
  }
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) { throw 'No OCR language is installed for this Windows user (Settings > Time & Language > Language).' }
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $words = New-Object System.Collections.Generic.List[object]
  $lineNo = 0
  foreach ($line in $result.Lines) {
    $lineNo++
    foreach ($w in $line.Words) {
      $r = $w.BoundingRect
      $words.Add([pscustomobject]@{ t = $w.Text; x = [math]::Round($r.X); y = [math]::Round($r.Y); w = [math]::Round($r.Width); h = [math]::Round($r.Height); line = $lineNo })
    }
  }
  $stream.Dispose()
  [pscustomobject]@{ lang = $engine.RecognizerLanguage.LanguageTag; width = $bitmap.PixelWidth; height = $bitmap.PixelHeight; words = $words } |
    ConvertTo-Json -Depth 4 -Compress | Out-File -FilePath $OutPath -Encoding utf8
} catch {
  ('{"error":' + (ConvertTo-Json ([string]$_.Exception.Message)) + '}') | Out-File -FilePath $OutPath -Encoding utf8
}
