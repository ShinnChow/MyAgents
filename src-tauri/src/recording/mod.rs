//! App-global recording authority.

pub(crate) mod analysis;
mod archive;
pub(crate) mod audio;
mod capture;
mod lifecycle;
pub(crate) mod manager;
pub(crate) mod privacy_settings;

pub use capture::{CaptureFormat, CaptureSelection, PreparedSource};
pub use manager::{ManagedRecordingManager, RecordingChange, RecordingManager, RecordingSnapshot};
