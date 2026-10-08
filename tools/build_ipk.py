#!/usr/bin/env python3
"""Quick local build of an opkg .ipk and an apk-tools v3 package without the SDK.

The packages carry no translations; release builds come from the SDK (see .github/workflows).
"""

import io
import re
import tarfile
from pathlib import Path

PKG = "luci-app-domain-limit"
REPO = Path(__file__).resolve().parent.parent
ROOT = REPO / PKG
SCRIPTS = Path(__file__).resolve().parent / "pkg-scripts"
DIST = REPO / "dist"


def makefile_var(name: str) -> str:
    m = re.search(rf"^{name}:=(.*)$", (ROOT / "Makefile").read_text(encoding="utf-8"), re.M)
    if not m:
        raise SystemExit(f"{name} missing from Makefile")
    return m.group(1).strip()


PKG_VERSION = makefile_var("PKG_VERSION")
PKG_RELEASE = makefile_var("PKG_RELEASE")
VERSION = f"{PKG_VERSION}-{PKG_RELEASE}"
OUT = DIST / f"{PKG}_{VERSION}_all.ipk"

EXECUTABLE = {
    "etc/init.d/domain-limit",
    "etc/hotplug.d/iface/99-domain-limit",
    "usr/sbin/domain-limit",
    "usr/sbin/domain-limit-status",
}


def lf(data: bytes) -> bytes:
    return data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")


def collect_data():
    files = []
    mapping = [
        (ROOT / "root", ""),
        (ROOT / "htdocs" / "luci-static", "www/luci-static"),
    ]
    for src_root, dest_root in mapping:
        for path in sorted(src_root.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(src_root).as_posix()
            arc = f"{dest_root}/{rel}" if dest_root else rel
            mode = 0o755 if arc in EXECUTABLE else 0o644
            files.append((f"./{arc}", lf(path.read_bytes()), mode))
    return files


def tar_gz(members):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.GNU_FORMAT) as tar:
        for name, data, mode in members:
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            info.mode = mode
            info.mtime = 0
            info.uid = 0
            info.gid = 0
            info.uname = "root"
            info.gname = "root"
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def ar_member(name: str, data: bytes) -> bytes:
    header = (
        f"{name:<16}{0:<12}{0:<6}{0:<6}{0o100644:<8o}{len(data):<10}`\n"
    ).encode("ascii")
    if len(header) != 60:
        raise SystemExit(f"bad ar header length {len(header)} for {name}")
    pad = b"\n" if len(data) % 2 else b""
    return header + data + pad


def main():
    data_members = collect_data()
    installed = sum(len(data) for _, data, _ in data_members)
    control = "\n".join([
        f"Package: {PKG}",
        f"Version: {VERSION}",
        "Depends: luci-base, firewall4, dnsmasq-full",
        "Section: luci",
        "Architecture: all",
        f"Installed-Size: {(installed + 1023) // 1024}",
        "Maintainer: Jianlong Chen",
        "License: Apache-2.0",
        "Description: Limit per-device bandwidth for selected domains",
        "",
    ]).encode("ascii")
    control_members = [("./control", control, 0o644)]
    for name in ("postinst", "prerm", "postrm", "conffiles"):
        raw = lf((SCRIPTS / name).read_bytes())
        mode = 0o755 if name != "conffiles" else 0o644
        control_members.append((f"./{name}", raw, mode))

    debian = b"2.0\n"
    payload = b"!<arch>\n"
    payload += ar_member("debian-binary", debian)
    payload += ar_member("control.tar.gz", tar_gz(control_members))
    payload += ar_member("data.tar.gz", tar_gz(data_members))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(payload)
    print(f"wrote {OUT} ({len(payload)} bytes)")
    from build_apk import main as build_apk
    build_apk()


if __name__ == "__main__":
    main()
