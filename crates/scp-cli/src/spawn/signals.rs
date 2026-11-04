//! Signals as Node's `process.on` takes them: a listener on a signal keeps it from ending the process, and when the last listener of a
//! signal goes the default action is back. One self-pipe carries every signal to the listeners on the runtime.

use std::cell::{Cell, RefCell};
use std::mem::MaybeUninit;
use std::os::fd::{FromRawFd, OwnedFd};
use std::rc::Rc;
use std::sync::atomic::{AtomicI32, Ordering};
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;

static WAKE: AtomicI32 = AtomicI32::new(-1);

#[cfg(target_os = "macos")]
fn errno() -> *mut libc::c_int {
    // SAFETY: the calling thread's errno
    unsafe { libc::__error() }
}

#[cfg(not(target_os = "macos"))]
fn errno() -> *mut libc::c_int {
    // SAFETY: the calling thread's errno
    unsafe { libc::__errno_location() }
}

extern "C" fn caught(signal: libc::c_int) {
    let byte = signal as u8;
    // SAFETY: write and errno are async-signal-safe; one byte from a live local
    unsafe {
        let saved = *errno();
        libc::write(
            WAKE.load(Ordering::Relaxed),
            (&raw const byte).cast::<libc::c_void>(),
            1,
        );
        *errno() = saved;
    }
}

fn set(signal: i32, handler: libc::sighandler_t) {
    // SAFETY: a zeroed sigaction, filled in, for a valid signal number
    unsafe {
        let mut action = MaybeUninit::<libc::sigaction>::zeroed().assume_init();
        action.sa_sigaction = handler;
        action.sa_flags = libc::SA_RESTART;
        libc::sigfillset(&mut action.sa_mask);
        libc::sigaction(signal, &action, std::ptr::null_mut());
    }
}

struct Entry {
    id: u64,
    signals: Vec<i32>,
    caught: Rc<Cell<bool>>,
    queue: mpsc::UnboundedSender<i32>,
}

#[derive(Default)]
struct Hub {
    next: u64,
    pumping: bool,
    entries: Vec<Entry>,
}

thread_local! {
    static HUB: RefCell<Hub> = RefCell::default();
}

fn dispatch(signal: i32) {
    HUB.with_borrow(|hub| {
        for entry in hub.entries.iter().filter(|e| e.signals.contains(&signal)) {
            entry.caught.set(true);
            let _ = entry.queue.send(signal);
        }
    });
}

async fn pump(read: OwnedFd) {
    let Ok(mut pipe) = tokio::net::unix::pipe::Receiver::from_owned_fd(read) else {
        return;
    };
    let mut bytes = [0u8; 64];
    while let Ok(count) = pipe.read(&mut bytes).await {
        if count == 0 {
            return;
        }
        for byte in &bytes[..count] {
            dispatch(i32::from(*byte));
        }
    }
}

/// opens the self-pipe, both ends close-on-exec and the write end nonblocking, and starts its reader
fn start_pump() {
    let mut fds = [0; 2];
    // SAFETY: a fresh pipe; its write end stays open for the process, for the handler
    unsafe {
        if libc::pipe(fds.as_mut_ptr()) < 0 {
            return;
        }
        for fd in fds {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
        libc::fcntl(fds[1], libc::F_SETFL, libc::O_NONBLOCK);
        WAKE.store(fds[1], Ordering::Relaxed);
        tokio::task::spawn_local(pump(OwnedFd::from_raw_fd(fds[0])));
    }
}

/// signals caught for as long as this lives; needs a LocalSet
pub struct Listener {
    id: u64,
    caught: Rc<Cell<bool>>,
    queue: mpsc::UnboundedReceiver<i32>,
}

impl Listener {
    pub fn new(signals: &[i32]) -> Listener {
        let (tx, queue) = mpsc::unbounded_channel();
        let caught = Rc::new(Cell::new(false));
        let id = HUB.with_borrow_mut(|hub| {
            if !hub.pumping {
                hub.pumping = true;
                start_pump();
            }
            for signal in signals {
                if !hub.entries.iter().any(|e| e.signals.contains(signal)) {
                    set(*signal, caught_handler());
                }
            }
            hub.next += 1;
            hub.entries.push(Entry {
                id: hub.next,
                signals: signals.to_vec(),
                caught: caught.clone(),
                queue: tx,
            });
            hub.next
        });
        Listener { id, caught, queue }
    }

    /// whether one came
    pub fn caught(&self) -> bool {
        self.caught.get()
    }

    /// the next signal; pending forever once the hub is gone
    pub async fn recv(&mut self) -> i32 {
        match self.queue.recv().await {
            Some(signal) => signal,
            None => std::future::pending().await,
        }
    }

    /// returns once a signal came, at once when one already did
    pub async fn next(&mut self) {
        if !self.caught() {
            self.recv().await;
        }
    }
}

fn caught_handler() -> libc::sighandler_t {
    caught as extern "C" fn(libc::c_int) as libc::sighandler_t
}

impl Drop for Listener {
    fn drop(&mut self) {
        HUB.with_borrow_mut(|hub| {
            let Some(at) = hub.entries.iter().position(|e| e.id == self.id) else {
                return;
            };
            let entry = hub.entries.remove(at);
            for signal in entry.signals {
                if !hub.entries.iter().any(|e| e.signals.contains(&signal)) {
                    set(signal, libc::SIG_DFL);
                }
            }
        });
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// tests that listen for signals take turns: the handler writes to one pipe for the process
    pub(crate) static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn both_listeners_hear_a_signal_and_the_default_comes_back() {
        let _turn = SERIAL.lock();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let local = tokio::task::LocalSet::new();
        local.block_on(&runtime, async {
            let mut first = Listener::new(&[libc::SIGUSR2]);
            let mut second = Listener::new(&[libc::SIGUSR2, libc::SIGWINCH]);
            // SAFETY: signals this process, which listens for it
            unsafe { libc::kill(libc::getpid(), libc::SIGUSR2) };
            assert_eq!(first.recv().await, libc::SIGUSR2);
            second.next().await;
            assert!(first.caught() && second.caught());
            drop(first);
            let current = || {
                // SAFETY: reads the disposition into a zeroed struct
                unsafe {
                    let mut old = MaybeUninit::<libc::sigaction>::zeroed().assume_init();
                    libc::sigaction(libc::SIGUSR2, std::ptr::null(), &mut old);
                    old.sa_sigaction
                }
            };
            assert_eq!(current(), caught_handler());
            drop(second);
            assert_eq!(current(), libc::SIG_DFL);
        });
    }
}
