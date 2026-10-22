import hashlib
import os
import pathlib
import sys
import tarfile
import zipfile

command, target, root = sys.argv[1:4]
base = sys.argv[4] if len(sys.argv) > 4 else "scp-relay"
root = pathlib.Path(root)
name = f"{base}-{target}"
windows = "windows" in target
binary = base + (".exe" if windows else "")
archive = root / (name + (".zip" if windows else ".tar.gz"))
if command == "pack":
    root.mkdir(parents=True, exist_ok=True)
    source = pathlib.Path(os.environ.get("CARGO_TARGET_DIR", "crates/target")) / target / "release" / binary
    if windows:
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
            output.write(source, binary)
    else:
        with tarfile.open(archive, "w:gz") as output:
            output.add(source, arcname=binary)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_name(archive.name + ".sha256").write_text(f"{digest}  {archive.name}\n")
elif command == "unpack":
    expected = archive.with_name(archive.name + ".sha256").read_text().split()[0]
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        raise ValueError(f"Checksum mismatch: {archive.name}")
    destination = root / name
    destination.mkdir(parents=True, exist_ok=True)
    if windows:
        with zipfile.ZipFile(archive) as source:
            (destination / binary).write_bytes(source.read(binary))
    else:
        with tarfile.open(archive) as source:
            (destination / binary).write_bytes(source.extractfile(binary).read())
    (destination / binary).chmod(0o755)
else:
    raise ValueError("Expected pack or unpack")
