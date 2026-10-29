#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    state::{Account as SplAccount, Mint as SplMint},
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked},
};
include!(concat!(env!("OUT_DIR"), "/program_id.rs"));

pub const MAX_SLOTS: usize = 10;
pub const CLAIM_WINDOW: i64 = 172_800;
pub const PRIORITY_WINDOW: i64 = 120;

#[program]
pub mod muuve_escrow {
    use super::*;

    pub fn init_config(
        ctx: Context<InitConfig>,
        attestor: Pubkey,
        fee_payer: Pubkey,
        max_slot: u64,
        max_link: u64,
    ) -> Result<()> {
        validate_mint(
            &ctx.accounts.mint.to_account_info(),
            ctx.accounts.token_program.key(),
        )?;
        validate_token(
            &ctx.accounts.treasury.to_account_info(),
            ctx.accounts.token_program.key(),
        )?;
        limits(max_slot, max_link)?;
        let authority = ctx
            .accounts
            .mint
            .mint_authority
            .ok_or(EscrowError::WrongMint)?;
        let roles = [
            ctx.accounts.admin.key(),
            attestor,
            fee_payer,
            ctx.accounts.treasury.owner,
            authority,
        ];
        for (i, key) in roles.iter().enumerate() {
            require!(
                *key != Pubkey::default() && !roles[..i].contains(key),
                EscrowError::RoleCollision
            );
        }
        ctx.accounts.config.set_inner(Config {
            admin: roles[0],
            attestor,
            fee_payer,
            mint: ctx.accounts.mint.key(),
            token_program: ctx.accounts.token_program.key(),
            treasury: ctx.accounts.treasury.key(),
            treasury_owner: ctx.accounts.treasury.owner,
            mint_authority: authority,
            max_slot,
            max_link,
            claim_window: CLAIM_WINDOW,
            bump: ctx.bumps.config,
        });
        Ok(())
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        attestor: Pubkey,
        max_slot: u64,
        max_link: u64,
    ) -> Result<()> {
        limits(max_slot, max_link)?;
        validate_mint(
            &ctx.accounts.mint.to_account_info(),
            ctx.accounts.config.token_program,
        )?;
        validate_token(
            &ctx.accounts.treasury.to_account_info(),
            ctx.accounts.config.token_program,
        )?;
        let c = &mut ctx.accounts.config;
        let roles = [
            c.admin,
            attestor,
            c.fee_payer,
            ctx.accounts.treasury.owner,
            c.mint_authority,
        ];
        for (i, key) in roles.iter().enumerate() {
            require!(
                *key != Pubkey::default() && !roles[..i].contains(key),
                EscrowError::RoleCollision
            );
        }
        c.attestor = attestor;
        c.treasury = ctx.accounts.treasury.key();
        c.treasury_owner = ctx.accounts.treasury.owner;
        c.max_slot = max_slot;
        c.max_link = max_link;
        Ok(())
    }

