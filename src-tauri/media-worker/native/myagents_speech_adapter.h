#ifndef MYAGENTS_SPEECH_ADAPTER_H_
#define MYAGENTS_SPEECH_ADAPTER_H_

#include <stdint.h>

#if defined(_WIN32)
#define MYAGENTS_SPEECH_EXPORT __declspec(dllexport)
#elif defined(__GNUC__)
#define MYAGENTS_SPEECH_EXPORT __attribute__((visibility("default")))
#else
#define MYAGENTS_SPEECH_EXPORT
#endif

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Stable, product-specific ABI between myagents-media-worker and the pinned
 * sherpa-onnx adapter. The adapter owns every opaque handle it returns. Caller
 * memory is used for all variable-sized output, so no allocator crosses this
 * boundary.
 */

#define MYAGENTS_SPEECH_ADAPTER_ABI_VERSION 1u
#define MYAGENTS_SPEECH_SAMPLE_RATE 16000u
#define MYAGENTS_SPEECH_EMBEDDING_DIMENSION 512u
#define MYAGENTS_SPEECH_MAX_PCM_CHUNK_SAMPLES (5u * MYAGENTS_SPEECH_SAMPLE_RATE)
#define MYAGENTS_SPEECH_MAX_ASR_SAMPLES (60u * MYAGENTS_SPEECH_SAMPLE_RATE)
#define MYAGENTS_SPEECH_MAX_TEXT_BYTES (64u * 1024u)
#define MYAGENTS_SPEECH_MAX_DIARIZATION_SAMPLES \
  (5u * 60u * MYAGENTS_SPEECH_SAMPLE_RATE)
#define MYAGENTS_SPEECH_MAX_LOCAL_SPEAKERS 32u
#define MYAGENTS_SPEECH_MAX_LOCAL_SEGMENTS 16384u

typedef enum MyAgentsSpeechStatus {
  MYAGENTS_SPEECH_STATUS_OK = 0,
  MYAGENTS_SPEECH_STATUS_INVALID_ARGUMENT = 1,
  MYAGENTS_SPEECH_STATUS_UNAVAILABLE = 2,
  MYAGENTS_SPEECH_STATUS_BUFFER_TOO_SMALL = 3,
  MYAGENTS_SPEECH_STATUS_MODEL_ERROR = 4,
  MYAGENTS_SPEECH_STATUS_INFERENCE_ERROR = 5,
  MYAGENTS_SPEECH_STATUS_RESOURCE_LIMIT = 6,
} MyAgentsSpeechStatus;

typedef struct MyAgentsSpeechBuildInfo {
  uint32_t struct_size;
  uint32_t abi_version;
  const char *sherpa_onnx_version;
  const char *sherpa_onnx_commit;
  const char *onnx_runtime_version;
  uint32_t sample_rate;
  uint32_t embedding_dimension;
} MyAgentsSpeechBuildInfo;

typedef struct MyAgentsSpeechUtf8Buffer {
  char *data;
  uint32_t capacity;
  uint32_t length;
} MyAgentsSpeechUtf8Buffer;

typedef struct MyAgentsSpeechAsrConfig {
  uint32_t struct_size;
  const char *sense_voice_model;
  const char *tokens;
  uint32_t num_threads;
  int32_t use_itn;
} MyAgentsSpeechAsrConfig;

typedef struct MyAgentsSpeechAsrResult {
  uint32_t struct_size;
  MyAgentsSpeechUtf8Buffer text;
  MyAgentsSpeechUtf8Buffer language;
  MyAgentsSpeechUtf8Buffer emotion;
  MyAgentsSpeechUtf8Buffer event;
} MyAgentsSpeechAsrResult;

typedef struct MyAgentsSpeechVadConfig {
  uint32_t struct_size;
  const char *silero_model;
  uint32_t num_threads;
  float threshold;
  float min_silence_seconds;
  float min_speech_seconds;
  float max_speech_seconds;
} MyAgentsSpeechVadConfig;

typedef struct MyAgentsSpeechVadSegment {
  uint32_t struct_size;
  uint64_t start_sample;
  float *samples;
  uint32_t sample_capacity;
  uint32_t sample_count;
} MyAgentsSpeechVadSegment;

