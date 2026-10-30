use anchor_lang::{
    prelude::*,
    solana_program::{entrypoint::ProgramResult, program_option::COption, program_pack::Pack},
    AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
};
use anchor_spl::{
    associated_token::spl_associated_token_account as associated,
    token_2022::spl_token_2022 as token,
};
use muuve_escrow::{Config, EscrowError, Link, SlotStatus, CLAIM_WINDOW};
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    compute_budget::ComputeBudgetInstruction,
    instruction::Instruction,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
use std::sync::atomic::{AtomicU32, Ordering};
static NONCE: AtomicU32 = AtomicU32::new(1);

fn entry(id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    // Anchor's entry ties slice and AccountInfo lifetimes. Test-only owned clones
    // live for the process; production code contains no leak or lifetime adapter.
    muuve_escrow::entry(id, Box::leak(accounts.to_vec().into_boxed_slice()), data)
}
fn account<T: AccountSerialize>(value: &T) -> Account {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    Account {
        lamports: 10_000_000,
        data,
        owner: muuve_escrow::ID,
        executable: false,
        rent_epoch: 0,
    }
}
fn wallet() -> Account {
    Account {
        lamports: 20_000_000_000,
        data: vec![],
        owner: solana_sdk::system_program::ID,
        executable: false,
        rent_epoch: 0,
    }
}
fn token_account(mint: Pubkey, owner: Pubkey, amount: u64, program: Pubkey) -> Account {
    let state = token::state::Account {
        mint,
        owner,
        amount,
        delegate: COption::None,
        state: token::state::AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    };
    let mut data = vec![0; token::state::Account::LEN];
    token::state::Account::pack(state, &mut data).unwrap();
    Account {
        lamports: 3_000_000,
        data,
        owner: program,
        executable: false,
        rent_epoch: 0,
    }
}
struct Fixture {
    ctx: ProgramTestContext,
    payer: Keypair,
    sender: Keypair,
    claim: Keypair,
    attestor: Keypair,
    treasury_owner: Pubkey,
    mint: Pubkey,
    token: Pubkey,
    config: Pubkey,
    link: Pubkey,
    id: [u8; 16],
    recipient: Pubkey,
    admin: Keypair,
    mint_authority: Keypair,
}
impl Fixture {
    async fn new(program: Pubkey) -> Self {
        let payer = Keypair::new();
        let sender = Keypair::new();
        let claim = Keypair::new();
        let attestor = Keypair::new();
        let admin = Keypair::new();
        let mint_authority = Keypair::new();
        let treasury_owner = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let id = [7; 16];
        let (config, bump) = Pubkey::find_program_address(&[b"config"], &muuve_escrow::ID);
        let link = Pubkey::find_program_address(
            &[b"link", sender.pubkey().as_ref(), &id],
            &muuve_escrow::ID,
        )
        .0;
        let treasury = associated::get_associated_token_address_with_program_id(
            &treasury_owner,
            &mint,
            &program,
        );
        let mut test = ProgramTest::default();
        if let Ok(path) = std::env::var("MUUVE_SBF_SO") {
            test.add_account(
                muuve_escrow::ID,
                Account {
                    lamports: 10_000_000,
                    data: std::fs::read(path).unwrap(),
                    owner: solana_sdk::bpf_loader::ID,
                    executable: true,
                    rent_epoch: 0,
                },
            );
        } else {
            test.add_program("muuve_escrow", muuve_escrow::ID, processor!(entry));
        }
        test.add_program(
            "spl_token",
            anchor_spl::token::ID,
            processor!(anchor_spl::token::spl_token::processor::Processor::process),
        );
        test.add_program(
            "spl_token_2022",
            token::ID,
            processor!(token::processor::Processor::process),
        );
        test.add_program(
            "spl_associated_token_account",
            associated::ID,
            processor!(associated::processor::process_instruction),
        );
        for key in [
            payer.pubkey(),
            sender.pubkey(),
            claim.pubkey(),
            attestor.pubkey(),
            treasury_owner,
            admin.pubkey(),
            mint_authority.pubkey(),
        ] {
            test.add_account(key, wallet());
        }
        let mint_state = token::state::Mint {
            mint_authority: COption::Some(mint_authority.pubkey()),
            supply: 1_000_000_000,
            decimals: 6,
            is_initialized: true,
            freeze_authority: COption::None,
        };
        let mut data = vec![0; token::state::Mint::LEN];
        token::state::Mint::pack(mint_state, &mut data).unwrap();
        test.add_account(
            mint,
            Account {
                lamports: 3_000_000,
                data,
                owner: program,
                executable: false,
                rent_epoch: 0,
            },
        );
        test.add_account(treasury, token_account(mint, treasury_owner, 0, program));
        test.add_account(
            associated::get_associated_token_address_with_program_id(
                &sender.pubkey(),
                &mint,
                &program,
            ),
            token_account(mint, sender.pubkey(), 1_000_000_000, program),
        );
        test.add_account(
            config,
            account(&Config {
                admin: admin.pubkey(),
                attestor: attestor.pubkey(),
                fee_payer: payer.pubkey(),
                mint,
                token_program: program,
                treasury,
                treasury_owner,
                mint_authority: mint_state.mint_authority.unwrap(),
                max_slot: 500_000_000,
                max_link: 1_000_000_000,
                claim_window: CLAIM_WINDOW,
                bump,
            }),
        );
        let ctx = test.start_with_context().await;
        Self {
            admin,
            mint_authority,
            ctx,
            payer,
            sender,
            claim,
            attestor,
            treasury_owner,
            mint,
            token: program,
            config,
            link,
            id,
            recipient: Pubkey::new_unique(),
        }
    }
    fn ata(&self, owner: Pubkey) -> Pubkey {
        associated::get_associated_token_address_with_program_id(&owner, &self.mint, &self.token)
    }
    async fn send(
        &mut self,
        ix: Instruction,
        extra: &[&Keypair],
    ) -> std::result::Result<(), solana_program_test::BanksClientError> {
        let blockhash = self.ctx.banks_client.get_latest_blockhash().await.unwrap();
        let mut signers = vec![&self.payer];
        signers.extend(extra);
        let tx = Transaction::new_signed_with_payer(
            &[
                ComputeBudgetInstruction::set_compute_unit_limit(
                    500_000 + NONCE.fetch_add(1, Ordering::Relaxed),
                ),
                ix,
            ],
            Some(&self.payer.pubkey()),
            &signers,
            blockhash,
        );
        self.ctx.banks_client.process_transaction(tx).await
    }
    async fn create(
        &mut self,
        amounts: Vec<u64>,
    ) -> std::result::Result<(), solana_program_test::BanksClientError> {
        let ix = Instruction {
            program_id: muuve_escrow::ID,
            accounts: muuve_escrow::accounts::CreateLink {
                sender: self.sender.pubkey(),
                payer: self.payer.pubkey(),
                config: self.config,
                link: self.link,
                mint: self.mint,
                token_program: self.token,
                sender_ata: self.ata(self.sender.pubkey()),
                vault: self.ata(self.link),
                associated_token_program: associated::ID,
                system_program: solana_sdk::system_program::ID,
            }
            .to_account_metas(None),
            data: muuve_escrow::instruction::CreateLink {
                link_id: self.id,
                claim_pubkey: self.claim.pubkey(),
                amounts,
            }
            .data(),
        };
        let sender = Keypair::try_from(self.sender.to_bytes().as_slice()).unwrap();
        self.send(ix, &[&sender]).await
    }
    async fn state(&mut self) -> Link {
        let a = self
            .ctx
            .banks_client
            .get_account(self.link)
            .await
            .unwrap()
            .unwrap();
        Link::try_deserialize(&mut a.data.as_slice()).unwrap()
    }
    async fn now(&mut self, time: i64) {
        let mut clock: Clock = self.ctx.banks_client.get_sysvar().await.unwrap();
        clock.unix_timestamp = time;
        self.ctx.set_sysvar(&clock);
    }
    async fn window(
        &mut self,
        seconds: i64,
        authorized: bool,
    ) -> std::result::Result<(), solana_program_test::BanksClientError> {
        let authority = if authorized {
            &self.admin
        } else {
            &self.sender
        };
        let signer = Keypair::try_from(authority.to_bytes().as_slice()).unwrap();
        let instruction = Instruction {
            program_id: muuve_escrow::ID,
            accounts: muuve_escrow::accounts::SetClaimWindow {
                admin: signer.pubkey(),
                config: self.config,
            }
            .to_account_metas(None),
            data: muuve_escrow::instruction::SetClaimWindow {
                claim_window: seconds,
            }
            .data(),
        };
        self.send(instruction, &[&signer]).await
    }
    async fn start(
        &mut self,
        index: u8,
        treasury: bool,
        version: u64,
    ) -> std::result::Result<(), solana_program_test::BanksClientError> {
        let ix = Instruction {
            program_id: muuve_escrow::ID,
            accounts: muuve_escrow::accounts::StartClaim {
                link: self.link,
                claim_key: self.claim.pubkey(),
                attestor: self.attestor.pubkey(),
            }
            .to_account_metas(None),
            data: muuve_escrow::instruction::StartClaim {
                slot_index: index,
                intent_id: [index + 1; 16],
                expected_version: version,
                destination: self.ata(if treasury {
                    self.treasury_owner
                } else {
                    self.recipient
                }),
                to_treasury: treasury,
            }
            .data(),
        };
        let claim = Keypair::try_from(self.claim.to_bytes().as_slice()).unwrap();
        let attestor = Keypair::try_from(self.attestor.to_bytes().as_slice()).unwrap();
        self.send(ix, &[&claim, &attestor]).await
    }
    fn settle_accounts(&self, owner: Pubkey) -> muuve_escrow::accounts::Settle {
        muuve_escrow::accounts::Settle {
            payer: self.payer.pubkey(),
            link: self.link,
            sender: self.sender.pubkey(),
            mint: self.mint,
            token_program: self.token,
            vault: self.ata(self.link),
            sender_ata: self.ata(self.sender.pubkey()),
            destination_owner: owner,
            destination: self.ata(owner),
            rent_beneficiary: self.payer.pubkey(),
            associated_token_program: associated::ID,
            system_program: solana_sdk::system_program::ID,
        }
    }
    async fn claim_slot(
        &mut self,
        index: u8,
        treasury: bool,
    ) -> std::result::Result<(), solana_program_test::BanksClientError> {
        let data = if treasury {
            muuve_escrow::instruction::ClaimToTreasury {
                slot_index: index,
                intent_id: [index + 1; 16],
                version: 1,
            }
            .data()
        } else {
            muuve_escrow::instruction::ClaimToWallet {
                slot_index: index,
                intent_id: [index + 1; 16],
                version: 1,
            }
            .data()
        };
        let ix = Instruction {
            program_id: muuve_escrow::ID,
            accounts: muuve_escrow::accounts::Claim {
                settlement: self.settle_accounts(if treasury {
                    self.treasury_owner
                } else {
                    self.recipient
                }),
                claim_key: self.claim.pubkey(),
                attestor: self.attestor.pubkey(),
            }
            .to_account_metas(None),
            data,
        };
        let claim = Keypair::try_from(self.claim.to_bytes().as_slice()).unwrap();
        let attestor = Keypair::try_from(self.attestor.to_bytes().as_slice()).unwrap();
        self.send(ix, &[&claim, &attestor]).await
    }
    async fn refund(
        &mut self,
        index: Option<u8>,
        expire: bool,
        authorized: bool,
    ) -> std::result::Result<(), solana_program_test::BanksClientError> {
        let data = if expire {
            muuve_escrow::instruction::Expire {}.data()
        } else if let Some(slot_index) = index {
            muuve_escrow::instruction::RecallSlot { slot_index }.data()
        } else {
            muuve_escrow::instruction::RecallAll {}.data()
        };
        let mut keys = self
            .settle_accounts(self.sender.pubkey())
            .to_account_metas(None);
        if !expire && authorized {
            keys[2].is_signer = true;
        }
        let ix = Instruction {
            program_id: muuve_escrow::ID,
            accounts: keys,
            data,
        };
        let sender = Keypair::try_from(self.sender.to_bytes().as_slice()).unwrap();
        let signed = [&sender];
        self.send(ix, if !expire && authorized { &signed } else { &[] })
            .await
    }
    async fn amount(&mut self, owner: Pubkey) -> u64 {
        let a = self
            .ctx
            .banks_client
            .get_account(self.ata(owner))
            .await
            .unwrap()
            .unwrap();
        token::extension::StateWithExtensions::<token::state::Account>::unpack(&a.data)
            .unwrap()
            .base
            .amount
    }
}
fn error(
    result: std::result::Result<(), solana_program_test::BanksClientError>,
    kind: EscrowError,
) {
    let e = format!("{:?}", result.unwrap_err());
    assert!(
        e.contains(&format!("Custom({})", 6000 + kind as u32)),
        "{e}"
    );
}

