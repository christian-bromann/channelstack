"""Media a test hands over (exit check 14.5): a fixture file's path, read in the test process from
the files root (or the absolute path), its bytes, or a placeholder the server makes."""

import base64
from collections.abc import Iterator
from pathlib import Path

import pytest

from channelstack.runtime.files import read_media, set_files_root

PNG = bytes([0x89, *b"PNG", 0, 255])


@pytest.fixture
def fixture(tmp_path: Path) -> Iterator[Path]:
    """A directory with `media/cat.png`, a few bytes that aren't text. Leaves no root set."""
    (tmp_path / "media").mkdir()
    (tmp_path / "media" / "cat.png").write_bytes(PNG)
    yield tmp_path
    set_files_root(None)


def test_a_path_is_the_files_bytes_and_its_name_from_the_files_root_or_absolute(fixture: Path) -> None:
    set_files_root(fixture)
    read = read_media("./media/cat.png")
    assert read["name"] == "cat.png"
    assert base64.b64decode(read["content"]) == PNG
    set_files_root(None)
    for absolute in (fixture / "media" / "cat.png", str(fixture / "media" / "cat.png")):
        assert read_media(absolute) == {"content": base64.b64encode(PNG).decode(), "name": "cat.png"}


def test_bytes_are_sent_as_they_are_without_a_name() -> None:
    assert read_media(b"\x00\x01\xff") == {"content": "AAH/"}
    assert read_media(bytearray(b"\x00\x01\xff")) == {"content": "AAH/"}


def test_a_placeholder_is_sent_as_it_is() -> None:
    placeholder = {"placeholder": {"width": 64, "height": 32}}
    assert read_media(placeholder) == placeholder
    assert read_media({"placeholder": {"seconds": 1.5}}) == {"placeholder": {"seconds": 1.5}}


def test_a_path_that_isnt_there_is_an_error(fixture: Path) -> None:
    set_files_root(fixture)
    with pytest.raises(FileNotFoundError):
        read_media("./media/dog.png")