typedef struct MyAgentsSpeechDiarizerConfig {
  uint32_t struct_size;
  const char *segmentation_model;
  const char *embedding_model;
  uint32_t num_threads;
  float segmentation_window_shift_ratio;
  float local_clustering_threshold;
  float min_duration_on_seconds;
  float min_duration_off_seconds;
} MyAgentsSpeechDiarizerConfig;

typedef struct MyAgentsSpeechLocalSpeaker {
  uint32_t local_speaker;
} MyAgentsSpeechLocalSpeaker;

typedef struct MyAgentsSpeechLocalSegment {
  uint64_t start_sample;
  uint64_t end_sample;
  uint32_t local_speaker;
} MyAgentsSpeechLocalSegment;

typedef struct MyAgentsSpeechDiarizationOutput {
  uint32_t struct_size;
  MyAgentsSpeechLocalSpeaker *speakers;
  uint32_t speaker_capacity;
  uint32_t speaker_count;
  MyAgentsSpeechLocalSegment *segments;
  uint32_t segment_capacity;
  uint32_t segment_count;
  float *embeddings;
  uint32_t embedding_capacity;
  uint32_t embedding_count;
} MyAgentsSpeechDiarizationOutput;

typedef struct MyAgentsSpeechAsr MyAgentsSpeechAsr;
typedef struct MyAgentsSpeechVad MyAgentsSpeechVad;
typedef struct MyAgentsSpeechDiarizer MyAgentsSpeechDiarizer;
typedef struct MyAgentsSpeechDiarizationResult
    MyAgentsSpeechDiarizationResult;

typedef struct MyAgentsSpeechAdapterApiV1 {
  uint32_t struct_size;
  uint32_t abi_version;

  MyAgentsSpeechStatus (*get_build_info)(MyAgentsSpeechBuildInfo *out);

  MyAgentsSpeechStatus (*create_asr)(const MyAgentsSpeechAsrConfig *config,
                                     MyAgentsSpeechAsr **out);
  void (*destroy_asr)(MyAgentsSpeechAsr *asr);
  MyAgentsSpeechStatus (*transcribe)(MyAgentsSpeechAsr *asr,
                                     const float *samples,
                                     uint32_t sample_count,
                                     MyAgentsSpeechAsrResult *out);

  MyAgentsSpeechStatus (*create_vad)(const MyAgentsSpeechVadConfig *config,
                                     MyAgentsSpeechVad **out);
  void (*destroy_vad)(MyAgentsSpeechVad *vad);
  MyAgentsSpeechStatus (*vad_accept)(MyAgentsSpeechVad *vad,
                                     const float *samples,
                                     uint32_t sample_count);
  MyAgentsSpeechStatus (*vad_flush)(MyAgentsSpeechVad *vad);
  MyAgentsSpeechStatus (*vad_pop)(MyAgentsSpeechVad *vad,
                                  MyAgentsSpeechVadSegment *out);
  MyAgentsSpeechStatus (*vad_reset)(MyAgentsSpeechVad *vad);

  MyAgentsSpeechStatus (*create_diarizer)(
      const MyAgentsSpeechDiarizerConfig *config,
      MyAgentsSpeechDiarizer **out);
  void (*destroy_diarizer)(MyAgentsSpeechDiarizer *diarizer);
  MyAgentsSpeechStatus (*diarize_window)(
      MyAgentsSpeechDiarizer *diarizer, const float *samples,
      uint32_t sample_count, MyAgentsSpeechDiarizationResult **out);
  MyAgentsSpeechStatus (*copy_diarization_result)(
      const MyAgentsSpeechDiarizationResult *result,
      MyAgentsSpeechDiarizationOutput *out);
  void (*destroy_diarization_result)(
      MyAgentsSpeechDiarizationResult *result);
} MyAgentsSpeechAdapterApiV1;

MYAGENTS_SPEECH_EXPORT const MyAgentsSpeechAdapterApiV1 *
myagents_speech_adapter_get_api(uint32_t requested_abi_version);

#ifdef __cplusplus
}
#endif

#endif  /* MYAGENTS_SPEECH_ADAPTER_H_ */
