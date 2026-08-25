#!/usr/bin/env python3
# /// script
# requires-python = "==3.12.*"
# dependencies = [
#   "pyarrow==21.0.0",
#   "praatio==6.2.0",
# ]
# ///
"""Prepare the pinned, local-only speech quality corpus.

Downloads remain owned by the existing Node resource cache. This helper only
extracts pinned selections, delegates media conversion to FFmpeg, and converts
upstream annotations into the prepared benchmark contract.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import os
import re
import subprocess
import tarfile
import wave
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import pyarrow.parquet as pq
from praatio import textgrid


SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
AISHELL_MARKUP = re.compile(r"<[^>]*>|[&#]")
MAX_REFERENCE_CHARS = 1_000_000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-lock", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--aishell1-audio", required=True)
    parser.add_argument("--aishell1-transcript", required=True)
    parser.add_argument("--aishell4-audio", required=True)
    parser.add_argument("--aishell4-textgrid", required=True)
    parser.add_argument("--aishell4-rttm", required=True)
    parser.add_argument("--ascend-test", required=True)
    parser.add_argument("--ami-audio", required=True)
    parser.add_argument("--ami-annotations", required=True)
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def write_new(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as output:
        output.write(payload)


def run_ffmpeg(source: Path, output: Path, start: float, duration: float, ogg: bool) -> None:
    if not math.isfinite(start) or not math.isfinite(duration) or start < 0 or duration <= 0:
        raise ValueError("Invalid FFmpeg crop window")
    arguments = [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-ss",
        f"{start:.6f}",
        "-t",
        f"{duration:.6f}",
        "-map",
        "0:a:0",
        "-map_metadata",
        "-1",
        "-fflags",
        "+bitexact",
    ]
    if ogg:
        arguments.extend(
            [
                "-ac",
                "1",
                "-ar",
                "48000",
                "-c:a",
                "libopus",
                "-flags:a",
                "+bitexact",
                "-application",
                "audio",
                "-frame_duration",
                "20",
                "-vbr",
                "off",
                "-b:a",
                "64k",
                str(output),
            ]
        )
    elif output.suffix == ".flac":
        arguments.extend(
            [
                "-c:a",
                "flac",
                "-flags:a",
                "+bitexact",
                "-compression_level",
                "8",
                str(output),
            ]
        )
    else:
        arguments.extend(
            [
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                "-flags:a",
                "+bitexact",
                str(output),
            ]
        )
    subprocess.run(arguments, check=True)


def source_evidence(path: Path) -> tuple[int, str]:
    metadata = path.stat()
    if not path.is_file() or path.is_symlink() or metadata.st_size <= 0:
        raise ValueError(f"Prepared source is unsafe: {path}")
    return metadata.st_size, sha256_file(path)


def validate_ffmpeg(expected_version: str) -> None:
    first_line = subprocess.check_output(
        ["ffmpeg", "-version"],
        text=True,
        stderr=subprocess.STDOUT,
    ).splitlines()[0]
    if not first_line.startswith(f"ffmpeg version {expected_version} "):
        raise ValueError(
            f"Speech quality corpus requires FFmpeg {expected_version}; got {first_line}"
        )


def validate_python_tools(tools: dict) -> None:
    expected = {
        "pyarrow": tools.get("pyarrow"),
        "praatio": tools.get("praatio"),
    }
    actual = {
        package: importlib.metadata.version(package) for package in expected
    }
    if actual != expected:
        raise ValueError(
            f"Speech quality Python tool versions drifted: expected={expected}, actual={actual}"
        )


def wav_duration_ms(path: Path) -> int:
    with wave.open(str(path), "rb") as audio:
        return round(audio.getnframes() * 1000 / audio.getframerate())


def asr_case(
    root: Path,
    case_id: str,
    group: str,
    language: str,
    metric: str,
    source: Path,
    reference: str,
    timeout_ms: int,
) -> dict:
    if not reference.strip() or len(reference) > MAX_REFERENCE_CHARS:
        raise ValueError(f"Invalid ASR reference for {case_id}")
    source_bytes, source_sha256 = source_evidence(source)
    return {
        "id": case_id,
        "kind": "asr",
        "group": group,
        "language": language,
        "metric": metric,
        "sourcePath": source.relative_to(root).as_posix(),
        "sourceBytes": source_bytes,
        "sourceSha256": source_sha256,
        "timeoutMs": timeout_ms,
        "reference": reference,
    }


def diarization_case(
    root: Path,
    case_id: str,
    source: Path,
    reference: list[dict],
    collar_seconds: float,
    timeout_ms: int,
) -> dict:
    if not reference:
        raise ValueError(f"Invalid diarization reference for {case_id}")
    source_bytes, source_sha256 = source_evidence(source)
    return {
        "id": case_id,
        "kind": "diarization",
        "group": "meeting",
        "sourcePath": source.relative_to(root).as_posix(),
        "sourceBytes": source_bytes,
        "sourceSha256": source_sha256,
        "timeoutMs": timeout_ms,
        "collarSeconds": collar_seconds,
        "reference": reference,
    }


def load_aishell1_references(path: Path) -> dict[str, str]:
    references = {}
    with path.open("r", encoding="utf8") as source:
        for line in source:
            parts = line.strip().split(maxsplit=1)
            if len(parts) == 2:
                references[parts[0]] = parts[1]
    return references


def prepare_aishell1(
    root: Path,
    archive_path: Path,
    transcript_path: Path,
    utterance_ids: list[str],
) -> list[dict]:
    references = load_aishell1_references(transcript_path)
    cases = []
    with tarfile.open(archive_path, "r:gz") as archive:
        for utterance_id in utterance_ids:
            if not SAFE_ID.fullmatch(utterance_id) or utterance_id not in references:
                raise ValueError(f"Unknown AISHELL-1 selection: {utterance_id}")
            member_name = f"train/S0002/{utterance_id}.wav"
            member = archive.getmember(member_name)
            if not member.isfile() or member.size <= 0 or member.size > 16 * 1024 * 1024:
                raise ValueError(f"Unsafe AISHELL-1 member: {member_name}")
            extracted = archive.extractfile(member)
            if extracted is None:
                raise ValueError(f"Missing AISHELL-1 member: {member_name}")
            output = root / "audio" / f"aishell1-{utterance_id}.wav"
            write_new(output, extracted.read())
            if not 250 <= wav_duration_ms(output) <= 60_000:
                raise ValueError(f"Unexpected AISHELL-1 duration: {utterance_id}")
            cases.append(
                asr_case(
                    root,
                    f"aishell1-{utterance_id}",
                    "mandarin-near",
                    "zh",
                    "cer",
                    output,
                    references[utterance_id],
                    120_000,
                )
            )
    return cases


def clean_aishell_text(value: str) -> str:
    return " ".join(AISHELL_MARKUP.sub("", value).split())


def aishell4_reference(path: Path, start: float, duration: float) -> str:
    stop = start + duration
    grid = textgrid.openTextgrid(str(path), includeEmptyIntervals=False)
    entries = []
    for tier_name in grid.tierNames:
        tier = grid.getTier(tier_name)
        for entry in tier.entries:
            if entry.end > start and entry.start < stop:
                cleaned = clean_aishell_text(entry.label)
                if cleaned:
                    entries.append((entry.start, entry.end, tier_name, cleaned))
    entries.sort(key=lambda item: (item[0], item[1], item[2]))
    return " ".join(item[3] for item in entries)


def rttm_reference(path: Path, start: float, duration: float) -> list[dict]:
    stop = start + duration
    segments = []
    with path.open("r", encoding="utf8") as source:
        for line in source:
            fields = line.split()
            if len(fields) != 10 or fields[0] != "SPEAKER":
                raise ValueError("Invalid AISHELL-4 RTTM line")
            segment_start = float(fields[3])
            segment_end = segment_start + float(fields[4])
            if segment_end <= start or segment_start >= stop:
                continue
            speaker = fields[7]
            if not SAFE_ID.fullmatch(speaker):
                raise ValueError("Invalid AISHELL-4 RTTM speaker")
            segments.append(
                {
                    "speaker": speaker,
                    "startSeconds": max(segment_start, start) - start,
                    "endSeconds": min(segment_end, stop) - start,
                }
            )
    segments.sort(key=lambda item: (item["startSeconds"], item["endSeconds"], item["speaker"]))
    return segments


def prepare_aishell4(
    root: Path,
    audio_path: Path,
    textgrid_path: Path,
    rttm_path: Path,
    asr_window: dict,
    diarization_window: dict,
) -> list[dict]:
    asr_audio = root / "audio" / "aishell4-mandarin-meeting.flac"
    run_ffmpeg(
        audio_path,
        asr_audio,
        asr_window["startSeconds"],
        asr_window["durationSeconds"],
        False,
    )
    diarization_audio = root / "audio" / "aishell4-four-speaker-overlap.ogg"
    run_ffmpeg(
        audio_path,
        diarization_audio,
        diarization_window["startSeconds"],
        diarization_window["durationSeconds"],
        True,
    )
    return [
        asr_case(
            root,
            "aishell4-mandarin-meeting",
            "mandarin-meeting",
            "zh",
            "cer",
            asr_audio,
            aishell4_reference(
                textgrid_path,
                asr_window["startSeconds"],
                asr_window["durationSeconds"],
            ),
            20 * 60 * 1000,
        ),
        diarization_case(
            root,
            "aishell4-four-speaker-overlap",
            diarization_audio,
            rttm_reference(
                rttm_path,
                diarization_window["startSeconds"],
                diarization_window["durationSeconds"],
            ),
            diarization_window["collarSeconds"],
            20 * 60 * 1000,
        ),
    ]


def prepare_ascend(root: Path, parquet_path: Path, utterance_ids: list[str]) -> list[dict]:
    requested = set(utterance_ids)
    if len(requested) != len(utterance_ids) or any(
        not SAFE_ID.fullmatch(value) for value in utterance_ids
    ):
        raise ValueError("Invalid ASCEND selection")
    table = pq.read_table(
        parquet_path,
        filters=[("id", "in", utterance_ids)],
    )
    selected = {row["id"]: row for row in table.to_pylist() if row["id"] in requested}
    if set(selected) != requested:
        raise ValueError("ASCEND selection is incomplete")
    cases = []
    for utterance_id in utterance_ids:
        row = selected[utterance_id]
        audio = row["audio"]
        if row["language"] != "mixed" or not isinstance(audio, dict) or not audio.get("bytes"):
            raise ValueError(f"ASCEND selection is invalid: {utterance_id}")
        output = root / "audio" / f"ascend-{utterance_id}.wav"
        write_new(output, audio["bytes"])
        cases.append(
            asr_case(
                root,
                f"ascend-{utterance_id}",
                "mixed",
                "mixed",
                "cer",
                output,
                row["transcription"],
                120_000,
            )
        )
    return cases


def ami_words(archive: zipfile.ZipFile, meeting: str, start: float, duration: float) -> str:
    stop = start + duration
    words = []
    for speaker in "ABCD":
        payload = archive.read(f"words/{meeting}.{speaker}.words.xml")
        root = ET.fromstring(payload)
        for element in root.iter("w"):
            word_start = float(element.attrib["starttime"])
            word_end = float(element.attrib["endtime"])
            text = element.text or ""
            if (
                element.attrib.get("punc") != "true"
                and word_end >= start
                and word_start < stop
                and text.strip()
            ):
                words.append((word_start, word_end, speaker, text.strip()))
    words.sort(key=lambda item: (item[0], item[1], item[2]))
    return " ".join(item[3] for item in words)


def ami_turns(
    archive: zipfile.ZipFile, meeting: str, start: float, duration: float
) -> list[dict]:
    stop = start + duration
    turns = []
    for speaker in "ABCD":
        payload = archive.read(f"segments/{meeting}.{speaker}.segments.xml")
        root = ET.fromstring(payload)
        for element in root.iter("segment"):
            segment_start = float(element.attrib["transcriber_start"])
            segment_end = float(element.attrib["transcriber_end"])
            if segment_end <= start or segment_start >= stop:
                continue
            turns.append(
                {
                    "speaker": speaker,
                    "startSeconds": max(segment_start, start) - start,
                    "endSeconds": min(segment_end, stop) - start,
                }
            )
    turns.sort(key=lambda item: (item["startSeconds"], item["endSeconds"], item["speaker"]))
    return turns


def prepare_ami(
    root: Path,
    audio_path: Path,
    annotation_path: Path,
    asr_window: dict,
    diarization_window: dict,
) -> list[dict]:
    if asr_window["meeting"] != diarization_window["meeting"]:
        raise ValueError("AMI benchmark windows must use one meeting")
    meeting = asr_window["meeting"]
    asr_audio = root / "audio" / "ami-english-meeting.wav"
    run_ffmpeg(
        audio_path,
        asr_audio,
        asr_window["startSeconds"],
        asr_window["durationSeconds"],
        False,
    )
    diarization_audio = root / "audio" / "ami-four-speaker-meeting.ogg"
    run_ffmpeg(
        audio_path,
        diarization_audio,
        diarization_window["startSeconds"],
        diarization_window["durationSeconds"],
        True,
    )
    with zipfile.ZipFile(annotation_path) as archive:
        return [
            asr_case(
                root,
                "ami-english-meeting",
                "english-meeting",
                "en",
                "wer",
                asr_audio,
                ami_words(
                    archive,
                    meeting,
                    asr_window["startSeconds"],
                    asr_window["durationSeconds"],
                ),
                20 * 60 * 1000,
            ),
            diarization_case(
                root,
                "ami-four-speaker-meeting",
                diarization_audio,
                ami_turns(
                    archive,
                    meeting,
                    diarization_window["startSeconds"],
                    diarization_window["durationSeconds"],
                ),
                diarization_window["collarSeconds"],
                20 * 60 * 1000,
            ),
        ]


def main() -> None:
    arguments = parse_args()
    source_lock_path = Path(arguments.source_lock).resolve()
    source_lock = json.loads(source_lock_path.read_text(encoding="utf8"))
    if source_lock.get("schemaVersion") != 1:
        raise ValueError("Speech quality source lock schema is unsupported")
    validate_python_tools(source_lock["tools"])
    validate_ffmpeg(source_lock["tools"]["ffmpeg"])
    output = Path(arguments.output).resolve()
    repository_root = Path(__file__).resolve().parent.parent
    if output == repository_root or output.is_relative_to(repository_root):
        raise ValueError(
            "Speech quality corpus output must stay outside the repository"
        )
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    selections = source_lock["selections"]
    cases = []
    cases.extend(
        prepare_aishell1(
            output,
            Path(arguments.aishell1_audio),
            Path(arguments.aishell1_transcript),
            selections["aishell1Utterances"],
        )
    )
    cases.extend(
        prepare_aishell4(
            output,
            Path(arguments.aishell4_audio),
            Path(arguments.aishell4_textgrid),
            Path(arguments.aishell4_rttm),
            selections["aishell4AsrWindow"],
            selections["aishell4DiarizationWindow"],
        )
    )
    cases.extend(
        prepare_ascend(
            output,
            Path(arguments.ascend_test),
            selections["ascendUtterances"],
        )
    )
    cases.extend(
        prepare_ami(
            output,
            Path(arguments.ami_audio),
            Path(arguments.ami_annotations),
            selections["amiAsrWindow"],
            selections["amiDiarizationWindow"],
        )
    )
    manifest = {
        "schemaVersion": 1,
        "corpusVersion": source_lock["corpusVersion"],
        "cases": cases,
    }
    manifest_path = output / "prepared-corpus.json"
    with manifest_path.open("x", encoding="utf8") as destination:
        json.dump(manifest, destination, ensure_ascii=False, indent=2)
        destination.write("\n")
    os.chmod(manifest_path, 0o600)
    manifest_sha256 = sha256_file(manifest_path)
    if manifest_sha256 != source_lock.get("preparedManifestSha256"):
        raise ValueError(
            "Prepared speech quality corpus does not match the locked manifest"
        )
    print(
        json.dumps(
            {
                "corpusVersion": manifest["corpusVersion"],
                "caseCount": len(cases),
                "manifestPath": str(manifest_path),
                "manifestSha256": manifest_sha256,
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
