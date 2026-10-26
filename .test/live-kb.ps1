# Live check: does the running app inline the configured knowledge base into the delivered question?
# ASCII-only source on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI and would choke
# on Chinese literals. The question text lives in .kb-live-question.txt (UTF-8) and the report is
# written as UTF-8 JSON so the caller can read it without console codepage games.
# The DSH port changes between restarts: pass -Base with the current GUI URL when
# 19387 is not it (e.g. -Base http://127.0.0.1:55475/interview).
param([string]$Base = 'http://127.0.0.1:19387/interview')

$ErrorActionPreference = 'Stop'
# Repo-relative: .test -> repo -> workspace, so the repo carries no local paths.
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$base = $Base.TrimEnd('/')
$kbDir = "$root\dsh-interview-mode\.test\.kb-live"
$qfile = "$root\dsh-interview-mode\.test\.kb-live-question.txt"
$wav = "$kbDir\q.wav"
$report = "$kbDir\report.json"

# Self-contained knowledge fixture: one small markdown file, copied from the committed fixture.
New-Item -ItemType Directory -Force -Path $kbDir | Out-Null
Copy-Item "$root\dsh-interview-mode\.test\fixtures\kb.md" "$kbDir\bio.md" -Force
$kbUri = $kbDir -replace '\\', '/'
$cfg = Invoke-RestMethod -Method Post -Uri "$base/config" -ContentType 'application/json' -Body (@{ knowledgeBase = $kbUri; knowledgeList = @($kbUri) } | ConvertTo-Json)

$script = [IO.File]::ReadAllText($qfile, [Text.Encoding]::UTF8).Trim()

# SAPI synthesis is optional: this machine sometimes exposes no voice to the sandboxed process.
# Fall back to the pre-rendered question-zh.wav (same wording as .kb-live-fallback-question.txt).
$fallback = "$root\dsh-interview-mode\.test\question-zh.wav"
$synthOk = $false
try {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SelectVoice('Microsoft Huihui Desktop')
  $synth.SetOutputToWaveFile($wav)
  $synth.Speak($script)
  $synth.Dispose()
  $synthOk = $true
} catch {
  $wav = $fallback
  $script = [IO.File]::ReadAllText("$root\dsh-interview-mode\.test\.kb-live-fallback-question.txt", [Text.Encoding]::UTF8).Trim()
}

$start = Invoke-RestMethod -Method Post -Uri "$base/start" -ContentType 'application/json' -Body '{}'
$player = New-Object System.Media.SoundPlayer $wav
$player.PlaySync()
Start-Sleep -Seconds 6
$st = Invoke-RestMethod "$base/status"
$stop = Invoke-RestMethod -Method Post -Uri "$base/stop"

$out = [ordered]@{
  knowledgeBase = $kbUri
  configOk   = $cfg.ok
  question   = $script
  synthOk    = $synthOk
  wavBytes   = (Get-Item $wav).Length
  startState = $start.state
  state      = $st.state
  delivered  = $st.delivered
  dropped    = $st.dropped
  errors     = $st.errors
  segments   = @($st.segments | ForEach-Object { $_.text })
  lastText   = $st.lastText
  delivery   = $st.lastDelivery
  stopState  = $stop.state
  knowledge  = $st.knowledge
}
[IO.File]::WriteAllText($report, ($out | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
"report written: $report"
"delivered=$($st.delivered) dropped=$($st.dropped) state=$($st.state)"
