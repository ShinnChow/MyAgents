#!/usr/bin/env python3
# /// script
# requires-python = "==3.12.*"
# dependencies = [
#   "jiwer==4.0.0",
#   "meeteval==0.4.3",
#   "wetext==0.1.6",
# ]
# ///
"""Content-redacted speech quality metrics for the release benchmark.

This script intentionally delegates edit-distance metrics to JiWER and DER to
MeetEval. MyAgents only owns corpus normalization, grouping, and the release
threshold contract.
"""

from __future__ import annotations

import json
import math
import re
import sys
import unicodedata
from collections import defaultdict
from importlib.metadata import version

import jiwer
import meeteval
from wetext import Normalizer


MAX_INPUT_BYTES = 16 * 1024 * 1024
SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


def fail(message: str) -> None:
    raise ValueError(message)


def load_request() -> dict:
    payload = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(payload) > MAX_INPUT_BYTES:
        fail("Metric request exceeds the 16 MiB hard limit")
    value = json.loads(payload)
    if not isinstance(value, dict) or set(value) - {"asr", "diarization"}:
        fail("Metric request has an invalid top-level shape")
    return value


NORMALIZERS = {
    "zh": Normalizer(
        lang="zh",
        operator="tn",
        traditional_to_simple=True,
        full_to_half=True,
        remove_puncts=True,
    ),
    "en": Normalizer(
        lang="en",
        operator="tn",
        full_to_half=True,
        remove_puncts=True,
    ),
    "mixed": Normalizer(
        lang="auto",
        operator="tn",
        traditional_to_simple=True,
        full_to_half=True,
        remove_puncts=True,
    ),
}


def normalize(text: str, language: str, metric: str) -> str:
    if not isinstance(text, str) or language not in NORMALIZERS:
        fail("ASR entry contains invalid text or language")
    normalized = NORMALIZERS[language].normalize(unicodedata.normalize("NFKC", text))
    normalized = unicodedata.normalize("NFKC", normalized).casefold()
    if metric == "cer":
        return "".join(normalized.split())
    if metric == "wer":
        return " ".join(normalized.split())
    fail("ASR entry contains an unsupported metric")


def error_counts(reference: str, hypothesis: str, metric: str) -> dict:
    if metric == "cer":
        result = jiwer.process_characters(reference, hypothesis)
    else:
        result = jiwer.process_words(reference, hypothesis)
    errors = result.substitutions + result.deletions + result.insertions
    reference_units = result.hits + result.substitutions + result.deletions
    hypothesis_units = result.hits + result.substitutions + result.insertions
    if reference_units == 0:
        rate = 0.0 if hypothesis_units == 0 else float(hypothesis_units)
    else:
        rate = errors / reference_units
    return {
        "errors": errors,
        "referenceUnits": reference_units,
        "hypothesisUnits": hypothesis_units,
        "insertions": result.insertions,
        "deletions": result.deletions,
        "substitutions": result.substitutions,
        "rate": rate,
    }


def score_asr(entries: object) -> dict:
    if not isinstance(entries, list) or len(entries) > 10_000:
        fail("ASR metric request must be a bounded list")
    cases = []
    grouped: dict[tuple[str, str], dict[str, int]] = defaultdict(
        lambda: {
            "errors": 0,
            "referenceUnits": 0,
            "hypothesisUnits": 0,
            "insertions": 0,
            "deletions": 0,
            "substitutions": 0,
        }
    )
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {
            "id",
            "group",
            "language",
            "metric",
            "reference",
            "hypothesis",
        }:
            fail("ASR entry has an invalid shape")
        case_id = entry["id"]
        group = entry["group"]
        metric = entry["metric"]
        if not isinstance(case_id, str) or not SAFE_ID.fullmatch(case_id):
            fail("ASR entry has an invalid ID")
        if not isinstance(group, str) or not SAFE_ID.fullmatch(group):
            fail("ASR entry has an invalid group")
        reference = normalize(entry["reference"], entry["language"], metric)
        hypothesis = normalize(entry["hypothesis"], entry["language"], metric)
        counts = error_counts(reference, hypothesis, metric)
        cases.append({"id": case_id, "group": group, "metric": metric, **counts})
        aggregate = grouped[(group, metric)]
        for key in aggregate:
            aggregate[key] += counts[key]

    groups = []
    for (group, metric), counts in sorted(grouped.items()):
        reference_units = counts["referenceUnits"]
        hypothesis_units = counts["hypothesisUnits"]
        rate = (
            counts["errors"] / reference_units
            if reference_units
            else (0.0 if hypothesis_units == 0 else float(hypothesis_units))
        )
        groups.append({"group": group, "metric": metric, **counts, "rate": rate})
    return {"cases": cases, "groups": groups}


