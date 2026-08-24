//! Filesystem capacity queries owned by the Rust OS boundary.
//!
//! Callers keep ownership of budgets and product errors. This helper only
//! asks the operating system about the filesystem containing an existing path;
//! it deliberately does not enumerate mounts or compare path spellings.

use std::io;
use std::path::Path;

pub(crate) fn available_space(path: &Path) -> io::Result<u64> {
    fs4::available_space(path)
}

#[cfg(test)]
mod tests {
    use super::available_space;

    #[test]
    fn queries_the_filesystem_containing_an_existing_directory() {
        let directory = tempfile::tempdir().expect("temp directory");
        let available = available_space(directory.path()).expect("filesystem capacity");

        assert!(available > 0);
    }

    #[cfg(windows)]
    #[test]
    fn queries_a_canonical_verbatim_windows_path() {
        let directory = tempfile::tempdir().expect("temp directory");
        let canonical = directory.path().canonicalize().expect("canonical path");
        assert!(canonical.to_string_lossy().starts_with(r"\\?\"));

        let available = available_space(&canonical).expect("verbatim path capacity");
        assert!(available > 0);
    }
}