#[tokio::test]
async fn both_token_programs_full_lifecycle() {
    for program in [anchor_spl::token::ID, token::ID] {
        let mut f = Fixture::new(program).await;
        f.create(vec![10_000_000, 20_000_000, 30_000_000])
            .await
            .unwrap();
        let initial = f.state().await;
        assert_eq!(initial.expires_at - initial.created_at, 172800);
        f.start(0, false, 0).await.unwrap();
        error(
            f.refund(Some(0), false, true).await,
            EscrowError::ClaimInProgress,
        );
        f.claim_slot(0, false).await.unwrap();
        assert_eq!(f.amount(f.recipient).await, 10_000_000);
        error(f.claim_slot(0, false).await, EscrowError::SlotNotFunded);
        f.start(1, true, 0).await.unwrap();
        f.claim_slot(1, true).await.unwrap();
        assert_eq!(f.amount(f.treasury_owner).await, 20_000_000);
        let after = f.state().await;
        assert_eq!(after.open_slots, 1);
        assert_eq!(after.slots[2].amount, 30_000_000);
        assert_eq!(after.slots[2].status, SlotStatus::Funded);
        error(
            f.refund(Some(2), false, false).await,
            EscrowError::NotSender,
        );
        error(f.start(3, false, 0).await, EscrowError::BadSlotIndex);
        error(f.refund(None, true, false).await, EscrowError::NotExpired);
        f.refund(Some(2), false, true).await.unwrap();
        assert_eq!(f.state().await.open_slots, 0);
        assert!(f
            .ctx
            .banks_client
            .get_account(f.ata(f.link))
            .await
            .unwrap()
            .is_none());
    }
}
#[tokio::test]
async fn priority_is_nonrenewable_and_expiry_wins() {
    for program in [anchor_spl::token::ID, token::ID] {
        let mut f = Fixture::new(program).await;
        f.create(vec![1_000_000, 2_000_000]).await.unwrap();
        let state = f.state().await;
        f.now(state.created_at + 10).await;
        f.start(0, false, 0).await.unwrap();
        let first = f.state().await.slots[0].priority_until;
        f.now(state.created_at + 100).await;
        f.start(0, false, 1).await.unwrap();
        assert_eq!(first, f.state().await.slots[0].priority_until);
        error(f.start(0, false, 0).await, EscrowError::BadIntent);
        f.now(first).await;
        f.refund(Some(0), false, true).await.unwrap();
        f.now(state.expires_at).await;
        error(f.start(1, false, 0).await, EscrowError::LinkExpired);
        error(
            f.refund(Some(1), false, true).await,
            EscrowError::LinkExpired,
        );
        f.refund(None, true, false).await.unwrap();
        let end = f.state().await;
        assert_eq!(end.slots[1].status, SlotStatus::Expired);
        assert_eq!(end.open_slots, 0);
    }
}
#[tokio::test]
async fn invalid_funding_never_creates_link() {
    for (amounts, expected) in [
        (vec![], EscrowError::InvalidSlotCount),
        (vec![1; 11], EscrowError::InvalidSlotCount),
        (vec![0], EscrowError::InvalidAmount),
        (vec![500_000_001], EscrowError::InvalidAmount),
        (vec![500_000_000, 500_000_000, 1], EscrowError::LinkTooLarge),
    ] {
        let mut f = Fixture::new(token::ID).await;
        error(f.create(amounts).await, expected);
        assert!(f
            .ctx
            .banks_client
            .get_account(f.link)
            .await
            .unwrap()
            .is_none());
    }
}