def rttm(segments: object, session_id: str) -> str:
    if not isinstance(segments, list) or len(segments) > 100_000:
        fail("Diarization segments must be a bounded list")
    lines = []
    for segment in segments:
        if not isinstance(segment, dict) or set(segment) != {
            "speaker",
            "startSeconds",
            "endSeconds",
        }:
            fail("Diarization segment has an invalid shape")
        speaker = segment["speaker"]
        start = segment["startSeconds"]
        end = segment["endSeconds"]
        if (
            not isinstance(speaker, str)
            or not SAFE_ID.fullmatch(speaker)
            or not isinstance(start, (int, float))
            or not isinstance(end, (int, float))
            or not math.isfinite(start)
            or not math.isfinite(end)
            or start < 0
            or end <= start
        ):
            fail("Diarization segment contains an invalid value")
        lines.append(
            f"SPEAKER {session_id} 1 {start:.6f} {end - start:.6f} "
            f"<NA> <NA> {speaker} <NA> <NA>"
        )
    if not lines:
        fail("Diarization entry must contain at least one segment")
    return "\n".join(lines)


def score_diarization(entries: object) -> dict:
    if not isinstance(entries, list) or len(entries) > 1_000:
        fail("Diarization metric request must be a bounded list")
    cases = []
    totals = defaultdict(float)
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {
            "id",
            "group",
            "collarSeconds",
            "reference",
            "hypothesis",
        }:
            fail("Diarization entry has an invalid shape")
        case_id = entry["id"]
        group = entry["group"]
        collar = entry["collarSeconds"]
        if (
            not isinstance(case_id, str)
            or not SAFE_ID.fullmatch(case_id)
            or not isinstance(group, str)
            or not SAFE_ID.fullmatch(group)
            or not isinstance(collar, (int, float))
            or not math.isfinite(collar)
            or collar < 0
            or collar > 5
        ):
            fail("Diarization entry contains invalid metadata")
        reference = meeteval.io.RTTM.parse(rttm(entry["reference"], case_id))
        hypothesis = meeteval.io.RTTM.parse(rttm(entry["hypothesis"], case_id))
        result = meeteval.der.dscore(
            reference,
            hypothesis,
            collar=collar,
            regions="all",
        )[case_id]
        values = {
            "scoredSpeakerSeconds": float(result.scored_speaker_time),
            "missedSpeakerSeconds": float(result.missed_speaker_time),
            "falseAlarmSpeakerSeconds": float(result.falarm_speaker_time),
            "speakerErrorSeconds": float(result.speaker_error_time),
            "rate": float(result.error_rate),
        }
        cases.append({"id": case_id, "group": group, **values})
        for key in values:
            if key != "rate":
                totals[(group, key)] += values[key]

    groups = []
    for group in sorted({entry["group"] for entry in cases}):
        scored = totals[(group, "scoredSpeakerSeconds")]
        errors = (
            totals[(group, "missedSpeakerSeconds")]
            + totals[(group, "falseAlarmSpeakerSeconds")]
            + totals[(group, "speakerErrorSeconds")]
        )
        groups.append(
            {
                "group": group,
                "scoredSpeakerSeconds": scored,
                "missedSpeakerSeconds": totals[(group, "missedSpeakerSeconds")],
                "falseAlarmSpeakerSeconds": totals[
                    (group, "falseAlarmSpeakerSeconds")
                ],
                "speakerErrorSeconds": totals[(group, "speakerErrorSeconds")],
                "rate": errors / scored if scored else 0.0,
            }
        )
    return {"cases": cases, "groups": groups}


def main() -> None:
    request = load_request()
    response = {
        "toolVersions": {
            "jiwer": version("jiwer"),
            "meeteval": version("meeteval"),
            "wetext": version("wetext"),
        },
        "asr": score_asr(request.get("asr", [])),
        "diarization": score_diarization(request.get("diarization", [])),
    }
    json.dump(response, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
