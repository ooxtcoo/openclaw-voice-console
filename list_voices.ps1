Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | ForEach-Object {
  $v = $_.VoiceInfo
  [PSCustomObject]@{
    Name = $v.Name
    Culture = $v.Culture.Name
    Gender = $v.Gender.ToString()
    Age = $v.Age.ToString()
  }
} | ConvertTo-Json -Depth 2
