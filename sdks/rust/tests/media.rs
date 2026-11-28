//! Media a test hands over (exit check 14.5): a fixture file's path, read in the test process from
//! the files root (or the absolute path), its bytes, or a placeholder the server makes. A path in
//! a scripted turn, a tool call's image in it, and a responder's turn are read the same way, and
//! the fake serves the file byte for byte: `pnpm test:rust` sets the binary; without it, that test
//! says so and passes.

use std::io::ErrorKind;
use std::path::Path;
use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use channelstack::runtime::client::enc;
use channelstack::runtime::files::{read_media, read_media_one_or_many, set_files_root};
use channelstack::{Error, IntoArg, Mode, connect};
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

/// The bytes of `media/cat.png`: a PNG's signature, then bytes that aren't text.
const PNG: [u8; 10] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 255];

/// A directory with `media/cat.png`.
fn fixture() -> tempfile::TempDir {
    let root = tempfile::Builder::new()
        .prefix("cs-media-")
        .tempdir()
        .unwrap();
    std::fs::create_dir_all(root.path().join("media")).unwrap();
    std::fs::write(root.path().join("media/cat.png"), PNG).unwrap();
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
        assert_eq!(bytes(&read), PNG);
    });
    let absolute = root.path().join("media/cat.png").display().to_string();
    let read = read_media(&json!(absolute)).unwrap();
    assert_eq!(read["name"], "cat.png");
    assert_eq!(bytes(&read), PNG);
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

#[test]
fn a_union_encodes_an_object_as_its_object_member_and_passes_text() {
    let root = fixture();
    let path = root.path().join("media/cat.png").display().to_string();
    let image = |v: &Value| enc::object(v, None, &[("image", &|v: &Value| read_media(v))]);
    let turn = |v: &Value| enc::union(v, Some(&image), None);
    assert_eq!(
        bytes(&turn(&json!({ "image": path })).unwrap()["image"]),
        PNG
    );
    assert_eq!(turn(&json!("hi")).unwrap(), json!("hi"));
}

/// Calls the fake as an agent does, tagged with the session (`user`) so they are the test's.
async fn call(base: &str, key: &str, path: &str, body: Value) -> Value {
    let response = reqwest::Client::new()
        .post(format!("{base}{path}"))
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .expect("the fake answers");
    let status = response.status().as_u16();
    let answer: Value = response.json().await.expect("JSON");
    assert_eq!(status, 200, "{answer}");
    answer
}

fn decoded(base64: &Value) -> Vec<u8> {
    STANDARD
        .decode(base64.as_str().unwrap_or_default())
        .unwrap()
}

#[tokio::test]
async fn a_path_in_a_turn_is_read_here_and_served_byte_for_byte() -> channelstack::Result<()> {
    if std::env::var("CHANNELSTACK_SERVER_BIN").is_err() {
        eprintln!("skipped: set CHANNELSTACK_SERVER_BIN (pnpm test:rust does)");
        return Ok(());
    }
    let root = fixture();
    let cat = root.path().join("media/cat.png").display().to_string();
    let client = connect(Mode::Start).await?;
    let session = client.open_session().await?;
    let key = client.env().await?["OPENAI_API_KEY"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let openai = session.openai().await?;
    let base = openai.base_url();
    let user = session.session_id();
    let draw = json!({ "model": "gpt-image-1", "prompt": "a cat", "user": user });

    // The Images API's answer: the turn's image.
    let script = openai.respond(json!({ "image": cat })).await?;
    let answer = call(&base, &key, "/images/generations", draw.clone()).await;
    assert_eq!(decoded(&answer["data"][0]["b64_json"]), PNG);
    script.undo().await?;

    // A tool call's image: the image_generation call's result.
    let script = openai
        .respond(json!({ "toolCalls": [{ "imageGeneration": { "image": cat } }] }))
        .await?;
    let body = json!({
        "model": "gpt-5",
        "input": "draw a cat",
        "tools": [{ "type": "image_generation" }],
        "user": user,
    });
    let answer = call(&base, &key, "/responses", body).await;
    assert_eq!(answer["output"][0]["type"], "image_generation_call");
    assert_eq!(decoded(&answer["output"][0]["result"]), PNG);
    script.undo().await?;

    // A responder's turn.
    let answered = cat.clone();
    openai
        .respond_with(move |_: Value| {
            let cat = answered.clone();
            async move { json!({ "image": cat }) }
        })
        .await?;
    let answer = call(&base, &key, "/images/generations", draw).await;
    assert_eq!(decoded(&answer["data"][0]["b64_json"]), PNG);
    session.close().await?;
    Ok(())
}
