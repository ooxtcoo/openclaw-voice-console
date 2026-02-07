param(
  [Parameter(Mandatory=$true)][string]$Text,
  [Parameter(Mandatory=$true)][string]$OutFile,
  [string]$VoiceName = 'Microsoft Hedda Desktop'
)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $s.SelectVoice($VoiceName)
} catch {
  $s.SelectVoice('Microsoft Hedda Desktop')
}
$s.Rate = 0
$s.Volume = 100
$s.SetOutputToWaveFile($OutFile)
$s.Speak($Text)
$s.SetOutputToNull()
$s.Dispose()
