//! Small stable ABI owned by the media Worker.
//!
//! sherpa-onnx intentionally stays behind the C++ adapter in `native/`.
//! Reproducing sherpa's aggregate configuration structs here would make every
//! upstream field addition an implicit Rust ABI change. This module instead
//! mirrors only the fixed MyAgents operations and validates the table prefix
//! before a verified native bundle may call it.

use crate::diarization::{LocalSegment, LocalSpeakerObservation, WindowObservation, WindowSpec};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{CStr, CString, c_char, c_float};
use std::mem::size_of;
use std::path::Path;
use std::ptr::NonNull;

pub const ADAPTER_ABI_VERSION: u32 = 1;
pub const SAMPLE_RATE: u32 = 16_000;
pub const EMBEDDING_DIMENSION: u32 = 512;
pub const MAX_PCM_CHUNK_SAMPLES: u32 = 5 * SAMPLE_RATE;
pub const MAX_ASR_SAMPLES: u32 = 60 * SAMPLE_RATE;
pub const MAX_TEXT_BYTES: u32 = 64 * 1024;
pub const MAX_DIARIZATION_SAMPLES: u32 = 5 * 60 * SAMPLE_RATE;
pub const MAX_LOCAL_SPEAKERS: u32 = 32;
pub const MAX_LOCAL_SEGMENTS: u32 = 16_384;

