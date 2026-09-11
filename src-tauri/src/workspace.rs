//! Bounded UTF-8 editing of existing workspace files. This is independent of
//! transport upload limits. External processes are not covered by our mutex.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

pub const FILE_LIMIT: usize = 1024 * 1024;
// Also held by the desktop run command, so a run cannot start during replacement.
pub static FILE_OPERATIONS: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
pub struct FileError {
    pub code: &'static str,
    pub message: String,
}

impl FileError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<std::io::Error> for FileError {
    fn from(error: std::io::Error) -> Self {
        let (code, label) = match error.kind() {
            std::io::ErrorKind::NotFound => ("not_found", "文件或目录不存在"),
            std::io::ErrorKind::PermissionDenied => ("permission", "没有文件读写权限"),
            _ => ("io", "文件操作失败"),
        };
        Self::new(code, format!("{label}：{error}"))
    }
}

type Result<T> = std::result::Result<T, FileError>;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
}

#[derive(Debug, Serialize)]
pub struct Document {
    pub content: String,
    pub revision: String,
    pub eol: Eol,
    pub bom: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub dir: String,
    pub name: String,
    pub content: String,
    pub expected_revision: String,
    pub eol: Eol,
    pub bom: bool,
}

#[derive(Debug, Serialize)]
pub struct Saved {
    pub revision: String,
}

fn redirected(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

fn invalid_path() -> FileError {
    FileError::new("path", "仅可编辑工作区内的普通文件，不支持链接或重定向路径")
}

fn resolve(dir: &str, name: &str) -> Result<PathBuf> {
    if name.is_empty() || name.contains(['\0', ':', '\\']) {
        return Err(invalid_path());
    }
    let relative = Path::new(name);
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(invalid_path());
    }
    // Check the selected root and its ancestors too (not just the final file).
    let absolute_root = std::path::absolute(dir)?;
    for ancestor in absolute_root.ancestors() {
        if redirected(&fs::symlink_metadata(ancestor)?) {
            return Err(invalid_path());
        }
    }
    let root = fs::canonicalize(&absolute_root)?;
    if !root.is_dir() {
        return Err(invalid_path());
    }
    let mut path = root.clone();
    for part in relative.components() {
        path.push(part);
        if redirected(&fs::symlink_metadata(&path)?) {
            return Err(invalid_path());
        }
    }
    let canonical = fs::canonicalize(&path)?;
    if !canonical.starts_with(&root) || canonical != path || !fs::metadata(&path)?.is_file() {
        return Err(invalid_path());
    }
    Ok(path)
}

fn revision(data: &[u8], meta: &Metadata) -> String {
    let mut digest = Sha256::new();
    digest.update(data);
    // Include timestamps and file identity where available to detect replacement.
    digest.update(format!(
        "{:?}{:?}",
        meta.modified().ok(),
        meta.created().ok()
    ));
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        digest.update(meta.dev().to_le_bytes());
        digest.update(meta.ino().to_le_bytes());
    }
    format!("{:x}", digest.finalize())
}

fn bytes(path: &Path) -> Result<(Vec<u8>, Metadata)> {
    let file = File::open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || redirected(&meta) {
        return Err(invalid_path());
    }
    if meta.len() > FILE_LIMIT as u64 {
        return Err(too_large());
    }
    let mut data = Vec::new();
    file.take(FILE_LIMIT as u64 + 1).read_to_end(&mut data)?;
    if data.len() > FILE_LIMIT {
        return Err(too_large());
    }
    Ok((data, meta))
}

fn too_large() -> FileError {
    FileError::new("too_large", "编辑器最多支持 1 MiB，请使用外部编辑器")
}

pub fn read(dir: &str, name: &str) -> Result<Document> {
    let path = resolve(dir, name)?;
    let (data, meta) = bytes(&path)?;
    let text = std::str::from_utf8(&data)
        .map_err(|_| FileError::new("encoding", "仅支持 UTF-8 文本，请使用外部编辑器转换编码"))?;
    if text.contains('\0') {
        return Err(FileError::new("encoding", "不支持包含 NUL 的文件"));
    }
    let bom = text.starts_with('\u{feff}');
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let crlf = text.contains("\r\n");
    let normalized = text.replace("\r\n", "\n");
    if normalized.contains('\r') || (crlf && text.replace("\r\n", "").contains('\n')) {
        return Err(FileError::new(
            "eol",
            "文件包含混合或不支持的行尾，请用外部编辑器统一为 LF 或 CRLF",
        ));
    }
    Ok(Document {
        content: normalized,
        revision: revision(&data, &meta),
        eol: if crlf { Eol::Crlf } else { Eol::Lf },
        bom,
    })
}

