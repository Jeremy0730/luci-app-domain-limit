#!/usr/bin/env python3
"""Build an apk-tools v3 package for ImmortalWrt (apk add)."""

import hashlib
import struct
from collections import defaultdict
from pathlib import Path

from build_ipk import DIST, PKG, PKG_RELEASE, PKG_VERSION, SCRIPTS, collect_data, lf

VERSION = f"{PKG_VERSION}-r{PKG_RELEASE}"
OUT = DIST / f"{PKG}-{VERSION}.apk"
SCHEMA_PACKAGE = 0x676B6370
ADB_INT = 0x10000000
ADB_BLOB8 = 0x80000000
ADB_BLOB16 = 0x90000000
ADB_BLOB32 = 0xA0000000
ADB_OBJECT = 0xE0000000


class Adb:
    def __init__(self):
        self.buf = bytearray(8)

    def align(self, n):
        pad = (-len(self.buf)) % n
        if pad:
            self.buf += b"\0" * pad

    def blob(self, data: bytes) -> int:
        if not data:
            return 0
        if len(data) <= 0xFF:
            self.align(1)
            off = len(self.buf)
            self.buf.append(len(data))
            kind = ADB_BLOB8
        elif len(data) <= 0xFFFF:
            self.align(2)
            off = len(self.buf)
            self.buf += struct.pack("<H", len(data))
            kind = ADB_BLOB16
        else:
            self.align(4)
            off = len(self.buf)
            self.buf += struct.pack("<I", len(data))
            kind = ADB_BLOB32
        self.buf += data
        return kind | off

    def integer(self, value: int) -> int:
        if value < 0 or value >= 0x10000000:
            raise SystemExit(f"integer out of range: {value}")
        return ADB_INT | value

    def obj(self, slots: dict) -> int:
        if not slots:
            return 0
        n = max(slots) + 1
        while n > 1 and slots.get(n - 1, 0) == 0:
            n -= 1
        if n <= 1:
            return 0
        self.align(4)
        off = len(self.buf)
        self.buf += struct.pack("<I", n)
        for i in range(1, n):
            self.buf += struct.pack("<I", slots.get(i, 0) & 0xFFFFFFFF)
        return ADB_OBJECT | off

    def set_root(self, value: int):
        struct.pack_into("<I", self.buf, 4, value & 0xFFFFFFFF)

    def seal_identity(self, at: int):
        digest = hashlib.sha256(self.buf).digest()[:20]
        self.buf[at:at + 20] = digest


def read_script(name: str) -> bytes:
    return lf((SCRIPTS / name).read_bytes())


def upgrade_script(postinst: bytes) -> bytes:
    body = postinst
    prefix = b"#!/bin/sh\n"
    if body.startswith(prefix):
        body = body[len(prefix):]
    return prefix + b"export PKG_UPGRADE=1\n" + body


def acl(db: Adb, mode: int) -> int:
    return db.obj({
        1: db.integer(mode),
        2: db.blob(b"root"),
        3: db.blob(b"root"),
    })


def dep(db: Adb, name: str) -> int:
    return db.obj({1: db.blob(name.encode("ascii"))})


def block(kind: int, payload: bytes) -> bytes:
    raw = 4 + len(payload)
    if raw >= 0x3FFFFFFF:
        raise SystemExit("block too large")
    header = struct.pack("<I", (kind << 30) + raw)
    pad = (-raw) % 8
    return header + payload + (b"\0" * pad)


def stage_files():
    files = []
    for arc, data, mode in collect_data():
        files.append((arc[2:], data, mode & 0o777))

    config = next(data for arc, data, _mode in files if arc == "etc/config/domain-limit")
    conf = "/etc/config/domain-limit"
    conffiles = (conf + "\n").encode("ascii")
    static = f"{conf} {hashlib.sha256(config).hexdigest()}\n".encode("ascii")
    meta = "lib/apk/packages/" + PKG
    names = [arc for arc, _data, _mode in files]
    names.extend([
        meta + ".conffiles",
        meta + ".conffiles_static",
        meta + ".list",
    ])
    listing = "".join(f"/{name}\n" for name in sorted(names)).encode("ascii")
    files.append((meta + ".conffiles", conffiles, 0o644))
    files.append((meta + ".conffiles_static", static, 0o644))
    files.append((meta + ".list", listing, 0o644))
    return files