const SHERPA_ONNX_VERSION: &str = "1.13.6";
const SHERPA_ONNX_COMMIT: &str = "1cb484af5e69d3c7803c1eb0b3b5ab8041e0e911";
const ONNX_RUNTIME_VERSION: &str = "1.28.0";
const MAX_IDENTITY_BYTES: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum NativeStatus {
    Ok = 0,
    InvalidArgument = 1,
    Unavailable = 2,
    BufferTooSmall = 3,
    ModelError = 4,
    InferenceError = 5,
    ResourceLimit = 6,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeAdapterError {
    MissingApi,
    AbiMismatch,
    MissingFunction,
    InvalidBuildIdentity,
    Native(NativeStatus),
    UnknownStatus,
    InvalidPath,
    InvalidOutput,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeBuildIdentity {
    pub sherpa_onnx_version: String,
    pub sherpa_onnx_commit: String,
    pub onnx_runtime_version: String,
}

#[repr(C)]
pub struct NativeBuildInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub sherpa_onnx_version: *const c_char,
    pub sherpa_onnx_commit: *const c_char,
    pub onnx_runtime_version: *const c_char,
    pub sample_rate: u32,
    pub embedding_dimension: u32,
}

#[repr(C)]
pub struct NativeUtf8Buffer {
    pub data: *mut c_char,
    pub capacity: u32,
    pub length: u32,
}

#[repr(C)]
pub struct NativeAsrConfig {
    pub struct_size: u32,
    pub sense_voice_model: *const c_char,
    pub tokens: *const c_char,
    pub num_threads: u32,
    pub use_itn: i32,
}

#[repr(C)]
pub struct NativeAsrResult {
    pub struct_size: u32,
    pub text: NativeUtf8Buffer,
    pub language: NativeUtf8Buffer,
    pub emotion: NativeUtf8Buffer,
    pub event: NativeUtf8Buffer,
}

#[repr(C)]
pub struct NativeVadConfig {
    pub struct_size: u32,
    pub silero_model: *const c_char,
    pub num_threads: u32,
    pub threshold: c_float,
    pub min_silence_seconds: c_float,
    pub min_speech_seconds: c_float,
    pub max_speech_seconds: c_float,
}

#[repr(C)]
pub struct NativeVadSegment {
    pub struct_size: u32,
    pub start_sample: u64,
    pub samples: *mut c_float,
    pub sample_capacity: u32,
    pub sample_count: u32,
}

#[repr(C)]
pub struct NativeDiarizerConfig {
    pub struct_size: u32,
    pub segmentation_model: *const c_char,
    pub embedding_model: *const c_char,
    pub num_threads: u32,
    pub segmentation_window_shift_ratio: c_float,
    pub local_clustering_threshold: c_float,
    pub min_duration_on_seconds: c_float,
    pub min_duration_off_seconds: c_float,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct NativeLocalSpeaker {
    pub local_speaker: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct NativeLocalSegment {
    pub start_sample: u64,
    pub end_sample: u64,
    pub local_speaker: u32,
}

#[repr(C)]
pub struct NativeDiarizationOutput {
    pub struct_size: u32,
    pub speakers: *mut NativeLocalSpeaker,
    pub speaker_capacity: u32,
    pub speaker_count: u32,
    pub segments: *mut NativeLocalSegment,
    pub segment_capacity: u32,
    pub segment_count: u32,
    pub embeddings: *mut c_float,
    pub embedding_capacity: u32,
    pub embedding_count: u32,
}

#[repr(C)]
pub struct NativeAsr {
    _private: [u8; 0],
}

#[repr(C)]
pub struct NativeVad {
    _private: [u8; 0],
}

#[repr(C)]
pub struct NativeDiarizer {
    _private: [u8; 0],
}

#[repr(C)]
pub struct NativeDiarizationResult {
    _private: [u8; 0],
}

type NativeStatusCode = i32;
type GetBuildInfo = unsafe extern "C" fn(*mut NativeBuildInfo) -> NativeStatusCode;
type CreateAsr =
    unsafe extern "C" fn(*const NativeAsrConfig, *mut *mut NativeAsr) -> NativeStatusCode;
type DestroyAsr = unsafe extern "C" fn(*mut NativeAsr);
type Transcribe = unsafe extern "C" fn(
    *mut NativeAsr,
    *const c_float,
    u32,
    *mut NativeAsrResult,
) -> NativeStatusCode;
type CreateVad =
    unsafe extern "C" fn(*const NativeVadConfig, *mut *mut NativeVad) -> NativeStatusCode;
type DestroyVad = unsafe extern "C" fn(*mut NativeVad);
type VadAccept = unsafe extern "C" fn(*mut NativeVad, *const c_float, u32) -> NativeStatusCode;
type VadFlush = unsafe extern "C" fn(*mut NativeVad) -> NativeStatusCode;
type VadPop = unsafe extern "C" fn(*mut NativeVad, *mut NativeVadSegment) -> NativeStatusCode;
type VadReset = unsafe extern "C" fn(*mut NativeVad) -> NativeStatusCode;
type CreateDiarizer =
    unsafe extern "C" fn(*const NativeDiarizerConfig, *mut *mut NativeDiarizer) -> NativeStatusCode;
type DestroyDiarizer = unsafe extern "C" fn(*mut NativeDiarizer);
type DiarizeWindow = unsafe extern "C" fn(
    *mut NativeDiarizer,
    *const c_float,
    u32,
    *mut *mut NativeDiarizationResult,
) -> NativeStatusCode;
type CopyDiarizationResult = unsafe extern "C" fn(
    *const NativeDiarizationResult,
    *mut NativeDiarizationOutput,
) -> NativeStatusCode;
type DestroyDiarizationResult = unsafe extern "C" fn(*mut NativeDiarizationResult);

#[repr(C)]
pub struct NativeApiV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub get_build_info: Option<GetBuildInfo>,
    pub create_asr: Option<CreateAsr>,
    pub destroy_asr: Option<DestroyAsr>,
    pub transcribe: Option<Transcribe>,
    pub create_vad: Option<CreateVad>,
    pub destroy_vad: Option<DestroyVad>,
    pub vad_accept: Option<VadAccept>,
    pub vad_flush: Option<VadFlush>,
    pub vad_pop: Option<VadPop>,
    pub vad_reset: Option<VadReset>,
    pub create_diarizer: Option<CreateDiarizer>,
    pub destroy_diarizer: Option<DestroyDiarizer>,
    pub diarize_window: Option<DiarizeWindow>,
    pub copy_diarization_result: Option<CopyDiarizationResult>,
    pub destroy_diarization_result: Option<DestroyDiarizationResult>,
}

impl NativeApiV1 {
    pub fn validate(&self) -> Result<(), NativeAdapterError> {
        if self.struct_size != size_of::<Self>() as u32 || self.abi_version != ADAPTER_ABI_VERSION {
            return Err(NativeAdapterError::AbiMismatch);
        }
        if self.get_build_info.is_none()
            || self.create_asr.is_none()
            || self.destroy_asr.is_none()
            || self.transcribe.is_none()
            || self.create_vad.is_none()
            || self.destroy_vad.is_none()
            || self.vad_accept.is_none()
            || self.vad_flush.is_none()
            || self.vad_pop.is_none()
            || self.vad_reset.is_none()
            || self.create_diarizer.is_none()
            || self.destroy_diarizer.is_none()
            || self.diarize_window.is_none()
            || self.copy_diarization_result.is_none()
            || self.destroy_diarization_result.is_none()
        {
            return Err(NativeAdapterError::MissingFunction);
        }
        Ok(())
    }

    /// Reads only static build strings owned by the loaded adapter.
    ///
    /// # Safety
    ///
    /// The table must come from a loaded, verified ABI-v1 adapter and its
    /// library must remain loaded for the duration of this call.
    pub unsafe fn build_identity(&self) -> Result<NativeBuildIdentity, NativeAdapterError> {
        self.validate()?;
        let mut info = NativeBuildInfo {
            struct_size: size_of::<NativeBuildInfo>() as u32,
            abi_version: 0,
            sherpa_onnx_version: std::ptr::null(),
            sherpa_onnx_commit: std::ptr::null(),
            onnx_runtime_version: std::ptr::null(),
            sample_rate: 0,
            embedding_dimension: 0,
        };
        // SAFETY: The caller guarantees the validated function table belongs
        // to a live verified adapter; `info` has the exact ABI-v1 layout.
        let status_code = unsafe {
            self.get_build_info
                .ok_or(NativeAdapterError::MissingFunction)?(&mut info)
        };
        let status = native_status(status_code)?;
        if status != NativeStatus::Ok {
            return Err(NativeAdapterError::Native(status));
        }
        if info.abi_version != ADAPTER_ABI_VERSION
            || info.sample_rate != SAMPLE_RATE
            || info.embedding_dimension != EMBEDDING_DIMENSION
        {
            return Err(NativeAdapterError::InvalidBuildIdentity);
        }
        // SAFETY: Successful build-info calls promise non-null, static,
        // NUL-terminated strings while the adapter library remains loaded.
        let sherpa_onnx_version = unsafe { bounded_c_string(info.sherpa_onnx_version)? };
        // SAFETY: Same build-info ownership contract as above.
        let sherpa_onnx_commit = unsafe { bounded_c_string(info.sherpa_onnx_commit)? };
        // SAFETY: Same build-info ownership contract as above.
        let onnx_runtime_version = unsafe { bounded_c_string(info.onnx_runtime_version)? };
        if sherpa_onnx_version != SHERPA_ONNX_VERSION
            || sherpa_onnx_commit != SHERPA_ONNX_COMMIT
            || onnx_runtime_version != ONNX_RUNTIME_VERSION
        {
            return Err(NativeAdapterError::InvalidBuildIdentity);
        }
        Ok(NativeBuildIdentity {
            sherpa_onnx_version,
            sherpa_onnx_commit,
            onnx_runtime_version,
        })
    }
}

fn native_status(code: NativeStatusCode) -> Result<NativeStatus, NativeAdapterError> {
    match code {
        0 => Ok(NativeStatus::Ok),
        1 => Ok(NativeStatus::InvalidArgument),
        2 => Ok(NativeStatus::Unavailable),
        3 => Ok(NativeStatus::BufferTooSmall),
        4 => Ok(NativeStatus::ModelError),
        5 => Ok(NativeStatus::InferenceError),
        6 => Ok(NativeStatus::ResourceLimit),
        _ => Err(NativeAdapterError::UnknownStatus),
    }
}

fn expect_status(code: NativeStatusCode, expected: NativeStatus) -> Result<(), NativeAdapterError> {
    let status = native_status(code)?;
    if status == expected {
        Ok(())
    } else {
        Err(NativeAdapterError::Native(status))
    }
}

fn path_c_string(path: &Path) -> Result<CString, NativeAdapterError> {
    if !path.is_absolute() {
        return Err(NativeAdapterError::InvalidPath);
    }
    let path = path.to_str().ok_or(NativeAdapterError::InvalidPath)?;
    CString::new(path).map_err(|_| NativeAdapterError::InvalidPath)
}

#[derive(Clone, PartialEq, Eq)]
pub struct AsrTranscript {
    pub text: String,
    pub language: Option<String>,
    pub emotion: Option<String>,
    pub event: Option<String>,
}

impl std::fmt::Debug for AsrTranscript {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AsrTranscript")
            .field("text", &"[REDACTED]")
            .field("language", &self.language)
            .field("emotion", &self.emotion.as_ref().map(|_| "[REDACTED]"))
            .field("event", &self.event.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

impl AsrTranscript {
    pub fn zeroize_sensitive(&mut self) {
        use zeroize::Zeroize;

        self.text.zeroize();
        if let Some(language) = &mut self.language {
            language.zeroize();
        }
        if let Some(emotion) = &mut self.emotion {
            emotion.zeroize();
        }
        if let Some(event) = &mut self.event {
            event.zeroize();
        }
    }

    pub fn into_publication(mut self) -> (String, Option<String>) {
        use zeroize::Zeroize;

        if let Some(emotion) = &mut self.emotion {
            emotion.zeroize();
        }
        if let Some(event) = &mut self.event {
            event.zeroize();
        }
        (self.text, self.language)
    }
}

pub struct AsrEngine<'adapter> {
    api: &'adapter NativeApiV1,
    handle: NonNull<NativeAsr>,
}

impl AsrEngine<'_> {
    pub fn transcribe(&mut self, samples: &[f32]) -> Result<AsrTranscript, NativeAdapterError> {
        if samples.is_empty() || samples.len() > MAX_ASR_SAMPLES as usize {
            return Err(NativeAdapterError::InvalidOutput);
        }
        let mut text = vec![0_u8; MAX_TEXT_BYTES as usize + 1];
        let mut language = vec![0_u8; 128];
        let mut emotion = vec![0_u8; 128];
        let mut event = vec![0_u8; 128];
        let mut output = NativeAsrResult {
            struct_size: size_of::<NativeAsrResult>() as u32,
            text: utf8_buffer(&mut text),
            language: utf8_buffer(&mut language),
            emotion: utf8_buffer(&mut emotion),
            event: utf8_buffer(&mut event),
        };
        // SAFETY: The handle is owned by this engine, samples and every output
        // buffer remain live for the call, and all lengths fit the ABI limits.
        let code = unsafe {
            self.api
                .transcribe
                .ok_or(NativeAdapterError::MissingFunction)?(
                self.handle.as_ptr(),
                samples.as_ptr(),
                samples.len() as u32,
                &mut output,
            )
        };
        expect_status(code, NativeStatus::Ok)?;
        Ok(AsrTranscript {
            text: take_utf8(&text, output.text.length)?,
            language: take_optional_label(&language, output.language.length)?,
            emotion: take_optional_utf8(&emotion, output.emotion.length)?,
            event: take_optional_utf8(&event, output.event.length)?,
        })
    }
}

impl Drop for AsrEngine<'_> {
    fn drop(&mut self) {
        if let Some(destroy) = self.api.destroy_asr {
            // SAFETY: This engine uniquely owns the live adapter handle.
            unsafe { destroy(self.handle.as_ptr()) };
        }
    }
}

pub(crate) fn create_asr_engine<'adapter>(
    api: &'adapter NativeApiV1,
    model: &Path,
    tokens: &Path,
) -> Result<AsrEngine<'adapter>, NativeAdapterError> {
    api.validate()?;
    let model = path_c_string(model)?;
    let tokens = path_c_string(tokens)?;
    let config = NativeAsrConfig {
        struct_size: size_of::<NativeAsrConfig>() as u32,
        sense_voice_model: model.as_ptr(),
        tokens: tokens.as_ptr(),
        num_threads: 1,
        use_itn: 1,
    };
    let mut handle = std::ptr::null_mut();
    // SAFETY: Config strings remain alive for the synchronous constructor and
    // the output pointer is writable. The adapter owns any returned handle.
    let code =
        unsafe { api.create_asr.ok_or(NativeAdapterError::MissingFunction)?(&config, &mut handle) };
    expect_status(code, NativeStatus::Ok)?;
    let handle = NonNull::new(handle).ok_or(NativeAdapterError::InvalidOutput)?;
    Ok(AsrEngine { api, handle })
}

