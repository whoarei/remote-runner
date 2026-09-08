//! Framing uses RS/US and a per-command nonce. Shell prompts and echoed command text
//! cannot match markers because commands contain printf escapes, not literal RS/US.
use crate::error::{Result, RunnerError};
use crate::runner::sh_quote;

pub struct FrameParser {
    begin: Vec<u8>,
    end: Vec<u8>,
    buffer: Vec<u8>,
    pub started: bool,
    pub code: Option<u32>,
}

impl FrameParser {
    pub fn new(nonce: &str) -> Self {
        Self {
            begin: format!("\x1eRR_{nonce}_B\x1f").into_bytes(),
            end: format!("\x1eRR_{nonce}_E:").into_bytes(),
            buffer: Vec::new(),
            started: false,
            code: None,
        }
    }

    pub fn push(&mut self, data: &[u8]) -> Result<Vec<u8>> {
        if self.code.is_some() {
            return Ok(Vec::new());
        }
        self.buffer.extend_from_slice(data);
        if !self.started {
            if let Some(pos) = find(&self.buffer, &self.begin) {
                self.buffer.drain(..pos + self.begin.len());
                self.started = true;
            } else {
                retain_prefix(&mut self.buffer, &self.begin);
                return Ok(Vec::new());
            }
        }
        if let Some(pos) = find(&self.buffer, &self.end) {
            let output = self.buffer.drain(..pos).collect();
            if let Some(end) = self.buffer[self.end.len()..]
                .iter()
                .position(|b| *b == 0x1f)
            {
                let digits = &self.buffer[self.end.len()..self.end.len() + end];
                self.code = std::str::from_utf8(digits)
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .filter(|n| *n <= 255);
                if self.code.is_none() {
                    return Err(RunnerError::Serial("invalid exit marker".into()));
                }
                self.buffer.clear();
            } else if self.buffer.len() > self.end.len() + 3 {
                return Err(RunnerError::Serial("invalid exit marker".into()));
            }
            Ok(output)
        } else {
            let keep = suffix_prefix_len(&self.buffer, &self.end);
            Ok(self.buffer.drain(..self.buffer.len() - keep).collect())
        }
    }
}

fn find(data: &[u8], needle: &[u8]) -> Option<usize> {
    data.windows(needle.len()).position(|w| w == needle)
}
fn suffix_prefix_len(data: &[u8], needle: &[u8]) -> usize {
    (1..=data.len().min(needle.len()))
        .rev()
        .find(|n| data.ends_with(&needle[..*n]))
        .unwrap_or(0)
}
fn retain_prefix(data: &mut Vec<u8>, needle: &[u8]) {
    let keep = suffix_prefix_len(data, needle);
    data.drain(..data.len() - keep);
}

pub fn wrap(command: &str, nonce: &str, dimensions: Option<(u32, u32)>) -> String {
    let tty = dimensions.map(|(cols, rows)| format!(
        "__rr_tty=$(stty -g) || {{ __rr_begin; exit 125; }}; stty echo icanon isig icrnl -inlcr -igncr -ixon -ixoff intr '^C' rows {rows} cols {cols} || {{ __rr_begin; exit 125; }}; "
    )).unwrap_or_default();
    // Keep the wrapper alive long enough to restore termios and emit the end marker.
    // The child explicitly resets these traps so Ctrl-C reaches the actual command even
    // on shells that inherit trapped signal dispositions into a nested `sh -c`.
    let cleanup = format!("__rr_rc=$?; if [ -n \"$__rr_tty\" ]; then stty \"$__rr_tty\"; fi; printf '\\036RR_%s_E:%s\\037' {nonce} \"$__rr_rc\"");
    let body = format!(
        "__rr_tty=; trap ':' INT QUIT; trap {} EXIT; __rr_begin() {{ printf '\\036RR_%s_B\\037' {nonce}; }}; {tty}__rr_begin; sh -c {}; exit $?",
        sh_quote(&cleanup),
        sh_quote(&format!("trap - INT QUIT; {command}"))
    );
    format!("sh -c {}\n", sh_quote(&body))
}

pub fn validate_wire_command(command: &str) -> Result<()> {
    if command.len() > 16 * 1024 {
        return Err(RunnerError::InvalidInput(
            "serial shell wrapper exceeds 16 KiB; put long commands in an uploaded script file"
                .into(),
        ));
    }
    if command.bytes().any(|b| (b < 32 && b != b'\n') || b == 127) {
        return Err(RunnerError::InvalidInput("serial shell command contains terminal control characters; put such content in an uploaded script file".into()));
    }
    if command.split('\n').any(|line| line.len() > 2048) {
        return Err(RunnerError::InvalidInput("serial shell command line exceeds 2048 bytes; use a script file for long commands or arguments".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn framing_preserves_binary_data_for_every_split_and_hides_echo_and_prompts() {
        let input = b"root# echoed printf '\\036RR_%s_B\\037' test\r\n\x1eRR_test_B\x1f\xffhello\r\n\x1eRR_test_E:7\x1froot# ";
        for split in 0..=input.len() {
            let mut parser = FrameParser::new("test");
            let mut output = parser.push(&input[..split]).unwrap();
            output.extend(parser.push(&input[split..]).unwrap());
            assert_eq!(output, b"\xffhello\r\n", "split={split}");
            assert_eq!(parser.code, Some(7));
        }
    }
    #[test]
    fn partial_markers_wrong_nonces_and_no_final_newline() {
        let mut parser = FrameParser::new("test");
        let mut output = Vec::new();
        for byte in b"\x1eRR_test_B\x1fabc\x1eRR_other_E:0\x1f\x1eRR_test_E:130\x1f" {
            output.extend(parser.push(&[*byte]).unwrap());
        }
        assert_eq!(output, b"abc\x1eRR_other_E:0\x1f");
        assert_eq!(parser.code, Some(130));
    }
    #[test]
    fn echoed_wrapper_never_contains_actual_markers() {
        let command = wrap("printf '%s' 'a b'", "test", Some((80, 24)));
        let mut parser = FrameParser::new("test");
        assert!(parser.push(command.as_bytes()).unwrap().is_empty());
        assert!(!parser.started);
    }
}
