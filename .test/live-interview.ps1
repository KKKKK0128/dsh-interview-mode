# dsh-interview-mode — 现场端到端：播放一段含「提问 + 陈述 + 提问」的中文语音，
# 让插件自己采集 → 转写 → 判定 → 投递，最后打印 status 与 stop 结果。
#
# 必须在**非沙箱**进程里跑：沙箱内既没有 SAPI 语音、播放出的声音也进不了环回采集。
#
#   pwsh -NoProfile -File .test/live-interview.ps1

$ErrorActionPreference = 'Stop'
# 音频固定生成在脚本旁边的目录里，不写死本机绝对路径。
$wav = Join-Path $PSScriptRoot 'question-zh.wav'
$base = 'http://127.0.0.1:19387/interview'

$script = '请你介绍一下你在光电硬件方面最擅长的项目经验。我本科是应用物理专业，后来读了硕士。这个项目的难点在哪里呢？'

if (-not (Test-Path $wav)) {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SelectVoice('Microsoft Huihui Desktop')
  $synth.SetOutputToWaveFile($wav)
  $synth.Speak($script)
  $synth.Dispose()
}
"wav: $wav ($((Get-Item $wav).Length) bytes)"
"script: $script"

# 不带 sessionId：让引擎自己挑「最近更新的非空会话」，顺便验证兜底逻辑。
$start = Invoke-RestMethod -Method Post -Uri "$base/start" -ContentType 'application/json' -Body '{}'
"start: " + ($start | ConvertTo-Json -Compress -Depth 6)

$player = New-Object System.Media.SoundPlayer $wav
$player.PlaySync()
Start-Sleep -Seconds 4   # 等最后一段的静音切段 + 转写闭环

$st = Invoke-RestMethod "$base/status"
"status: " + ($st | ConvertTo-Json -Compress -Depth 8)

$stop = Invoke-RestMethod -Method Post -Uri "$base/stop"
"stop: " + ($stop | ConvertTo-Json -Compress -Depth 6)

$ping = Invoke-RestMethod "$base/ping"
"ping: " + ($ping | ConvertTo-Json -Compress -Depth 6)
