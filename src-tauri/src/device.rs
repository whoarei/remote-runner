use crate::error::{Result, RunnerError};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransportKind {
    #[default]
    Ssh,
    Serial,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_ssh_profiles_remain_compatible_and_serial_defaults_are_validated() {
        let ssh: DeviceProfile = serde_json::from_value(serde_json::json!({
            "id": "old", "name": "old board", "host": "localhost", "username": "root"
        }))
        .unwrap();
        assert_eq!(ssh.transport, TransportKind::Ssh);
        assert!(ssh.serial.is_none());
        ssh.validate().unwrap();
        let mut serial: DeviceProfile = serde_json::from_value(serde_json::json!({
            "id": "serial", "name": "uart", "transport": "serial", "serial": { "port": "COM8" }
        }))
        .unwrap();
        assert_eq!(serial.serial.as_ref().unwrap().baud_rate, 115200);
        serial.validate().unwrap();
        serial.serial.as_mut().unwrap().baud_rate = 0;
        assert!(serial.validate().is_err());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialConfig {
    pub port: String,
    #[serde(default = "default_baud_rate")]
    pub baud_rate: u32,
}

fn default_baud_rate() -> u32 {
    115_200
}

/// SSH 认证方式
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthMethod {
    /// 使用密码（V1 直接明文保存在本地配置，见安全设计 TODO）
    Password { password: String },
    /// 使用指定私钥文件；key_path 为空时依次尝试 ~/.ssh/id_ed25519、id_rsa
    Key { key_path: Option<String> },
}

impl Default for AuthMethod {
    fn default() -> Self {
        AuthMethod::Key { key_path: None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub transport: TransportKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial: Option<SerialConfig>,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub auth: AuthMethod,
    /// 远程 workspace 根目录
    #[serde(default = "default_workspace_root")]
    pub workspace_root: String,
}

fn default_port() -> u16 {
    22
}

fn default_workspace_root() -> String {
    "/tmp/devrunner/workspaces".to_string()
}

impl DeviceProfile {
    pub fn validate(&self) -> Result<()> {
        let invalid = |text: &str| RunnerError::InvalidInput(text.into());
        if self.name.trim().is_empty() {
            return Err(invalid("device name is required"));
        }
        if !self.workspace_root.starts_with('/')
            || self.workspace_root.contains(['\0', '\r', '\n'])
            || self
                .workspace_root
                .split('/')
                .any(|p| p == ".." || p == ".")
        {
            return Err(invalid(
                "workspace root must be an absolute Linux path without dot components",
            ));
        }
        match self.transport {
            TransportKind::Ssh => {
                if self.host.trim().is_empty() || self.username.trim().is_empty() || self.port == 0
                {
                    return Err(invalid("SSH host, username and port are required"));
                }
            }
            TransportKind::Serial => {
                let serial = self
                    .serial
                    .as_ref()
                    .ok_or_else(|| invalid("serial configuration is required"))?;
                if serial.port.trim().is_empty()
                    || serial.port.contains(['\0', '\r', '\n'])
                    || serial.baud_rate == 0
                    || serial.baud_rate > 4_000_000
                {
                    return Err(invalid(
                        "serial port and baud rate (1–4000000) are required",
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

/// 设备配置持久化存储（JSON 文件）
pub struct DeviceStore {
    path: PathBuf,
}

impl DeviceStore {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            path: config_dir.join("devices.json"),
        }
    }

    pub fn list(&self) -> Result<Vec<DeviceProfile>> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let data = std::fs::read_to_string(&self.path)?;
        let devices: Vec<DeviceProfile> =
            serde_json::from_str(&data).map_err(|e| RunnerError::InvalidInput(e.to_string()))?;
        Ok(devices)
    }

    pub fn get(&self, id: &str) -> Result<DeviceProfile> {
        self.list()?
            .into_iter()
            .find(|d| d.id == id)
            .ok_or_else(|| RunnerError::DeviceNotFound(id.to_string()))
    }

    pub fn save(&self, mut device: DeviceProfile) -> Result<DeviceProfile> {
        device.validate()?;
        let mut devices = self.list()?;
        if device.id.is_empty() {
            device.id = uuid::Uuid::new_v4().to_string();
        }
        match devices.iter_mut().find(|d| d.id == device.id) {
            Some(existing) => *existing = device.clone(),
            None => devices.push(device.clone()),
        }
        self.write_all(&devices)?;
        Ok(device)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let mut devices = self.list()?;
        devices.retain(|d| d.id != id);
        self.write_all(&devices)
    }

    fn write_all(&self, devices: &[DeviceProfile]) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_string_pretty(devices)
            .map_err(|e| RunnerError::InvalidInput(e.to_string()))?;
        std::fs::write(&self.path, data)?;
        Ok(())
    }
}
