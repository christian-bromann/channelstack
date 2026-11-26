//! Files a test hands over: read from disk or given inline, sent as paths with base64 contents.
//!
//! A file input is inline contents (`{ "name", "content" }`, the content text or bytes) or a path
//! to a fixture file or directory (`{ "path", "name"? }`), as in `api/common.d.ts`.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Map, Value, json};

use crate::runtime::error::{Error, Result};

static ROOT: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Where relative fixture paths start from, so `.files("./fixtures/web")` means the directory next
/// to the test. Without it (`None`), paths start from the working directory, which `cargo test`
/// sets to the crate's directory. The root is the whole process's, and `cargo test` runs tests on
/// parallel threads: set it once, before the tests that need it, not per test.
pub fn set_files_root(directory: Option<&Path>) {
    *ROOT
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = directory.map(Path::to_path_buf);
}

fn located(path: &str) -> Result<PathBuf> {
    let given = Path::new(path);
    if given.is_absolute() {
        return Ok(given.to_path_buf());
    }
    let root = ROOT
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    match root {
        Some(root) => Ok(root.join(given)),
        None => std::env::current_dir()
            .map(|directory| directory.join(given))
            .map_err(|source| Error::Files {
                path: path.to_owned(),
                source,
            }),
    }
}

fn unread(path: &Path) -> impl FnOnce(std::io::Error) -> Error + '_ {
    move |source| Error::Files {
        path: path.display().to_string(),
        source,
    }
}

fn read_bytes(path: &Path) -> Result<Vec<u8>> {
    std::fs::read(path).map_err(unread(path))
}

/// A file's contents in base64: text, or bytes as a list of numbers (`Vec<u8>` as an argument).
fn base64(content: &Value) -> Result<String> {
    match content {
        Value::String(text) => Ok(STANDARD.encode(text)),
        Value::Array(items) => {
            let bytes = items
                .iter()
                .map(|item| item.as_u64().and_then(|byte| u8::try_from(byte).ok()))
                .collect::<Option<Vec<u8>>>()
                .ok_or_else(|| {
                    Error::Invalid("A file's bytes must be numbers from 0 to 255".into())
                })?;
            Ok(STANDARD.encode(bytes))
        }
        other => Err(Error::Invalid(format!("Not a file's contents: {other}"))),
    }
}

fn wire(path: String, content: String) -> Value {
    json!({ "path": path, "content": content })
}

/// Every file under a directory, by its path inside it, with forward slashes. A path that isn't
/// a directory is an error (not found, or not a directory), not no files.
fn walk(directory: &Path) -> Result<Vec<Value>> {
    fn visit(directory: &Path, inside: &str, found: &mut Vec<(String, PathBuf)>) -> Result<()> {
        for entry in std::fs::read_dir(directory).map_err(unread(directory))? {
            let entry = entry.map_err(unread(directory))?;
            let kind = entry.file_type().map_err(unread(directory))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = if inside.is_empty() {
                name
            } else {
                format!("{inside}/{name}")
            };
            if kind.is_dir() {
                visit(&entry.path(), &path, found)?;
            } else if kind.is_file() {
                found.push((path, entry.path()));
            }
        }
        Ok(())
    }
    let mut found = Vec::new();
    visit(directory, "", &mut found)?;
    found.sort();
    found
        .into_iter()
        .map(|(path, file)| Ok(wire(path, STANDARD.encode(read_bytes(&file)?))))
        .collect()
}

/// One file input as wire files: inline contents, a file on disk, or everything under a directory on disk.
fn read(input: &Value) -> Result<Vec<Value>> {
    let text = |field: &str| input.get(field).and_then(Value::as_str);
    if let Some(content) = input.get("content") {
        let name = text("name")
            .ok_or_else(|| Error::Invalid("Inline file contents without a name".into()))?;
        return Ok(vec![wire(name.to_owned(), base64(content)?)]);
    }
    let given = text("path").ok_or_else(|| Error::Invalid(format!("Not a file: {input}")))?;
    let name = text("name").filter(|name| !name.is_empty());
    let path = located(given)?;
    if path.is_dir() {
        return Ok(walk(&path)?
            .into_iter()
            .map(|mut file| {
                if let (Some(name), Some(inside)) = (name, file["path"].as_str()) {
                    file["path"] = Value::String(format!("{name}/{inside}"));
                }
                file
            })
            .collect());
    }
    let base = given.rsplit(['/', '\\']).next().unwrap_or(given);
    Ok(vec![wire(
        name.unwrap_or(base).to_owned(),
        STANDARD.encode(read_bytes(&path)?),
    )])
}

