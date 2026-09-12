//! Bounded run-event retention. Desktop consumers pull batches instead of pushing
//! unlimited messages into the WebView. Lagged consumers recover status snapshots.
use crate::runner::{RunEvent, RunManager};
use tokio::sync::broadcast;

pub const EVENT_CAPACITY: usize = 256;
pub const OUTPUT_CHUNK: usize = 16 * 1024;
pub const BATCH_SIZE: usize = 64;

pub fn channel() -> (broadcast::Sender<RunEvent>, broadcast::Receiver<RunEvent>) {
    broadcast::channel(EVENT_CAPACITY)
}

pub fn drain(rx: &mut broadcast::Receiver<RunEvent>, manager: &RunManager) -> Vec<RunEvent> {
    let mut events = Vec::new();
    let mut lagged = false;
    // Bound work even if producers are continuously publishing.
    for _ in 0..BATCH_SIZE {
        match rx.try_recv() {
            Ok(event) => events.push(event),
            Err(broadcast::error::TryRecvError::Lagged(_)) => {
                lagged = true;
                events.clear();
                // Continue reading the retained window so even sustained noisy
                // workloads show recent output instead of only gap notices.
            }
            Err(_) => break,
        }
    }
    if lagged {
        events.retain(|event| matches!(event, RunEvent::Output { .. }));
        events.insert(
            0,
            RunEvent::Resync {
                statuses: manager.snapshot(),
            },
        );
    }
    events
}
