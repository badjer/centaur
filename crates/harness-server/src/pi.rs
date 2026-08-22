//! Pi coding agent harness — drives `pi --mode rpc` (JSON lines over stdio)
//! as a Centaur harness.
//!
//! Like hermes, Pi ships a long-lived process that owns the agent loop and a
//! durable session store, so this runtime mirrors the hermes shape: one
//! persistent child per sandbox, one `{"type":"prompt"}` per turn, events
//! pumped into the shared `CodexTurnNormalizer`:
//!
//! - `message_update` `text_delta`      → AgentTextDelta
//! - `message_update` `thinking_delta`  → ReasoningTextDelta
//! - `tool_execution_start`             → AssistantMessage(ToolUse)
//! - `tool_execution_end`               → ToolResults
//! - assistant `message_end`            → AssistantMessage(final text) + TokenUsage
//! - `error` / failed `response`        → Result(error)
//! - `agent_settled`                    → Result (terminal)
//!
//! Pi resolves its provider and model from `~/.pi/agent/models.json` (the
//! sandbox entrypoint composes it from `PI_MODELS_JSON`) plus the
//! `--provider`/`--model` flags, which this runtime fills from the blocks
//! command or the `PI_MODEL_PROVIDER`/`PI_MODEL` env vars. A mid-thread model
//! or reasoning change restarts the child with `--continue`, which resumes
//! the session from `--session-dir`; Centaur's `interrupt` maps to Pi's
//! `{"type":"abort"}` — the turn ends Interrupted while the session lives on.
//! Pi discovers AGENTS.md itself from the working directory, so no system
//! prompt is passed here.

use std::env;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command as ProcessCommand, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use codex_app_server_protocol::UserInput;
use serde_json::{Value, json};

use crate::server::{BlocksCommand, BlocksState, parse_blocks_line_with_state, write_blocks_error};
use crate::traits::{
    NormalizedContent, NormalizedEvent, NormalizedTokenUsage, NormalizedToolResult,
};
use crate::turn::{BridgeConfig, CodexTurnNormalizer};
use crate::util::write_value;
use crate::wire::notification_to_wire_value;
use crate::{HarnessServerError, Result};

/// How long an interrupted turn may take to deliver its terminal frame
/// before we stop draining and move on.
const INTERRUPT_DRAIN_TIMEOUT: Duration = Duration::from_secs(30);

/// Entry point for `harness-server pi`.
pub fn run_pi_blocks_server() -> Result<()> {
    let mut stdout = io::stdout().lock();
    let mut pi: Option<PiChild> = None;
    let (command_tx, command_rx) = mpsc::channel();
    let (interrupt_tx, interrupt_rx) = mpsc::channel();

    thread::spawn(move || {
        let stdin = io::stdin();
        let mut blocks_state = BlocksState::default();
        for raw in stdin.lock().lines() {
            let Ok(line) = raw else { break };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let sent = match parse_blocks_line_with_state(trimmed, &mut blocks_state) {
                Ok(BlocksCommand::Interrupt) => interrupt_tx.send(()).is_ok(),
                Ok(command) => command_tx.send(Ok(command)).is_ok(),
                Err(error) => command_tx.send(Err(error.to_string())).is_ok(),
            };
            if !sent {
                break;
            }
        }
    });

    let mut turn = 0u64;
    while let Ok(input) = command_rx.recv() {
        match input {
            Ok(BlocksCommand::User {
                input,
                client_user_message_id,
                model,
                provider,
                reasoning,
                trace_context: _,
            }) => {
                turn += 1;
                let result =
                    ensure_child(&mut pi, model, provider, reasoning).and_then(|child| {
                        run_pi_turn(
                            child,
                            &mut stdout,
                            input,
                            client_user_message_id,
                            turn,
                            &interrupt_rx,
                        )
                    });
                if let Err(error) = result {
                    eprintln!("Pi blocks turn failed: {error:#}");
                    write_blocks_error(&mut stdout, "pi", "turn", error.to_string())?;
                    // A dead child cannot serve the next turn; drop it so the
                    // next message restarts Pi and resumes the session via
                    // `--continue`.
                    if pi.as_mut().is_some_and(|child| !child.is_alive()) {
                        pi = None;
                    }
                }
            }
            Ok(BlocksCommand::Interrupt) => {
                eprintln!("Pi blocks interrupt ignored: no active turn runs");
            }
            Ok(BlocksCommand::AttachmentChunk) => {}
            Err(error) => {
                eprintln!("invalid Pi blocks input: {error}");
                write_blocks_error(&mut stdout, "pi", "input", error)?;
            }
        }
        // Drain interrupts that arrived between turns so a stale one cannot
        // instantly cancel the next turn.
        while interrupt_rx.try_recv().is_ok() {}
    }
    Ok(())
}