#[tokio::test]
async fn single_claim_surplus_and_rent_recovery() {
    for program in [anchor_spl::token::ID, token::ID] {
        let mut f = Fixture::new(program).await;
        f.create(vec![10_000_000]).await.unwrap();
        let donated = 777;
        let donation = token::instruction::transfer_checked(
            &f.token,
            &f.ata(f.sender.pubkey()),
            &f.mint,
            &f.ata(f.link),
            &f.sender.pubkey(),
            &[],
            donated,
            6,
        )
        .unwrap();
        let sender = Keypair::try_from(f.sender.to_bytes().as_slice()).unwrap();
        f.send(donation, &[&sender]).await.unwrap();
        f.start(0, false, 0).await.unwrap();
        let rent_before = f
            .ctx
            .banks_client
            .get_account(f.payer.pubkey())
            .await
            .unwrap()
            .unwrap()
            .lamports;
        f.claim_slot(0, false).await.unwrap();
        assert_eq!(f.amount(f.recipient).await, 10_000_000);
        assert_eq!(f.amount(f.sender.pubkey()).await, 990_000_000);
        // Recipient ATA rent is paid in this transaction too, so compare total
        // rent in the closed vault and created ATA rather than guessing the fee.
        let rent_after = f
            .ctx
            .banks_client
            .get_account(f.payer.pubkey())
            .await
            .unwrap()
            .unwrap()
            .lamports;
        assert!(rent_after + 100_000 >= rent_before);
        assert!(f
            .ctx
            .banks_client
            .get_account(f.ata(f.link))
            .await
            .unwrap()
            .is_none());
        assert_eq!(f.state().await.total, 10_000_000);
    }
}