#[derive(Clone, PartialEq)]
pub struct VadSpeechSegment {
    pub start_sample: u64,
    pub samples: Vec<f32>,
}

impl std::fmt::Debug for VadSpeechSegment {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("VadSpeechSegment")
            .field("start_sample", &self.start_sample)
            .field("sample_count", &self.samples.len())
            .finish()
    }
}

pub struct VadEngine<'adapter> {
    api: &'adapter NativeApiV1,
    handle: NonNull<NativeVad>,
}

impl VadEngine<'_> {
    pub fn accept(&mut self, samples: &[f32]) -> Result<(), NativeAdapterError> {
        if samples.is_empty() || samples.len() > MAX_PCM_CHUNK_SAMPLES as usize {
            return Err(NativeAdapterError::InvalidOutput);
        }
        // SAFETY: The owned handle and bounded sample slice remain live.
        let code = unsafe {
            self.api
                .vad_accept
                .ok_or(NativeAdapterError::MissingFunction)?(
                self.handle.as_ptr(),
                samples.as_ptr(),
                samples.len() as u32,
            )
        };
        expect_status(code, NativeStatus::Ok)
    }

    pub fn flush(&mut self) -> Result<(), NativeAdapterError> {
        // SAFETY: The owned handle is live and used only on this thread.
        let code = unsafe {
            self.api
                .vad_flush
                .ok_or(NativeAdapterError::MissingFunction)?(self.handle.as_ptr())
        };
        expect_status(code, NativeStatus::Ok)
    }

    pub fn reset(&mut self) -> Result<(), NativeAdapterError> {
        // SAFETY: The owned handle is live and used only on this thread.
        let code = unsafe {
            self.api
                .vad_reset
                .ok_or(NativeAdapterError::MissingFunction)?(self.handle.as_ptr())
        };
        expect_status(code, NativeStatus::Ok)
    }

    pub fn pop(&mut self) -> Result<Option<VadSpeechSegment>, NativeAdapterError> {
        let mut query = NativeVadSegment {
            struct_size: size_of::<NativeVadSegment>() as u32,
            start_sample: 0,
            samples: std::ptr::null_mut(),
            sample_capacity: 0,
            sample_count: 0,
        };
        let pop = self
            .api
            .vad_pop
            .ok_or(NativeAdapterError::MissingFunction)?;
        // SAFETY: Query output is writable; a buffer-too-small query does not
        // pop the native queue entry.
        let query_code = unsafe { pop(self.handle.as_ptr(), &mut query) };
        match native_status(query_code)? {
            NativeStatus::Unavailable => return Ok(None),
            NativeStatus::BufferTooSmall => {}
            status => return Err(NativeAdapterError::Native(status)),
        }
        if query.sample_count == 0 || query.sample_count > MAX_ASR_SAMPLES {
            return Err(NativeAdapterError::InvalidOutput);
        }
        let mut samples = vec![0.0_f32; query.sample_count as usize];
        let mut output = NativeVadSegment {
            struct_size: size_of::<NativeVadSegment>() as u32,
            start_sample: 0,
            samples: samples.as_mut_ptr(),
            sample_capacity: samples.len() as u32,
            sample_count: 0,
        };
        // SAFETY: The exact-size output buffer remains live for the call.
        let code = unsafe { pop(self.handle.as_ptr(), &mut output) };
        expect_status(code, NativeStatus::Ok)?;
        if output.sample_count != samples.len() as u32
            || samples.iter().any(|sample| !sample.is_finite())
        {
            return Err(NativeAdapterError::InvalidOutput);
        }
        Ok(Some(VadSpeechSegment {
            start_sample: output.start_sample,
            samples,
        }))
    }
}

