#![allow(deprecated)]
use solana_sdk::{bpf_loader_upgradeable, instruction::Instruction, pubkey::Pubkey};

fn encoded(ix: &Instruction, name: &str) -> Vec<String> {
    vec![
        format!(
            "{name}_data={}",
            ix.data
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        ),
        format!(
            "{name}_accounts={}",
            ix.accounts
                .iter()
                .map(|a| format!("{}:{}:{}", a.pubkey, a.is_signer as u8, a.is_writable as u8))
                .collect::<Vec<_>>()
                .join(",")
        ),
    ]
}

#[test]
fn typescript_loader_encoding_and_accounts_match_pinned_rust_sdk() {
    let program = Pubkey::new_from_array([1; 32]);
    let buffer = Pubkey::new_from_array([2; 32]);
    let authority = Pubkey::new_from_array([3; 32]);
    let write = bpf_loader_upgradeable::write(&buffer, &authority, 42, vec![7, 8, 9]);
    let deploy = bpf_loader_upgradeable::deploy_with_max_program_len(
        &authority, &program, &buffer, &authority, 1, 1234,
    )
    .unwrap();
    let mut lines = encoded(&write, "write");
    lines.extend(encoded(&deploy[1], "deploy"));
    assert_eq!(
        lines.join("\n") + "\n",
        include_str!("../../../tests/fixtures/loader-v3.txt")
    );
}
