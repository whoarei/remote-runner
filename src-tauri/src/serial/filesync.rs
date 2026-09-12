use crate::error::Result;
use crate::runner::sh_quote;
use base64::Engine;

use std::path::Path;

#[cfg(test)]
const FILE_LIMIT: u64 = crate::workspace_upload::SERIAL.file_limit;

// Each chunk is acknowledged before sending the next. Never put an entire file
// into one `sh -c` argument (Linux also limits the size of each individual argv).
const UPLOAD_CHUNK: usize = 3 * 1024;

#[derive(Debug)]
pub struct TextFile {
    pub relative: String,
    pub data: Vec<u8>,
}

#[derive(Debug)]
pub enum UploadEntry {
    Directory(String),
    File(TextFile),
}

impl UploadEntry {
    pub fn path(&self) -> &str {
        match self {
            Self::Directory(path) => path,
            Self::File(file) => &file.relative,
        }
    }
    pub fn commands<'a>(&'a self, remote: &'a str) -> Box<dyn Iterator<Item = String> + Send + 'a> {
        match self {
            Self::Directory(path) => Box::new(std::iter::once(format!(
                "mkdir -p {}",
                sh_quote(&format!("{remote}/{path}"))
            ))),
            Self::File(file) => Box::new(upload_commands(file, remote)),
        }
    }
}

/// Preflight before touching the serial device: V1 supports UTF-8 text workspaces only.
pub fn collect(local: &Path) -> Result<Vec<UploadEntry>> {
    Ok(
        crate::workspace_upload::collect(local, crate::workspace_upload::SERIAL)?
            .into_iter()
            .map(|entry| match entry.data {
                Some(data) => UploadEntry::File(TextFile {
                    relative: entry.path,
                    data,
                }),
                None => UploadEntry::Directory(entry.path),
            })
            .collect(),
    )
}

pub fn upload_commands<'a>(
    file: &'a TextFile,
    remote: &'a str,
) -> impl Iterator<Item = String> + 'a {
    // One empty chunk creates/truncates an empty file too.
    (0..file.data.len().div_ceil(UPLOAD_CHUNK).max(1)).map(move |index| {
        let start = index * UPLOAD_CHUNK;
        upload_chunk(
            &file.relative,
            &file.data[start..file.data.len().min(start + UPLOAD_CHUNK)],
            remote,
            index == 0,
        )
    })
}

fn upload_chunk(relative: &str, data: &[u8], remote: &str, first: bool) -> String {
    let path = format!("{}/{}", remote.trim_end_matches('/'), relative);
    let parent = path.rsplit_once('/').unwrap().0;
    // Base64 in a quoted heredoc preserves text without a final newline and cannot
    // execute substitutions from the file. Short lines stay below canonical TTY limits.
    let encoded = base64::engine::general_purpose::STANDARD.encode(data);
    let body = encoded
        .as_bytes()
        .chunks(76)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    let redirect = if first { ">" } else { ">>" };
    format!(
        "mkdir -p {} && base64 -d {redirect} {} <<'RR_UPLOAD_EOF'\n{body}\nRR_UPLOAD_EOF\n",
        sh_quote(parent),
        sh_quote(&path)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preflight_normalizes_text_and_rejects_binary_and_large_files() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/test.py"), "print('hello')\r\n").unwrap();
        let files = collect(&root).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path(), "sub");
        let UploadEntry::File(file) = &files[1] else {
            panic!("expected file");
        };
        assert_eq!(file.relative, "sub/test.py");
        assert_eq!(file.data, b"print('hello')\n");
        std::fs::write(root.join("binary.bin"), [0, 1, 2]).unwrap();
        assert!(collect(&root)
            .unwrap_err()
            .to_string()
            .contains("UTF-8 text"));
        std::fs::remove_file(root.join("binary.bin")).unwrap();
        std::fs::File::create(root.join("large.txt"))
            .unwrap()
            .set_len(FILE_LIMIT + 1)
            .unwrap();
        assert!(collect(&root).unwrap_err().to_string().contains("1 MiB"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn upload_payload_is_literal_and_preserves_no_final_newline() {
        let file = TextFile {
            relative: "a'b.py".into(),
            data: b"$(touch SHOULD_NOT_EXIST)\nRR_UPLOAD_EOF".to_vec(),
        };
        let command = upload_commands(&file, "/tmp/work space").next().unwrap();
        let encoded = command
            .split("<<'RR_UPLOAD_EOF'\n")
            .nth(1)
            .unwrap()
            .split("\nRR_UPLOAD_EOF")
            .next()
            .unwrap()
            .replace('\n', "");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap(),
            file.data
        );
        assert!(!command.contains("$(touch"));
    }
}