impl Drop for VadEngine<'_> {
    fn drop(&mut self) {
        if let Some(destroy) = self.api.destroy_vad {
            // SAFETY: This engine uniquely owns the live adapter handle.
            unsafe { destroy(self.handle.as_ptr()) };
        }
    }
}

pub(crate) fn create_vad_engine<'adapter>(
    api: &'adapter NativeApiV1,
    model: &Path,
) -> Result<VadEngine<'adapter>, NativeAdapterError> {
    api.validate()?;
    let model = path_c_string(model)?;
    let config = NativeVadConfig {
        struct_size: size_of::<NativeVadConfig>() as u32,
        silero_model: model.as_ptr(),
        num_threads: 1,
        threshold: 0.25,
        min_silence_seconds: 0.5,
        min_speech_seconds: 0.25,
        max_speech_seconds: 30.0,
    };
    let mut handle = std::ptr::null_mut();
    // SAFETY: Config strings remain alive for the synchronous constructor.
    let code =
        unsafe { api.create_vad.ok_or(NativeAdapterError::MissingFunction)?(&config, &mut handle) };
    expect_status(code, NativeStatus::Ok)?;
    let handle = NonNull::new(handle).ok_or(NativeAdapterError::InvalidOutput)?;
    Ok(VadEngine { api, handle })
}

pub struct DiarizerEngine<'adapter> {
    api: &'adapter NativeApiV1,
    handle: NonNull<NativeDiarizer>,
}

impl DiarizerEngine<'_> {
    pub fn diarize_window(
        &mut self,
        window: WindowSpec,
        samples: &[f32],
    ) -> Result<WindowObservation, NativeAdapterError> {
        let expected_length = window
            .end_sample
            .checked_sub(window.start_sample)
            .ok_or(NativeAdapterError::InvalidOutput)?;
        if samples.is_empty()
            || samples.len() > MAX_DIARIZATION_SAMPLES as usize
            || expected_length != samples.len() as u64
        {
            return Err(NativeAdapterError::InvalidOutput);
        }
        let mut result = std::ptr::null_mut();
        // SAFETY: The owned handle and bounded samples remain live; result is
        // initialized by the adapter and released by the guard below.
        let code = unsafe {
            self.api
                .diarize_window
                .ok_or(NativeAdapterError::MissingFunction)?(
                self.handle.as_ptr(),
                samples.as_ptr(),
                samples.len() as u32,
                &mut result,
            )
        };
        expect_status(code, NativeStatus::Ok)?;
        let result = NonNull::new(result).ok_or(NativeAdapterError::InvalidOutput)?;
        let guard = NativeDiarizationGuard {
            api: self.api,
            handle: result,
        };
        copy_window_observation(self.api, guard.handle, window, samples.len())
    }
}

impl Drop for DiarizerEngine<'_> {
    fn drop(&mut self) {
        if let Some(destroy) = self.api.destroy_diarizer {
            // SAFETY: This engine uniquely owns the live adapter handle.
            unsafe { destroy(self.handle.as_ptr()) };
        }
    }
}

