#!/usr/bin/env python3
"""Dump git log/diff between tags without invoking git CLI."""
import struct
import zlib
import re
from pathlib import Path

REPO = Path("/Users/reggie.pierce/Projects/github-reggie-db/dbx-tools-js")
GIT = REPO / ".git"
OBJECTS = GIT / "objects"
OUT = REPO / ".git-dump-output.txt"

_object_cache: dict[str, tuple[str, bytes]] = {}


def _read_size(data: bytes, pos: int) -> tuple[int, int]:
    c = data[pos]
    pos += 1
    size = c & 0x0F
    shift = 4
    while c & 0x80:
        c = data[pos]
        pos += 1
        size |= (c & 0x7F) << shift
        shift += 7
    return size, pos


def _read_offset(data: bytes, pos: int) -> tuple[int, int]:
    offset = 0
    shift = 0
    while True:
        c = data[pos]
        pos += 1
        offset |= (c & 0x7F) << shift
        if not (c & 0x80):
            break
        shift += 7
        offset += 1
    return offset, pos


def _apply_delta(base: bytes, delta: bytes) -> bytes:
    pos = 0
    _, pos = _read_size(delta, pos)
    _, pos = _read_size(delta, pos)
    out = bytearray()
    while pos < len(delta):
        cmd = delta[pos]
        pos += 1
        if cmd & 0x80:
            cp_off = cp_size = 0
            s = 0
            if cmd & 0x01:
                cp_off = delta[pos]
                pos += 1
            if cmd & 0x02:
                cp_off |= delta[pos] << 8
                pos += 1
            if cmd & 0x04:
                cp_off |= delta[pos] << 16
                pos += 1
            if cmd & 0x08:
                cp_off |= delta[pos] << 24
                pos += 1
            if cmd & 0x10:
                cp_size = delta[pos]
                pos += 1
            if cmd & 0x20:
                cp_size |= delta[pos] << 8
                pos += 1
            if cmd & 0x40:
                cp_size |= delta[pos] << 16
                pos += 1
            if cp_size == 0:
                cp_size = 0x10000
            out.extend(base[cp_off : cp_off + cp_size])
        elif cmd:
            out.append(delta[pos])
            pos += 1
    return bytes(out)


def _load_pack() -> None:
    if _object_cache:
        return
    pack_dir = OBJECTS / "pack"
    for idx_path in sorted(pack_dir.glob("*.idx")):
        pack_path = Path(str(idx_path)[:-4])
        if not pack_path.exists():
            continue
        data = pack_path.read_bytes()
        idx = idx_path.read_bytes()
        if idx[:4] != b"\xfftOc":
            continue
        fanout = struct.unpack(">256I", idx[8 : 8 + 256 * 4])
        total = fanout[-1]
        off = 8 + 256 * 4
        shas = []
        for _ in range(total):
            shas.append(idx[off : off + 20].hex())
            off += 24
        offsets = []
        for i in range(total):
            eoff = struct.unpack(">I", idx[off + i * 4 : off + i * 4 + 4])[0]
            offsets.append((eoff & 0x7FFFFFFF) * 2)
        typ_names = {1: "commit", 2: "tree", 3: "blob", 4: "tag"}

        def read_at(sha: str, file_off: int) -> tuple[str, bytes]:
            if sha in _object_cache:
                return _object_cache[sha]
            pos = file_off
            byte = data[pos]
            pos += 1
            typ = (byte >> 4) & 7
            size = byte & 0x0F
            shift = 4
            while byte & 0x80:
                byte = data[pos]
                pos += 1
                size |= (byte & 0x7F) << shift
                shift += 7
            if typ == 6:
                rel, pos = _read_offset(data, pos)
                base_off = file_off - rel
                base_sha = None
                for i, o in enumerate(offsets):
                    if o == base_off:
                        base_sha = shas[i]
                        break
                if base_sha is None:
                    raise KeyError(f"base for delta at {sha}")
                _, base_raw = read_at(base_sha, base_off)
                delta = zlib.decompress(data[pos:])
                raw = _apply_delta(base_raw, delta)
            elif typ == 7:
                base_sha = data[pos : pos + 20].hex()
                pos += 20
                base_off = offsets[shas.index(base_sha)]
                _, base_raw = read_at(base_sha, base_off)
                delta = zlib.decompress(data[pos:])
                raw = _apply_delta(base_raw, delta)
            else:
                raw = zlib.decompress(data[pos:])
            name = typ_names.get(typ, "unknown")
            _object_cache[sha] = (name, raw)
            return name, raw

        for sha, file_off in zip(shas, offsets):
            if sha not in _object_cache:
                read_at(sha, file_off)


def read_object(sha: str) -> tuple[str, bytes]:
    path = OBJECTS / sha[:2] / sha[2:]
    if path.exists():
        raw = zlib.decompress(path.read_bytes())
        nul = raw.index(b"\0")
        header = raw[:nul].decode()
        typ, _size = header.split()
        return typ, raw[nul + 1 :]
    _load_pack()
    if sha in _object_cache:
        return _object_cache[sha]
    raise FileNotFoundError(sha)


