//! App-global recording authority.

mod archive;
mod capture;
mod lifecycle;
pub(crate) mod manager;

pub use capture::{CaptureFormat, CaptureSelection, PreparedSource};
pub use manager::{ManagedRecordingManager, RecordingChange, RecordingManager, RecordingSnapshot};