def build_package(files):
    db = Adb()
    grouped = defaultdict(list)
    directories = {""}
    for arc, data, mode in files:
        parent, _, name = arc.rpartition("/")
        grouped[parent].append((name, data, mode))
        parts = parent.split("/") if parent else []
        cur = []
        for part in parts:
            cur.append(part)
            directories.add("/".join(cur))

    dir_names = sorted(directories, key=lambda item: (item != "", item))
    file_index = {}
    dir_values = []
    for dir_i, dirname in enumerate(dir_names, start=1):
        entries = sorted(grouped.get(dirname, []), key=lambda item: item[0])
        file_values = []
        for file_i, (name, data, mode) in enumerate(entries, start=1):
            slots = {
                1: db.blob(name.encode("ascii")),
                2: acl(db, mode),
                3: db.integer(len(data)),
                4: db.integer(0),
            }
            if data:
                slots[5] = db.blob(hashlib.sha256(data).digest())
                file_index[(dir_i, file_i)] = data
            file_values.append(db.obj(slots))
        dir_slots = {2: acl(db, 0o755)}
        if dirname:
            dir_slots[1] = db.blob(dirname.encode("ascii"))
        if file_values:
            dir_slots[3] = db.obj({i + 1: value for i, value in enumerate(file_values)})
        dir_values.append(db.obj(dir_slots))

    postinst = read_script("postinst")
    scripts = db.obj({
        3: db.blob(postinst),
        4: db.blob(read_script("prerm")),
        5: db.blob(read_script("postrm")),
        7: db.blob(upgrade_script(postinst)),
    })
    depends = db.obj({
        i + 1: dep(db, name)
        for i, name in enumerate((
            "dnsmasq-full",
            "firewall4",
            "luci-base",
        ))
    })
    identity_at = len(db.buf) + 1
    identity = db.blob(b"\0" * 20)
    installed = sum(len(data) for _arc, data, _mode in files) or 1
    info = db.obj({
        1: db.blob(PKG.encode("ascii")),
        2: db.blob(VERSION.encode("ascii")),
        3: identity,
        4: db.blob(b"Limit per-device bandwidth for selected domains"),
        5: db.blob(b"noarch"),
        6: db.blob(b"Apache-2.0"),
        7: db.blob(PKG.encode("ascii")),
        8: db.blob(b"Jianlong Chen"),
        12: db.integer(installed),
        15: depends,
    })
    paths = db.obj({i + 1: value for i, value in enumerate(dir_values)})
    package = db.obj({
        1: info,
        2: paths,
        3: scripts,
    })
    db.set_root(package)
    db.seal_identity(identity_at)

    payload = bytes(db.buf)
    chunks = [b"ADB.", struct.pack("<I", SCHEMA_PACKAGE), block(0, payload)]
    for (dir_i, file_i), data in file_index.items():
        hdr = struct.pack("<II", dir_i, file_i)
        chunks.append(block(2, hdr + data))
    return b"".join(chunks), file_index, identity_at


def u32(buf, off):
    return struct.unpack_from("<I", buf, off)[0]


def blob_at(payload, val):
    kind = val & 0xF0000000
    off = val & 0x0FFFFFFF
    if kind == ADB_BLOB8:
        size = payload[off]
        start = off + 1
    elif kind == ADB_BLOB16:
        size = struct.unpack_from("<H", payload, off)[0]
        start = off + 2
    elif kind == ADB_BLOB32:
        size = u32(payload, off)
        start = off + 4
    else:
        raise SystemExit(f"expected blob, got {val:#x}")
    return payload[start:start + size]


def obj_at(payload, val):
    if val == 0:
        return []
    if (val & 0xF0000000) != ADB_OBJECT:
        raise SystemExit(f"expected object, got {val:#x}")
    off = val & 0x0FFFFFFF
    count = u32(payload, off)
    return [u32(payload, off + 4 * i) for i in range(1, count)]


def verify(package, file_index, identity_at):
    if package[:4] != b"ADB.":
        raise SystemExit("missing ADB header")
    if u32(package, 4) != SCHEMA_PACKAGE:
        raise SystemExit("wrong schema")
    raw = u32(package, 8) & 0x3FFFFFFF
    payload = package[12:8 + raw]
    if u32(payload, 0) & 0xFFFF != 0:
        raise SystemExit("unexpected adb header")
    root = obj_at(payload, u32(payload, 4))
    info = obj_at(payload, root[0])
    if blob_at(payload, info[0]) != PKG.encode():
        raise SystemExit("package name mismatch")
    if blob_at(payload, info[1]) != VERSION.encode():
        raise SystemExit("version mismatch")
    if blob_at(payload, info[4]) != b"noarch":
        raise SystemExit("arch mismatch")
    depends = [blob_at(payload, obj_at(payload, item)[0]) for item in obj_at(payload, info[14])]
    expect = [b"dnsmasq-full", b"firewall4", b"luci-base"]
    if depends != expect:
        raise SystemExit(f"depends mismatch: {depends}")

    zeroed = bytearray(payload)
    zeroed[identity_at:identity_at + 20] = b"\0" * 20
    if hashlib.sha256(zeroed).digest()[:20] != payload[identity_at:identity_at + 20]:
        raise SystemExit("identity hash mismatch")

    paths = obj_at(payload, root[1])
    cursor = 8 + ((raw + 7) & ~7)
    seen = 0
    for dir_i, dir_val in enumerate(paths, start=1):
        files = obj_at(payload, obj_at(payload, dir_val)[2] if len(obj_at(payload, dir_val)) >= 3 else 0)
        for file_i, file_val in enumerate(files, start=1):
            slots = obj_at(payload, file_val)
            size = slots[2] & 0x0FFFFFFF
            if size == 0:
                continue
            kind = u32(package, cursor) >> 30
            block_raw = u32(package, cursor) & 0x3FFFFFFF
            data_off = cursor + 4
            path_idx, got_file = struct.unpack_from("<II", package, data_off)
            body = package[data_off + 8:data_off + 8 + size]
            if kind != 2 or path_idx != dir_i or got_file != file_i:
                raise SystemExit(f"data block index mismatch at {dir_i},{file_i}")
            if body != file_index[(dir_i, file_i)] or hashlib.sha256(body).digest() != blob_at(payload, slots[4]):
                raise SystemExit(f"file hash mismatch at {dir_i},{file_i}")
            cursor += (block_raw + 7) & ~7
            seen += 1
    if seen != len(file_index) or cursor != len(package):
        raise SystemExit(f"trailing data: seen {seen} cursor {cursor} len {len(package)}")
    print(f"verified {PKG} {VERSION}: {seen} files, {len(depends)} depends")


def main():
    files = stage_files()
    package, file_index, identity_at = build_package(files)
    verify(package, file_index, identity_at)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(package)
    print(f"wrote {OUT} ({len(package)} bytes)")


if __name__ == "__main__":
    main()