pub(crate) fn create_diarizer_engine<'adapter>(
    api: &'adapter NativeApiV1,
    segmentation_model: &Path,
    embedding_model: &Path,
) -> Result<DiarizerEngine<'adapter>, NativeAdapterError> {
    api.validate()?;
    let segmentation_model = path_c_string(segmentation_model)?;
    let embedding_model = path_c_string(embedding_model)?;
    let config = NativeDiarizerConfig {
        struct_size: size_of::<NativeDiarizerConfig>() as u32,
        segmentation_model: segmentation_model.as_ptr(),
        embedding_model: embedding_model.as_ptr(),
        num_threads: 1,
        segmentation_window_shift_ratio: 1.0,
        local_clustering_threshold: 0.50,
        min_duration_on_seconds: 0.3,
        min_duration_off_seconds: 0.5,
    };
    let mut handle = std::ptr::null_mut();
    // SAFETY: Config strings remain alive for the synchronous constructor.
    let code = unsafe {
        api.create_diarizer
            .ok_or(NativeAdapterError::MissingFunction)?(&config, &mut handle)
    };
    expect_status(code, NativeStatus::Ok)?;
    let handle = NonNull::new(handle).ok_or(NativeAdapterError::InvalidOutput)?;
    Ok(DiarizerEngine { api, handle })
}

struct NativeDiarizationGuard<'adapter> {
    api: &'adapter NativeApiV1,
    handle: NonNull<NativeDiarizationResult>,
}

impl Drop for NativeDiarizationGuard<'_> {
    fn drop(&mut self) {
        if let Some(destroy) = self.api.destroy_diarization_result {
            // SAFETY: This guard uniquely owns the result handle.
            unsafe { destroy(self.handle.as_ptr()) };
        }
    }
}

fn copy_window_observation(
    api: &NativeApiV1,
    result: NonNull<NativeDiarizationResult>,
    window: WindowSpec,
    sample_count: usize,
) -> Result<WindowObservation, NativeAdapterError> {
    let copy = api
        .copy_diarization_result
        .ok_or(NativeAdapterError::MissingFunction)?;
    let mut query = empty_diarization_output();
    // SAFETY: Query output is writable and the result guard keeps the native
    // object alive for both calls.
    let query_code = unsafe { copy(result.as_ptr(), &mut query) };
    let query_status = native_status(query_code)?;
    if query_status != NativeStatus::Ok && query_status != NativeStatus::BufferTooSmall {
        return Err(NativeAdapterError::Native(query_status));
    }
    if query.speaker_count > MAX_LOCAL_SPEAKERS
        || query.segment_count > MAX_LOCAL_SEGMENTS
        || query.embedding_count
            != query
                .speaker_count
                .checked_mul(EMBEDDING_DIMENSION)
                .ok_or(NativeAdapterError::InvalidOutput)?
    {
        return Err(NativeAdapterError::InvalidOutput);
    }
    if query.speaker_count == 0 {
        if query.segment_count != 0 || query.embedding_count != 0 {
            return Err(NativeAdapterError::InvalidOutput);
        }
        return Ok(WindowObservation {
            window,
            speakers: Vec::new(),
        });
    }
    let mut speakers = vec![NativeLocalSpeaker { local_speaker: 0 }; query.speaker_count as usize];
    let mut segments = vec![
        NativeLocalSegment {
            start_sample: 0,
            end_sample: 0,
            local_speaker: 0,
        };
        query.segment_count as usize
    ];
    let mut embeddings = vec![0.0_f32; query.embedding_count as usize];
    let mut output = NativeDiarizationOutput {
        struct_size: size_of::<NativeDiarizationOutput>() as u32,
        speakers: speakers.as_mut_ptr(),
        speaker_capacity: speakers.len() as u32,
        speaker_count: 0,
        segments: segments.as_mut_ptr(),
        segment_capacity: segments.len() as u32,
        segment_count: 0,
        embeddings: embeddings.as_mut_ptr(),
        embedding_capacity: embeddings.len() as u32,
        embedding_count: 0,
    };
    // SAFETY: All output buffers have the exact capacities from the bounded
    // query and remain live for the call.
    let code = unsafe { copy(result.as_ptr(), &mut output) };
    expect_status(code, NativeStatus::Ok)?;
    if output.speaker_count != speakers.len() as u32
        || output.segment_count != segments.len() as u32
        || output.embedding_count != embeddings.len() as u32
        || embeddings.iter().any(|value| !value.is_finite())
    {
        return Err(NativeAdapterError::InvalidOutput);
    }
    let unique = speakers
        .iter()
        .map(|speaker| speaker.local_speaker)
        .collect::<BTreeSet<_>>();
    if unique.len() != speakers.len() {
        return Err(NativeAdapterError::InvalidOutput);
    }
    let mut grouped_segments = BTreeMap::<u32, Vec<LocalSegment>>::new();
    for segment in segments {
        if !unique.contains(&segment.local_speaker)
            || segment.start_sample >= segment.end_sample
            || segment.end_sample > sample_count as u64
        {
            return Err(NativeAdapterError::InvalidOutput);
        }
        grouped_segments
            .entry(segment.local_speaker)
            .or_default()
            .push(LocalSegment {
                start_sample: segment.start_sample,
                end_sample: segment.end_sample,
            });
    }
    let speakers = speakers
        .into_iter()
        .enumerate()
        .map(|(index, speaker)| {
            let start = index * EMBEDDING_DIMENSION as usize;
            let end = start + EMBEDDING_DIMENSION as usize;
            LocalSpeakerObservation {
                local_speaker: speaker.local_speaker,
                embedding: embeddings[start..end].to_vec(),
                segments: grouped_segments
                    .remove(&speaker.local_speaker)
                    .unwrap_or_default(),
            }
        })
        .collect();
    Ok(WindowObservation { window, speakers })
}

