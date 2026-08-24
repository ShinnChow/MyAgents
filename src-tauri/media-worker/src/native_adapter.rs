//! Small stable ABI owned by the media Worker.
//!
//! sherpa-onnx intentionally stays behind the C++ adapter in `native/`.
//! Reproducing sherpa's aggregate configuration structs here would make every
//! upstream field addition an implicit Rust ABI change. This module instead
//! mirrors only the fixed MyAgents operations and validates the table prefix
//! before a verified native bundle may call it.

use std::ffi::{CStr, c_char, c_float};
use std::mem::size_of;

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
}
