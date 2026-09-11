use crate::error::{Result, RunnerError};
use crate::ssh::filesync::{is_text_script, normalize_lf};
use std::{io::Read, path::Path};

pub const FILE_LIMIT: u64 = 16 * 1024 * 1024;
pub const TOTAL_LIMIT: usize = 64 * 1024 * 1024;
pub const ENTRY_LIMIT: usize = 4096;

pub struct Entry {
    pub path: String,
    pub data: Option<Vec<u8>>,
    pub mode: u32,
}

/// Snapshot and validate the entire workspace before creating anything in WSL.
pub fn collect(local: &Path) -> Result<Vec<Entry>> {
    fn visit(root: &Path, dir: &Path, entries: &mut Vec<Entry>, total: &mut usize) -> Result<()> {
        let canonical = std::fs::canonicalize(dir)?;
        for item in std::fs::read_dir(dir)? {
            let item = item?;
            if matches!(item.file_name().to_str(), Some(".git" | ".hg" | ".svn")) {
                continue;
            }
            let path = item.path();
            let metadata = std::fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink()
                || (!metadata.is_file() && !metadata.is_dir())
                || std::fs::canonicalize(&path)?.parent() != Some(canonical.as_path())
            {
                return Err(RunnerError::InvalidInput(format!(
                    "WSL workspace contains a link, redirected path or special file: {}",
                    path.display()
                )));
            }
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_str()
                .ok_or_else(|| RunnerError::InvalidInput("WSL filename must be UTF-8".into()))?
                .to_string();
            #[cfg(windows)]
            let relative = relative.replace('\\', "/");
            if relative.len() > 1024
                || relative.chars().any(char::is_control)
                || entries.len() >= ENTRY_LIMIT
            {
                return Err(RunnerError::InvalidInput("WSL workspace exceeds 4096 entries or has an invalid filename (maximum 1024 bytes)".into()));
            }
            if metadata.is_dir() {
                entries.push(Entry {
                    path: relative,
                    data: None,
                    mode: 0o700,
                });
                visit(root, &path, entries, total)?;
            } else {
                if metadata.len() > FILE_LIMIT {
                    return Err(RunnerError::InvalidInput("WSL file exceeds 16 MiB".into()));
                }
                let mut data = Vec::new();
                std::fs::File::open(&path)?
                    .take(FILE_LIMIT + 1)
                    .read_to_end(&mut data)?;
                if data.len() as u64 > FILE_LIMIT {
                    return Err(RunnerError::InvalidInput("WSL file exceeds 16 MiB".into()));
                }
                *total += data.len();
                if *total > TOTAL_LIMIT {
                    return Err(RunnerError::InvalidInput(
                        "WSL workspace exceeds 64 MiB".into(),
                    ));
                }
                if is_text_script(&relative) {
                    data = normalize_lf(data);
                }
                #[cfg(unix)]
                let mode = {
                    use std::os::unix::fs::PermissionsExt;
                    metadata.permissions().mode() & 0o777
                };
                #[cfg(not(unix))]
                let mode = if relative.ends_with(".sh") {
                    0o700
                } else {
                    0o600
                };
                entries.push(Entry {
                    path: relative,
                    data: Some(data),
                    mode,
                });
            }
        }
        Ok(())
    }
    let root = std::fs::canonicalize(local)?;
    let mut entries = Vec::new();
    visit(&root, &root, &mut entries, &mut 0)?;
    Ok(entries)
}