    pub fn create_link(
        ctx: Context<CreateLink>,
        link_id: [u8; 16],
        claim_pubkey: Pubkey,
        amounts: Vec<u64>,
    ) -> Result<()> {
        validate_mint(
            &ctx.accounts.mint.to_account_info(),
            ctx.accounts.token_program.key(),
        )?;
        validate_token(
            &ctx.accounts.sender_ata.to_account_info(),
            ctx.accounts.token_program.key(),
        )?;
        validate_token(
            &ctx.accounts.vault.to_account_info(),
            ctx.accounts.token_program.key(),
        )?;
        require!(claim_pubkey != Pubkey::default(), EscrowError::BadClaimKey);
        let now = Clock::get()?.unix_timestamp;
        let total = checked_total(
            &amounts,
            ctx.accounts.config.max_slot,
            ctx.accounts.config.max_link,
        )?;
        let link = &mut ctx.accounts.link;
        link.set_inner(Link {
            link_id,
            sender: ctx.accounts.sender.key(),
            rent_payer: ctx.accounts.payer.key(),
            claim_pubkey,
            mint: ctx.accounts.mint.key(),
            token_program: ctx.accounts.token_program.key(),
            attestor: ctx.accounts.config.attestor,
            treasury: ctx.accounts.config.treasury,
            treasury_owner: ctx.accounts.config.treasury_owner,
            created_at: now,
            expires_at: now
                .checked_add(ctx.accounts.config.claim_window)
                .ok_or(EscrowError::MathOverflow)?,
            total,
            slot_count: amounts.len() as u8,
            open_slots: amounts.len() as u8,
            slots: [Slot::default(); MAX_SLOTS],
            bump: ctx.bumps.link,
        });
        for (i, amount) in amounts.iter().enumerate() {
            link.slots[i].amount = *amount;
            link.slots[i].status = SlotStatus::Funded;
        }
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.sender_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            total,
            6,
        )?;
        emit!(LinkCreated {
            link: link.key(),
            sender: link.sender,
            total,
            slot_count: link.slot_count,
            expires_at: link.expires_at
        });
        Ok(())
    }

    pub fn start_claim(
        ctx: Context<StartClaim>,
        slot_index: u8,
        intent_id: [u8; 16],
        expected_version: u64,
        destination: Pubkey,
        to_treasury: bool,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let link = &mut ctx.accounts.link;
        require!(now < link.expires_at, EscrowError::LinkExpired);
        require!(
            intent_id != [0; 16] && destination != Pubkey::default(),
            EscrowError::BadIntent
        );
        if to_treasury {
            require_keys_eq!(destination, link.treasury, EscrowError::WrongTreasury);
        }
        let expires_at = link.expires_at;
        let slot = link.funded_mut(slot_index)?;
        require!(slot.version == expected_version, EscrowError::BadIntent);
        if slot.version == 0 {
            slot.priority_until = now
                .checked_add(PRIORITY_WINDOW)
                .ok_or(EscrowError::MathOverflow)?
                .min(expires_at);
        }
        slot.version = slot
            .version
            .checked_add(1)
            .ok_or(EscrowError::MathOverflow)?;
        slot.intent_id = intent_id;
        slot.destination = destination;
        slot.to_treasury = to_treasury;
        emit!(ClaimStarted {
            link: link.key(),
            slot_index,
            intent_id,
            priority_until: link.slots[slot_index as usize].priority_until
        });
        Ok(())
    }

    pub fn claim_to_wallet(
        ctx: Context<Claim>,
        slot_index: u8,
        intent_id: [u8; 16],
        version: u64,
    ) -> Result<()> {
        claim(ctx, slot_index, intent_id, version, false)
    }
    pub fn claim_to_treasury(
        ctx: Context<Claim>,
        slot_index: u8,
        intent_id: [u8; 16],
        version: u64,
    ) -> Result<()> {
        claim(ctx, slot_index, intent_id, version, true)
    }
    pub fn recall_slot(ctx: Context<Settle>, slot_index: u8) -> Result<()> {
        require!(ctx.accounts.sender.is_signer, EscrowError::NotSender);
        let now = Clock::get()?.unix_timestamp;
        require!(now < ctx.accounts.link.expires_at, EscrowError::LinkExpired);
        let slot = ctx.accounts.link.funded_mut(slot_index)?;
        require!(!slot.protected(now), EscrowError::ClaimInProgress);
        let amount = slot.amount;
        transfer(
            &ctx.accounts,
            ctx.accounts.sender_ata.to_account_info(),
            amount,
        )?;
        ctx.accounts.link.finish(slot_index, SlotStatus::Recalled)?;
        emit!(SlotRecalled {
            link: ctx.accounts.link.key(),
            slot_index,
            amount
        });
        close_if_done(ctx.accounts)
    }
    pub fn recall_all(ctx: Context<Settle>) -> Result<()> {
        require!(ctx.accounts.sender.is_signer, EscrowError::NotSender);
        let now = Clock::get()?.unix_timestamp;
        require!(now < ctx.accounts.link.expires_at, EscrowError::LinkExpired);
        refund_all(ctx.accounts, now, false)
    }
    pub fn expire(ctx: Context<Settle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now >= ctx.accounts.link.expires_at, EscrowError::NotExpired);
        refund_all(ctx.accounts, now, true)
    }
    // On-chain receipts make blockhash replacements safe for treasury/wallet transfers too.
    pub fn transfer_once(
        ctx: Context<TransferOnce>,
        operation_id: [u8; 16],
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        validate_mint(
            &ctx.accounts.mint.to_account_info(),
            ctx.accounts.token_program.key(),
        )?;
        validate_token(
            &ctx.accounts.source.to_account_info(),
            ctx.accounts.token_program.key(),
        )?;
        validate_token(
            &ctx.accounts.destination.to_account_info(),
            ctx.accounts.token_program.key(),
        )?;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
            6,
        )?;
        ctx.accounts.receipt.set_inner(OperationReceipt {
            operation_id,
            authority: ctx.accounts.authority.key(),
            destination: ctx.accounts.destination.key(),
            amount,
            kind: 0,
        });
        Ok(())
    }
    pub fn mint_test_once(
        ctx: Context<MintOnce>,
        operation_id: [u8; 16],
        amount: u64,
    ) -> Result<()> {
        require!(
            amount > 0 && amount <= 200_000_000,
            EscrowError::InvalidAmount
        );
        validate_mint(
            &ctx.accounts.mint.to_account_info(),
            ctx.accounts.token_program.key(),
        )?;
        validate_token(
            &ctx.accounts.destination.to_account_info(),
            ctx.accounts.token_program.key(),
        )?;
        token_interface::mint_to(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token_interface::MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
        )?;
        ctx.accounts.receipt.set_inner(OperationReceipt {
            operation_id,
            authority: ctx.accounts.authority.key(),
            destination: ctx.accounts.destination.key(),
            amount,
            kind: 1,
        });
        Ok(())
    }
}