// Keep the original file in place until a complete replacement is ready.
struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(not(windows))]
fn replace(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

#[cfg(windows)]
fn replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // ReplaceFile preserves the target ACL. Both strings are NUL terminated and
    // remain alive for the synchronous call; optional pointer arguments are null.
    let ok = unsafe {
        ReplaceFileW(
            target.as_ptr(),
            source.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Caller holds FILE_OPERATIONS and checks that no desktop run is syncing.
pub fn write(request: SaveRequest) -> Result<Saved> {
    if request.content.contains(['\0', '\r']) {
        return Err(FileError::new(
            "encoding",
            "编辑内容必须是无 NUL 的 LF 文本",
        ));
    }
    if request.content.len() > FILE_LIMIT {
        return Err(too_large());
    }
    let mut data = if request.bom {
        vec![0xef, 0xbb, 0xbf]
    } else {
        Vec::new()
    };
    match request.eol {
        Eol::Lf => data.extend_from_slice(request.content.as_bytes()),
        Eol::Crlf => data.extend_from_slice(request.content.replace('\n', "\r\n").as_bytes()),
    }
    if data.len() > FILE_LIMIT {
        return Err(too_large());
    }
    let path = resolve(&request.dir, &request.name)?;
    let (original, meta) = bytes(&path)?;
    let conflict = || {
        FileError::new(
            "conflict",
            "文件已被其他程序修改。请复制需要保留的内容后重新加载，或取消保存",
        )
    };
    if revision(&original, &meta) != request.expected_revision {
        return Err(conflict());
    }
    if meta.permissions().readonly() {
        return Err(FileError::new("permission", "文件为只读，无法保存"));
    }
    let temp = Temporary(
        path.parent()
            .ok_or_else(invalid_path)?
            .join(format!(".rr-edit-{}.tmp", uuid::Uuid::new_v4())),
    );
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp.0)?;
    file.write_all(&data)?;
    file.set_permissions(meta.permissions())?;
    file.sync_all()?;
    drop(file);
    if resolve(&request.dir, &request.name)? != path {
        return Err(conflict());
    }
    let (latest, latest_meta) = bytes(&path)?;
    if revision(&latest, &latest_meta) != request.expected_revision {
        return Err(conflict());
    }
    replace(&temp.0, &path)?;
    // Read after replacement so the revision includes the new file metadata.
    let saved = read(&request.dir, &request.name)?;
    if saved.content != request.content {
        return Err(conflict());
    }
    Ok(Saved {
        revision: saved.revision,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new(data: &[u8]) -> Self {
            let root = std::env::temp_dir().join(format!("rr-editor-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            fs::write(root.join("main.py"), data).unwrap();
            Self(root)
        }
        fn dir(&self) -> &str {
            self.0.to_str().unwrap()
        }
        fn request(&self, content: &str) -> SaveRequest {
            let doc = read(self.dir(), "main.py").unwrap();
            SaveRequest {
                dir: self.dir().into(),
                name: "main.py".into(),
                content: content.into(),
                expected_revision: doc.revision,
                eol: doc.eol,
                bom: doc.bom,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn preserves_bom_crlf_and_final_newline_and_returns_new_revision() {
        let f = Fixture::new(b"\xef\xbb\xbfprint(1)\r\n");
        let doc = read(f.dir(), "main.py").unwrap();
        assert_eq!(doc.content, "print(1)\n");
        let saved = write(f.request("print('中文')\n")).unwrap();
        assert_eq!(
            fs::read(f.0.join("main.py")).unwrap(),
            "\u{feff}print('中文')\r\n".as_bytes()
        );
        assert_ne!(saved.revision, doc.revision);
        assert_eq!(saved.revision, read(f.dir(), "main.py").unwrap().revision);
        write(f.request("")).unwrap();
        assert_eq!(fs::read(f.0.join("main.py")).unwrap(), b"\xef\xbb\xbf");
        assert_eq!(fs::read_dir(&f.0).unwrap().count(), 1);
    }

    #[test]
    fn conflict_and_deletion_preserve_external_changes() {
        let f = Fixture::new(b"original");
        let request = f.request("mine");
        fs::write(f.0.join("main.py"), b"external").unwrap();
        assert_eq!(write(request).unwrap_err().code, "conflict");
        assert_eq!(fs::read(f.0.join("main.py")).unwrap(), b"external");
        let request = f.request("mine");
        fs::remove_file(f.0.join("main.py")).unwrap();
        assert_eq!(write(request).unwrap_err().code, "not_found");
        assert!(!f.0.join("main.py").exists());
    }

    #[test]
    fn rejects_invalid_paths_encodings_and_sizes() {
        let f = Fixture::new(b"ok");
        for name in [
            "../main.py",
            "/main.py",
            "C:/main.py",
            "main.py:stream",
            "a\\b",
            "",
            "main.py\0",
        ] {
            assert_eq!(read(f.dir(), name).unwrap_err().code, "path");
        }
        for data in [b"a\0b".as_slice(), b"\xff", b"a\r\nb\nc", b"a\rb"] {
            fs::write(f.0.join("main.py"), data).unwrap();
            assert!(read(f.dir(), "main.py").is_err());
        }
        fs::write(f.0.join("main.py"), vec![b'a'; FILE_LIMIT]).unwrap();
        assert!(read(f.dir(), "main.py").is_ok());
        let request = f.request(&"b".repeat(FILE_LIMIT + 1));
        assert_eq!(write(request).unwrap_err().code, "too_large");
        let mut request = f.request(&"\n".repeat(FILE_LIMIT / 2 + 1));
        request.eol = Eol::Crlf;
        assert_eq!(write(request).unwrap_err().code, "too_large");
        fs::write(f.0.join("main.py"), vec![b'a'; FILE_LIMIT + 1]).unwrap();
        assert_eq!(read(f.dir(), "main.py").unwrap_err().code, "too_large");
    }

    #[test]
    fn replacement_failure_keeps_original() {
        let f = Fixture::new(b"original");
        assert!(replace(&f.0.join("missing"), &f.0.join("main.py")).is_err());
        assert_eq!(fs::read(f.0.join("main.py")).unwrap(), b"original");
    }

    #[cfg(windows)]
    #[test]
    fn sharing_violation_during_replace_preserves_original_and_cleans_temp() {
        use std::os::windows::fs::OpenOptionsExt;
        let f = Fixture::new(b"original");
        let request = f.request("new content");
        // Permit reading/writing, but keep FILE_SHARE_DELETE off so replacement fails.
        let held = OpenOptions::new()
            .read(true)
            .share_mode(3)
            .open(f.0.join("main.py"))
            .unwrap();
        assert!(write(request).is_err());
        drop(held);
        assert_eq!(fs::read(f.0.join("main.py")).unwrap(), b"original");
        assert_eq!(fs::read_dir(&f.0).unwrap().count(), 1);
    }

    #[test]
    fn readonly_file_is_not_replaced() {
        let f = Fixture::new(b"original");
        let path = f.0.join("main.py");
        let request = f.request("new content");
        let original_permissions = fs::metadata(&path).unwrap().permissions();
        let mut permissions = original_permissions.clone();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();
        let result = write(request);
        fs::set_permissions(&path, original_permissions).unwrap();
        assert_eq!(result.unwrap_err().code, "permission");
        assert_eq!(fs::read(path).unwrap(), b"original");
    }

    #[cfg(windows)]
    #[test]
    fn windows_symbolic_links_are_rejected_when_creation_is_permitted() {
        let f = Fixture::new(b"original");
        match std::os::windows::fs::symlink_file(f.0.join("main.py"), f.0.join("link.py")) {
            Ok(()) => assert_eq!(read(f.dir(), "link.py").unwrap_err().code, "path"),
            Err(error) if error.raw_os_error() == Some(1314) => {
                eprintln!(
                    "SKIP Windows symlink check: this account lacks symlink creation privilege"
                );
            }
            Err(error) => panic!("cannot create test symlink: {error}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_links_and_preserves_executable_permission() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let f = Fixture::new(b"echo hi\n");
        symlink(f.0.join("main.py"), f.0.join("link.py")).unwrap();
        assert_eq!(read(f.dir(), "link.py").unwrap_err().code, "path");
        fs::set_permissions(f.0.join("main.py"), fs::Permissions::from_mode(0o755)).unwrap();
        write(f.request("echo bye\n")).unwrap();
        assert_eq!(
            fs::metadata(f.0.join("main.py"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
    }
}
