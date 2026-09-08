# 实施进度与关键实现方法记录

> 对应设计文档：`00001_20260908_embedded-linux-remote-script-runner-design.md`
> 本文档持续更新，记录每个实施阶段完成了什么、怎么实现的、踩过的坑。
> 2026-09-08 代码审查后的修复、验证和当前限制见 [代码审查记录](00003_20260908_code-review.md)。串口 Shell V1 的实现记录见 [串口实现记录](00004_20260908_serial-shell.md)。以下阶段 1 方法为首次实现时的记录。

---

## 阶段 1（2026-09-08）：SSH-only MVP

### 本阶段范围（相比完整设计的裁剪）

| 项 | 状态 |
|---|---|
| 通信方式 | **仅 SSH**（russh + russh-sftp），串口/Agent 未实现 |
| 脚本类型 | **Python（.py）、Shell（.sh）、普通命令**；Node.js 暂不实现 |
| 运行环境 | 仅 System Runtime（远端 `python3` / `bash`）；venv / Managed Runtime 预留接口未实现 |
| PTY / pipe | 均已实现，用户可选，默认 pty |
| Run Console | xterm.js，语义为"远程进程"而非"远程 Shell" |
| 编辑器 | 等宽 textarea 只读预览（Monaco 与写回保存为后续工作） |
| Artifact 下载 / Expect / 增量同步 | 未实现 |
| Run History | 已实现（内存 + `history.json` 持久化，上限 200 条） |

### 工程结构

```text
remote_runner/
├── package.json / vite.config.ts / index.html
├── src/                        # React + TS 前端
│   ├── api.ts                  # invoke/event 封装 + 类型定义
│   ├── store.ts                # zustand 全局状态（设备/工作区/run/输出缓冲）
│   ├── App.tsx
│   └── components/
│       ├── DeviceBar.tsx       # 设备选择 + 添加/编辑/测试连接（模态框）
│       ├── WorkspacePanel.tsx  # 本地工作区目录选择与文件列表
│       ├── Editor.tsx          # 脚本预览（只读 textarea）
│       ├── RunToolbar.tsx      # 脚本/命令模式、参数、pty/pipe、超时、Run/Stop
│       ├── RunConsole.tsx      # xterm.js 控制台（输入回传、Ctrl+C、resize）
│       └── HistoryPanel.tsx    # 运行历史
└── src-tauri/src/              # Rust 后端
    ├── lib.rs                  # Tauri 装配：AppState、RunEvent→"run-event" 事件转发
    ├── commands.rs             # Tauri commands（Runner API）
    ├── device.rs               # DeviceProfile + devices.json 持久化
    ├── runner.rs               # RunManager（状态机/停止升级/超时/历史）
    ├── ssh/
    │   ├── client.rs           # 连接、认证（agent/私钥/密码）、host key TOFU
    │   ├── session.rs          # ProcessSession：exec channel + PTY + 控制通道
    │   └── filesync.rs         # SFTP 递归上传 + CRLF→LF 规范化
    └── bin/rr_cli.rs           # 无 GUI 链路验证工具（见"验证记录"）
```

### 关键实现方法

#### 1. Runner API（Tauri commands）

```text
list_devices / save_device / delete_device / test_device
list_workspace / read_workspace_file        # 带路径逃逸防护
run_script(request) -> run_id               # 前端只拿到 run_id
stop_run / send_run_input / resize_run_console
get_run_status / list_running_runs / get_run_history
```

流式输出走 Tauri Event：`run-event`，两种负载：

```text
{ type: "output", run_id, stream: "stdout"|"stderr", data: <base64> }
{ type: "status", status: RunStatus }
```

#### 2. SSH 认证顺序（AuthMethod::Key）

1. **ssh-agent 优先**：Windows 连接 `\\.\pipe\openssh-ssh-agent`（`AgentClient::connect_named_pipe`），
   Unix 走 `SSH_AUTH_SOCK`；枚举 agent 身份逐一 `authenticate_publickey_with`。
2. 本地私钥文件：`~/.ssh/id_ed25519` → `id_rsa` → `id_ecdsa`（或用户指定路径）。
3. AuthMethod::Password：密码认证。

Host key 采用 **TOFU**（Trust On First Use）：首次连接记录 SHA256 指纹到
`known_hosts.json`，再次连接校验；不一致则拒绝连接（日志记录）。

#### 3. 一次 Run 的执行流程（execute_inner）

```text
SSH 连接 → SFTP 全量上传 workspace 到 /tmp/devrunner/workspaces/<run_id>/
→ 构造包装命令 → exec channel（可选 PTY）spawn
→ 事件循环：转发输出 + 捕获远程 PID + 处理 stop/timeout
→ 结束：exited / canceled / failed，写入历史
```

#### 4. 包装命令（最关键的实现细节）

最终下发到 exec channel 的命令形如：

```bash
__f=/tmp/.devrunner-wrap-$$.sh; echo <base64> | base64 -d > $__f; exec 3<&0; \
setsid sh $__f <&3 & __pid=$!; printf '__DEVRUNNER_PID_%s__\n' "$__pid"; \
wait $__pid; __rc=$?; rm -f $__f; exit $__rc
```

其中 base64 解码后的脚本体（以 python 为例）：

```bash
cd '/tmp/devrunner/workspaces/<run_id>' &&  exec python3 -u 'test.py' 'arg1'
```

设计要点与原因：

