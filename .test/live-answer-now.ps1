# dsh-interview-mode - live check for POST /interview/answer-now (v1.7).
# Plays the same long statement twice: once normally (the engine should judge it
# a statement and drop it) and once interrupted by answer-now halfway through
# (the engine should cut the segment short and deliver it anyway).
# Delivery is aimed at a non-existent session id on purpose, so the transcript
# shows up in /interview/status without ever reaching a real conversation.
# Run with Windows PowerShell 5.1; this file stays ASCII, the Chinese sentence
# lives in .now-lines.txt (UTF-8).
#   powershell.exe -NoProfile -File .test\live-answer-now.ps1
# The DSH server port changes between restarts: when 19387 is not it, pass the
# current GUI URL, e.g. -Base http://127.0.0.1:55475/interview

param([string]$Base = 'http://127.0.0.1:19387/interview')

$ErrorActionPreference = 'Stop'
$base = $Base.TrimEnd('/')
$dir = Join-Path $PSScriptRoot 'live-now'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$txt = Join-Path $PSScriptRoot '.now-lines.txt'
$line = @([IO.File]::ReadAllText($txt, [Text.Encoding]::UTF8) -split "`r?`n" | Where-Object { $_ -ne '' })[0]

$clip = Join-Path $dir 'statement.wav'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $synth.SelectVoice('Microsoft Huihui Desktop') } catch { }
$synth.Rate = 0
$synth.SetOutputToWaveFile($clip)
$synth.Speak($line)
$synth.Dispose()

$fallback = Join-Path $PSScriptRoot 'question-zh.wav'
if (-not (Test-Path $clip) -or (Get-Item $clip).Length -lt 4000) {
  if (Test-Path $fallback) { $clip = $fallback }
}
"clip: " + $clip + " (" + (Get-Item $clip).Length + " bytes)"

function Post($p, $b) { Invoke-RestMethod -Method Post -Uri "$base$p" -ContentType 'application/json' -Body $b }
function Fetch($p) { Invoke-RestMethod "$base$p" }

function Round([bool]$force) {
  Post '/stop' '{}' | Out-Null
  Post '/config' '{"targetSessionId":"live-now-probe","dupWindowMs":0,"minQuestionChars":4,"silenceMs":1000,"autoAnswer":true}' | Out-Null
  Post '/start' '{}' | Out-Null
  Start-Sleep -Milliseconds 700

  $player = New-Object System.Media.SoundPlayer $clip
  $player.Play()
  Start-Sleep -Milliseconds 2400

  $mid = Fetch '/status'
  "  inflight: " + ($mid.inflight | ConvertTo-Json -Compress)
  if ($force) {
    $res = Post '/answer-now' '{}'
    "  answer-now -> ok=" + $res.ok + " delivered=" + $res.delivered + " reason=" + $res.reason + " text=" + $res.text
  }
  $player.Stop()

  Start-Sleep -Seconds 4
  $st = Fetch '/status'
  "  state=" + $st.state + " delivered=" + $st.delivered + " dropped=" + $st.dropped
  foreach ($s in @($st.segments)) {
    "  Q=" + $s.isQuestion + " manual=" + $s.manual + " reason=" + $s.reason + " | " + $s.text
  }
  $errors = @($st.errors)
  if ($errors.Count -gt 0) { "  errors: " + (($errors | ForEach-Object { $_.message }) -join ' | ') }
  Post '/stop' '{}' | Out-Null
}

"ROUND 1 - normal playback (expect: statement, reason not-a-question)"
Round $false
"ROUND 2 - answer-now halfway (expect: manual=true, text delivered anyway)"
Round $true

Post '/config' '{"dupWindowMs":10000,"targetSessionId":""}' | Out-Null
"restored: " + ((Fetch '/status').settings | ConvertTo-Json -Compress)