#[tokio::test]
async fn reject_claim_authority_destination_and_rent_substitution() {
    let mut f = Fixture::new(token::ID).await;
    f.create(vec![10_000_000, 20_000_000]).await.unwrap();
    f.start(0, true, 0).await.unwrap();
    let data = muuve_escrow::instruction::ClaimToTreasury {
        slot_index: 0,
        intent_id: [1; 16],
        version: 1,
    }
    .data();
    let claim = Keypair::try_from(f.claim.to_bytes().as_slice()).unwrap();
    let attestor = Keypair::try_from(f.attestor.to_bytes().as_slice()).unwrap();
    let mut accounts = muuve_escrow::accounts::Claim {
        settlement: f.settle_accounts(f.recipient),
        claim_key: f.claim.pubkey(),
        attestor: f.attestor.pubkey(),
    }
    .to_account_metas(None);
    // Intent locks the treasury; a different canonical ATA still fails.
    error(
        f.send(
            Instruction {
                program_id: muuve_escrow::ID,
                accounts: accounts.clone(),
                data: data.clone(),
            },
            &[&claim, &attestor],
        )
        .await,
        EscrowError::WrongDestination,
    );
    accounts = muuve_escrow::accounts::Claim {
        settlement: f.settle_accounts(f.treasury_owner),
        claim_key: f.claim.pubkey(),
        attestor: f.attestor.pubkey(),
    }
    .to_account_metas(None);
    let wrong = Keypair::new();
    let n = accounts.len();
    accounts[n - 2].pubkey = wrong.pubkey();
    error(
        f.send(
            Instruction {
                program_id: muuve_escrow::ID,
                accounts: accounts.clone(),
                data: data.clone(),
            },
            &[&wrong, &attestor],
        )
        .await,
        EscrowError::BadClaimKey,
    );
    accounts[n - 2].pubkey = f.claim.pubkey();
    accounts[n - 1].pubkey = wrong.pubkey();
    error(
        f.send(
            Instruction {
                program_id: muuve_escrow::ID,
                accounts: accounts.clone(),
                data: data.clone(),
            },
            &[&claim, &wrong],
        )
        .await,
        EscrowError::BadAttestor,
    );
    accounts[n - 1].pubkey = f.attestor.pubkey();
    accounts[9].pubkey = f.sender.pubkey();
    error(
        f.send(
            Instruction {
                program_id: muuve_escrow::ID,
                accounts,
                data,
            },
            &[&claim, &attestor],
        )
        .await,
        EscrowError::WrongRentPayer,
    );
    assert_eq!(f.state().await.open_slots, 2);
}

