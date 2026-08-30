#include "myagents_speech_adapter.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <new>
#include <string>
#include <utility>
#include <vector>

#include "fastcluster-all-in-one.h"  // NOLINT
#include "sherpa-onnx/c-api/c-api.h"

#ifndef MYAGENTS_SHERPA_ONNX_COMMIT
#define MYAGENTS_SHERPA_ONNX_COMMIT \
  "1cb484af5e69d3c7803c1eb0b3b5ab8041e0e911"
#endif

static_assert(sizeof(void *) == 8, "MyAgents desktop targets require a 64-bit ABI");
static_assert(sizeof(MyAgentsSpeechBuildInfo) == 40);
static_assert(sizeof(MyAgentsSpeechUtf8Buffer) == 16);
static_assert(sizeof(MyAgentsSpeechAsrConfig) == 32);
static_assert(sizeof(MyAgentsSpeechAsrResult) == 72);
static_assert(sizeof(MyAgentsSpeechVadConfig) == 40);
static_assert(sizeof(MyAgentsSpeechVadSegment) == 32);
static_assert(sizeof(MyAgentsSpeechDiarizerConfig) == 48);
static_assert(sizeof(MyAgentsSpeechLocalSpeaker) == 4);
static_assert(sizeof(MyAgentsSpeechLocalSegment) == 24);
static_assert(sizeof(MyAgentsSpeechDiarizationOutput) == 56);
static_assert(sizeof(MyAgentsSpeechAdapterApiV1) == 136);

namespace {

constexpr uint32_t kVadWindowSamples = 512;
constexpr float kVadBufferSeconds = 35.0f;

bool HasText(const char *value) { return value != nullptr && value[0] != '\0'; }

bool ValidThreads(uint32_t value) { return value >= 1 && value <= 2; }

bool ValidFiniteRange(float value, float lower, float upper) {
  return std::isfinite(value) && value >= lower && value <= upper;
}

bool ValidSamples(const float *samples, uint32_t count, uint32_t maximum) {
  if (samples == nullptr || count == 0 || count > maximum) return false;
  for (uint32_t index = 0; index != count; ++index) {
    if (!std::isfinite(samples[index]) || samples[index] < -1.001f ||
        samples[index] > 1.001f) {
      return false;
    }
  }
  return true;
}

MyAgentsSpeechStatus WriteUtf8(const char *source,
                               MyAgentsSpeechUtf8Buffer *destination) {
  if (destination == nullptr) return MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT;
  const char *value = source == nullptr ? "" : source;
  const size_t length = std::strlen(value);
  if (length > MYAGENTS_SPEECH_MAX_TEXT_BYTES) {
    return MYAGENTS_SPEECH_STATUS_RESOURCE_LIMIT;
  }
  destination->length = static_cast<uint32_t>(length);
  if (destination->capacity <= length || destination->data == nullptr) {
    return MYAGENTS_SPEECH_STATUS_BUFFER_TOO_SMALL;
  }
  std::memcpy(destination->data, value, length);
  destination->data[length] = '\0';
  return MYAGENTS_SPEECH_STATUS_OK;
}

MyAgentsSpeechStatus MergeBufferStatus(MyAgentsSpeechStatus current,
                                       MyAgentsSpeechStatus next) {
  if (next == MYAGENTS_SPEECH_STATUS_OK) return current;
  if (current == MYAGENTS_SPEECH_STATUS_OK ||
      next != MYAGENTS_SPEECH_STATUS_BUFFER_TOO_SMALL) {
    return next;
  }
  return current;
}

uint64_t SecondsToStartSample(float seconds, uint32_t maximum) {
  const double samples = std::floor(static_cast<double>(seconds) *
                                    MYAGENTS_SPEECH_SAMPLE_RATE);
  return static_cast<uint64_t>(std::clamp(samples, 0.0,
                                          static_cast<double>(maximum)));
}

uint64_t SecondsToEndSample(float seconds, uint32_t minimum,
                            uint32_t maximum) {
  const double samples = std::ceil(static_cast<double>(seconds) *
                                   MYAGENTS_SPEECH_SAMPLE_RATE);
  return static_cast<uint64_t>(std::clamp(
      samples, static_cast<double>(minimum), static_cast<double>(maximum)));
}

}  // namespace

struct MyAgentsSpeechAsr {
  const SherpaOnnxOfflineRecognizer *recognizer = nullptr;
};