fn claim(ctx: Context<Claim>, index: u8, id: [u8; 16], version: u64, treasury: bool) -> Result<()> {
    let a = &mut ctx.accounts.settlement;
    require!(
        Clock::get()?.unix_timestamp < a.link.expires_at,
        EscrowError::LinkExpired
    );
    let slot = a.link.funded_mut(index)?;
    require!(
        slot.version > 0
            && slot.version == version
            && slot.intent_id == id
            && slot.to_treasury == treasury,
        EscrowError::BadIntent
    );
    require_keys_eq!(
        slot.destination,
        a.destination.key(),
        EscrowError::WrongDestination
    );
    if treasury {
        require_keys_eq!(
            a.destination.key(),
            a.link.treasury,
            EscrowError::WrongTreasury
        );
    }
    let amount = a.link.slots[index as usize].amount;
    transfer(a, a.destination.to_account_info(), amount)?;
    a.link.finish(index, SlotStatus::Claimed)?;
    emit!(SlotClaimed {
        link: a.link.key(),
        slot_index: index,
        destination: a.destination.key(),
        amount,
        to_treasury: treasury
    });
    close_if_done(a)
}

fn refund_all(a: &mut Settle, now: i64, expired: bool) -> Result<()> {
    let mut total = 0u64;
    let mut indices = Vec::new();
    for i in 0..a.link.slot_count as usize {
        let slot = &a.link.slots[i];
        if slot.status == SlotStatus::Funded && (expired || !slot.protected(now)) {
            total = total
                .checked_add(slot.amount)
                .ok_or(EscrowError::MathOverflow)?;
            indices.push(i as u8);
        }
    }
    require!(!indices.is_empty(), EscrowError::NothingToRefund);
    transfer(a, a.sender_ata.to_account_info(), total)?;
    for i in &indices {
        let amount = a.link.slots[*i as usize].amount;
        a.link.finish(
            *i,
            if expired {
                SlotStatus::Expired
            } else {
                SlotStatus::Recalled
            },
        )?;
        if !expired {
            emit!(SlotRecalled {
                link: a.link.key(),
                slot_index: *i,
                amount
            });
        }
    }
    if expired {
        emit!(LinkExpired {
            link: a.link.key(),
            refunded_slots: indices.len() as u8,
            amount: total
        });
    }
    close_if_done(a)
}