#[tokio::test]
async fn four_minute_demo_is_admin_only_and_preserves_existing_deadlines() {
    for program in [anchor_spl::token::ID, token::ID] {
        let mut f = Fixture::new(program).await;
        f.create(vec![10_000_000]).await.unwrap();
        let original = f.state().await;
        error(f.window(240, false).await, EscrowError::BadAdmin);
        for value in [0, -1, 1, 239, 241, i64::MAX] {
            error(f.window(value, true).await, EscrowError::InvalidClaimWindow);
        }
        f.window(240, true).await.unwrap();
        assert_eq!(f.state().await.expires_at, original.expires_at);
        f.id = [8; 16];
        f.link = Pubkey::find_program_address(
            &[b"link", f.sender.pubkey().as_ref(), &f.id],
            &muuve_escrow::ID,
        )
        .0;
        f.create(vec![10_000_000, 20_000_000]).await.unwrap();
        let demo = f.state().await;
        assert_eq!(demo.expires_at - demo.created_at, 240);
        f.window(CLAIM_WINDOW, true).await.unwrap();
        assert_eq!(f.state().await.expires_at, demo.expires_at);
        f.now(demo.expires_at - 1).await;
        error(f.refund(None, true, false).await, EscrowError::NotExpired);
        f.start(0, true, 0).await.unwrap();
        assert_eq!(f.state().await.slots[0].priority_until, demo.expires_at);
        f.now(demo.expires_at).await;
        error(f.claim_slot(0, true).await, EscrowError::LinkExpired);
        error(f.start(1, true, 0).await, EscrowError::LinkExpired);
        error(f.refund(None, false, true).await, EscrowError::LinkExpired);
        f.refund(None, true, false).await.unwrap();
        assert_eq!(f.amount(f.sender.pubkey()).await, 990_000_000);
        assert!(f
            .ctx
            .banks_client
            .get_account(f.ata(f.link))
            .await
            .unwrap()
            .is_none());
        assert!(f.refund(None, true, false).await.is_err());
    }
}

#[tokio::test]
async fn expiry_refunds_only_unclaimed_and_claim_boundary_is_exact() {
    for program in [anchor_spl::token::ID, token::ID] {
        let mut f = Fixture::new(program).await;
        f.create(vec![10_000_000, 20_000_000]).await.unwrap();
        f.start(0, false, 0).await.unwrap();
        f.claim_slot(0, false).await.unwrap();
        let state = f.state().await;
        f.now(state.expires_at - 1).await;
        f.start(1, true, 0).await.unwrap();
        assert_eq!(f.state().await.slots[1].priority_until, state.expires_at);
        f.now(state.expires_at).await;
        error(f.claim_slot(1, true).await, EscrowError::LinkExpired);
        error(f.refund(None, false, true).await, EscrowError::LinkExpired);
        f.refund(None, true, false).await.unwrap();
        assert_eq!(f.amount(f.sender.pubkey()).await, 990_000_000);
        assert_eq!(f.state().await.slots[0].status, SlotStatus::Claimed);
    }
}

