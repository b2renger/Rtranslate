# NOTE: this file MUST stay UTF-8 *with* a BOM. Windows PowerShell 5.1 reads a
# .ps1 as the system ANSI codepage unless a BOM says otherwise, and without one
# every accented character in the French passage below is read as mojibake and
# then spoken as mojibake. The transcript it writes is UTF-8 WITHOUT a BOM - the
# opposite rule, because that one is data, not script.

<#
.SYNOPSIS
    Generate a 16 kHz mono speech sample with a known transcript, using the
    voices Windows already has.

.DESCRIPTION
    Comparing two engines needs the same audio through both, and comparing
    accuracy needs to know what was actually said. A microphone recording gives
    neither for free: it is different every time, and its transcript is whatever
    you remember saying.

    SAPI gives both. The text is written next to the WAV, so a run can be scored
    and not just timed, and anyone can reproduce the input on any Windows box
    with no microphone, no download and no quiet room.

    It is synthetic speech, so it is CLEANER than real audio - no room, no
    overlap, no disfluency. Treat the numbers as a floor on difficulty. The
    conclusion it supports is "engine A is faster than engine B on identical
    input", not "this is what a meeting sounds like".

.EXAMPLE
    .\make-sample.ps1 -Language fr
    .\make-sample.ps1 -Language en -Seconds 60
#>

[CmdletBinding()]
param(
    [ValidateSet('fr', 'en')]
    [string]$Language = 'fr',

    # Repeats the passage until at least this many seconds are covered.
    [int]$Seconds = 60,

    [string]$OutDir = (Join-Path $PSScriptRoot 'samples')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

# Natural sentence boundaries matter: the incumbent's NLLB path is
# sentence-gated, so a passage of real sentences measures something a word list
# would not.
$passages = @{
    fr = @(
        "Bonjour à toutes et à tous, et merci d'être venus si nombreux ce matin.",
        "Nous allons parler de la traduction automatique en temps réel, et de ce qui la rend difficile.",
        "Le problème n'est pas de traduire une phrase complète, mais de décider quand une phrase est terminée.",
        "Si le système attend trop longtemps, la conversation avance sans lui.",
        "S'il n'attend pas assez, il traduit une pensée qui n'est pas encore finie.",
        "C'est exactement le compromis que nous essayons de mesurer aujourd'hui."
    )
    en = @(
        "Good morning everyone, and thank you all for coming out so early.",
        "We are going to talk about real time machine translation, and what makes it hard.",
        "The problem is not translating a finished sentence, but deciding when a sentence has finished.",
        "If the system waits too long, the conversation moves on without it.",
        "If it does not wait long enough, it translates a thought that is not complete.",
        "That trade off is exactly what we are trying to measure today."
    )
}

$voiceCulture = if ($Language -eq 'fr') { 'fr-FR' } else { 'en-US' }

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $synth.GetInstalledVoices() |
    Where-Object { $_.VoiceInfo.Culture.Name -eq $voiceCulture } |
    Select-Object -First 1

if (-not $voice) {
    $have = ($synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Culture.Name }) -join ', '
    throw "No $voiceCulture voice installed. Available: $have. Add one under Settings > Time & Language > Speech."
}
$synth.SelectVoice($voice.VoiceInfo.Name)

# Build enough text to cover the requested duration. Measured at the default
# rate with these passages: about 6.1 s per sentence in French, 5.0 s in
# English. It is an estimate, so the real duration is printed at the end and
# that is the number to quote - the profiler reads it from the file anyway.
$secondsPerSentence = if ($Language -eq 'fr') { 6.1 } else { 5.0 }
$lines = @()
$sentences = $passages[$Language]
for ($i = 0; $i -lt [Math]::Ceiling($Seconds / $secondsPerSentence); $i++) {
    $lines += $sentences[$i % $sentences.Count]
}
$text = $lines -join ' '

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$wav = Join-Path $OutDir "$($Language)_$($Seconds)s.wav"
$txt = Join-Path $OutDir "$($Language)_$($Seconds)s.txt"

# 16 kHz, 16-bit, mono - the one format the engine contract accepts, written
# directly so nothing has to resample it later.
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    16000,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono
)

$synth.SetOutputToWaveFile($wav, $format)
$synth.Speak($text) | Out-Null
$synth.SetOutputToNull()
$synth.Dispose()

# UTF-8 *without* a BOM. Windows PowerShell's -Encoding utf8 writes one, and a
# BOM at the head of the reference transcript turns the first word into mojibake
# for anything that scores against it.
[System.IO.File]::WriteAllText($txt, $text, (New-Object System.Text.UTF8Encoding($false)))

$bytes = (Get-Item $wav).Length
$duration = [Math]::Round(($bytes - 44) / 2 / 16000, 1)

Write-Host ""
Write-Host "  wrote $wav"
Write-Host "  $duration s of $voiceCulture speech, 16 kHz mono, $([Math]::Round($bytes/1KB)) KB"
Write-Host "  transcript: $txt"
Write-Host ""
Write-Host "  node spike\profile.mjs --engine qvac --wav $wav"
Write-Host ""
