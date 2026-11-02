fn main() {
    let origin = scp_hook::now();
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    if args == ["--version"] {
        use std::io::Write;
        let _ = writeln!(std::io::stdout(), "scp-hook {}", env!("SCP_HOOK_VERSION"));
    } else {
        scp_hook::entry(origin, &args);
    }
}