- **base64 编码脚本体**：彻底避免多层嵌套引号转义问题（用户命令里可能含任意引号/`$`）。
- **先写临时文件再执行**：不能用 `echo b64 | base64 -d | sh` 直接喂——管道会抢占脚本进程的
  stdin，导致交互式脚本拿到的是 base64 流而不是用户输入。
- **`exec 3<&0` + `<&3`**：POSIX 规定非交互 shell 的后台任务 stdin 默认重定向到 `/dev/null`，
  必须先保存 channel 的 stdin 到 fd 3，再显式喂给后台脚本进程。否则 PTY 模式下
  `sys.stdin.isatty()` 为 False、`input()` 直接 EOF。
- **`exec python3 ...`**（脚本体内部）：让 `sh` 原地替换为目标进程，捕获到的 PID 就是
  python 进程本身，kill 精确。
- **`printf '__DEVRUNNER_PID_...__'`**：把后台进程 PID 打印到输出流，后端从 stdout 开头
  解析并剥离该标记（用户不可见）。这是 stop/timeout 能可靠杀进程的基础。
- **`wait $__pid`**：把被 kill 的退出码（如 143 = 128+SIGTERM）原样传回 channel exit-status。

#### 5. Stop / Timeout 的分级 kill

**坑**：实测该设备（OpenSSH 8.4p1）对 **非 PTY channel 的 signal 请求完全忽略**，
且进程不死时客户端发的 channel close 也得不到响应（用 paramiko 交叉验证确认是服务端行为，
不是 russh 的 bug）。因此不能依赖 SSH signal 请求来停止远程进程。

实际方案：

```text
stop/timeout 触发
  → 阶段1：PTY 模式发 0x03 字节（SIGINT 广播到前台进程组）；pipe 模式发 signal 请求（尽力而为）
  → 3s 后：kill -TERM -- -<pid>（pipe 模式进程组原子 kill）或 pkill -TERM -P + kill -TERM（pty）
  → 2s 后：同上，SIGKILL；同时本地发 channel close 双保险
  → 3s 后：服务端仍不关闭 channel，则本地强制结束 run（不阻塞 GUI）
```

- **pipe 模式包装层带 `setsid`**：脚本独立成进程组，PGID = PID，`kill -- -<pid>` 整组原子杀死，
  避免"先杀子进程后 sh 继续执行下一条命令"的竞态（实测 `sleep` 被杀后 sh 会抢跑执行后续命令）。
- **pty 模式不带 `setsid`**：setsid 会让进程失去控制终端，导致 `input()`/isatty 失效。
  pty 下 Ctrl+C 字节本身就能 SIGINT 整个前台进程组，树 kill 只是兜底。

#### 6. SFTP 上传的 CRLF 规范化

Windows 上编辑的脚本是 CRLF 行尾，`bash` 遇到 `\r` 会报
`exit: 3：需要数字参数` 这类错误。上传时对文本类扩展名
（sh/bash/py/txt/cfg/ini/yaml/yml/json/toml/csv/md/env 及无扩展名文件）自动做 CRLF→LF。
Python 本身兼容 CRLF，但统一处理更安全。

#### 7. russh 在 Windows 的加密后端

russh 默认 `aws-lc-rs` 在 Windows 构建需要 NASM（环境没有）。改用 ring 后端：

```toml
russh = { version = "0.63", default-features = false, features = ["ring", "flate2", "rsa"] }
```

#### 8. Vite dev server 绑定地址

Tauri CLI 探测 `http://localhost:1420` 走 IPv4，而 vite 默认可能只监听 IPv6 `[::1]`，
导致 `tauri dev` 一直 "Waiting for your frontend dev server"。
vite.config.ts 中显式 `server.host = "127.0.0.1"`。

### 验证记录（测试设备 root@172.16.0.67，aarch64，OpenSSH 8.4p1，Python 3.9.2）

无 GUI 验证工具 `rr-cli`（`cargo run --bin rr-cli`）：

```text
rr-cli command "uname -a && python3 --version"   → 输出正确，exit=0
rr-cli python hello.py a1 b2                      → stdout/stderr 分离正确，argv 正确，exit=0
rr-cli shell hello.sh world                       → 参数正确，exit=3 原样透传
rr-cli interact-test  # PTY + input() 自检        → isatty=True，stdin 输入正常，exit=0
rr-cli stop-test      # sleep 60 中途 stop        → canceled，exit=143，进程组无残留
```

### 已知问题 / 待办

- [ ] 编辑器为只读，未实现保存写回本地文件；Monaco 未接入。
- [ ] 设备密码明文存于 devices.json（应迁移到 Windows Credential Manager）。
- [ ] 远程 workspace 运行后不清理（便于排查）；Artifact 下载未实现。
- [ ] command 模式下复合命令（`a; b`）stop 只能杀到包装 sh，孙进程可能残留
      （pipe 模式已由 setsid 进程组 kill 覆盖；pty 模式依赖 Ctrl+C 兜底）。
- [ ] 首次连接偶发一次 run 不结束（仅出现 1 次未复现，疑似 TOFU 写盘时序，待观察）。
- [x] 串口 Shell transport V1 已实现（端口枚举、8N1、marker 协议、文本工作区上传、stdin、停止与超时）；详见 `00004`。
- [ ] Serial Agent、Node.js、Python venv / Managed Runtime、Expect、增量同步（hash）均未实现。

### 运行方式

```powershell
npm install
npm run tauri dev    # 开发模式（自动重载）
npm run tauri build  # 打包
```

无 GUI 冒烟测试：`cd src-tauri; cargo run --bin rr-cli -- <command|python|shell|interact-test|stop-test> ...`
