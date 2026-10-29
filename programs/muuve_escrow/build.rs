use std::{env, fs, path::PathBuf};
fn main() {
    println!("cargo:rerun-if-env-changed=MUUVE_PROGRAM_ID");
    let id = env::var("MUUVE_PROGRAM_ID").unwrap_or_else(|_| {
        let target = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
        let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
        assert!(
            target != "solana" && arch != "bpf" && arch != "sbf",
            "MUUVE_PROGRAM_ID is required for SBF builds"
        );
        // Public host-test fixture only; never presented as a deployed address.
        "Fg6PaFpoGXkYsidMpWxTWqkZ7FEfcYkgMQhgV7tTqKpP".to_string()
    });
    assert!(
        id.len() >= 32 && id.len() <= 44 && id.chars().all(|c| c.is_ascii_alphanumeric()),
        "invalid program ID"
    );
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("program_id.rs"),
        format!("anchor_lang::declare_id!(\"{id}\");"),
    )
    .unwrap();
}