fn read_list(items: &[Value]) -> Result<Value> {
    let mut files = Vec::new();
    for item in items {
        files.extend(read(item)?);
    }
    Ok(Value::Array(files))
}

/// A whole tree of files: a fixture directory, or a list of files.
pub fn read_tree(input: &Value) -> Result<Value> {
    match input {
        Value::Null => Ok(Value::Null),
        Value::String(directory) => Ok(Value::Array(walk(&located(directory)?)?)),
        Value::Array(items) => read_list(items),
        other => Err(Error::Invalid(format!(
            "Not a directory or a list of files: {other}"
        ))),
    }
}

/// Changes to files: a list of files, or a map of path to its new contents, where `null` deletes the file.
pub fn read_changes(input: &Value) -> Result<Value> {
    match input {
        Value::Null => Ok(Value::Null),
        Value::Array(items) => read_list(items),
        Value::Object(changes) => Ok(Value::Array(
            changes
                .iter()
                .map(|(path, content)| {
                    let content = match content {
                        Value::Null => Value::Null,
                        other => Value::String(base64(other)?),
                    };
                    let mut change = Map::new();
                    change.insert("path".into(), Value::String(path.clone()));
                    change.insert("content".into(), content);
                    Ok(Value::Object(change))
                })
                .collect::<Result<_>>()?,
        )),
        other => Err(Error::Invalid(format!(
            "Not a list of files or a map of changes: {other}"
        ))),
    }
}