def peel_tag(sha: str) -> str:
    typ, body = read_object(sha)
    if typ != "tag":
        return sha
    m = re.search(rb"^object ([0-9a-f]{40})$", body, re.M)
    if not m:
        raise ValueError(f"no object in tag {sha}")
    return m.group(1).decode()


def parse_commit(sha: str) -> dict:
    typ, body = read_object(sha)
    assert typ == "commit", f"expected commit, got {typ} for {sha}"
    text = body.decode()
    lines = text.splitlines()
    parents = []
    meta = {}
    i = 0
    while i < len(lines) and lines[i]:
        line = lines[i]
        if line.startswith("parent "):
            parents.append(line.split()[1])
        elif line.startswith("tree "):
            meta["tree"] = line.split()[1]
        i += 1
    message = "\n".join(lines[i + 1 :]).strip()
    return {"sha": sha, "parents": parents, "message": message, "tree": meta.get("tree")}


def resolve_ref(name: str) -> str:
    for candidate in [
        GIT / "refs" / "tags" / name,
        GIT / "refs" / "heads" / name,
    ]:
        if candidate.exists():
            sha = candidate.read_text().strip()
            return peel_tag(sha)
    packed = (GIT / "packed-refs").read_text().splitlines()
    tag_sha = None
    peeled = None
    for line in packed:
        if line.startswith("#") or not line.strip():
            continue
        parts = line.split()
        if len(parts) == 2 and parts[1] == f"refs/tags/{name}":
            tag_sha = parts[0]
            peeled = None
        elif line.startswith("^") and tag_sha is not None:
            peeled = line[1:].strip()
    if peeled:
        return peeled
    if tag_sha:
        return peel_tag(tag_sha)
    raise KeyError(name)


def walk_commits(start: str, stop: str) -> list[dict]:
    seen = set()
    out = []
    stack = [start]
    while stack:
        sha = stack.pop()
        if sha in seen or sha == stop:
            continue
        seen.add(sha)
        c = parse_commit(sha)
        out.append(c)
        stack.extend(c["parents"])
    return out


def parse_tree_entries(tree_sha: str) -> dict[str, tuple[str, str]]:
    typ, body = read_object(tree_sha)
    assert typ == "tree"
    entries = {}
    i = 0
    while i < len(body):
        sp = body.index(b" ", i)
        mode = body[i:sp].decode()
        sp2 = body.index(b"\0", sp)
        name = body[sp + 1 : sp2].decode()
        sha = body[sp2 + 1 : sp2 + 21].hex()
        i = sp2 + 21
        entries[name] = (mode, sha)
    return entries


def resolve_path(tree_sha: str, path_parts: list[str]) -> tuple[str, str] | None:
    entries = parse_tree_entries(tree_sha)
    if not path_parts:
        return tree_sha, "tree"
    name = path_parts[0]
    if name not in entries:
        return None
    mode, sha = entries[name]
    if mode.startswith("04"):
        if len(path_parts) == 1:
            return sha, "tree"
        return resolve_path(sha, path_parts[1:])
    return sha, "blob"


def read_blob(sha: str) -> str:
    typ, body = read_object(sha)
    assert typ == "blob"
    return body.decode("utf-8", errors="replace")


def unified_diff(a: str, b: str, path: str) -> str:
    import difflib

    return "".join(
        difflib.unified_diff(
            a.splitlines(keepends=True),
            b.splitlines(keepends=True),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
        )
    )


def main():
    old_sha = resolve_ref("v0.1.85")
    new_sha = resolve_ref("v0.1.87")
    commits = walk_commits(new_sha, old_sha)
    non_merges = [c for c in commits if len(c["parents"]) <= 1]

    lines = []
    lines.append("=== COMMAND 1 ===")
    for c in non_merges:
        lines.append(f"{c['sha'][:8]} {c['message'].splitlines()[0]}")
    lines.append("")
    lines.append("=== COMMAND 2 ===")
    for c in non_merges:
        lines.append(c["message"].splitlines()[0])
    lines.append("")
    lines.append("=== COMMAND 3 ===")
    old_tree = parse_commit(old_sha)["tree"]
    new_tree = parse_commit(new_sha)["tree"]
    paths = [
        "packages/appkit-mastra-ui/src/react/bubbles.tsx",
        "packages/devkit/src/cursor.ts",
        "packages/devkit/src/cursor-agent.ts",
        "packages/devkit/src/index.ts",
        "packages/devkit/src/tag.ts",
    ]
    for path in paths:
        parts = path.split("/")
        old_res = resolve_path(old_tree, parts)
        new_res = resolve_path(new_tree, parts)
        old_text = read_blob(old_res[0]) if old_res and old_res[1] == "blob" else ""
        new_text = read_blob(new_res[0]) if new_res and new_res[1] == "blob" else ""
        if old_text == new_text:
            continue
        diff = unified_diff(old_text, new_text, path)
        if diff:
            lines.append(diff.rstrip("\n"))
    OUT.write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