#[tokio::test]
async fn operation_receipts_prevent_replacement_double_spend() {
    for program in [anchor_spl::token::ID, token::ID] {
        let mut f = Fixture::new(program).await;
        let operation_id = [42; 16];
        let authority = f.sender.pubkey();
        let receipt = Pubkey::find_program_address(
            &[b"operation", authority.as_ref(), &operation_id],
            &muuve_escrow::ID,
        )
        .0;
        let ix = Instruction {
            program_id: muuve_escrow::ID,
            accounts: muuve_escrow::accounts::TransferOnce {
                payer: f.payer.pubkey(),
                authority,
                config: f.config,
                receipt,
                mint: f.mint,
                token_program: f.token,
                source: f.ata(authority),
                destination_owner: f.recipient,
                destination: f.ata(f.recipient),
                associated_token_program: associated::ID,
                system_program: solana_sdk::system_program::ID,
            }
            .to_account_metas(None),
            data: muuve_escrow::instruction::TransferOnce {
                operation_id,
                amount: 10_000_000,
            }
            .data(),
        };
        let sender = Keypair::try_from(f.sender.to_bytes().as_slice()).unwrap();
        f.send(ix.clone(), &[&sender]).await.unwrap();
        let duplicate = f.send(ix, &[&sender]).await.unwrap_err();
        assert!(!format!("{duplicate:?}").contains("ProgramFailedToComplete"));
        assert_eq!(f.amount(f.recipient).await, 10_000_000);
        assert_eq!(f.amount(authority).await, 990_000_000);
        let operation_id = [43; 16];
        let authority = f.mint_authority.pubkey();
        let receipt = Pubkey::find_program_address(
            &[b"operation", authority.as_ref(), &operation_id],
            &muuve_escrow::ID,
        )
        .0;
        let ix = Instruction {
            program_id: muuve_escrow::ID,
            accounts: muuve_escrow::accounts::MintOnce {
                payer: f.payer.pubkey(),
                authority,
                config: f.config,
                receipt,
                mint: f.mint,
                token_program: f.token,
                destination_owner: f.recipient,
                destination: f.ata(f.recipient),
                associated_token_program: associated::ID,
                system_program: solana_sdk::system_program::ID,
            }
            .to_account_metas(None),
            data: muuve_escrow::instruction::MintTestOnce {
                operation_id,
                amount: 1_000_000,
            }
            .data(),
        };
        let authority = Keypair::try_from(f.mint_authority.to_bytes().as_slice()).unwrap();
        f.send(ix.clone(), &[&authority]).await.unwrap();
        assert!(f.send(ix, &[&authority]).await.is_err());
        assert_eq!(f.amount(f.recipient).await, 11_000_000);
    }
}

#[tokio::test]
async fn configuration_rotation_preserves_existing_terms_and_sender_local_ids() {
    let mut f = Fixture::new(token::ID).await;
    f.create(vec![10_000_000]).await.unwrap();
    let before = f.state().await;
    let new_owner = Pubkey::new_unique();
    let treasury = f.ata(new_owner);
    f.ctx.set_account(
        &treasury,
        &solana_sdk::account::AccountSharedData::from(token_account(f.mint, new_owner, 0, f.token)),
    );
    let new_attestor = Pubkey::new_unique();
    let ix = Instruction {
        program_id: muuve_escrow::ID,
        accounts: muuve_escrow::accounts::UpdateConfig {
            admin: f.admin.pubkey(),
            config: f.config,
            mint: f.mint,
            token_program: f.token,
            treasury_owner: new_owner,
            treasury,
        }
        .to_account_metas(None),
        data: muuve_escrow::instruction::UpdateConfig {
            attestor: new_attestor,
            max_slot: 500_000_000,
            max_link: 1_000_000_000,
        }
        .data(),
    };
    let admin = Keypair::try_from(f.admin.to_bytes().as_slice()).unwrap();
    f.send(ix, &[&admin]).await.unwrap();
    let after = f.state().await;
    assert_eq!(after.attestor, before.attestor);
    assert_eq!(after.treasury, before.treasury);
    assert_eq!(after.expires_at, before.expires_at);
    f.start(0, true, 0).await.unwrap();
    f.claim_slot(0, true).await.unwrap();
    let other = Keypair::new();
    f.ctx.set_account(
        &other.pubkey(),
        &solana_sdk::account::AccountSharedData::from(wallet()),
    );
    f.ctx.set_account(
        &f.ata(other.pubkey()),
        &solana_sdk::account::AccountSharedData::from(token_account(
            f.mint,
            other.pubkey(),
            100_000_000,
            f.token,
        )),
    );
    f.sender = other;
    f.link = Pubkey::find_program_address(
        &[b"link", f.sender.pubkey().as_ref(), &f.id],
        &muuve_escrow::ID,
    )
    .0;
    f.create(vec![1_000_000]).await.unwrap();
    assert_eq!(f.state().await.attestor, new_attestor);
}