fn transfer<'info>(a: &Settle<'info>, destination: AccountInfo<'info>, amount: u64) -> Result<()> {
    validate_mint(&a.mint.to_account_info(), a.token_program.key())?;
    validate_token(&a.vault.to_account_info(), a.token_program.key())?;
    validate_token(&destination, a.token_program.key())?;
    let bump = [a.link.bump];
    let seeds: &[&[u8]] = &[b"link", a.link.sender.as_ref(), &a.link.link_id, &bump];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            TransferChecked {
                from: a.vault.to_account_info(),
                mint: a.mint.to_account_info(),
                to: destination,
                authority: a.link.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        6,
    )
}

fn close_if_done(a: &mut Settle) -> Result<()> {
    if a.link.open_slots != 0 {
        return Ok(());
    }
    a.vault.reload()?;
    if a.vault.amount > 0 {
        let surplus = a.vault.amount;
        transfer(a, a.sender_ata.to_account_info(), surplus)?;
        emit!(SurplusReturned {
            link: a.link.key(),
            amount: surplus,
            sender: a.link.sender
        });
    }
    let bump = [a.link.bump];
    let seeds: &[&[u8]] = &[b"link", a.link.sender.as_ref(), &a.link.link_id, &bump];
    token_interface::close_account(CpiContext::new_with_signer(
        a.token_program.to_account_info(),
        CloseAccount {
            account: a.vault.to_account_info(),
            destination: a.rent_beneficiary.to_account_info(),
            authority: a.link.to_account_info(),
        },
        &[seeds],
    ))
}

