fn main() {
    let path = "../../packages/cli/package.json";
    println!("cargo:rerun-if-changed={path}");
    let text = std::fs::read_to_string(path).expect("CLI package manifest");
    let version = text
        .lines()
        .find_map(|line| {
            let line = line.trim().strip_prefix("\"version\":")?;
            Some(line.trim().trim_end_matches(',').trim_matches('"'))
        })
        .expect("CLI version");
    println!("cargo:rustc-env=SCP_HOOK_VERSION={version}");
}