#[tokio::test]
#[ignore = "requires a built SBF artifact via MUUVE_SBF_SO; native processors cannot impersonate upgradeable-loader programs"]
async fn bootstrap_requires_legitimate_upgrade_authority() {
    let mut f = Fixture::new(token::ID).await;
    let loader = solana_sdk::bpf_loader_upgradeable::ID;
    let program_data = Pubkey::find_program_address(&[muuve_escrow::ID.as_ref()], &loader).0;
    let mut program_bytes = 2u32.to_le_bytes().to_vec();
    program_bytes.extend_from_slice(program_data.as_ref());
    let mut metadata = 3u32.to_le_bytes().to_vec();
    metadata.extend_from_slice(&0u64.to_le_bytes());
    metadata.push(1);
    metadata.extend_from_slice(f.admin.pubkey().as_ref());
    metadata.extend_from_slice(
        &std::fs::read(std::env::var("MUUVE_SBF_SO").expect("SBF artifact required")).unwrap(),
    );
    f.ctx.set_account(
        &muuve_escrow::ID,
        &solana_sdk::account::AccountSharedData::from(Account {
            lamports: 10_000_000,
            data: program_bytes,
            owner: loader,
            executable: true,
            rent_epoch: 0,
        }),
    );
    f.ctx.set_account(
        &program_data,
        &solana_sdk::account::AccountSharedData::from(Account {
            lamports: 10_000_000,
            data: metadata,
            owner: loader,
            executable: false,
            rent_epoch: 0,
        }),
    );
    f.ctx.set_account(
        &f.config,
        &solana_sdk::account::AccountSharedData::default(),
    );
    let make = |authority: Pubkey| Instruction {
        program_id: muuve_escrow::ID,
        accounts: muuve_escrow::accounts::InitConfig {
            payer: f.payer.pubkey(),
            admin: authority,
            deployment_authority: authority,
            program: muuve_escrow::ID,
            program_data,
            config: f.config,
            mint: f.mint,
            treasury: f.ata(f.treasury_owner),
            treasury_owner: f.treasury_owner,
            token_program: f.token,
            system_program: solana_sdk::system_program::ID,
        }
        .to_account_metas(None),
        data: muuve_escrow::instruction::InitConfig {
            attestor: f.attestor.pubkey(),
            fee_payer: f.payer.pubkey(),
            max_slot: 500_000_000,
            max_link: 1_000_000_000,
        }
        .data(),
    };
    let wrong = make(f.sender.pubkey());
    let right = make(f.admin.pubkey());
    let sender = Keypair::try_from(f.sender.to_bytes().as_slice()).unwrap();
    error(f.send(wrong, &[&sender]).await, EscrowError::BadAdmin);
    let admin = Keypair::try_from(f.admin.to_bytes().as_slice()).unwrap();
    f.send(right, &[&admin]).await.unwrap();
    let config = f
        .ctx
        .banks_client
        .get_account(f.config)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        Config::try_deserialize(&mut config.data.as_slice())
            .unwrap()
            .admin,
        f.admin.pubkey()
    );
}

#[tokio::test]
async fn recall_all_skips_protected_slots_then_closes_at_priority_boundary() {
    for program in [anchor_spl::token::ID, token::ID] {
        let mut f = Fixture::new(program).await;
        f.create(vec![1_000_000, 2_000_000, 3_000_000])
            .await
            .unwrap();
        f.start(0, false, 0).await.unwrap();
        f.refund(None, false, true).await.unwrap();
        let state = f.state().await;
        assert_eq!(state.open_slots, 1);
        assert_eq!(state.slots[0].status, SlotStatus::Funded);
        assert_eq!(state.slots[1].status, SlotStatus::Recalled);
        error(
            f.refund(None, false, true).await,
            EscrowError::NothingToRefund,
        );
        f.now(state.slots[0].priority_until).await;
        f.refund(None, false, true).await.unwrap();
        assert_eq!(f.state().await.open_slots, 0);
        assert!(f
            .ctx
            .banks_client
            .get_account(f.ata(f.link))
            .await
            .unwrap()
            .is_none());
        assert_eq!(f.amount(f.sender.pubkey()).await, 1_000_000_000);
    }
}

