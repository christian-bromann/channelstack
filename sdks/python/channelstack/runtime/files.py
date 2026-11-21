"""Files a test hands over: read from disk or given inline, sent as paths with base64 contents."""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

# Inline contents (`{"name", "content"}`) or a path to a fixture file or directory (`{"path", "name"?}`).
type FileInput = dict[str, Any]
# A whole tree of files: a fixture directory, or a list of files.
type TreeInput = str | list[FileInput]
# Changes to files: a list of files, or a map of path to its new contents, where `None` deletes the file.
type ChangesInput = list[FileInput] | dict[str, str | None]

_root: Path | None = None


def set_files_root(directory: str | Path | None) -> None:
    """Where relative fixture paths start from. A test framework integration sets it to the test file's directory."""
    global _root
    _root = None if directory is None else Path(directory)


def _located(path: str) -> Path:
    given = Path(path)
    return given if given.is_absolute() else (_root or Path.cwd()) / given


def _base64(content: str | bytes) -> str:
    return base64.b64encode(content.encode() if isinstance(content, str) else content).decode()


def _walk(directory: Path) -> list[dict[str, Any]]:
    """Every file under a directory, by its path inside it, with forward slashes."""
    files = sorted(path for path in directory.rglob("*") if path.is_file())
    return [{"path": path.relative_to(directory).as_posix(), "content": _base64(path.read_bytes())} for path in files]


def _read(file: FileInput) -> list[dict[str, Any]]:
    """One file input as wire files: inline contents, a file on disk, or everything under a directory on disk."""
    if "content" in file:
        return [{"path": file["name"], "content": _base64(file["content"])}]
    path = _located(file["path"])
    name = file.get("name")
    if path.is_dir():
        return [{**found, "path": f"{name}/{found['path']}" if name else found["path"]} for found in _walk(path)]
    return [{"path": name or path.name, "content": _base64(path.read_bytes())}]


def read_tree(files: TreeInput) -> list[dict[str, Any]]:
    if isinstance(files, str):
        return _walk(_located(files))
    return [wire for file in files for wire in _read(file)]


def read_changes(changes: ChangesInput) -> list[dict[str, Any]]:
    if isinstance(changes, list):
        return [wire for file in changes for wire in _read(file)]
    return [
        {"path": path, "content": None if content is None else _base64(content)} for path, content in changes.items()
    ]