/// Start the child on first use, and restart it (resuming the session with
/// `--continue`) when the requested model or reasoning level changes. Pi's
/// RPC has `set_model`/`set_thinking_level`, but `set_model` only accepts
/// models already present in its catalog snapshot; a restart with explicit
/// flags behaves identically for cataloged and ad-hoc models.
fn ensure_child(
    pi: &mut Option<PiChild>,
    model: Option<String>,
    provider: Option<String>,
    reasoning: Option<String>,
) -> Result<&mut PiChild> {
    let model = normalized_override(model, "PI_MODEL");
    let provider = normalized_override(provider, "PI_MODEL_PROVIDER");
    let thinking = reasoning
        .and_then(|value| map_thinking_level(&value))
        .or_else(|| {
            env::var("PI_THINKING_LEVEL")
                .ok()
                .and_then(|value| map_thinking_level(&value))
        });

    let stale = pi.as_ref().is_some_and(|child| {
        child.model != model || child.provider != provider || child.thinking != thinking
    });
    if stale {
        *pi = None;
    }
    if pi.is_none() {
        let resume = resume_marker_path().is_some_and(|marker| marker.exists());
        *pi = Some(PiChild::start(model, provider, thinking, resume)?);
        if let Some(marker) = resume_marker_path() {
            let _ = std::fs::write(marker, b"1");
        }
    }
    Ok(pi.as_mut().expect("pi started"))
}

fn normalized_override(value: Option<String>, env_key: &str) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            env::var(env_key)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
}

/// Centaur reasoning efforts map onto Pi's `--thinking` levels; Pi has no
/// `none` (its equivalent is `off`). Unknown values are dropped rather than
/// passed through so a typo cannot kill the child at spawn.
fn map_thinking_level(value: &str) -> Option<String> {
    let level = value.trim().to_lowercase();
    match level.as_str() {
        "none" | "off" => Some("off".to_string()),
        "minimal" | "low" | "medium" | "high" | "xhigh" | "max" => Some(level),
        _ => None,
    }
}

/// Session continuity across child restarts: the first child in a sandbox
/// starts fresh; every later one resumes the most recent session in the
/// session dir with `--continue`. The marker lives next to the sessions so
/// both disappear together when sandbox state does.
fn resume_marker_path() -> Option<PathBuf> {
    session_dir().map(|dir| dir.join(".centaur-pi-started"))
}