#[tokio::test]
async fn wrong_mint_and_timestamp_overflow_are_atomic_failures() {
    let mut f = Fixture::new(token::ID).await;
    let foreign = Pubkey::new_unique();
    let existing = f
        .ctx
        .banks_client
        .get_account(f.mint)
        .await
        .unwrap()
        .unwrap();
    f.ctx.set_account(
        &foreign,
        &solana_sdk::account::AccountSharedData::from(existing),
    );
    let foreign_sender = associated::get_associated_token_address_with_program_id(
        &f.sender.pubkey(),
        &foreign,
        &f.token,
    );
    let foreign_vault =
        associated::get_associated_token_address_with_program_id(&f.link, &foreign, &f.token);
    f.ctx.set_account(
        &foreign_sender,
        &solana_sdk::account::AccountSharedData::from(token_account(
            foreign,
            f.sender.pubkey(),
            1_000_000,
            f.token,
        )),
    );
    let ix = Instruction {
        program_id: muuve_escrow::ID,
        accounts: muuve_escrow::accounts::CreateLink {
            sender: f.sender.pubkey(),
            payer: f.payer.pubkey(),
            config: f.config,
            link: f.link,
            mint: foreign,
            token_program: f.token,
            sender_ata: foreign_sender,
            vault: foreign_vault,
            associated_token_program: associated::ID,
            system_program: solana_sdk::system_program::ID,
        }
        .to_account_metas(None),
        data: muuve_escrow::instruction::CreateLink {
            link_id: f.id,
            claim_pubkey: f.claim.pubkey(),
            amounts: vec![1],
        }
        .data(),
    };
    let sender = Keypair::try_from(f.sender.to_bytes().as_slice()).unwrap();
    error(f.send(ix, &[&sender]).await, EscrowError::WrongMint);
    f.now(i64::MAX - 10).await;
    error(f.create(vec![1]).await, EscrowError::MathOverflow);
    assert!(f
        .ctx
        .banks_client
        .get_account(f.link)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn original_rent_payer_receives_rent_when_someone_else_sponsors_final_claim() {
    for program in [anchor_spl::token::ID, token::ID] {
        let mut f = Fixture::new(program).await;
        f.create(vec![1_000_000]).await.unwrap();
        f.start(0, false, 0).await.unwrap();
        let sponsor = Keypair::new();
        f.ctx.set_account(
            &sponsor.pubkey(),
            &solana_sdk::account::AccountSharedData::from(wallet()),
        );
        let vault_rent = f
            .ctx
            .banks_client
            .get_account(f.ata(f.link))
            .await
            .unwrap()
            .unwrap()
            .lamports;
        let original_before = f
            .ctx
            .banks_client
            .get_account(f.payer.pubkey())
            .await
            .unwrap()
            .unwrap()
            .lamports;
        let mut settlement = f.settle_accounts(f.recipient);
        settlement.payer = sponsor.pubkey();
        let ix = Instruction {
            program_id: muuve_escrow::ID,
            accounts: muuve_escrow::accounts::Claim {
                settlement,
                claim_key: f.claim.pubkey(),
                attestor: f.attestor.pubkey(),
            }
            .to_account_metas(None),
            data: muuve_escrow::instruction::ClaimToWallet {
                slot_index: 0,
                intent_id: [1; 16],
                version: 1,
            }
            .data(),
        };
        let blockhash = f.ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&sponsor.pubkey()),
            &[&sponsor, &f.claim, &f.attestor],
            blockhash,
        );
        f.ctx.banks_client.process_transaction(tx).await.unwrap();
        let original_after = f
            .ctx
            .banks_client
            .get_account(f.payer.pubkey())
            .await
            .unwrap()
            .unwrap()
            .lamports;
        assert_eq!(original_after - original_before, vault_rent);
        assert_eq!(f.amount(f.recipient).await, 1_000_000);
    }
}

#[tokio::test]
async fn competing_claim_and_recall_release_principal_once_after_priority_ends() {
    let mut f = Fixture::new(token::ID).await;
    f.create(vec![1_000_000, 2_000_000]).await.unwrap();
    f.start(0, false, 0).await.unwrap();
    let state = f.state().await;
    f.now(state.slots[0].priority_until).await;
    let claim = Instruction {
        program_id: muuve_escrow::ID,
        accounts: muuve_escrow::accounts::Claim {
            settlement: f.settle_accounts(f.recipient),
            claim_key: f.claim.pubkey(),
            attestor: f.attestor.pubkey(),
        }
        .to_account_metas(None),
        data: muuve_escrow::instruction::ClaimToWallet {
            slot_index: 0,
            intent_id: [1; 16],
            version: 1,
        }
        .data(),
    };
    let mut accounts = f.settle_accounts(f.sender.pubkey()).to_account_metas(None);
    accounts[2].is_signer = true;
    let recall = Instruction {
        program_id: muuve_escrow::ID,
        accounts,
        data: muuve_escrow::instruction::RecallSlot { slot_index: 0 }.data(),
    };
    let hash = f.ctx.banks_client.get_latest_blockhash().await.unwrap();
    let claim_tx = Transaction::new_signed_with_payer(
        &[claim],
        Some(&f.payer.pubkey()),
        &[&f.payer, &f.claim, &f.attestor],
        hash,
    );
    let recall_tx = Transaction::new_signed_with_payer(
        &[recall],
        Some(&f.payer.pubkey()),
        &[&f.payer, &f.sender],
        hash,
    );
    let mut one = f.ctx.banks_client.clone();
    let mut two = f.ctx.banks_client.clone();
    let (a, b) = tokio::join!(
        one.process_transaction(claim_tx),
        two.process_transaction(recall_tx)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let after = f.state().await;
    assert_eq!(after.open_slots, 1);
    assert_eq!(after.slots[1].amount, 2_000_000);
    assert_eq!(f.amount(f.link).await, 2_000_000);
    assert!(matches!(
        after.slots[0].status,
        SlotStatus::Claimed | SlotStatus::Recalled
    ));
}
