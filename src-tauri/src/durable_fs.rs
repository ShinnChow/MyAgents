//! Small cross-platform durability primitives shared by app-owned stores.

use std::fs::File;
#[cfg(windows)]
use std::fs::OpenOptions;
use std::path::Path;

pub(crate) fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;

        return OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)?
            .sync_all();
    }
    #[cfg(not(windows))]
    {
        File::open(path)?.sync_all()
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn rename_directory_noreplace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn rename_directory_noreplace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
pub(crate) fn rename_directory_noreplace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS};
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if result != 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error
        .raw_os_error()
        .map(|code| code as u32)
        .is_some_and(|code| code == ERROR_ALREADY_EXISTS || code == ERROR_FILE_EXISTS)
    {
        Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "destination already exists",
        ))
    } else {
        Err(error)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn rename_directory_noreplace(source: &Path, destination: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(destination).is_ok() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "destination exists",
        ));
    }
    std::fs::rename(source, destination)
}
