"""Build or verify the extension ZIP using the committed runtime and project license."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def read_runtime():
    revision = git("rev-parse", "--verify", "HEAD").decode().strip()
    if git("diff", "--name-only", revision, "--", "extension", "LICENSE") or git(
        "diff", "--cached", "--name-only", revision, "--", "extension", "LICENSE"
    ):
        raise ValueError("Commit runtime and license changes before packaging.")
    tree = git("ls-tree", "-rz", revision + ":extension")
    files = {}
    for entry in tree.rstrip(b"\0").split(b"\0"):
        metadata, raw_path = entry.split(b"\t", 1)
        mode, kind, oid = metadata.decode().split()
        name = raw_path.decode()
        if mode != "100644" or kind != "blob" or not re.fullmatch(
            r"(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+\.(?:json|js|css|html|png)", name
        ):
            raise ValueError(f"Unexpected extension file: {name}")
        files[name] = git("cat-file", "blob", oid)
    manifest = json.loads(files["manifest.json"])
    version = manifest["version"]
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){0,3}", version):
        raise ValueError("Invalid extension version")
    action = manifest["action"]
    refs = set(manifest["icons"].values()) | set(action["default_icon"].values())
    refs.update([action["default_popup"], manifest["background"]["service_worker"]])
    for script in manifest["content_scripts"]:
        refs.update(script.get("js", []))
        refs.update(script.get("css", []))
    missing = refs - files.keys()
    if missing:
        raise ValueError("Missing manifest references: " + ", ".join(sorted(missing)))
    files["LICENSE"] = git("cat-file", "blob", revision + ":LICENSE")
    return version, files


def make_zip(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, content, compress_type=zipfile.ZIP_STORED)
    return buffer.getvalue()


def replace(path, content):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as out:
        temp_path = Path(out.name)
        try:
            out.write(content)
            out.close()
            os.replace(temp_path, path)
        finally:
            temp_path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify an existing ZIP and checksum")
    args = parser.parse_args()
    version, files = read_runtime()
    archive = ROOT / "dist" / f"mute-on-x-{version}.zip"
    checksum = archive.with_suffix(".zip.sha256")
    content = make_zip(files)
    digest = hashlib.sha256(content).hexdigest()
    checksum_text = f"{digest}  {archive.name}\n".encode("ascii")
    if args.check:
        if archive.read_bytes() != content or checksum.read_bytes() != checksum_text:
            raise ValueError("Release ZIP or checksum differs from the committed runtime and license.")
    else:
        archive.parent.mkdir(exist_ok=True)
        replace(archive, content)
        replace(checksum, checksum_text)
    print(f"{archive.name}  {len(files)} files  SHA-256 {digest}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from error
