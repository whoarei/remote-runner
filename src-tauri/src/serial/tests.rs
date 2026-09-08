use crate::process::SessionControl;
use crate::runner::RunRequest;
use crate::serial::{
    self,
    session::{ShellSession, StopReason},
};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::sync::mpsc;

fn local_shell() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    let path = std::path::PathBuf::from("C:/Program Files/Git/bin/bash.exe");
    #[cfg(not(windows))]
    let path = std::path::PathBuf::from("/bin/sh");
    path.is_file().then_some(path)
}

#[test]
fn real_local_shell_validates_wrapper_quoting_and_exit_trap() {
    let Some(shell) = local_shell() else {
        eprintln!("local POSIX shell unavailable; skipping shell smoke test");
        return;
    };
    let command = serial::protocol::wrap(
        r#"printf '%s' "quote ' and literal \$()"; exit 7"#,
        "test",
        None,
    );
    let result = std::process::Command::new(shell)
        .arg("-c")
        .arg(command)
        .output()
        .unwrap();
    let mut parser = serial::protocol::FrameParser::new("test");
    let output = parser.push(&result.stdout).unwrap();
    assert_eq!(
        parser.code,
        Some(7),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(output, b"quote ' and literal $()");
}

#[test]
fn real_local_shell_delivers_interrupt_to_the_wrapped_command() {
    let Some(shell) = local_shell() else {
        eprintln!("local POSIX shell unavailable; skipping signal smoke test");
        return;
    };
    let command = serial::protocol::wrap("kill -INT $$", "signal", None);
    let result = std::process::Command::new(shell)
        .arg("-c")
        .arg(command)
        .output()
        .unwrap();
    let mut parser = serial::protocol::FrameParser::new("signal");
    assert!(parser.push(&result.stdout).unwrap().is_empty());
    assert_eq!(
        parser.code,
        Some(130),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn real_local_shell_upload_does_not_evaluate_file_content() {
    let Some(shell) = local_shell() else {
        eprintln!("local POSIX shell unavailable; skipping upload smoke test");
        return;
    };
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&root).unwrap();
    let file = serial::filesync::TextFile {
        relative: "a'b.py".into(),
        data: b"$(touch SHOULD_NOT_EXIST)\nRR_UPLOAD_EOF".to_vec(),
    };
    let command =
        serial::protocol::wrap(&serial::filesync::upload_command(&file, "."), "test", None);
    let result = std::process::Command::new(shell)
        .current_dir(&root)
        .arg("-c")
        .arg(command)
        .output()
        .unwrap();
    let mut parser = serial::protocol::FrameParser::new("test");
    assert!(parser.push(&result.stdout).unwrap().is_empty());
    assert_eq!(
        parser.code,
        Some(0),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(std::fs::read(root.join("a'b.py")).unwrap(), file.data);
    assert!(!root.join("SHOULD_NOT_EXIST").exists());
    std::fs::remove_dir_all(root).unwrap();
}

// Consume a full shell command, including quoted multiline upload bodies.
async fn read_command(stream: &mut DuplexStream) -> (String, String) {
    let mut command = Vec::new();
    let mut quoted = false;
    let mut escaped = false;
    loop {
        let byte = stream.read_u8().await.unwrap();
        command.push(byte);
        if escaped {
            escaped = false;
            continue;
        }
        if !quoted && byte == b'\\' {
            escaped = true;
            continue;
        }
        if byte == b'\'' {
            quoted = !quoted;
        }
        if byte == b'\n' && !quoted {
            break;
        }
    }
    let command = String::from_utf8(command).unwrap();
    let nonce = command
        .split(|c: char| !c.is_ascii_hexdigit())
        .find(|s| s.len() == 32)
        .unwrap()
        .to_string();
    (command, nonce)
}

async fn begin(stream: &mut DuplexStream, nonce: &str) {
    stream
        .write_all(format!("\x1eRR_{nonce}_B\x1f").as_bytes())
        .await
        .unwrap();
}
async fn end(stream: &mut DuplexStream, nonce: &str, code: u32) {
    stream
        .write_all(format!("\x1eRR_{nonce}_E:{code}\x1froot@board# ").as_bytes())
        .await
        .unwrap();
}

#[tokio::test]
async fn full_workspace_run_hides_setup_and_echo_and_preserves_exit_code() {
    let (client, mut device) = tokio::io::duplex(128);
    let fake = tokio::spawn(async move {
        for index in 0..4 {
            let (command, nonce) = read_command(&mut device).await;
            if index == 2 {
                assert!(command.contains("base64 -d"));
                assert!(command.contains("RR_UPLOAD_EOF"));
            }
            device.write_all(command.as_bytes()).await.unwrap(); // full shell echo
            begin(&mut device, &nonce).await;
            device
                .write_all(if index == 3 {
                    b"script output"
                } else {
                    b"internal output"
                })
                .await
                .unwrap();
            end(&mut device, &nonce, if index == 3 { 7 } else { 0 }).await;
        }
    });
    let request: RunRequest = serde_json::from_value(serde_json::json!({
        "device_id": "test", "kind": "python", "entry": "test.py", "workspace_dir": "."
    }))
    .unwrap();
    let (_tx, mut rx) = mpsc::unbounded_channel();
    let output = Mutex::new(Vec::new());
    let states = Mutex::new(Vec::new());
    let result = serial::execute(
        client,
        115200,
        &request,
        "/tmp/test",
        vec![serial::filesync::UploadEntry::File(
            serial::filesync::TextFile {
                relative: "test.py".into(),
                data: b"print('hello')\n".to_vec(),
            },
        )],
        &mut rx,
        |event| match event {
            serial::Event::Output(data) => output.lock().unwrap().extend(data),
            serial::Event::State(state) => states.lock().unwrap().push(state),
        },
    )
    .await
    .unwrap();
    fake.await.unwrap();
    assert_eq!(result.code, 7);
    assert_eq!(result.stopped, None);
    assert_eq!(*output.lock().unwrap(), b"script output");
    assert_eq!(
        *states.lock().unwrap(),
        vec!["syncing", "starting", "running"]
    );
}

#[tokio::test]
async fn interactive_input_reaches_process_without_shell_commands() {
    let (client, mut device) = tokio::io::duplex(128);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let fake = tokio::spawn(async move {
        let (_, nonce) = read_command(&mut device).await;
        begin(&mut device, &nonce).await;
        device.write_all(b"name? ").await.unwrap();
        let mut input = [0; 6];
        device.read_exact(&mut input).await.unwrap();
        assert_eq!(&input, b"world\n");
        device.write_all(b"hello world").await.unwrap();
        end(&mut device, &nonce, 0).await;
    });
    let mut output = Vec::new();
    let mut sent = false;
    let result = ShellSession::new(client, 115200)
        .execute(
            "python3 test.py",
            Some((80, 24)),
            None,
            &mut rx,
            |data| {
                output.extend(data);
                if !sent && output.ends_with(b"name? ") {
                    sent = true;
                    tx.send(SessionControl::Input(b"world\n".to_vec())).unwrap();
                }
            },
            |_| {},
        )
        .await
        .unwrap();
    assert_eq!(result.code, 0);
    assert_eq!(output, b"name? hello world");
    fake.await.unwrap();
}

#[tokio::test]
async fn input_arriving_with_the_start_marker_is_queued_until_the_process_is_ready() {
    let (client, mut device) = tokio::io::duplex(128);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let fake = tokio::spawn(async move {
        let (_, nonce) = read_command(&mut device).await;
        begin(&mut device, &nonce).await;
        let mut input = [0; 6];
        device.read_exact(&mut input).await.unwrap();
        assert_eq!(&input, b"early\n");
        end(&mut device, &nonce, 0).await;
    });
    tx.send(SessionControl::Input(b"early\n".to_vec())).unwrap();
    let result = ShellSession::new(client, 115200)
        .execute("cat", None, None, &mut rx, |_| {}, |_| {})
        .await
        .unwrap();
    assert_eq!(result.code, 0);
    fake.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn timeout_interrupts_and_requires_confirmed_exit() {
    let (client, mut device) = tokio::io::duplex(128);
    let fake = tokio::spawn(async move {
        let (_, nonce) = read_command(&mut device).await;
        begin(&mut device, &nonce).await;
        assert_eq!(device.read_u8().await.unwrap(), 3);
        end(&mut device, &nonce, 130).await;
    });
    let (_tx, mut rx) = mpsc::unbounded_channel();
    let result = ShellSession::new(client, 115200)
        .execute(
            "sleep 60",
            None,
            Some(Duration::from_secs(1)),
            &mut rx,
            |_| {},
            |_| {},
        )
        .await
        .unwrap();
    assert_eq!(result.stopped, Some(StopReason::Timeout));
    assert_eq!(result.code, 130);
    fake.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn unresponsive_process_is_not_reported_as_canceled() {
    let (client, mut device) = tokio::io::duplex(128);
    let fake = tokio::spawn(async move {
        let (_, nonce) = read_command(&mut device).await;
        begin(&mut device, &nonce).await;
        assert_eq!(device.read_u8().await.unwrap(), 3);
        std::future::pending::<()>().await;
    });
    let (_tx, mut rx) = mpsc::unbounded_channel();
    let error = ShellSession::new(client, 115200)
        .execute(
            "sleep 60",
            None,
            Some(Duration::from_secs(1)),
            &mut rx,
            |_| {},
            |_| {},
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("may still be running"));
    fake.abort();
}

#[tokio::test(start_paused = true)]
async fn login_prompt_is_not_mistaken_for_a_ready_shell() {
    let (client, mut device) = tokio::io::duplex(1024);
    let fake = tokio::spawn(async move {
        let (command, _) = read_command(&mut device).await;
        device.write_all(command.as_bytes()).await.unwrap();
        device.write_all(b"login: root# password: $").await.unwrap();
        std::future::pending::<()>().await;
    });
    let (_tx, mut rx) = mpsc::unbounded_channel();
    let error = ShellSession::new(client, 115200)
        .execute(
            "uname -a",
            None,
            None,
            &mut rx,
            |_| panic!("login prompt must be hidden"),
            |_| {},
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("already logged"));
    fake.abort();
}

#[tokio::test]
async fn disconnect_before_end_marker_fails() {
    let (client, mut device) = tokio::io::duplex(128);
    tokio::spawn(async move {
        let (_, nonce) = read_command(&mut device).await;
        begin(&mut device, &nonce).await;
    });
    let (_tx, mut rx) = mpsc::unbounded_channel();
    let error = ShellSession::new(client, 115200)
        .execute("true", None, None, &mut rx, |_| {}, |_| {})
        .await
        .unwrap_err();
    assert!(error.to_string().contains("disconnected"));
}

#[tokio::test]
async fn user_stop_is_forwarded_as_ctrl_c() {
    let (client, mut device) = tokio::io::duplex(128);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let seen = Arc::new(Mutex::new(false));
    let fake_seen = seen.clone();
    let fake = tokio::spawn(async move {
        let (_, nonce) = read_command(&mut device).await;
        begin(&mut device, &nonce).await;
        assert_eq!(device.read_u8().await.unwrap(), 3);
        *fake_seen.lock().unwrap() = true;
        end(&mut device, &nonce, 130).await;
    });
    let result = ShellSession::new(client, 115200)
        .execute(
            "sleep 60",
            None,
            None,
            &mut rx,
            |_| {},
            |state| {
                if state == "running" {
                    tx.send(SessionControl::Interrupt).unwrap();
                }
            },
        )
        .await
        .unwrap();
    assert_eq!(result.stopped, Some(StopReason::User));
    fake.await.unwrap();
    assert!(*seen.lock().unwrap());
}
