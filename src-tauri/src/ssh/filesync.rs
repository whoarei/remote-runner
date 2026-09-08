use crate::error::Result;
use crate::ssh::client::SshConnection;
use russh_sftp::client::SftpSession;
use std::path::Path;
use tokio::io::AsyncWriteExt;

pub async fn open_sftp(conn: &SshConnection) -> Result<SftpSession> {
    let channel = conn.handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let sftp = SftpSession::new(channel.into_stream()).await?;
    Ok(sftp)
}

async fn mkdir_p(sftp: &SftpSession, path: &str) -> Result<()> {
    // 逐级创建目录，忽略“已存在”错误
    let mut current = String::new();
    for part in path.split('/') {
        if part.is_empty() {
            if current.is_empty() {
                current.push('/');
            }
            continue;
        }
        if !current.ends_with('/') && !current.is_empty() {
            current.push('/');
        }
        current.push_str(part);
        let p = current.trim_end_matches('/');
        if p.is_empty() {
            continue;
        }
        let _ = sftp.create_dir(p).await;
    }
    Ok(())
}

/// 递归上传本地目录到远程目录（V1：全量同步）
pub async fn upload_dir(sftp: &SftpSession, local: &Path, remote: &str) -> Result<u64> {
    let mut count = 0u64;
    mkdir_p(sftp, remote).await?;
    upload_dir_inner(sftp, local, remote, &mut count).await?;
    Ok(count)
}

fn upload_dir_inner<'a>(
    sftp: &'a SftpSession,
    local: &'a Path,
    remote: &'a str,
    count: &'a mut u64,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(async move {
        let mut entries = std::fs::read_dir(local)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().to_string();
            let local_path = entry.path();
            let remote_path = format!("{}/{}", remote.trim_end_matches('/'), name);
            let meta = entry.metadata()?;
            if meta.is_dir() {
                mkdir_p(sftp, &remote_path).await?;
                upload_dir_inner(sftp, &local_path, &remote_path, count).await?;
            } else if meta.is_file() {
                let mut data = std::fs::read(&local_path)?;
                // Windows 编辑的文本脚本转 LF，避免 bash 因 \r 报错
                if is_text_script(&name) {
                    data = normalize_lf(data);
                }
                let mut file = sftp.create(&remote_path).await.map_err(|e| {
                    crate::error::RunnerError::Ssh(format!("sftp create {remote_path}: {e}"))
                })?;
                file.write_all(&data).await.map_err(|e| {
                    crate::error::RunnerError::Ssh(format!("sftp write {remote_path}: {e}"))
                })?;
                // 保留可执行位
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let mode = meta.permissions().mode();
                    let mut perms = russh_sftp::protocol::FileAttributes::default();
                    perms.set_permissions(mode);
                    let _ = sftp.set_metadata(&remote_path, perms).await;
                }
                *count += 1;
            }
        }
        Ok(())
    })
}

/// 判断是否为文本脚本（需要 CRLF→LF 规范化）
fn is_text_script(name: &str) -> bool {
    let lower = name.to_lowercase();
    match lower.rsplit('.').next() {
        Some(ext) => matches!(
            ext,
            "sh" | "bash" | "py" | "txt" | "cfg" | "ini" | "yaml" | "yml" | "json" | "toml"
                | "csv" | "md" | "env"
        ),
        None => true, // 无扩展名按文本处理
    }
}

fn normalize_lf(data: Vec<u8>) -> Vec<u8> {
    if !data.windows(2).any(|w| w == b"\r\n") {
        return data;
    }
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        if data[i] == b'\r' && i + 1 < data.len() && data[i + 1] == b'\n' {
            i += 1;
            continue;
        }
        out.push(data[i]);
        i += 1;
    }
    out
}