fn empty_diarization_output() -> NativeDiarizationOutput {
    NativeDiarizationOutput {
        struct_size: size_of::<NativeDiarizationOutput>() as u32,
        speakers: std::ptr::null_mut(),
        speaker_capacity: 0,
        speaker_count: 0,
        segments: std::ptr::null_mut(),
        segment_capacity: 0,
        segment_count: 0,
        embeddings: std::ptr::null_mut(),
        embedding_capacity: 0,
        embedding_count: 0,
    }
}

fn utf8_buffer(buffer: &mut [u8]) -> NativeUtf8Buffer {
    NativeUtf8Buffer {
        data: buffer.as_mut_ptr().cast(),
        capacity: buffer.len() as u32,
        length: 0,
    }
}

fn take_utf8(buffer: &[u8], length: u32) -> Result<String, NativeAdapterError> {
    let length = length as usize;
    if length >= buffer.len() || buffer.get(length) != Some(&0) {
        return Err(NativeAdapterError::InvalidOutput);
    }
    std::str::from_utf8(&buffer[..length])
        .map(str::to_owned)
        .map_err(|_| NativeAdapterError::InvalidOutput)
}

fn take_optional_utf8(buffer: &[u8], length: u32) -> Result<Option<String>, NativeAdapterError> {
    let value = take_utf8(buffer, length)?;
    Ok((!value.is_empty()).then_some(value))
}

fn take_optional_label(buffer: &[u8], length: u32) -> Result<Option<String>, NativeAdapterError> {
    let Some(value) = take_optional_utf8(buffer, length)? else {
        return Ok(None);
    };
    let value = value
        .strip_prefix("<|")
        .and_then(|value| value.strip_suffix("|>"))
        .unwrap_or(&value)
        .to_ascii_lowercase();
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(NativeAdapterError::InvalidOutput);
    }
    Ok(Some(value))
}

/// Validate the fixed table prefix returned by
/// `myagents_speech_adapter_get_api(1)`.
///
/// # Safety
///
/// `api` must either be null or point to readable memory owned by a verified
/// adapter library that remains loaded for the returned reference's lifetime.
pub unsafe fn validate_api<'library>(
    api: *const NativeApiV1,
) -> Result<&'library NativeApiV1, NativeAdapterError> {
    // SAFETY: The caller supplies the pointer provenance and library lifetime.
    let api = unsafe { api.as_ref() }.ok_or(NativeAdapterError::MissingApi)?;
    api.validate()?;
    Ok(api)
}

