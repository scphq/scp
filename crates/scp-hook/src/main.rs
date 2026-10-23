fn main() {
    let origin = scp_hook::now();
    std::panic::set_hook(Box::new(|_| {}));
    let _ = std::panic::catch_unwind(|| {
        let args: Vec<String> = std::env::args_os()
            .skip(1)
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        if args == ["--version"] {
            use std::io::Write;
            let _ = writeln!(std::io::stdout(), "scp-hook {}", env!("SCP_HOOK_VERSION"));
        } else {
            let _ = scp_hook::run(origin, &args);
        }
    });
}