/// One text a test hands over: inline, or the contents of a fixture file (`{ "path" }`).
/// Structured content (a list of blocks) passes as it is.
pub fn read_document(input: &Value) -> Result<Value> {
    match input {
        Value::Null | Value::String(_) | Value::Array(_) => Ok(input.clone()),
        Value::Object(document) => {
            let given = document
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| Error::Invalid(format!("Not a document: {input}")))?;
            let path = located(given)?;
            std::fs::read_to_string(&path)
                .map(Value::String)
                .map_err(unread(&path))
        }
        other => Err(Error::Invalid(format!("Not a document: {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, write};
    use std::io::ErrorKind;
    use std::sync::Mutex;

    /// The root is the process's, and tests run in parallel: those that rely on it take turns.
    static TURN: Mutex<()> = Mutex::new(());

    fn rooted<T>(root: Option<&Path>, check: impl FnOnce() -> T) -> T {
        let _turn = TURN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        set_files_root(root);
        let result = check();
        set_files_root(None);
        result
    }

    /// `web/README.md` and `web/src/app.ts` in a new directory, in `parent` when given.
    fn fixture(parent: Option<&Path>) -> tempfile::TempDir {
        let builder = tempfile::Builder::new().prefix("cs-files-").clone();
        let root = match parent {
            Some(parent) => builder.tempdir_in(parent),
            None => builder.tempdir(),
        }
        .unwrap();
        create_dir_all(root.path().join("web/src")).unwrap();
        write(root.path().join("web/README.md"), "# web\n").unwrap();
        write(root.path().join("web/src/app.ts"), "export {}\n").unwrap();
        root
    }

    fn text(content: &Value) -> Option<String> {
        content
            .as_str()
            .map(|content| String::from_utf8(STANDARD.decode(content).unwrap()).unwrap())
    }

    fn paths(files: &Value) -> Vec<&str> {
        files
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file["path"].as_str().unwrap())
            .collect()
    }

    fn kind(error: Error) -> ErrorKind {
        match error {
            Error::Files { source, .. } => source.kind(),
            other => panic!("not a files error: {other}"),
        }
    }

    fn at(path: &Path) -> Value {
        Value::String(path.display().to_string())
    }

    #[test]
    fn a_document_is_its_text_inline_or_a_fixture_files_contents_from_the_tests_directory() {
        let root = fixture(None);
        rooted(Some(root.path()), || {
            assert_eq!(
                read_document(&json!("# inline")).unwrap(),
                json!("# inline")
            );
            assert_eq!(
                read_document(&json!({ "path": "./web/README.md" })).unwrap(),
                json!("# web\n")
            );
            let blocks = json!([{ "type": "divider", "divider": {} }]);
            assert_eq!(read_document(&blocks).unwrap(), blocks);
        });
    }

    #[test]
    fn a_directory_is_every_file_under_it_by_its_path_inside_it() {
        let root = fixture(None);
        let files = read_tree(&at(&root.path().join("web"))).unwrap();
        let read: Vec<_> = files
            .as_array()
            .unwrap()
            .iter()
            .map(|file| {
                (
                    file["path"].as_str().unwrap(),
                    text(&file["content"]).unwrap(),
                )
            })
            .collect();
        assert_eq!(
            read,
            [
                ("README.md", "# web\n".into()),
                ("src/app.ts", "export {}\n".into())
            ]
        );
    }

    #[test]
    fn a_relative_path_starts_from_the_root_an_integration_set_or_from_the_working_directory() {
        let root = fixture(None);
        rooted(Some(root.path()), || {
            assert_eq!(
                paths(&read_tree(&json!("./web")).unwrap()),
                ["README.md", "src/app.ts"]
            );
            assert_eq!(
                paths(&read_tree(&json!([{ "path": "web/README.md" }])).unwrap()),
                ["README.md"]
            );
        });
        // Without a root the same path starts from the working directory, where it isn't: an error, not no files.
        let here = fixture(Some(&std::env::current_dir().unwrap()));
        let relative = here
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        rooted(None, || {
            assert_eq!(
                kind(read_tree(&json!("./web-that-is-not-in-the-working-directory")).unwrap_err()),
                ErrorKind::NotFound
            );
            let web = json!(format!("{relative}/web"));
            assert_eq!(
                paths(&read_tree(&web).unwrap()),
                ["README.md", "src/app.ts"]
            );
            let file = json!(format!("{relative}/web/README.md"));
            assert_eq!(
                kind(read_tree(&file).unwrap_err()),
                ErrorKind::NotADirectory
            );
        });
    }

    #[test]
    fn a_list_takes_inline_contents_a_file_on_disk_under_a_name_and_a_directory_under_a_prefix() {
        let root = fixture(None);
        let readme = at(&root.path().join("web/README.md"));
        let files = read_tree(&json!([
            { "name": "notes.txt", "content": "hi" },
            { "name": "bin/data", "content": [0, 255] },
            { "path": readme },
            { "path": readme, "name": "docs/README.md" },
            { "path": at(&root.path().join("web/src")), "name": "lib" },
        ]))
        .unwrap();
        assert_eq!(
            paths(&files),
            [
                "notes.txt",
                "bin/data",
                "README.md",
                "docs/README.md",
                "lib/app.ts"
            ]
        );
        assert_eq!(text(&files[0]["content"]).unwrap(), "hi");
        assert_eq!(
            STANDARD
                .decode(files[1]["content"].as_str().unwrap())
                .unwrap(),
            [0, 255]
        );
        assert_eq!(text(&files[3]["content"]).unwrap(), "# web\n");
        assert!(matches!(
            read_tree(&json!([{ "name": "bad", "content": [256] }])),
            Err(Error::Invalid(_))
        ));
    }

    #[test]
    fn changes_are_a_list_of_files_or_a_map_of_path_to_contents_where_null_deletes() {
        let root = fixture(None);
        let changes =
            read_changes(&json!({ "src/app.ts": "export const x = 1\n", "old.ts": null })).unwrap();
        let read: Vec<_> = changes
            .as_array()
            .unwrap()
            .iter()
            .map(|file| (file["path"].as_str().unwrap(), text(&file["content"])))
            .collect();
        assert_eq!(
            read,
            [
                ("old.ts", None),
                ("src/app.ts", Some("export const x = 1\n".into()))
            ]
        );
        assert_eq!(
            read_changes(&json!([{ "name": "a.txt", "content": "a" }])).unwrap(),
            json!([{ "path": "a.txt", "content": "YQ==" }])
        );
        let site = json!([{ "path": at(&root.path().join("web")), "name": "site" }]);
        assert_eq!(
            paths(&read_changes(&site).unwrap()),
            ["site/README.md", "site/src/app.ts"]
        );
    }
}
