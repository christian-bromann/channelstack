//! Every example in `src/` is a module of the crate, so none is left out of the build: a file the
//! docs show (`<Example id="…" />`) compiles without anyone listing it in `lib.rs`.

use std::fmt::Write;
use std::path::Path;
use std::{env, fs};

/// The crate's own modules, which aren't examples.
const NOT_EXAMPLES: [&str; 2] = ["lib.rs", "fixtures.rs"];

fn main() {
    let src = Path::new(&env::var("CARGO_MANIFEST_DIR").expect("cargo sets the manifest dir"))
        .join("src");
    println!("cargo::rerun-if-changed={}", src.display());
    let mut names: Vec<String> = fs::read_dir(&src)
        .expect("the examples' src folder")
        .map(|entry| {
            entry
                .expect("an entry of src")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.ends_with(".rs") && !NOT_EXAMPLES.contains(&name.as_str()))
        .collect();
    names.sort();
    let mut modules = String::new();
    for name in names {
        let path = src.join(&name);
        let module = name.trim_end_matches(".rs");
        writeln!(
            modules,
            "#[path = {:?}]\nmod {module};",
            path.display().to_string()
        )
        .expect("a module line");
    }
    let out = Path::new(&env::var("OUT_DIR").expect("cargo sets the out dir")).join("examples.rs");
    fs::write(out, modules).expect("the examples' module list");
}
