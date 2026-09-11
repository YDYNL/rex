Add-Type -AssemblyName System.Drawing
$base = 'C:\Users\jieliu\AppData\Roaming\TRAE SOLO CN\ModularData\ai-agent\work-mode-projects\6a9f7a1d9879c75e4bf84790\yueban\resources\png'
foreach ($s in @(16, 32, 48, 256)) {
  $p = Join-Path $base "$s.png"
  $b = [System.Drawing.Bitmap]::FromFile($p)
  $c1 = $b.GetPixel(0, 0).A
  $c2 = $b.GetPixel($s - 1, 0).A
  $c3 = $b.GetPixel(0, $s - 1).A
  $c4 = $b.GetPixel($s - 1, $s - 1).A
  $mid = $b.GetPixel([int]($s / 2), [int]($s / 2)).A
  Write-Output "${s}px corners=$c1,$c2,$c3,$c4 center=$mid"
  $b.Dispose()
}
