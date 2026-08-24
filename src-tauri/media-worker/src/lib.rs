//! Domain-owned media inference building blocks.
//!
//! The executable protocol and sherpa adapter live in this crate as they are
//! added. Keeping diarization here (instead of in the App manager) ensures the
//! exact worker generation owns all model execution state while the App keeps
//! durable job and publication authority.

pub mod diarization;
pub mod model_pack_source;
pub mod native_adapter;
pub mod protocol;
