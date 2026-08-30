# Attachment audio fixtures

These files are deterministic, synthetic 440 Hz/880 Hz tones generated with
FFmpeg 8.0.1. They contain no user or third-party media. FFmpeg is a
development-only fixture generator; MyAgents does not invoke or bundle it at
runtime.

The corpus pins the product admission table against real container/codec
bytes: WAV/IMA ADPCM, AIFF/PCM, MP3, FLAC, OGG/Vorbis, M4A/AAC-LC,
M4A/ALAC, every allowed MP4 and MOV audio codec (including video-bearing
AAC-LC/PCM examples), MP4 without audio, MP4 with two non-default audio
tracks, and unsupported WAV mu-law. Each tone is 0.25 seconds at 48 kHz
unless the format command requires otherwise.

Regenerate from lavfi `sine`/`color` inputs with the codec and container named
by each file. MP4 fixtures use `mpeg4` video and `-movflags +faststart`;
`video-two-audio.mp4` clears both audio disposition flags so the fallback-track
warning contract is exercised.
