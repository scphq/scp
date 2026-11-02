#[path = "../testing.rs"]
mod testing;

fn main() {
    if let Ok(spec) = std::env::var("SCP_MCP_TEST") {
        std::process::exit(testing::main(&spec));
    }
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    if std::env::var("SCP_MCP_IDENTITY").is_ok_and(|v| v == "1") {
        std::process::exit(scp_mcp::shim::identity_main(&args));
    }
    std::process::exit(scp_mcp::main(&args));
}