fn session_dir() -> Option<PathBuf> {
    if let Ok(dir) = env::var("PI_SESSION_DIR") {
        let dir = dir.trim();
        if !dir.is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    env::var("CENTAUR_STATE_DIR")
        .ok()
        .map(|state| PathBuf::from(state).join("pi"))
}

struct PiChild {
    child: Child,
    stdin: ChildStdin,
    stdout: Receiver<io::Result<String>>,
    model: Option<String>,
    provider: Option<String>,
    thinking: Option<String>,
}

impl Drop for PiChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl PiChild {
    fn start(
        model: Option<String>,
        provider: Option<String>,
        thinking: Option<String>,
        resume: bool,
    ) -> Result<Self> {
        let bin = env::var("PI_BIN").unwrap_or_else(|_| "pi".to_string());
        let mut command = ProcessCommand::new(&bin);
        // Themes and prompt templates are interactive-UI concerns; skills,
        // extensions, and AGENTS.md discovery stay on so deployments can ship
        // them through the workspace.
        command.args(["--mode", "rpc", "--no-themes", "--no-prompt-templates"]);
        if let Some(provider) = provider.as_deref() {
            command.args(["--provider", provider]);
        }
        if let Some(model) = model.as_deref() {
            command.args(["--model", model]);
        }
        if let Some(thinking) = thinking.as_deref() {
            command.args(["--thinking", thinking]);
        }
        if let Some(dir) = session_dir() {
            let _ = std::fs::create_dir_all(&dir);
            command.args(["--session-dir".as_ref(), dir.as_os_str()]);
        }
        if resume {
            command.arg("--continue");
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|source| HarnessServerError::SpawnHarness {
                cwd: env::current_dir().unwrap_or_default(),
                source,
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or(HarnessServerError::HarnessStdinUnavailable)?;
        let stdout = child
            .stdout
            .take()
            .ok_or(HarnessServerError::HarnessStdoutUnavailable)?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or(HarnessServerError::HarnessStderrUnavailable)?;
        thread::spawn(move || {
            // Unlocked handle on purpose: the child lives across turns, so
            // holding the StderrLock for the copy's lifetime would block
            // every eprintln! in the server until the child exits.
            let mut parent_stderr = io::stderr();
            let _ = io::copy(&mut stderr, &mut parent_stderr);
        });
        let (stdout_tx, stdout_rx) = mpsc::channel();
        thread::spawn(move || {
            let reader = io::BufReader::new(stdout);
            for raw in reader.lines() {
                let should_stop = raw.is_err();
                if stdout_tx.send(raw).is_err() || should_stop {
                    break;
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            stdout: stdout_rx,
            model,
            provider,
            thinking,
        })
    }

    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn write_command(&mut self, value: &Value) -> Result<()> {
        serde_json::to_writer(&mut self.stdin, value)?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()?;
        Ok(())
    }
}

/// Per-turn normalization state: Pi streams several assistant messages per
/// turn (one per model round), and delta/final reconciliation in the
/// normalizer requires each message's deltas and completed text to share an
/// item id.
#[derive(Default)]
struct PiTurnState {
    assistant_messages: u64,
}

impl PiTurnState {
    fn message_item_id(&self, turn: u64) -> String {
        format!("pi-msg-{turn}-{}", self.assistant_messages)
    }

    fn thinking_item_id(&self, turn: u64) -> String {
        format!("pi-thinking-{turn}-{}", self.assistant_messages)
    }
}

/// Translate one Pi RPC frame into normalized events. `agent_settled` is the
/// terminal frame (steered/follow-up prompts keep the run alive until it
/// fires); a failed turn's error arrives as an `error` event or a failed
/// `response`, which the normalizer latches for `finish_turn`.
fn normalize_pi_frame(turn: u64, state: &mut PiTurnState, frame: &Value) -> Vec<NormalizedEvent> {
    let kind = frame.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "message_start" => {
            if frame.pointer("/message/role").and_then(Value::as_str) == Some("assistant") {
                state.assistant_messages += 1;
            }
            Vec::new()
        }
        "message_update" => {
            let event = frame.get("assistantMessageEvent").unwrap_or(&Value::Null);
            let delta = event.get("delta").and_then(Value::as_str).unwrap_or("");
            if delta.is_empty() {
                return Vec::new();
            }
            match event.get("type").and_then(Value::as_str) {
                Some("text_delta") => vec![NormalizedEvent::AgentTextDelta {
                    item_id: state.message_item_id(turn),
                    delta: delta.to_string(),
                }],
                Some("thinking_delta") => vec![NormalizedEvent::ReasoningTextDelta {
                    item_id: state.thinking_item_id(turn),
                    delta: delta.to_string(),
                }],
                _ => Vec::new(),
            }
        }
        "message_end" => {
            let message = frame.get("message").unwrap_or(&Value::Null);
            if message.get("role").and_then(Value::as_str) != Some("assistant") {
                return Vec::new();
            }
            let mut events = Vec::new();
            if let Some(usage) = normalize_usage(message) {
                events.push(NormalizedEvent::TokenUsage { usage });
            }
            let text = message
                .get("content")
                .and_then(Value::as_array)
                .map(|parts| {
                    parts
                        .iter()
                        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|part| part.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            if !text.is_empty() {
                let stop_reason = (message.get("stopReason").and_then(Value::as_str)
                    == Some("stop"))
                .then(|| "end_turn".to_string());
                // The final text repeats the streamed deltas; the normalizer's
                // suffix-delta reconciliation prevents double emission.
                events.push(NormalizedEvent::AssistantMessage {
                    partial: false,
                    stop_reason,
                    content: vec![NormalizedContent::AgentText {
                        item_id: state.message_item_id(turn),
                        text,
                    }],
                });
            }
            events
        }
        "tool_execution_start" => vec![NormalizedEvent::AssistantMessage {
            partial: false,
            stop_reason: None,
            content: vec![NormalizedContent::ToolUse {
                raw_id: string_or(frame.get("toolCallId"), "tool"),
                tool: string_or(frame.get("toolName"), "tool"),
                arguments: frame.get("args").cloned().unwrap_or(json!({})),
            }],
        }],
        "tool_execution_end" => vec![NormalizedEvent::ToolResults(vec![NormalizedToolResult {
            tool_use_id: string_or(frame.get("toolCallId"), "tool"),
            content: tool_result_text(frame.get("result")),
            is_error: frame.get("isError").and_then(Value::as_bool).unwrap_or(false),
            exit_code: None,
        }])],
        "error" => vec![NormalizedEvent::Result {
            error: Some(string_or(frame.get("message"), "pi turn failed")),
        }],
        "response" => {
            if frame.get("success").and_then(Value::as_bool) == Some(false) {
                let command = string_or(frame.get("command"), "command");
                let error = string_or(frame.get("error"), "request failed");
                vec![NormalizedEvent::Result {
                    error: Some(format!("pi {command} failed: {error}")),
                }]
            } else {
                Vec::new()
            }
        }
        "agent_settled" => vec![NormalizedEvent::Result { error: None }],
        _ => Vec::new(),
    }
}

fn string_or(value: Option<&Value>, fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

/// Pi tool results carry MCP-shaped content: `{content: [{type: "text",
/// text}]}`. Other shapes are stringified rather than dropped.
fn tool_result_text(result: Option<&Value>) -> String {
    let Some(result) = result else {
        return String::new();
    };
    if let Some(parts) = result.get("content").and_then(Value::as_array) {
        let text = parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("");
        if !text.is_empty() {
            return text;
        }
    }
    match result {
        Value::String(text) => text.clone(),
        value if !value.is_null() => serde_json::to_string(value).unwrap_or_default(),
        _ => String::new(),
    }
}

fn normalize_usage(message: &Value) -> Option<NormalizedTokenUsage> {
    let usage = message.get("usage")?;
    let count = |key: &str| usage.get(key).and_then(Value::as_i64);
    let usage = NormalizedTokenUsage {
        model: message
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string),
        input_tokens: count("input"),
        output_tokens: count("output"),
        cache_creation_input_tokens: count("cacheWrite"),
        cache_read_input_tokens: count("cacheRead"),
        reasoning_output_tokens: count("reasoning"),
        total_tokens: count("totalTokens"),
    };
    usage.has_counts().then_some(usage)
}

fn run_pi_turn<W: Write>(
    child: &mut PiChild,
    stdout: &mut W,
    input: Vec<UserInput>,
    client_user_message_id: Option<String>,
    turn: u64,
    interrupt_rx: &Receiver<()>,
) -> Result<()> {
    let mut config = BridgeConfig::new("pi".to_string(), format!("turn-{turn}"));
    config.cli_version = "pi".to_string();
    config.model_provider = child
        .provider
        .clone()
        .unwrap_or_else(|| "pi".to_string());
    let mut normalizer = CodexTurnNormalizer::new(config);

    for notification in normalizer.start_notifications(turn == 1)? {
        write_value(stdout, &notification_to_wire_value(&notification)?)?;
    }
    for notification in normalizer.emit_user_message(client_user_message_id, input.clone())? {
        write_value(stdout, &notification_to_wire_value(&notification)?)?;
    }

    child.write_command(&json!({
        "type": "prompt",
        "message": user_input_text(&input),
    }))?;

    let mut state = PiTurnState::default();
    loop {
        if interrupt_rx.try_recv().is_ok() {
            let _ = child.write_command(&json!({"type": "abort"}));
            // Pi ends the aborted run with its own terminal frame; drain
            // until it arrives (bounded) so it can't leak into the next turn
            // as an instant terminal.
            let deadline = Instant::now() + INTERRUPT_DRAIN_TIMEOUT;
            while let Ok(Ok(line)) = child.stdout.recv_timeout(
                deadline
                    .checked_duration_since(Instant::now())
                    .unwrap_or_default(),
            ) {
                let Ok(frame) = serde_json::from_str::<Value>(line.trim()) else {
                    continue;
                };
                if normalize_pi_frame(turn, &mut state, &frame)
                    .iter()
                    .any(NormalizedEvent::is_terminal)
                {
                    break;
                }
            }
            if let Some(notification) = normalizer.finish_turn_interrupted()? {
                write_value(stdout, &notification_to_wire_value(&notification)?)?;
            }
            return Ok(());
        }

        match child.stdout.recv_timeout(Duration::from_millis(50)) {
            Ok(line) => {
                let Ok(frame) = serde_json::from_str::<Value>(line?.trim()) else {
                    continue;
                };
                let mut terminal = false;
                for event in normalize_pi_frame(turn, &mut state, &frame) {
                    terminal |= event.is_terminal();
                    for notification in normalizer.process_event(&event)? {
                        write_value(stdout, &notification_to_wire_value(&notification)?)?;
                    }
                }
                if terminal {
                    // A failed turn's error was latched from the Result event.
                    if let Some(notification) = normalizer.finish_turn(None)? {
                        write_value(stdout, &notification_to_wire_value(&notification)?)?;
                    }
                    return Ok(());
                }
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                return Err(HarnessServerError::PiExited {
                    status: self_wait(child)?,
                });
            }
        }
    }
}

fn self_wait(child: &mut PiChild) -> Result<std::process::ExitStatus> {
    Ok(child.child.wait()?)
}

fn user_input_text(input: &[UserInput]) -> String {
    let mut parts = Vec::new();
    for item in input {
        match item {
            UserInput::Text { text, .. } => parts.push(text.clone()),
            UserInput::Image { url, .. } => parts.push(format!("[image: {url}]")),
            UserInput::LocalImage { path, .. } => {
                parts.push(format!("[image file: {}]", path.display()))
            }
            UserInput::Skill { name, path } => {
                parts.push(format!("[skill: {name} at {}]", path.display()))
            }
            UserInput::Mention { name, path } => parts.push(format!("[mention: {name} at {path}]")),
        }
    }
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::traits::{NormalizedContent, NormalizedEvent};

    use super::{PiTurnState, map_thinking_level, normalize_pi_frame};

    fn is_terminal(events: &[NormalizedEvent]) -> bool {
        events.iter().any(NormalizedEvent::is_terminal)
    }

    // Fixtures below are verbatim shapes captured from `pi --mode rpc`
    // 0.84.2 against a mock openai-completions provider.

    #[test]
    fn text_delta_becomes_agent_text_delta() {
        let mut state = PiTurnState::default();
        let events = normalize_pi_frame(
            1,
            &mut state,
            &json!({"type": "message_update",
                    "assistantMessageEvent": {"type": "text_delta", "delta": "Running a quick check.", "contentIndex": 0}}),
        );
        assert!(!is_terminal(&events));
        assert!(matches!(
            &events[..],
            [NormalizedEvent::AgentTextDelta { delta, .. }] if delta == "Running a quick check."
        ));
    }

    #[test]
    fn thinking_delta_becomes_reasoning_delta() {
        let mut state = PiTurnState::default();
        let events = normalize_pi_frame(
            1,
            &mut state,
            &json!({"type": "message_update",
                    "assistantMessageEvent": {"type": "thinking_delta", "delta": "hmm"}}),
        );
        assert!(matches!(
            &events[..],
            [NormalizedEvent::ReasoningTextDelta { delta, .. }] if delta == "hmm"
        ));
    }

    #[test]
    fn tool_execution_start_becomes_tool_use() {
        let mut state = PiTurnState::default();
        let events = normalize_pi_frame(
            1,
            &mut state,
            &json!({"type": "tool_execution_start", "toolCallId": "call_mock_1",
                    "toolName": "bash", "args": {"command": "echo hello-from-pi"}}),
        );
        match &events[..] {
            [NormalizedEvent::AssistantMessage { content, .. }] => match &content[..] {
                [NormalizedContent::ToolUse { raw_id, tool, arguments }] => {
                    assert_eq!(raw_id, "call_mock_1");
                    assert_eq!(tool, "bash");
                    assert_eq!(arguments["command"], "echo hello-from-pi");
                }
                other => panic!("unexpected content: {other:?}"),
            },
            other => panic!("unexpected events: {other:?}"),
        }
    }

    #[test]
    fn tool_execution_end_becomes_tool_result() {
        let mut state = PiTurnState::default();
        let events = normalize_pi_frame(
            1,
            &mut state,
            &json!({"type": "tool_execution_end", "toolCallId": "call_mock_1", "toolName": "bash",
                    "result": {"content": [{"type": "text", "text": "hello-from-pi\n"}]},
                    "isError": false}),
        );
        match &events[..] {
            [NormalizedEvent::ToolResults(results)] => {
                assert_eq!(results.len(), 1);
                assert_eq!(results[0].tool_use_id, "call_mock_1");
                assert_eq!(results[0].content, "hello-from-pi\n");
                assert!(!results[0].is_error);
            }
            other => panic!("unexpected events: {other:?}"),
        }
    }

    #[test]
    fn assistant_message_end_emits_usage_and_final_text() {
        let mut state = PiTurnState::default();
        normalize_pi_frame(
            1,
            &mut state,
            &json!({"type": "message_start", "message": {"role": "assistant", "content": []}}),
        );
        let events = normalize_pi_frame(
            1,
            &mut state,
            &json!({"type": "message_end", "message": {
                "role": "assistant",
                "stopReason": "stop",
                "content": [{"type": "text", "text": "TOOL_OK hello-from-pi"}],
                "usage": {"input": 140, "output": 8, "cacheRead": 0, "cacheWrite": 0,
                           "reasoning": 0, "totalTokens": 148, "cost": {}}}}),
        );
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            NormalizedEvent::TokenUsage { usage }
                if usage.input_tokens == Some(140) && usage.output_tokens == Some(8)
        ));
        match &events[1] {
            NormalizedEvent::AssistantMessage { stop_reason, content, .. } => {
                assert_eq!(stop_reason.as_deref(), Some("end_turn"));
                assert!(matches!(
                    &content[..],
                    [NormalizedContent::AgentText { text, .. }] if text == "TOOL_OK hello-from-pi"
                ));
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn tool_use_round_keeps_stop_reason_open() {
        let mut state = PiTurnState::default();
        normalize_pi_frame(
            1,
            &mut state,
            &json!({"type": "message_start", "message": {"role": "assistant", "content": []}}),
        );
        let events = normalize_pi_frame(
            1,
            &mut state,
            &json!({"type": "message_end", "message": {
                "role": "assistant", "stopReason": "toolUse",
                "content": [{"type": "text", "text": "Running a quick check."},
                             {"type": "toolCall", "id": "call_mock_1", "name": "bash"}]}}),
        );
        match &events[..] {
            [NormalizedEvent::AssistantMessage { stop_reason, .. }] => {
                assert!(stop_reason.is_none());
            }
            other => panic!("unexpected events: {other:?}"),
        }
    }

    #[test]
    fn user_and_tool_result_messages_are_ignored() {
        let mut state = PiTurnState::default();
        for role in ["user", "toolResult"] {
            let events = normalize_pi_frame(
                1,
                &mut state,
                &json!({"type": "message_end", "message": {"role": role,
                        "content": [{"type": "text", "text": "hi"}]}}),
            );
            assert!(events.is_empty(), "{role} message leaked events");
        }
        assert_eq!(state.assistant_messages, 0);
    }

    #[test]
    fn agent_settled_is_terminal() {
        let mut state = PiTurnState::default();
        let events = normalize_pi_frame(1, &mut state, &json!({"type": "agent_settled"}));
        assert!(is_terminal(&events));
        assert!(matches!(
            &events[..],
            [NormalizedEvent::Result { error: None }]
        ));
    }

    #[test]
    fn error_event_latches_turn_error() {
        let mut state = PiTurnState::default();
        let events = normalize_pi_frame(
            1,
            &mut state,
            &json!({"type": "error", "message": "provider unreachable"}),
        );
        assert!(matches!(
            &events[..],
            [NormalizedEvent::Result { error: Some(error) }] if error == "provider unreachable"
        ));
    }

    #[test]
    fn failed_response_latches_turn_error() {
        let mut state = PiTurnState::default();
        let events = normalize_pi_frame(
            1,
            &mut state,
            &json!({"type": "response", "command": "prompt", "success": false,
                    "error": "no session"}),
        );
        assert!(matches!(
            &events[..],
            [NormalizedEvent::Result { error: Some(error) }] if error == "pi prompt failed: no session"
        ));
        let ok = normalize_pi_frame(
            1,
            &mut state,
            &json!({"type": "response", "command": "prompt", "success": true}),
        );
        assert!(ok.is_empty());
    }

    #[test]
    fn assistant_rounds_get_distinct_item_ids() {
        let mut state = PiTurnState::default();
        normalize_pi_frame(
            3,
            &mut state,
            &json!({"type": "message_start", "message": {"role": "assistant"}}),
        );
        let first = normalize_pi_frame(
            3,
            &mut state,
            &json!({"type": "message_update",
                    "assistantMessageEvent": {"type": "text_delta", "delta": "a"}}),
        );
        normalize_pi_frame(
            3,
            &mut state,
            &json!({"type": "message_start", "message": {"role": "assistant"}}),
        );
        let second = normalize_pi_frame(
            3,
            &mut state,
            &json!({"type": "message_update",
                    "assistantMessageEvent": {"type": "text_delta", "delta": "b"}}),
        );
        let id = |events: &[NormalizedEvent]| match events {
            [NormalizedEvent::AgentTextDelta { item_id, .. }] => item_id.clone(),
            other => panic!("unexpected events: {other:?}"),
        };
        assert_eq!(id(&first), "pi-msg-3-1");
        assert_eq!(id(&second), "pi-msg-3-2");
    }

    #[test]
    fn thinking_levels_map_and_reject() {
        assert_eq!(map_thinking_level("none").as_deref(), Some("off"));
        assert_eq!(map_thinking_level("HIGH").as_deref(), Some("high"));
        assert_eq!(map_thinking_level("xhigh").as_deref(), Some("xhigh"));
        assert_eq!(map_thinking_level("superduper"), None);
    }
}
