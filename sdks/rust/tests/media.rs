//! Media a test hands over (exit check 14.5): a fixture file's path, read in the test process from
//! the files root (or the absolute path), its bytes, or a placeholder the server makes.

use std::io::ErrorKind;
use std::path::Path;
use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use channelstack::Error;
use channelstack::IntoArg;
use channelstack::runtime::files::{read_media, read_media_one_or_many, set_files_root};
use serde_json::{Value, json};

/// The files root is the process's, and tests run in parallel: those that rely on it take turns.
static TURN: Mutex<()> = Mutex::new(());

fn rooted<T>(root: Option<&Path>, check: impl FnOnce() -> T) -> T {
    let _turn = TURN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    set_files_root(root);
    let result = check();
    set_files_root(None);
    result
}

/// A directory with `media/cat.png`, a few bytes that aren't text.
fn fixture() -> tempfile::TempDir {
    let root = tempfile::Builder::new()
        .prefix("cs-media-")
        .tempdir()
        .unwrap();
    std::fs::create_dir_all(root.path().join("media")).unwrap();
    std::fs::write(
        root.path().join("media/cat.png"),
        [0x89, b'P', b'N', b'G', 0, 255],
    )
    .unwrap();
    root
}

fn bytes(media: &Value) -> Vec<u8> {
    STANDARD.decode(media["content"].as_str().unwrap()).unwrap()
}

#[test]
fn a_path_is_the_files_bytes_and_its_name_from_the_files_root_or_absolute() {
    let root = fixture();
    rooted(Some(root.path()), || {
        let read = read_media(&json!("./media/cat.png")).unwrap();
        assert_eq!(read["name"], "cat.png");
        assert_eq!(bytes(&read), [0x89, b'P', b'N', b'G', 0, 255]);
    });
    let absolute = root.path().join("media/cat.png").display().to_string();
    let read = read_media(&json!(absolute)).unwrap();
    assert_eq!(read["name"], "cat.png");
    assert_eq!(bytes(&read), [0x89, b'P', b'N', b'G', 0, 255]);
}

#[test]
fn bytes_are_sent_as_they_are_without_a_name() {
    let read = read_media(&vec![0u8, 1, 255].into_arg()).unwrap();
    assert_eq!(read, json!({ "content": "AAH/" }));
    assert!(matches!(read_media(&json!([256])), Err(Error::Invalid(_))));
}

#[test]
fn a_placeholder_is_sent_as_it_is() {
    let placeholder = json!({ "placeholder": { "width": 64, "height": 32 } });
    assert_eq!(read_media(&placeholder).unwrap(), placeholder);
    assert_eq!(
        read_media(&json!({ "placeholder": { "seconds": 1.5 } })).unwrap(),
        json!({ "placeholder": { "seconds": 1.5 } })
    );
    assert!(matches!(
        read_media(&json!({ "width": 64 })),
        Err(Error::Invalid(_))
    ));
}

#[test]
fn a_path_that_isnt_there_is_an_error() {
    let root = fixture();
    rooted(Some(root.path()), || {
        match read_media(&json!("./media/dog.png")).unwrap_err() {
            Error::Files { source, .. } => assert_eq!(source.kind(), ErrorKind::NotFound),
            other => panic!("not a files error: {other}"),
        }
    });
}

#[test]
fn one_or_many_takes_bytes_as_one_source_and_a_list_as_several() {
    let root = fixture();
    rooted(Some(root.path()), || {
        assert_eq!(
            read_media_one_or_many(&json!([0, 1, 255])).unwrap(),
            json!([{ "content": "AAH/" }])
        );
        let many = read_media_one_or_many(&json!([
            "media/cat.png",
            [0, 1, 255],
            { "placeholder": { "width": 8 } },
        ]))
        .unwrap();
        assert_eq!(many[0]["name"], "cat.png");
        assert_eq!(many[1], json!({ "content": "AAH/" }));
        assert_eq!(many[2], json!({ "placeholder": { "width": 8 } }));
        assert_eq!(
            read_media_one_or_many(&json!("media/cat.png")).unwrap()[0]["name"],
            "cat.png"
        );
    });
}
