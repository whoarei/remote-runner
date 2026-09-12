use crate::error::Result;
pub use crate::workspace_upload::Entry;
use std::path::Path;
pub const FILE_LIMIT: u64 = crate::workspace_upload::WSL.file_limit;
pub const TOTAL_LIMIT: usize = crate::workspace_upload::WSL.total_limit;
pub const ENTRY_LIMIT: usize = crate::workspace_upload::WSL.entry_limit;
pub fn collect(local: &Path) -> Result<Vec<Entry>> {
    crate::workspace_upload::collect(local, crate::workspace_upload::WSL)
}
