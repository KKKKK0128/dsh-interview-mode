# dsh-interview-mode - live check for question-detection sensitivity.
# Plays three short clips (statement / weak-hint sentence / particle question)
# once per preset (strict, standard, high) and prints the engine's judgement.
# Run with Windows PowerShell 5.1 (SAPI voices); the script itself stays ASCII,
# the Chinese sentences live in .sens-lines.txt (UTF-8).
#   powershell.exe -NoProfile -File .test\live-sensitivity.ps1

$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:19387/interview'
$dir = Join-Path $PSScriptRoot 'live-sens'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$txt = Join-Path $PSScriptRoot '.sens-lines.txt'
$lines = @([IO.File]::ReadAllText($txt, [Text.Encoding]::UTF8) -split "`r?`n" | Where-Object { $_ -ne '' })

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice('Microsoft Huihui Desktop')
$synth.Rate = 0
$wavs = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
  $w = Join-Path $dir ("clip$i.wav")
  $synth.SetOutputToWaveFile($w)
  $synth.Speak($lines[$i])
  $wavs += $w
}
$synth.Dispose()
"clips: " + (($wavs | ForEach-Object { (Get-Item $_).Length }) -join ', ')

function Post($p, $b) { Invoke-RestMethod -Method Post -Uri "$base$p" -ContentType 'application/json' -Body $b }
function Fetch($p) { Invoke-RestMethod "$base$p" }

foreach ($preset in @('strict', 'standard', 'high')) {
  Post '/stop' '{}' | Out-Null
  Post '/config' ('{"questionSensitivity":"' + $preset + '","dupWindowMs":0,"targetSessionId":"live-sens-probe","minQuestionChars":4}') | Out-Null
  Post '/start' '{}' | Out-Null
  foreach ($w in $wavs) {
    $player = New-Object System.Media.SoundPlayer $w
    $player.PlaySync()
    Start-Sleep -Milliseconds 1400
  }
  Start-Sleep -Seconds 3
  $st = Fetch '/status'
  "PRESET " + $preset + " state=" + $st.state + " delivered=" + $st.delivered + " dropped=" + $st.dropped
  foreach ($s in @($st.segments)) {
    "  Q=" + $s.isQuestion + " lang=" + $s.lang + " promo=" + $s.promoted + " reason=" + $s.reason + " | " + $s.text
  }
  $errors = @($st.errors)
  if ($errors.Count -gt 0) { "  errors: " + (($errors | ForEach-Object { $_.message }) -join ' | ') }
  Post '/stop' '{}' | Out-Null
}

Post '/config' '{"dupWindowMs":10000,"targetSessionId":""}' | Out-Null
"restored: " + ((Fetch '/status').settings | ConvertTo-Json -Compress)
