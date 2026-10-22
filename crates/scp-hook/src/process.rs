use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::ffi::CStr;

#[derive(Debug, Serialize)]
pub struct Proc {
    pub pid: i32,
    pub ppid: i32,
    pub start: Option<String>,
    pub args: String,
    pub comm: String,
}

pub fn start_string(seconds: i64) -> Option<String> {
    let seconds = seconds as libc::time_t;
    let mut time = unsafe { std::mem::zeroed::<libc::tm>() };
    if unsafe { libc::localtime_r(&seconds, &mut time) }.is_null() {
        return None;
    }
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let text = format!(
        "{}-{}-{}-{:02}:{:02}:{:02}-{}",
        DAYS.get(time.tm_wday as usize)?,
        MONTHS.get(time.tm_mon as usize)?,
        time.tm_mday,
        time.tm_hour,
        time.tm_min,
        time.tm_sec,
        time.tm_year + 1900
    );
    (text.len() <= 64
        && text
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b":-".contains(&c)))
    .then_some(text)
}

pub fn collect(ppid: i32, env: &HashMap<String, String>) -> Vec<Proc> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    let roots = std::iter::once(ppid).chain(
        ["CLAUDE_PID", "OPENCODE_PID", "SCP_HARNESS_PID"]
            .iter()
            .filter_map(|key| env.get(*key)?.parse::<i32>().ok()),
    );
    for mut pid in roots {
        while pid > 0 && result.len() < 64 && seen.insert(pid) {
            let Some(proc) = read(pid) else { break };
            pid = proc.ppid;
            result.push(proc);
        }
    }
    result
}

#[cfg(target_os = "linux")]
pub fn read(pid: i32) -> Option<Proc> {
    use std::fs;
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = stat.rfind(')')?;
    let name = stat.get(stat.find('(')? + 1..close)?;
    let fields: Vec<_> = stat.get(close + 1..)?.split_whitespace().collect();
    let ppid = fields.get(1)?.parse().ok()?;
    let ticks: i64 = fields.get(19)?.parse().ok()?;
    let frequency = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if frequency <= 0 {
        return None;
    }
    let boot: i64 = fs::read_to_string("/proc/stat")
        .ok()?
        .lines()
        .find_map(|l| l.strip_prefix("btime "))?
        .parse()
        .ok()?;
    let args = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let args = String::from_utf8_lossy(&args)
        .trim_end_matches('\0')
        .replace('\0', " ");
    let args = if args.is_empty() {
        format!("[{name}]")
    } else {
        args.trim().to_owned()
    };
    let comm = fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()?
        .trim()
        .to_owned();
    Some(Proc {
        pid,
        ppid,
        start: start_string(boot + ticks / frequency),
        args,
        comm,
    })
}

#[cfg(target_os = "macos")]
pub fn read(pid: i32) -> Option<Proc> {
    unsafe extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut libc::c_void,
            size: i32,
        ) -> i32;
        fn proc_pidpath(pid: i32, buffer: *mut libc::c_void, size: u32) -> i32;
    }
    let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdinfo>() };
    let size = std::mem::size_of_val(&info) as i32;
    if unsafe {
        proc_pidinfo(
            pid,
            3,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    } != size
    {
        return None;
    }
    let mut path = [0u8; 4096];
    let count = unsafe { proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    let short: Vec<u8> = info
        .pbi_comm
        .iter()
        .take_while(|c| **c != 0)
        .map(|c| *c as u8)
        .collect();
    let short = String::from_utf8_lossy(&short).into_owned();
    let comm = if count > 0 {
        String::from_utf8_lossy(&path[..count as usize])
            .trim_end_matches('\0')
            .to_owned()
    } else {
        short.clone()
    };
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size = 0usize;
    let ok = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    let args = if ok == 0 && size >= 4 {
        let mut bytes = vec![0u8; size];
        if unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                3,
                bytes.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } == 0
        {
            parse_args(&bytes[..size])
        } else {
            None
        }
    } else {
        None
    };
    Some(Proc {
        pid,
        ppid: info.pbi_ppid as i32,
        start: start_string(info.pbi_start_tvsec as i64),
        args: args
            .as_ref()
            .map(|(args, _)| args.clone())
            .unwrap_or_else(|| format!("({short})")),
        comm: args.map(|(_, comm)| comm).unwrap_or(comm),
    })
}

#[cfg(target_os = "macos")]
fn parse_args(bytes: &[u8]) -> Option<(String, String)> {
    let argc = i32::from_ne_bytes(bytes.get(..4)?.try_into().ok()?);
    if !(0..=65536).contains(&argc) {
        return None;
    }
    let mut rest = bytes.get(4..)?;
    rest = rest.get(rest.iter().position(|b| *b == 0)? + 1..)?;
    while rest.first() == Some(&0) {
        rest = &rest[1..];
    }
    let mut args = Vec::new();
    for _ in 0..argc {
        let end = rest.iter().position(|b| *b == 0)?;
        args.push(String::from_utf8_lossy(&rest[..end]).into_owned());
        rest = &rest[end + 1..];
    }
    Some((
        args.join(" ").trim().to_owned(),
        args.first().cloned().unwrap_or_default(),
    ))
}

pub fn home() -> Option<String> {
    unsafe {
        let mut pwd = std::mem::zeroed::<libc::passwd>();
        let mut result = std::ptr::null_mut();
        let mut buffer = vec![0u8; 16384];
        if libc::getpwuid_r(
            libc::getuid(),
            &mut pwd,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        ) != 0
            || result.is_null()
            || pwd.pw_dir.is_null()
        {
            return None;
        }
        Some(CStr::from_ptr(pwd.pw_dir).to_string_lossy().into_owned())
    }
}