struct MyAgentsSpeechVad {
  const SherpaOnnxVoiceActivityDetector *vad = nullptr;
};

struct MyAgentsSpeechDiarizer {
  const SherpaOnnxOfflineSpeakerDiarization *diarizer = nullptr;
  const SherpaOnnxSpeakerEmbeddingExtractor *extractor = nullptr;
};

struct MyAgentsSpeechDiarizationResult {
  std::vector<MyAgentsSpeechLocalSpeaker> speakers;
  std::vector<MyAgentsSpeechLocalSegment> segments;
  std::vector<float> embeddings;
};

namespace {

MyAgentsSpeechStatus GetBuildInfo(MyAgentsSpeechBuildInfo *out) {
  if (out == nullptr || out->struct_size != sizeof(*out)) {
    return MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT;
  }
  out->abi_version = MYAGENTS_SPEECH_ADAPTER_ABI_VERSION;
  out->sherpa_onnx_version = SherpaOnnxGetVersionStr();
  out->sherpa_onnx_commit = MYAGENTS_SHERPA_ONNX_COMMIT;
  out->onnx_runtime_version = SherpaOnnxGetOnnxruntimeVersionStr();
  out->sample_rate = MYAGENTS_SPEECH_SAMPLE_RATE;
  out->embedding_dimension = MYAGENTS_SPEECH_EMBEDDING_DIMENSION;
  if (!HasText(out->sherpa_onnx_version) ||
      !HasText(out->onnx_runtime_version)) {
    return MYAGENTS_SPEECH_STATUS_UNAVAILABLE;
  }
  return MYAGENTS_SPEECH_STATUS_OK;
}

MyAgentsSpeechStatus CreateAsr(const MyAgentsSpeechAsrConfig *config,
                               MyAgentsSpeechAsr **out) {
  if (out == nullptr) return MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT;
  *out = nullptr;
  if (config == nullptr || config->struct_size != sizeof(*config) ||
      !HasText(config->sense_voice_model) || !HasText(config->tokens) ||
      !ValidThreads(config->num_threads) ||
      (config->use_itn != 0 && config->use_itn != 1)) {
    return MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT;
  }
  try {
    SherpaOnnxOfflineRecognizerConfig recognizer_config{};
    recognizer_config.feat_config.sample_rate = MYAGENTS_SPEECH_SAMPLE_RATE;
    recognizer_config.feat_config.feature_dim = 80;
    recognizer_config.model_config.sense_voice.model =
        config->sense_voice_model;
    recognizer_config.model_config.sense_voice.language = "auto";
    recognizer_config.model_config.sense_voice.use_itn = config->use_itn;
    recognizer_config.model_config.tokens = config->tokens;
    recognizer_config.model_config.num_threads =
        static_cast<int32_t>(config->num_threads);
    recognizer_config.model_config.provider = "cpu";
    recognizer_config.decoding_method = "greedy_search";
    const auto *recognizer =
        SherpaOnnxCreateOfflineRecognizer(&recognizer_config);
    if (recognizer == nullptr) return MYAGENTS_SPEECH_STATUS_MODEL_ERROR;
    auto *asr = new (std::nothrow) MyAgentsSpeechAsr{};
    if (asr == nullptr) {
      SherpaOnnxDestroyOfflineRecognizer(recognizer);
      return MYAGENTS_SPEECH_STATUS_RESOURCE_LIMIT;
    }
    asr->recognizer = recognizer;
    *out = asr;
    return MYAGENTS_SPEECH_STATUS_OK;
  } catch (...) {
    return MYAGENTS_SPEECH_STATUS_MODEL_ERROR;
  }
}

void DestroyAsr(MyAgentsSpeechAsr *asr) {
  if (asr == nullptr) return;
  if (asr->recognizer != nullptr) {
    SherpaOnnxDestroyOfflineRecognizer(asr->recognizer);
  }
  delete asr;
}

MyAgentsSpeechStatus Transcribe(MyAgentsSpeechAsr *asr, const float *samples,
                                uint32_t sample_count,
                                MyAgentsSpeechAsrResult *out) {
  if (asr == nullptr || asr->recognizer == nullptr || out == nullptr ||
      out->struct_size != sizeof(*out) ||
      !ValidSamples(samples, sample_count, MYAGENTS_SPEECH_MAX_ASR_SAMPLES)) {
    return MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT;
  }
  const SherpaOnnxOfflineStream *stream = nullptr;
  const SherpaOnnxOfflineRecognizerResult *result = nullptr;
  try {
    stream = SherpaOnnxCreateOfflineStream(asr->recognizer);
    if (stream == nullptr) return MYAGENTS_SPEECH_STATUS_INFERENCE_ERROR;
    SherpaOnnxAcceptWaveformOffline(stream, MYAGENTS_SPEECH_SAMPLE_RATE,
                                   samples, static_cast<int32_t>(sample_count));
    SherpaOnnxDecodeOfflineStream(asr->recognizer, stream);
    result = SherpaOnnxGetOfflineStreamResult(stream);
    if (result == nullptr) {
      SherpaOnnxDestroyOfflineStream(stream);
      return MYAGENTS_SPEECH_STATUS_INFERENCE_ERROR;
    }
    MyAgentsSpeechStatus status = MYAGENTS_SPEECH_STATUS_OK;
    status = MergeBufferStatus(status, WriteUtf8(result->text, &out->text));
    status =
        MergeBufferStatus(status, WriteUtf8(result->lang, &out->language));
    status =
        MergeBufferStatus(status, WriteUtf8(result->emotion, &out->emotion));
    status =
        MergeBufferStatus(status, WriteUtf8(result->event, &out->event));
    SherpaOnnxDestroyOfflineRecognizerResult(result);
    SherpaOnnxDestroyOfflineStream(stream);
    return status;
  } catch (...) {
    if (result != nullptr) SherpaOnnxDestroyOfflineRecognizerResult(result);
    if (stream != nullptr) SherpaOnnxDestroyOfflineStream(stream);
    return MYAGENTS_SPEECH_STATUS_INFERENCE_ERROR;
  }
}

MyAgentsSpeechStatus CreateVad(const MyAgentsSpeechVadConfig *config,
                               MyAgentsSpeechVad **out) {
  if (out == nullptr) return MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT;
  *out = nullptr;
  if (config == nullptr || config->struct_size != sizeof(*config) ||
      !HasText(config->silero_model) || !ValidThreads(config->num_threads) ||
      !ValidFiniteRange(config->threshold, 0.01f, 0.99f) ||
      !ValidFiniteRange(config->min_silence_seconds, 0.05f, 10.0f) ||
      !ValidFiniteRange(config->min_speech_seconds, 0.05f, 10.0f) ||
      !ValidFiniteRange(config->max_speech_seconds, 1.0f, 30.0f)) {
    return MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT;
  }
  try {
    SherpaOnnxVadModelConfig vad_config{};
    vad_config.silero_vad.model = config->silero_model;
    vad_config.silero_vad.threshold = config->threshold;
    vad_config.silero_vad.min_silence_duration = config->min_silence_seconds;
    vad_config.silero_vad.min_speech_duration = config->min_speech_seconds;
    vad_config.silero_vad.max_speech_duration = config->max_speech_seconds;
    vad_config.silero_vad.window_size = kVadWindowSamples;
    vad_config.sample_rate = MYAGENTS_SPEECH_SAMPLE_RATE;
    vad_config.num_threads = static_cast<int32_t>(config->num_threads);
    vad_config.provider = "cpu";
    const auto *detector =
        SherpaOnnxCreateVoiceActivityDetector(&vad_config, kVadBufferSeconds);
    if (detector == nullptr) return MYAGENTS_SPEECH_STATUS_MODEL_ERROR;
    auto *vad = new (std::nothrow) MyAgentsSpeechVad{};
    if (vad == nullptr) {
      SherpaOnnxDestroyVoiceActivityDetector(detector);
      return MYAGENTS_SPEECH_STATUS_RESOURCE_LIMIT;
    }
    vad->vad = detector;
    *out = vad;
    return MYAGENTS_SPEECH_STATUS_OK;
  } catch (...) {
    return MYAGENTS_SPEECH_STATUS_MODEL_ERROR;
  }
}

void DestroyVad(MyAgentsSpeechVad *vad) {
  if (vad == nullptr) return;
  if (vad->vad != nullptr) SherpaOnnxDestroyVoiceActivityDetector(vad->vad);
  delete vad;
}

MyAgentsSpeechStatus VadAccept(MyAgentsSpeechVad *vad, const float *samples,
                               uint32_t sample_count) {
  if (vad == nullptr || vad->vad == nullptr ||
      !ValidSamples(samples, sample_count,
                    MYAGENTS_SPEECH_MAX_PCM_CHUNK_SAMPLES)) {
    return MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT;
  }
  try {
    SherpaOnnxVoiceActivityDetectorAcceptWaveform(
        vad->vad, samples, static_cast<int32_t>(sample_count));
    return MYAGENTS_SPEECH_STATUS_OK;
  } catch (...) {
    return MYAGENTS_SPEECH_STATUS_INFERENCE_ERROR;
  }
}

MyAgentsSpeechStatus VadFlush(MyAgentsSpeechVad *vad) {
  if (vad == nullptr || vad->vad == nullptr) {
    return MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT;
  }
  try {
    SherpaOnnxVoiceActivityDetectorFlush(vad->vad);
    return MYAGENTS_SPEECH_STATUS_OK;
  } catch (...) {
    return MYAGENTS_SPEECH_STATUS_INFERENCE_ERROR;
  }
}

MyAgentsSpeechStatus VadPop(MyAgentsSpeechVad *vad,
                            MyAgentsSpeechVadSegment *out) {
  if (vad == nullptr || vad->vad == nullptr || out == nullptr ||
      out->struct_size != sizeof(*out)) {
    return MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT;
  }
  if (SherpaOnnxVoiceActivityDetectorEmpty(vad->vad) != 0) {
    out->sample_count = 0;
    return MYAGENTS_SPEECH_STATUS_UNAVAILABLE;
  }
  const SherpaOnnxSpeechSegment *segment = nullptr;
  try {
    segment = SherpaOnnxVoiceActivityDetectorFront(vad->vad);
    if (segment == nullptr || segment->start < 0 || segment->n <= 0 ||
        segment->samples == nullptr ||
        static_cast<uint32_t>(segment->n) > MYAGENTS_SPEECH_MAX_ASR_SAMPLES) {
      if (segment != nullptr) SherpaOnnxDestroySpeechSegment(segment);
      SherpaOnnxVoiceActivityDetectorPop(vad->vad);
      return MYAGENTS_SPEECH_STATUS_INFERENCE_ERROR;
    }
    out->start_sample = static_cast<uint64_t>(segment->start);
    out->sample_count = static_cast<uint32_t>(segment->n);
    if (out->samples == nullptr || out->sample_capacity < out->sample_count) {
      SherpaOnnxDestroySpeechSegment(segment);
      return MYAGENTS_SPEECH_STATUS_BUFFER_TOO_SMALL;
    }
    std::copy_n(segment->samples, segment->n, out->samples);
    SherpaOnnxDestroySpeechSegment(segment);
    SherpaOnnxVoiceActivityDetectorPop(vad->vad);
    return MYAGENTS_SPEECH_STATUS_OK;
  } catch (...) {
    if (segment != nullptr) SherpaOnnxDestroySpeechSegment(segment);
    return MYAGENTS_SPEECH_STATUS_INFERENCE_ERROR;
  }
}

MyAgentsSpeechStatus VadReset(MyAgentsSpeechVad *vad) {
  if (vad == nullptr || vad->vad == nullptr) {
    return MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT;
  }
  try {
    SherpaOnnxVoiceActivityDetectorReset(vad->vad);
    return MYAGENTS_SPEECH_STATUS_OK;
  } catch (...) {
    return MYAGENTS_SPEECH_STATUS_INFERENCE_ERROR;
  }
}

MyAgentsSpeechStatus CreateDiarizer(
    const MyAgentsSpeechDiarizerConfig *config,
    MyAgentsSpeechDiarizer **out) {
  if (out == nullptr) return MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT;
  *out = nullptr;
  if (config == nullptr || config->struct_size != sizeof(*config) ||
      !HasText(config->segmentation_model) ||
      !HasText(config->embedding_model) || !ValidThreads(config->num_threads) ||
      !ValidFiniteRange(config->segmentation_window_shift_ratio, 0.01f, 1.0f) ||
      !ValidFiniteRange(config->local_clustering_threshold, 0.01f, 1.99f) ||
      !ValidFiniteRange(config->min_duration_on_seconds, 0.0f, 10.0f) ||
      !ValidFiniteRange(config->min_duration_off_seconds, 0.0f, 10.0f)) {
    return MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT;
  }
  const SherpaOnnxOfflineSpeakerDiarization *diarizer = nullptr;
  const SherpaOnnxSpeakerEmbeddingExtractor *extractor = nullptr;
  try {
    SherpaOnnxOfflineSpeakerDiarizationConfig diarizer_config{};
    diarizer_config.segmentation.pyannote.model = config->segmentation_model;
    diarizer_config.segmentation.pyannote.window_shift_ratio =
        config->segmentation_window_shift_ratio;
    diarizer_config.segmentation.num_threads =
        static_cast<int32_t>(config->num_threads);
    diarizer_config.segmentation.provider = "cpu";
    diarizer_config.embedding.model = config->embedding_model;
    diarizer_config.embedding.num_threads =
        static_cast<int32_t>(config->num_threads);
    diarizer_config.embedding.provider = "cpu";
    diarizer_config.clustering.threshold =
        config->local_clustering_threshold;
    diarizer_config.min_duration_on = config->min_duration_on_seconds;
    diarizer_config.min_duration_off = config->min_duration_off_seconds;
    diarizer = SherpaOnnxCreateOfflineSpeakerDiarization(&diarizer_config);
    if (diarizer == nullptr) return MYAGENTS_SPEECH_STATUS_MODEL_ERROR;

    SherpaOnnxSpeakerEmbeddingExtractorConfig embedding_config{};
    embedding_config.model = config->embedding_model;
    embedding_config.num_threads = static_cast<int32_t>(config->num_threads);
    embedding_config.provider = "cpu";
    extractor = SherpaOnnxCreateSpeakerEmbeddingExtractor(&embedding_config);
    if (extractor == nullptr ||
        SherpaOnnxSpeakerEmbeddingExtractorDim(extractor) !=
            MYAGENTS_SPEECH_EMBEDDING_DIMENSION) {
      if (extractor != nullptr) {
        SherpaOnnxDestroySpeakerEmbeddingExtractor(extractor);
      }
      SherpaOnnxDestroyOfflineSpeakerDiarization(diarizer);
      return MYAGENTS_SPEECH_STATUS_MODEL_ERROR;
    }
    auto *created = new (std::nothrow) MyAgentsSpeechDiarizer{};
    if (created == nullptr) {
      SherpaOnnxDestroySpeakerEmbeddingExtractor(extractor);
      SherpaOnnxDestroyOfflineSpeakerDiarization(diarizer);
      return MYAGENTS_SPEECH_STATUS_RESOURCE_LIMIT;
    }
    created->diarizer = diarizer;
    created->extractor = extractor;
    *out = created;
    return MYAGENTS_SPEECH_STATUS_OK;
  } catch (...) {
    if (extractor != nullptr) {
      SherpaOnnxDestroySpeakerEmbeddingExtractor(extractor);
    }
    if (diarizer != nullptr) {
      SherpaOnnxDestroyOfflineSpeakerDiarization(diarizer);
    }
    return MYAGENTS_SPEECH_STATUS_MODEL_ERROR;
  }
}

void DestroyDiarizer(MyAgentsSpeechDiarizer *diarizer) {
  if (diarizer == nullptr) return;
  if (diarizer->extractor != nullptr) {
    SherpaOnnxDestroySpeakerEmbeddingExtractor(diarizer->extractor);
  }
  if (diarizer->diarizer != nullptr) {
    SherpaOnnxDestroyOfflineSpeakerDiarization(diarizer->diarizer);
  }
  delete diarizer;
}

MyAgentsSpeechStatus DiarizeWindow(
    MyAgentsSpeechDiarizer *diarizer, const float *samples,
    uint32_t sample_count,
    MyAgentsSpeechEmbeddingStartedCallback embedding_started, void *user_data,
    MyAgentsSpeechDiarizationResult **out) {
  if (out == nullptr) return MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT;
  *out = nullptr;
  if (diarizer == nullptr || diarizer->diarizer == nullptr ||
      diarizer->extractor == nullptr ||
      !ValidSamples(samples, sample_count,
                    MYAGENTS_SPEECH_MAX_DIARIZATION_SAMPLES)) {
    return MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT;
  }
  const SherpaOnnxOfflineSpeakerDiarizationResult *raw_result = nullptr;
  const SherpaOnnxOfflineSpeakerDiarizationSegment *raw_segments = nullptr;
  std::unique_ptr<MyAgentsSpeechDiarizationResult> result;
  try {
    raw_result = SherpaOnnxOfflineSpeakerDiarizationProcess(
        diarizer->diarizer, samples, static_cast<int32_t>(sample_count));
    if (raw_result == nullptr) return MYAGENTS_SPEECH_STATUS_INFERENCE_ERROR;
    const int32_t segment_count =
        SherpaOnnxOfflineSpeakerDiarizationResultGetNumSegments(raw_result);
    const int32_t speaker_count =
        SherpaOnnxOfflineSpeakerDiarizationResultGetNumSpeakers(raw_result);
    if (segment_count < 0 || speaker_count < 0 ||
        static_cast<uint32_t>(segment_count) >
            MYAGENTS_SPEECH_MAX_LOCAL_SEGMENTS ||
        static_cast<uint32_t>(speaker_count) >
            MYAGENTS_SPEECH_MAX_LOCAL_SPEAKERS) {
      SherpaOnnxOfflineSpeakerDiarizationDestroyResult(raw_result);
      return MYAGENTS_SPEECH_STATUS_RESOURCE_LIMIT;
    }
    if (segment_count > 0) {
      raw_segments =
          SherpaOnnxOfflineSpeakerDiarizationResultSortByStartTime(raw_result);
      if (raw_segments == nullptr) {
        SherpaOnnxOfflineSpeakerDiarizationDestroyResult(raw_result);
        return MYAGENTS_SPEECH_STATUS_INFERENCE_ERROR;
      }
    }

    std::map<int32_t,
             std::vector<SherpaOnnxOfflineSpeakerDiarizationSegment>>
        grouped;
    for (int32_t index = 0; index != segment_count; ++index) {
      const auto &segment = raw_segments[index];
      if (segment.speaker < 0 || !std::isfinite(segment.start) ||
          !std::isfinite(segment.end) || segment.start < 0 ||
          segment.end <= segment.start) {
        continue;
      }
      grouped[segment.speaker].push_back(segment);
    }
    if (grouped.size() > MYAGENTS_SPEECH_MAX_LOCAL_SPEAKERS) {
      SherpaOnnxOfflineSpeakerDiarizationDestroySegment(raw_segments);
      SherpaOnnxOfflineSpeakerDiarizationDestroyResult(raw_result);
      return MYAGENTS_SPEECH_STATUS_RESOURCE_LIMIT;
    }

    result.reset(new (std::nothrow) MyAgentsSpeechDiarizationResult{});
    if (result == nullptr) {
      if (raw_segments != nullptr) {
        SherpaOnnxOfflineSpeakerDiarizationDestroySegment(raw_segments);
      }
      SherpaOnnxOfflineSpeakerDiarizationDestroyResult(raw_result);
      return MYAGENTS_SPEECH_STATUS_RESOURCE_LIMIT;
    }
    result->speakers.reserve(grouped.size());
    result->embeddings.reserve(grouped.size() *
                               MYAGENTS_SPEECH_EMBEDDING_DIMENSION);
    std::map<int32_t, bool> ready_speakers;
    if (embedding_started != nullptr) embedding_started(user_data);
    for (const auto &[speaker, speaker_segments] : grouped) {
      const auto *stream =
          SherpaOnnxSpeakerEmbeddingExtractorCreateStream(diarizer->extractor);
      if (stream == nullptr) continue;
      for (const auto &segment : speaker_segments) {
        const uint64_t start = SecondsToStartSample(segment.start, sample_count);
        const uint64_t end = SecondsToEndSample(
            segment.end, static_cast<uint32_t>(start), sample_count);
        if (end > start) {
          SherpaOnnxOnlineStreamAcceptWaveform(
              stream, MYAGENTS_SPEECH_SAMPLE_RATE, samples + start,
              static_cast<int32_t>(end - start));
        }
      }
      SherpaOnnxOnlineStreamInputFinished(stream);
      if (SherpaOnnxSpeakerEmbeddingExtractorIsReady(diarizer->extractor,
                                                     stream) == 0) {
        SherpaOnnxDestroyOnlineStream(stream);
        continue;
      }
      const float *embedding =
          SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding(
              diarizer->extractor, stream);
      if (embedding == nullptr) {
        SherpaOnnxDestroyOnlineStream(stream);
        continue;
      }
      bool valid_embedding = true;
      for (uint32_t index = 0;
           index != MYAGENTS_SPEECH_EMBEDDING_DIMENSION; ++index) {
        valid_embedding = valid_embedding && std::isfinite(embedding[index]);
      }
      if (valid_embedding) {
        result->speakers.push_back(
            {static_cast<uint32_t>(speaker)});
        result->embeddings.insert(
            result->embeddings.end(), embedding,
            embedding + MYAGENTS_SPEECH_EMBEDDING_DIMENSION);
        ready_speakers.emplace(speaker, true);
      }
      SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding(embedding);
      SherpaOnnxDestroyOnlineStream(stream);
    }
    result->segments.reserve(static_cast<size_t>(segment_count));
    for (int32_t index = 0; index != segment_count; ++index) {
      const auto &segment = raw_segments[index];
      if (!ready_speakers.contains(segment.speaker)) continue;
      const uint64_t start = SecondsToStartSample(segment.start, sample_count);
      const uint64_t end = SecondsToEndSample(
          segment.end, static_cast<uint32_t>(start), sample_count);
      if (end > start) {
        result->segments.push_back(
            {start, end, static_cast<uint32_t>(segment.speaker)});
      }
    }
    if (raw_segments != nullptr) {
      SherpaOnnxOfflineSpeakerDiarizationDestroySegment(raw_segments);
    }
    SherpaOnnxOfflineSpeakerDiarizationDestroyResult(raw_result);
    *out = result.release();
    return MYAGENTS_SPEECH_STATUS_OK;
  } catch (...) {
    if (raw_segments != nullptr) {
      SherpaOnnxOfflineSpeakerDiarizationDestroySegment(raw_segments);
    }
    if (raw_result != nullptr) {
      SherpaOnnxOfflineSpeakerDiarizationDestroyResult(raw_result);
    }
    return MYAGENTS_SPEECH_STATUS_INFERENCE_ERROR;
  }
}

MyAgentsSpeechStatus CopyDiarizationResult(
    const MyAgentsSpeechDiarizationResult *result,
    MyAgentsSpeechDiarizationOutput *out) {
  if (result == nullptr || out == nullptr || out->struct_size != sizeof(*out) ||
      result->speakers.size() > std::numeric_limits<uint32_t>::max() ||
      result->segments.size() > std::numeric_limits<uint32_t>::max() ||
      result->embeddings.size() > std::numeric_limits<uint32_t>::max()) {
    return MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT;
  }
  out->speaker_count = static_cast<uint32_t>(result->speakers.size());
  out->segment_count = static_cast<uint32_t>(result->segments.size());
  out->embedding_count = static_cast<uint32_t>(result->embeddings.size());
  if ((out->speaker_count > 0 &&
       (out->speakers == nullptr ||
        out->speaker_capacity < out->speaker_count)) ||
      (out->segment_count > 0 &&
       (out->segments == nullptr ||
        out->segment_capacity < out->segment_count)) ||
      (out->embedding_count > 0 &&
       (out->embeddings == nullptr ||
        out->embedding_capacity < out->embedding_count))) {
    return MYAGENTS_SPEECH_STATUS_BUFFER_TOO_SMALL;
  }
  if (!result->speakers.empty()) {
    std::copy(result->speakers.begin(), result->speakers.end(), out->speakers);
  }
  if (!result->segments.empty()) {
    std::copy(result->segments.begin(), result->segments.end(), out->segments);
  }
  if (!result->embeddings.empty()) {
    std::copy(result->embeddings.begin(), result->embeddings.end(),
              out->embeddings);
  }
  return MYAGENTS_SPEECH_STATUS_OK;
}

void DestroyDiarizationResult(MyAgentsSpeechDiarizationResult *result) {
  delete result;
}

MyAgentsSpeechStatus ClusterEmbeddings(const float *embeddings,
                                       uint32_t embedding_count,
                                       float distance_threshold,
                                       uint32_t *labels,
                                       uint32_t label_capacity,
                                       uint32_t *speaker_count) {
  if (embeddings == nullptr || embedding_count == 0 ||
      embedding_count > MYAGENTS_SPEECH_MAX_CLUSTER_EMBEDDINGS ||
      !ValidFiniteRange(distance_threshold, 0.01f, 1.99f) ||
      labels == nullptr || label_capacity < embedding_count ||
      speaker_count == nullptr) {
    return MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT;
  }
  try {
    if (embedding_count == 1) {
      labels[0] = 0;
      *speaker_count = 1;
      return MYAGENTS_SPEECH_STATUS_OK;
    }
    std::vector<double> norms(embedding_count, 0.0);
    for (uint32_t row = 0; row != embedding_count; ++row) {
      const float *embedding =
          embeddings + row * MYAGENTS_SPEECH_EMBEDDING_DIMENSION;
      double squared_norm = 0.0;
      for (uint32_t column = 0;
           column != MYAGENTS_SPEECH_EMBEDDING_DIMENSION; ++column) {
        if (!std::isfinite(embedding[column])) {
          return MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT;
        }
        squared_norm += static_cast<double>(embedding[column]) *
                        static_cast<double>(embedding[column]);
      }
      if (!std::isfinite(squared_norm) ||
          squared_norm <= std::numeric_limits<double>::epsilon()) {
        return MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT;
      }
      norms[row] = std::sqrt(squared_norm);
    }

    const size_t distance_count =
        static_cast<size_t>(embedding_count) * (embedding_count - 1) / 2;
    std::vector<double> distances(distance_count);
    size_t distance_index = 0;
    for (uint32_t left = 0; left != embedding_count; ++left) {
      const float *left_embedding =
          embeddings + left * MYAGENTS_SPEECH_EMBEDDING_DIMENSION;
      for (uint32_t right = left + 1; right != embedding_count; ++right) {
        const float *right_embedding =
            embeddings + right * MYAGENTS_SPEECH_EMBEDDING_DIMENSION;
        double dot = 0.0;
        for (uint32_t column = 0;
             column != MYAGENTS_SPEECH_EMBEDDING_DIMENSION; ++column) {
          dot += static_cast<double>(left_embedding[column]) *
                 static_cast<double>(right_embedding[column]);
        }
        const double similarity =
            std::clamp(dot / (norms[left] * norms[right]), -1.0, 1.0);
        distances[distance_index++] = std::max(0.0, 1.0 - similarity);
      }
    }

    std::vector<int32_t> merge(2 * (embedding_count - 1));
    std::vector<double> height(embedding_count - 1);
    std::vector<int32_t> native_labels(embedding_count);
    fastclustercpp::hclust_fast(
        static_cast<int32_t>(embedding_count), distances.data(),
        fastclustercpp::HCLUST_METHOD_COMPLETE, merge.data(), height.data());
    fastclustercpp::cutree_cdist(
        static_cast<int32_t>(embedding_count), merge.data(), height.data(),
        distance_threshold, native_labels.data());

    uint32_t maximum_label = 0;
    for (uint32_t row = 0; row != embedding_count; ++row) {
      if (native_labels[row] < 0 ||
          native_labels[row] >= static_cast<int32_t>(embedding_count)) {
        return MYAGENTS_SPEECH_STATUS_INFERENCE_ERROR;
      }
      labels[row] = static_cast<uint32_t>(native_labels[row]);
      maximum_label = std::max(maximum_label, labels[row]);
    }
    *speaker_count = maximum_label + 1;
    return MYAGENTS_SPEECH_STATUS_OK;
  } catch (const std::bad_alloc &) {
    return MYAGENTS_SPEECH_STATUS_RESOURCE_LIMIT;
  } catch (...) {
    return MYAGENTS_SPEECH_STATUS_INFERENCE_ERROR;
  }
}

const MyAgentsSpeechAdapterApiV1 kApi = {
    sizeof(MyAgentsSpeechAdapterApiV1),
    MYAGENTS_SPEECH_ADAPTER_ABI_VERSION,
    GetBuildInfo,
    CreateAsr,
    DestroyAsr,
    Transcribe,
    CreateVad,
    DestroyVad,
    VadAccept,
    VadFlush,
    VadPop,
    VadReset,
    CreateDiarizer,
    DestroyDiarizer,
    DiarizeWindow,
    CopyDiarizationResult,
    DestroyDiarizationResult,
    ClusterEmbeddings,
};

}  // namespace

extern "C" MYAGENTS_SPEECH_EXPORT const MyAgentsSpeechAdapterApiV1 *
myagents_speech_adapter_get_api(uint32_t requested_abi_version) {
  return requested_abi_version == MYAGENTS_SPEECH_ADAPTER_ABI_VERSION ? &kApi
                                                                      : nullptr;
}