unsafe fn bounded_c_string(value: *const c_char) -> Result<String, NativeAdapterError> {
    if value.is_null() {
        return Err(NativeAdapterError::InvalidBuildIdentity);
    }
    // SAFETY: The caller guarantees `value` is a valid NUL-terminated native
    // build string. We immediately enforce a small identity bound.
    let bytes = unsafe { CStr::from_ptr(value) }.to_bytes();
    if bytes.is_empty() || bytes.len() > MAX_IDENTITY_BYTES {
        return Err(NativeAdapterError::InvalidBuildIdentity);
    }
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| NativeAdapterError::InvalidBuildIdentity)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SHERPA_VERSION: &[u8] = b"1.13.6\0";
    static SHERPA_COMMIT: &[u8] = b"1cb484af5e69d3c7803c1eb0b3b5ab8041e0e911\0";
    static ORT_VERSION: &[u8] = b"1.28.0\0";

    unsafe extern "C" fn mock_build_info(out: *mut NativeBuildInfo) -> NativeStatusCode {
        // SAFETY: The test passes a live NativeBuildInfo with the expected size.
        let Some(out) = (unsafe { out.as_mut() }) else {
            return NativeStatus::InvalidArgument as NativeStatusCode;
        };
        if out.struct_size != size_of::<NativeBuildInfo>() as u32 {
            return NativeStatus::InvalidArgument as NativeStatusCode;
        }
        out.abi_version = ADAPTER_ABI_VERSION;
        out.sherpa_onnx_version = SHERPA_VERSION.as_ptr().cast();
        out.sherpa_onnx_commit = SHERPA_COMMIT.as_ptr().cast();
        out.onnx_runtime_version = ORT_VERSION.as_ptr().cast();
        out.sample_rate = SAMPLE_RATE;
        out.embedding_dimension = EMBEDDING_DIMENSION;
        NativeStatus::Ok as NativeStatusCode
    }

    unsafe extern "C" fn stub_create_asr(
        _: *const NativeAsrConfig,
        _: *mut *mut NativeAsr,
    ) -> NativeStatusCode {
        NativeStatus::Ok as NativeStatusCode
    }
    unsafe extern "C" fn stub_destroy_asr(_: *mut NativeAsr) {}
    unsafe extern "C" fn stub_transcribe(
        _: *mut NativeAsr,
        _: *const c_float,
        _: u32,
        _: *mut NativeAsrResult,
    ) -> NativeStatusCode {
        NativeStatus::Ok as NativeStatusCode
    }
    unsafe extern "C" fn stub_create_vad(
        _: *const NativeVadConfig,
        _: *mut *mut NativeVad,
    ) -> NativeStatusCode {
        NativeStatus::Ok as NativeStatusCode
    }
    unsafe extern "C" fn stub_destroy_vad(_: *mut NativeVad) {}
    unsafe extern "C" fn stub_vad_accept(
        _: *mut NativeVad,
        _: *const c_float,
        _: u32,
    ) -> NativeStatusCode {
        NativeStatus::Ok as NativeStatusCode
    }
    unsafe extern "C" fn stub_vad_control(_: *mut NativeVad) -> NativeStatusCode {
        NativeStatus::Ok as NativeStatusCode
    }
    unsafe extern "C" fn stub_vad_pop(
        _: *mut NativeVad,
        _: *mut NativeVadSegment,
    ) -> NativeStatusCode {
        NativeStatus::Ok as NativeStatusCode
    }
    unsafe extern "C" fn stub_create_diarizer(
        _: *const NativeDiarizerConfig,
        _: *mut *mut NativeDiarizer,
    ) -> NativeStatusCode {
        NativeStatus::Ok as NativeStatusCode
    }
    unsafe extern "C" fn stub_destroy_diarizer(_: *mut NativeDiarizer) {}
    unsafe extern "C" fn stub_diarize_window(
        _: *mut NativeDiarizer,
        _: *const c_float,
        _: u32,
        _: *mut *mut NativeDiarizationResult,
    ) -> NativeStatusCode {
        NativeStatus::Ok as NativeStatusCode
    }
    unsafe extern "C" fn stub_copy_diarization(
        _: *const NativeDiarizationResult,
        _: *mut NativeDiarizationOutput,
    ) -> NativeStatusCode {
        NativeStatus::Ok as NativeStatusCode
    }
    unsafe extern "C" fn stub_destroy_diarization(_: *mut NativeDiarizationResult) {}

    unsafe extern "C" fn create_fake_asr(
        _: *const NativeAsrConfig,
        out: *mut *mut NativeAsr,
    ) -> NativeStatusCode {
        // SAFETY: The wrapper passes a live output pointer.
        unsafe { *out = NonNull::<NativeAsr>::dangling().as_ptr() };
        NativeStatus::Ok as NativeStatusCode
    }

    unsafe extern "C" fn fake_transcribe(
        _: *mut NativeAsr,
        _: *const c_float,
        _: u32,
        out: *mut NativeAsrResult,
    ) -> NativeStatusCode {
        // SAFETY: The wrapper passes the exact ABI result and writable buffers.
        let out = unsafe { &mut *out };
        // SAFETY: Test bytes fit every wrapper-owned output buffer.
        unsafe {
            write_fake_utf8(&mut out.text, "测试转写".as_bytes());
            write_fake_utf8(&mut out.language, b"<|ZH|>");
            write_fake_utf8(&mut out.emotion, b"");
            write_fake_utf8(&mut out.event, b"speech");
        }
        NativeStatus::Ok as NativeStatusCode
    }

    unsafe fn write_fake_utf8(buffer: &mut NativeUtf8Buffer, value: &[u8]) {
        assert!(buffer.capacity as usize > value.len());
        // SAFETY: Assertion and wrapper-owned allocation establish both writes.
        unsafe {
            std::ptr::copy_nonoverlapping(value.as_ptr(), buffer.data.cast(), value.len());
            *buffer.data.add(value.len()) = 0;
        }
        buffer.length = value.len() as u32;
    }

    unsafe extern "C" fn create_fake_vad(
        _: *const NativeVadConfig,
        out: *mut *mut NativeVad,
    ) -> NativeStatusCode {
        // SAFETY: The wrapper passes a live output pointer.
        unsafe { *out = NonNull::<NativeVad>::dangling().as_ptr() };
        NativeStatus::Ok as NativeStatusCode
    }

    static VAD_POP_STATE: AtomicUsize = AtomicUsize::new(0);

    unsafe extern "C" fn fake_vad_pop(
        _: *mut NativeVad,
        out: *mut NativeVadSegment,
    ) -> NativeStatusCode {
        // SAFETY: The wrapper passes the exact ABI output struct.
        let out = unsafe { &mut *out };
        if VAD_POP_STATE.load(Ordering::SeqCst) != 0 {
            out.sample_count = 0;
            return NativeStatus::Unavailable as NativeStatusCode;
        }
        out.start_sample = 7;
        out.sample_count = 3;
        if out.samples.is_null() || out.sample_capacity < 3 {
            return NativeStatus::BufferTooSmall as NativeStatusCode;
        }
        // SAFETY: The wrapper allocated the advertised three-float buffer.
        unsafe { std::ptr::copy_nonoverlapping([0.1, 0.2, 0.3].as_ptr(), out.samples, 3) };
        VAD_POP_STATE.store(1, Ordering::SeqCst);
        NativeStatus::Ok as NativeStatusCode
    }

    unsafe extern "C" fn create_fake_diarizer(
        _: *const NativeDiarizerConfig,
        out: *mut *mut NativeDiarizer,
    ) -> NativeStatusCode {
        // SAFETY: The wrapper passes a live output pointer.
        unsafe { *out = NonNull::<NativeDiarizer>::dangling().as_ptr() };
        NativeStatus::Ok as NativeStatusCode
    }

    unsafe extern "C" fn fake_diarize_window(
        _: *mut NativeDiarizer,
        _: *const c_float,
        _: u32,
        out: *mut *mut NativeDiarizationResult,
    ) -> NativeStatusCode {
        // SAFETY: The wrapper passes a live output pointer.
        unsafe { *out = NonNull::<NativeDiarizationResult>::dangling().as_ptr() };
        NativeStatus::Ok as NativeStatusCode
    }

    unsafe extern "C" fn fake_copy_diarization(
        _: *const NativeDiarizationResult,
        out: *mut NativeDiarizationOutput,
    ) -> NativeStatusCode {
        // SAFETY: The wrapper passes the exact ABI output struct.
        let out = unsafe { &mut *out };
        out.speaker_count = 2;
        out.segment_count = 2;
        out.embedding_count = 2 * EMBEDDING_DIMENSION;
        if out.speakers.is_null() || out.segments.is_null() || out.embeddings.is_null() {
            return NativeStatus::BufferTooSmall as NativeStatusCode;
        }
        if out.speaker_capacity < 2
            || out.segment_capacity < 2
            || out.embedding_capacity < 2 * EMBEDDING_DIMENSION
        {
            return NativeStatus::BufferTooSmall as NativeStatusCode;
        }
        // SAFETY: Capacities are checked against each fixed write.
        unsafe {
            *out.speakers.add(0) = NativeLocalSpeaker { local_speaker: 3 };
            *out.speakers.add(1) = NativeLocalSpeaker { local_speaker: 8 };
            *out.segments.add(0) = NativeLocalSegment {
                start_sample: 0,
                end_sample: 4,
                local_speaker: 3,
            };
            *out.segments.add(1) = NativeLocalSegment {
                start_sample: 4,
                end_sample: 10,
                local_speaker: 8,
            };
            std::ptr::write_bytes(out.embeddings, 0, (2 * EMBEDDING_DIMENSION) as usize);
            *out.embeddings.add(0) = 1.0;
            *out.embeddings.add(EMBEDDING_DIMENSION as usize + 1) = 1.0;
        }
        NativeStatus::Ok as NativeStatusCode
    }

    fn complete_api() -> NativeApiV1 {
        NativeApiV1 {
            struct_size: size_of::<NativeApiV1>() as u32,
            abi_version: ADAPTER_ABI_VERSION,
            get_build_info: Some(mock_build_info),
            create_asr: Some(stub_create_asr),
            destroy_asr: Some(stub_destroy_asr),
            transcribe: Some(stub_transcribe),
            create_vad: Some(stub_create_vad),
            destroy_vad: Some(stub_destroy_vad),
            vad_accept: Some(stub_vad_accept),
            vad_flush: Some(stub_vad_control),
            vad_pop: Some(stub_vad_pop),
            vad_reset: Some(stub_vad_control),
            create_diarizer: Some(stub_create_diarizer),
            destroy_diarizer: Some(stub_destroy_diarizer),
            diarize_window: Some(stub_diarize_window),
            copy_diarization_result: Some(stub_copy_diarization),
            destroy_diarization_result: Some(stub_destroy_diarization),
        }
    }

    #[test]
    fn rust_layout_matches_the_64_bit_c_abi() {
        assert_eq!(size_of::<NativeBuildInfo>(), 40);
        assert_eq!(size_of::<NativeUtf8Buffer>(), 16);
        assert_eq!(size_of::<NativeAsrConfig>(), 32);
        assert_eq!(size_of::<NativeAsrResult>(), 72);
        assert_eq!(size_of::<NativeVadConfig>(), 40);
        assert_eq!(size_of::<NativeVadSegment>(), 32);
        assert_eq!(size_of::<NativeDiarizerConfig>(), 48);
        assert_eq!(size_of::<NativeLocalSpeaker>(), 4);
        assert_eq!(size_of::<NativeLocalSegment>(), 24);
        assert_eq!(size_of::<NativeDiarizationOutput>(), 56);
        assert_eq!(size_of::<NativeApiV1>(), 128);
    }

    #[test]
    fn complete_api_reports_the_frozen_runtime_identity() {
        let api = complete_api();
        // SAFETY: The complete mocked table and static build strings outlive
        // the call and satisfy the ABI-v1 contract.
        let identity = unsafe { api.build_identity() }.unwrap();
        assert_eq!(identity.sherpa_onnx_version, "1.13.6");
        assert_eq!(identity.onnx_runtime_version, "1.28.0");
    }

    #[test]
    fn table_validation_rejects_prefix_or_function_drift() {
        let mut api = complete_api();
        api.struct_size -= 8;
        assert_eq!(api.validate(), Err(NativeAdapterError::AbiMismatch));

        let mut api = complete_api();
        api.vad_pop = None;
        assert_eq!(api.validate(), Err(NativeAdapterError::MissingFunction));

        assert_eq!(native_status(77), Err(NativeAdapterError::UnknownStatus));
    }

    #[test]
    fn safe_wrappers_copy_and_validate_native_outputs() {
        VAD_POP_STATE.store(0, Ordering::SeqCst);
        let mut api = complete_api();
        api.create_asr = Some(create_fake_asr);
        api.transcribe = Some(fake_transcribe);
        api.create_vad = Some(create_fake_vad);
        api.vad_pop = Some(fake_vad_pop);
        api.create_diarizer = Some(create_fake_diarizer);
        api.diarize_window = Some(fake_diarize_window);
        api.copy_diarization_result = Some(fake_copy_diarization);
        let root = tempfile::tempdir().unwrap();

        let mut asr = create_asr_engine(
            &api,
            &root.path().join("sensevoice.onnx"),
            &root.path().join("tokens.txt"),
        )
        .unwrap();
        let transcript = asr.transcribe(&[0.0; 160]).unwrap();
        assert_eq!(transcript.text, "测试转写");
        assert_eq!(transcript.language.as_deref(), Some("zh"));
        assert!(!format!("{transcript:?}").contains("测试转写"));

        let mut vad = create_vad_engine(&api, &root.path().join("vad.onnx")).unwrap();
        vad.accept(&[0.0; 160]).unwrap();
        let segment = vad.pop().unwrap().unwrap();
        assert_eq!(segment.start_sample, 7);
        assert_eq!(segment.samples, vec![0.1, 0.2, 0.3]);
        assert_eq!(vad.pop().unwrap(), None);

        let mut diarizer = create_diarizer_engine(
            &api,
            &root.path().join("segmentation.onnx"),
            &root.path().join("embedding.onnx"),
        )
        .unwrap();
        let observation = diarizer
            .diarize_window(
                WindowSpec {
                    index: 2,
                    start_sample: 20,
                    end_sample: 30,
                },
                &[0.0; 10],
            )
            .unwrap();
        assert_eq!(observation.speakers.len(), 2);
        assert_eq!(observation.speakers[0].local_speaker, 3);
        assert_eq!(observation.speakers[0].segments[0].end_sample, 4);
        assert_eq!(observation.speakers[1].embedding[1], 1.0);
    }
}