pub fn checked_total(amounts: &[u64], max_slot: u64, max_link: u64) -> Result<u64> {
    require!(
        !amounts.is_empty() && amounts.len() <= MAX_SLOTS,
        EscrowError::InvalidSlotCount
    );
    let mut total = 0u64;
    for amount in amounts {
        require!(
            *amount > 0 && *amount <= max_slot,
            EscrowError::InvalidAmount
        );
        total = total
            .checked_add(*amount)
            .ok_or(EscrowError::MathOverflow)?;
    }
    require!(total <= max_link, EscrowError::LinkTooLarge);
    Ok(total)
}
fn limits(slot: u64, link: u64) -> Result<()> {
    require!(
        slot > 0 && slot <= 500_000_000 && link >= slot && link <= 1_000_000_000,
        EscrowError::InvalidAmount
    );
    Ok(())
}
pub fn validate_mint(info: &AccountInfo, program: Pubkey) -> Result<()> {
    require_keys_eq!(*info.owner, program, EscrowError::WrongMint);
    require!(
        program == anchor_spl::token::ID || program == anchor_spl::token_2022::ID,
        EscrowError::WrongTokenProgram
    );
    let data = info.try_borrow_data()?;
    let state = StateWithExtensions::<SplMint>::unpack(&data)
        .map_err(|_| error!(EscrowError::WrongMint))?;
    require!(
        state.base.decimals == 6 && state.base.freeze_authority.is_none(),
        EscrowError::WrongMint
    );
    require!(
        state.get_extension_types()?.is_empty(),
        EscrowError::UnsupportedExtension
    );
    Ok(())
}
pub fn validate_token(info: &AccountInfo, program: Pubkey) -> Result<()> {
    require_keys_eq!(*info.owner, program, EscrowError::WrongTokenProgram);
    let data = info.try_borrow_data()?;
    let state = StateWithExtensions::<SplAccount>::unpack(&data)
        .map_err(|_| error!(EscrowError::WrongDestination))?;
    require!(
        state
            .get_extension_types()?
            .iter()
            .all(|x| *x == ExtensionType::ImmutableOwner),
        EscrowError::UnsupportedExtension
    );
    require!(
        state.base.delegate.is_none() && state.base.close_authority.is_none(),
        EscrowError::WrongDestination
    );
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub attestor: Pubkey,
    pub fee_payer: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub treasury: Pubkey,
    pub treasury_owner: Pubkey,
    pub mint_authority: Pubkey,
    pub max_slot: u64,
    pub max_link: u64,
    pub claim_window: i64,
    pub bump: u8,
}
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, Debug, InitSpace,
)]
pub enum SlotStatus {
    #[default]
    Empty,
    Funded,
    Claimed,
    Recalled,
    Expired,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Slot {
    pub amount: u64,
    pub status: SlotStatus,
    pub intent_id: [u8; 16],
    pub version: u64,
    pub priority_until: i64,
    pub destination: Pubkey,
    pub to_treasury: bool,
}
impl Slot {
    pub fn protected(&self, now: i64) -> bool {
        self.version > 0 && now < self.priority_until
    }
}
#[account]
#[derive(InitSpace)]
pub struct Link {
    pub link_id: [u8; 16],
    pub sender: Pubkey,
    pub rent_payer: Pubkey,
    pub claim_pubkey: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub attestor: Pubkey,
    pub treasury: Pubkey,
    pub treasury_owner: Pubkey,
    pub created_at: i64,
    pub expires_at: i64,
    pub total: u64,
    pub slot_count: u8,
    pub open_slots: u8,
    pub slots: [Slot; MAX_SLOTS],
    pub bump: u8,
}
#[account]
#[derive(InitSpace)]
pub struct OperationReceipt {
    pub operation_id: [u8; 16],
    pub authority: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub kind: u8,
}
impl Link {
    pub fn funded_mut(&mut self, index: u8) -> Result<&mut Slot> {
        require!(index < self.slot_count, EscrowError::BadSlotIndex);
        let slot = &mut self.slots[index as usize];
        require!(
            slot.status == SlotStatus::Funded,
            EscrowError::SlotNotFunded
        );
        Ok(slot)
    }
    pub fn finish(&mut self, index: u8, status: SlotStatus) -> Result<()> {
        self.funded_mut(index)?.status = status;
        self.open_slots = self
            .open_slots
            .checked_sub(1)
            .ok_or(EscrowError::MathOverflow)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub admin: Signer<'info>,
    pub deployment_authority: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ EscrowError::BadAdmin)]
    pub program: Program<'info, crate::program::MuuveEscrow>,
    #[account(constraint = program_data.upgrade_authority_address == Some(deployment_authority.key()) @ EscrowError::BadAdmin)]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer=payer, space=8+Config::INIT_SPACE, seeds=[b"config"], bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mint::token_program=token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(associated_token::mint=mint, associated_token::authority=treasury_owner, associated_token::token_program=token_program)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: ATA constraint proves treasury token ownership; role separation checked in handler.
    pub treasury_owner: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds=[b"config"], bump=config.bump, has_one=admin @ EscrowError::BadAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(address=config.mint, owner=config.token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address=config.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: used solely as constrained ATA owner.
    pub treasury_owner: UncheckedAccount<'info>,
    #[account(associated_token::mint=mint, associated_token::authority=treasury_owner, associated_token::token_program=token_program)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,
}
#[derive(Accounts)]
#[instruction(link_id: [u8;16])]
pub struct CreateLink<'info> {
    pub sender: Signer<'info>,
    #[account(mut, address=config.fee_payer)]
    pub payer: Signer<'info>,
    #[account(seeds=[b"config"], bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer=payer, space=8+Link::INIT_SPACE, seeds=[b"link", sender.key().as_ref(), &link_id], bump)]
    pub link: Box<Account<'info, Link>>,
    #[account(address=config.mint @ EscrowError::WrongMint, mint::token_program=token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address=config.token_program @ EscrowError::WrongTokenProgram)]
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut, associated_token::mint=mint, associated_token::authority=sender, associated_token::token_program=token_program)]
    pub sender_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer=payer, associated_token::mint=mint, associated_token::authority=link, associated_token::token_program=token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct StartClaim<'info> {
    #[account(mut, seeds=[b"link", link.sender.as_ref(), &link.link_id], bump=link.bump)]
    pub link: Box<Account<'info, Link>>,
    #[account(address=link.claim_pubkey @ EscrowError::BadClaimKey)]
    pub claim_key: Signer<'info>,
    #[account(address=link.attestor @ EscrowError::BadAttestor)]
    pub attestor: Signer<'info>,
}
#[derive(Accounts)]
pub struct Claim<'info> {
    pub settlement: Settle<'info>,
    #[account(address=settlement.link.claim_pubkey @ EscrowError::BadClaimKey)]
    pub claim_key: Signer<'info>,
    #[account(address=settlement.link.attestor @ EscrowError::BadAttestor)]
    pub attestor: Signer<'info>,
}
#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds=[b"link", link.sender.as_ref(), &link.link_id], bump=link.bump)]
    pub link: Box<Account<'info, Link>>,
    /// CHECK: original sender constrained; recall additionally requires its signature.
    #[account(address=link.sender @ EscrowError::NotSender)]
    pub sender: UncheckedAccount<'info>,
    #[account(address=link.mint @ EscrowError::WrongMint, mint::token_program=token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address=link.token_program @ EscrowError::WrongTokenProgram)]
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut, associated_token::mint=mint, associated_token::authority=link, associated_token::token_program=token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init_if_needed, payer=payer, associated_token::mint=mint, associated_token::authority=sender, associated_token::token_program=token_program)]
    pub sender_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: destination ATA constraint verifies its token owner. Intent binds exact ATA.
    pub destination_owner: UncheckedAccount<'info>,
    #[account(init_if_needed, payer=payer, associated_token::mint=mint, associated_token::authority=destination_owner, associated_token::token_program=token_program)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: immutable recorded rent beneficiary, never caller chosen.
    #[account(mut, address=link.rent_payer @ EscrowError::WrongRentPayer)]
    pub rent_beneficiary: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(operation_id:[u8;16])]
