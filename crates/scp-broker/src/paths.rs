use std::collections::BTreeMap;
use std::ffi::CStr;
use std::io;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone)]
pub struct Paths {
    pub dir: PathBuf,
    pub socket: PathBuf,
    pub database: PathBuf,
    pub lock: PathBuf,
}

impl Paths {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            socket: socket_path(&dir),
            database: normalize(&dir.join("relay.db")),
            lock: normalize(&dir.join("broker.lock")),
            dir,
        }
    }

    pub fn from_env(env: &BTreeMap<String, String>) -> io::Result<Self> {
        Ok(Self::new(relay_dir(env)?))
    }

    pub async fn prepare(&self) -> io::Result<()> {
        private_dir(&self.dir).await?;
        if let Some(parent) = self.socket.parent() {
            private_dir(parent).await?;
        }
        Ok(())
    }
}

pub fn relay_dir(env: &BTreeMap<String, String>) -> io::Result<PathBuf> {
    let nonempty = |key| env.get(key).filter(|value| !value.is_empty());
    if let Some(dir) = nonempty("SCP_DIR") {
        return Ok(PathBuf::from(dir));
    }
    if let Some(base) = nonempty("XDG_STATE_HOME") {
        return Ok(normalize(&Path::new(base).join("scp")));
    }
    let home = nonempty("HOME")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(account_home)?;
    Ok(normalize(&home.join(".local/state/scp")))
}

pub fn socket_path(dir: &Path) -> PathBuf {
    let inside = normalize(&dir.join("relay.sock"));
    if inside.as_os_str().len() <= 100 {
        return inside;
    }
    let key = hex::encode(Sha256::digest(dir.as_os_str().as_encoded_bytes()));
    Path::new("/tmp")
        .join(format!("scp-{}-{}", uid(), &key[..12]))
        .join("relay.sock")
}

fn normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir if result.file_name().is_some_and(|name| name != "..") => {
                result.pop();
            }
            Component::ParentDir if result.has_root() => {}
            component => result.push(component.as_os_str()),
        }
    }
    if result.as_os_str().is_empty() {
        result.push(".");
    }
    result
}

pub fn account_home() -> io::Result<PathBuf> {
    let mut size = 16 * 1024;
    loop {
        let mut buffer = vec![0u8; size];
        let mut record = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut result = std::ptr::null_mut();
        // The record's strings remain inside buffer until they are copied.
        let code = unsafe {
            libc::getpwuid_r(
                uid(),
                record.as_mut_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if code == libc::ERANGE && size < 1024 * 1024 {
            size *= 2;
            continue;
        }
        if code != 0 {
            return Err(io::Error::from_raw_os_error(code));
        }
        if result.is_null() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "account home directory is unavailable",
            ));
        }
        // A successful lookup initializes the record and its directory pointer.
        let pointer = unsafe { record.assume_init().pw_dir };
        if pointer.is_null() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "account home directory is unavailable",
            ));
        }
        let directory = unsafe { CStr::from_ptr(pointer) };
        if directory.to_bytes().is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "account home directory is unavailable",
            ));
        }
        use std::os::unix::ffi::OsStrExt;
        return Ok(PathBuf::from(std::ffi::OsStr::from_bytes(
            directory.to_bytes(),
        )));
    }
}

pub fn uid() -> u32 {
    // getuid has no failure mode.
    unsafe { libc::getuid() }
}

pub async fn private_dir(path: &Path) -> io::Result<()> {
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true).mode(0o700).create(path).await?;
    let metadata = tokio::fs::symlink_metadata(path).await?;
    if !metadata.is_dir() || metadata.uid() != uid() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "state directory is not a directory this user owns",
        ));
    }
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await
}

pub struct BrokerLock {
    path: PathBuf,
    content: String,
}

impl BrokerLock {
    pub async fn acquire(path: &Path) -> io::Result<Self> {
        let content = format!("{}:{}", std::process::id(), crate::core::now_ms() / 1000);
        for _ in 0..8 {
            match tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
                .await
            {
                Ok(mut file) => {
                    if let Err(error) = file.write_all(content.as_bytes()).await {
                        let _ = tokio::fs::remove_file(path).await;
                        return Err(error);
                    }
                    return Ok(Self {
                        path: path.into(),
                        content,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let holder = match tokio::fs::read_to_string(path).await {
                        Ok(holder) => holder,
                        Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                        Err(error) => return Err(error),
                    };
                    if holder_alive(&holder) {
                        return Err(io::Error::new(
                            io::ErrorKind::AlreadyExists,
                            "a relay broker already runs",
                        ));
                    }
                    let aside = path.with_extension(format!(
                        "{}.{}",
                        std::process::id(),
                        rand::random::<u64>()
                    ));
                    match tokio::fs::rename(path, &aside).await {
                        Ok(()) => {
                            if tokio::fs::read_to_string(&aside).await.ok().as_deref()
                                != Some(&holder)
                            {
                                let _ = tokio::fs::hard_link(&aside, path).await;
                            }
                            let _ = tokio::fs::remove_file(aside).await;
                        }
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error),
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "a relay broker already runs",
        ))
    }

    pub async fn owned(&self) -> bool {
        tokio::fs::read_to_string(&self.path).await.ok().as_deref() == Some(self.content.as_str())
    }

    pub async fn release(&self) {
        if self.owned().await {
            let _ = tokio::fs::remove_file(&self.path).await;
        }
    }
}

fn holder_alive(content: &str) -> bool {
    let mut parts = content.split(':');
    let Some(pid) = parts
        .next()
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|pid| *pid > 0)
    else {
        return false;
    };
    if let Some(started) = parts
        .next()
        .and_then(|part| part.parse::<f64>().ok())
        .filter(|n| n.is_finite())
        && let Some(boot) = boot_time()
        && started < boot - 60.0
    {
        return false;
    }
    // Signal zero checks existence without signalling the process.
    unsafe {
        libc::kill(pid, 0) == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

fn boot_time() -> Option<f64> {
    #[cfg(target_os = "linux")]
    let clock = libc::CLOCK_BOOTTIME;
    #[cfg(not(target_os = "linux"))]
    let clock = libc::CLOCK_MONOTONIC;
    let mut uptime = std::mem::MaybeUninit::<libc::timespec>::uninit();
    // clock_gettime writes the timespec on success.
    if unsafe { libc::clock_gettime(clock, uptime.as_mut_ptr()) } != 0 {
        return None;
    }
    let uptime = unsafe { uptime.assume_init() };
    Some(
        crate::core::now_ms() as f64 / 1000.0
            - uptime.tv_sec as f64
            - uptime.tv_nsec as f64 / 1_000_000_000.0,
    )
}