pub struct TransferOnce<'info> {
    #[account(mut,address=config.fee_payer)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(seeds=[b"config"],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init,payer=payer,space=8+OperationReceipt::INIT_SPACE,seeds=[b"operation",authority.key().as_ref(),&operation_id],bump)]
    pub receipt: Account<'info, OperationReceipt>,
    #[account(address=config.mint,mint::token_program=token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address=config.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut,associated_token::mint=mint,associated_token::authority=authority,associated_token::token_program=token_program)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: ATA authority only.
    pub destination_owner: UncheckedAccount<'info>,
    #[account(init_if_needed,payer=payer,associated_token::mint=mint,associated_token::authority=destination_owner,associated_token::token_program=token_program)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(operation_id:[u8;16])]
pub struct MintOnce<'info> {
    #[account(mut,address=config.fee_payer)]
    pub payer: Signer<'info>,
    #[account(address=config.mint_authority)]
    pub authority: Signer<'info>,
    #[account(seeds=[b"config"],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init,payer=payer,space=8+OperationReceipt::INIT_SPACE,seeds=[b"operation",authority.key().as_ref(),&operation_id],bump)]
    pub receipt: Account<'info, OperationReceipt>,
    #[account(mut,address=config.mint,mint::token_program=token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address=config.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: ATA authority only.
    pub destination_owner: UncheckedAccount<'info>,
    #[account(init_if_needed,payer=payer,associated_token::mint=mint,associated_token::authority=destination_owner,associated_token::token_program=token_program)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct LinkCreated {
    pub link: Pubkey,
    pub sender: Pubkey,
    pub total: u64,
    pub slot_count: u8,
    pub expires_at: i64,
}
#[event]
pub struct ClaimStarted {
    pub link: Pubkey,
    pub slot_index: u8,
    pub intent_id: [u8; 16],
    pub priority_until: i64,
}
#[event]
pub struct SlotClaimed {
    pub link: Pubkey,
    pub slot_index: u8,
    pub destination: Pubkey,
    pub amount: u64,
    pub to_treasury: bool,
}
#[event]
pub struct SlotRecalled {
    pub link: Pubkey,
    pub slot_index: u8,
    pub amount: u64,
}
#[event]
pub struct LinkExpired {
    pub link: Pubkey,
    pub refunded_slots: u8,
    pub amount: u64,
}
#[event]
pub struct SurplusReturned {
    pub link: Pubkey,
    pub amount: u64,
    pub sender: Pubkey,
}

#[error_code]
pub enum EscrowError {
    #[msg("Invalid slot count")]
    InvalidSlotCount,
    #[msg("Invalid allocation or limit")]
    InvalidAmount,
    #[msg("Link exceeds maximum")]
    LinkTooLarge,
    #[msg("Wrong mint or unsupported authority/decimals")]
    WrongMint,
    #[msg("Invalid slot index")]
    BadSlotIndex,
    #[msg("Slot no longer funded")]
    SlotNotFunded,
    #[msg("Link expired")]
    LinkExpired,
    #[msg("Link has not expired")]
    NotExpired,
    #[msg("No eligible principal to refund")]
    NothingToRefund,
    #[msg("Wrong claim key")]
    BadClaimKey,
    #[msg("Wrong attestor")]
    BadAttestor,
    #[msg("Sender signature required")]
    NotSender,
    #[msg("Wrong treasury")]
    WrongTreasury,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Unauthorized configuration authority")]
    BadAdmin,
    #[msg("Roles must be distinct")]
    RoleCollision,
    #[msg("Unsupported token program")]
    WrongTokenProgram,
    #[msg("Unsupported token extension")]
    UnsupportedExtension,
    #[msg("Wrong token destination")]
    WrongDestination,
    #[msg("Wrong rent beneficiary")]
    WrongRentPayer,
    #[msg("Stale or invalid claim intent")]
    BadIntent,
    #[msg("Recipient currently has priority")]
    ClaimInProgress,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_and_overflow() {
        assert!(checked_total(&[], 10, 100).is_err());
        assert!(checked_total(&[1; 11], 10, 100).is_err());
        assert!(checked_total(&[0], 10, 100).is_err());
        assert!(checked_total(&[11], 10, 100).is_err());
        assert!(checked_total(&[10, 10], 10, 19).is_err());
        assert!(checked_total(&[u64::MAX, 1], u64::MAX, u64::MAX).is_err());
        assert_eq!(checked_total(&[1, 2, 3], 3, 6).unwrap(), 6);
    }
    #[test]
    fn priority_boundary() {
        let s = Slot {
            version: 1,
            priority_until: 120,
            ..Slot::default()
        };
        assert!(s.protected(119));
        assert!(!s.protected(120));
    }
    #[test]
    fn token_2022_extension_allowlist() {
        use anchor_lang::solana_program::program_option::COption;
        use anchor_spl::token_2022::spl_token_2022::extension::{
            transfer_fee::TransferFeeConfig, BaseStateWithExtensionsMut, StateWithExtensionsMut,
        };
        let owner = anchor_spl::token_2022::ID;
        let key = Pubkey::new_unique();
        let mut rent = 10_000_000;
        let len = ExtensionType::try_calculate_account_len::<SplMint>(&[
            ExtensionType::TransferFeeConfig,
        ])
        .unwrap();
        let mut data = vec![0; len];
        {
            let mut state =
                StateWithExtensionsMut::<SplMint>::unpack_uninitialized(&mut data).unwrap();
            state.init_extension::<TransferFeeConfig>(true).unwrap();
            state.base = SplMint {
                mint_authority: COption::Some(Pubkey::new_unique()),
                supply: 0,
                decimals: 6,
                is_initialized: true,
                freeze_authority: COption::None,
            };
            state.pack_base();
            state.init_account_type().unwrap();
        }
        let info = AccountInfo::new(&key, false, false, &mut rent, &mut data, &owner, false, 0);
        assert!(validate_mint(&info, owner).is_err());
    }
}
