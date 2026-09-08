//! TWZRD lock vault. PDA ["lock", locker]. Classic SPL only.

use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed, set_return_data},
    program_error::ProgramError,
    program_option::COption,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};
use spl_token::state::{Account as TokenAccount, AccountState, Mint};

pub mod grant;
mod state;
use grant::{grant_from_lock, UNBOND_SECS};
use state::{LockState, LOCK_LEN, STATE_VERSION};

solana_program::declare_id!("4FGcyxUtzqMJG4HqtYPiGk7zCMn75N5aLSCDFe3BJPjB");

const LOCK_SEED: &[u8] = b"lock";
const TOKEN_MINT: Pubkey = solana_program::pubkey!("PovfzmSRWs1spwusPpW3ED3B2o26Zhsm8CSDWeXciV3");
const ATA_PROGRAM: Pubkey = solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const GET_LOCK_LEN: usize = 40;

#[repr(u32)]
enum VaultError {
    WrongMint = 0,
    InvalidTokenAccount = 1,
    Unbonding = 2,
    NotUnbonding = 3,
    UnbondPending = 4,
    EmptyLock = 5,
    InvalidClock = 6,
}

impl From<VaultError> for ProgramError {
    fn from(error: VaultError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match data {
        [0, amount @ ..] if amount.len() == 8 => lock(
            program_id,
            accounts,
            u64::from_le_bytes(amount.try_into().unwrap()),
        ),
        [1] => get_lock(program_id, accounts),
        [2] => start_unbond(program_id, accounts),
        [3] => withdraw(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn lock_pda(program_id: &Pubkey, locker: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[LOCK_SEED, locker.as_ref()], program_id)
}

fn check_pda(program_id: &Pubkey, locker: &Pubkey, key: &Pubkey) -> Result<u8, ProgramError> {
    let (pda, bump) = lock_pda(program_id, locker);
    if key != &pda {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(bump)
}

fn read_state(program_id: &Pubkey, account: &AccountInfo) -> Result<LockState, ProgramError> {
    if account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    LockState::unpack(&account.try_borrow_data()?)
}

fn check_signer(locker: &AccountInfo, lock_acc: &AccountInfo) -> ProgramResult {
    if !locker.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !lock_acc.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

fn lock_clock(state: &LockState) -> Result<i64, ProgramError> {
    let now = Clock::get()?.unix_timestamp;
    if now <= 0 || now < state.lock_time {
        return Err(VaultError::InvalidClock.into());
    }
    Ok(now)
}

fn get_lock(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let [locker, lock_acc] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    check_pda(program_id, locker.key, lock_acc.key)?;
    let state = read_state(program_id, lock_acc)?;
    let grant = grant_from_lock(state.amount, state.unbond_ts);
    let mut out = [0u8; GET_LOCK_LEN];
    out[0..8].copy_from_slice(&grant.amount.to_le_bytes());
    out[8..16].copy_from_slice(&grant.cap_usd.to_le_bytes());
    out[16..24].copy_from_slice(&grant.unbond_ts.to_le_bytes());
    out[24..26].copy_from_slice(&grant.wallets.to_le_bytes());
    out[26..28].copy_from_slice(&grant.qps.to_le_bytes());
    out[28..30].copy_from_slice(&grant.window_h.to_le_bytes());
    out[30] = STATE_VERSION;
    out[32..40].copy_from_slice(&state.lock_time.to_le_bytes());
    set_return_data(&out);
    Ok(())
}

fn start_unbond(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let [locker, lock_acc] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    check_signer(locker, lock_acc)?;
    check_pda(program_id, locker.key, lock_acc.key)?;
    let mut state = read_state(program_id, lock_acc)?;
    if state.amount == 0 {
        return Err(VaultError::EmptyLock.into());
    }
    if state.unbond_ts != 0 {
        return Err(VaultError::Unbonding.into());
    }
    state.unbond_ts = lock_clock(&state)?;
    state.pack(&mut lock_acc.try_borrow_mut_data()?);
    Ok(())
}

struct TokenAccounts<'a, 'info> {
    locker: &'a AccountInfo<'info>,
    source: &'a AccountInfo<'info>,
    lock_acc: &'a AccountInfo<'info>,
    vault: &'a AccountInfo<'info>,
    mint: &'a AccountInfo<'info>,
    token: &'a AccountInfo<'info>,
    system: &'a AccountInfo<'info>,
    ata: &'a AccountInfo<'info>,
    bump: u8,
}

impl<'a, 'info> TokenAccounts<'a, 'info> {
    fn parse(
        program_id: &Pubkey,
        accounts: &'a [AccountInfo<'info>],
    ) -> Result<Self, ProgramError> {
        let [locker, source, lock_acc, vault, mint, token, system, ata] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };
        check_signer(locker, lock_acc)?;
        if !locker.is_writable || !source.is_writable || !vault.is_writable {
            return Err(ProgramError::InvalidAccountData);
        }
        if mint.key != &TOKEN_MINT {
            return Err(VaultError::WrongMint.into());
        }
        if token.key != &spl_token::id()
            || ata.key != &ATA_PROGRAM
            || system.key != &system_program::id()
            || mint.owner != token.key
        {
            return Err(ProgramError::IncorrectProgramId);
        }
        let mint_state = Mint::unpack(&mint.try_borrow_data()?)?;
        if mint_state.decimals != grant::DECIMALS as u8 {
            return Err(VaultError::WrongMint.into());
        }
        let bump = check_pda(program_id, locker.key, lock_acc.key)?;
        for (owner, account) in [(locker.key, source), (lock_acc.key, vault)] {
            let (expected, _) = Pubkey::find_program_address(
                &[
                    owner.as_ref(),
                    spl_token::id().as_ref(),
                    TOKEN_MINT.as_ref(),
                ],
                &ATA_PROGRAM,
            );
            if account.key != &expected {
                return Err(ProgramError::InvalidSeeds);
            }
        }
        Ok(Self {
            locker,
            source,
            lock_acc,
            vault,
            mint,
            token,
            system,
            ata,
            bump,
        })
    }

    fn create_ata(
        &self,
        account: &AccountInfo<'info>,
        owner: &AccountInfo<'info>,
    ) -> ProgramResult {
        if account.owner == self.token.key && !account.data_is_empty() {
            return Ok(());
        }
        let ix = Instruction {
            program_id: ATA_PROGRAM,
            accounts: vec![
                AccountMeta::new(*self.locker.key, true),
                AccountMeta::new(*account.key, false),
                AccountMeta::new_readonly(*owner.key, false),
                AccountMeta::new_readonly(TOKEN_MINT, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new_readonly(spl_token::id(), false),
            ],
            data: vec![1], // Idempotent creation also handles prefunded ATAs.
        };
        invoke(
            &ix,
            &[
                self.locker.clone(),
                account.clone(),
                owner.clone(),
                self.mint.clone(),
                self.system.clone(),
                self.token.clone(),
                self.ata.clone(),
            ],
        )
    }

    fn transfer(&self, amount: u64, mode: TransferMode) -> ProgramResult {
        let (source, dest, authority) = match mode {
            TransferMode::Deposit => (self.source, self.vault, self.locker),
            TransferMode::Withdraw => (self.vault, self.source, self.lock_acc),
        };
        let ix = spl_token::instruction::transfer_checked(
            self.token.key,
            source.key,
            self.mint.key,
            dest.key,
            authority.key,
            &[],
            amount,
            grant::DECIMALS as u8,
        )?;
        let infos = [
            source.clone(),
            self.mint.clone(),
            dest.clone(),
            authority.clone(),
            self.token.clone(),
        ];
        match mode {
            TransferMode::Deposit => invoke(&ix, &infos),
            TransferMode::Withdraw => invoke_signed(
                &ix,
                &infos,
                &[&[LOCK_SEED, self.locker.key.as_ref(), &[self.bump]]],
            ),
        }
    }
}

enum TransferMode {
    Deposit,
    Withdraw,
}

fn check_tokens(account: &AccountInfo, owner: &Pubkey) -> ProgramResult {
    if account.owner != &spl_token::id() {
        return Err(ProgramError::IncorrectProgramId);
    }
    let token = TokenAccount::unpack(&account.try_borrow_data()?)?;
    if token.mint != TOKEN_MINT || &token.owner != owner || token.state != AccountState::Initialized
    {
        return Err(VaultError::InvalidTokenAccount.into());
    }
    Ok(())
}

fn check_vault(accs: &TokenAccounts) -> ProgramResult {
    check_tokens(accs.vault, accs.lock_acc.key)?;
    let token = TokenAccount::unpack(&accs.vault.try_borrow_data()?)?;
    // No third party may withdraw the vault's backing outside this program.
    if token.delegate != COption::None || token.close_authority != COption::None {
        return Err(VaultError::InvalidTokenAccount.into());
    }
    Ok(())
}

fn init_lock(program_id: &Pubkey, accs: &TokenAccounts) -> ProgramResult {
    let rent = Rent::get()?.minimum_balance(LOCK_LEN);
    let extra = rent.saturating_sub(accs.lock_acc.lamports());
    if extra != 0 {
        invoke(
            &system_instruction::transfer(accs.locker.key, accs.lock_acc.key, extra),
            &[
                accs.locker.clone(),
                accs.lock_acc.clone(),
                accs.system.clone(),
            ],
        )?;
    }
    // Allocate and assign separately so unsolicited SOL cannot block first lock.
    let seeds: &[&[u8]] = &[LOCK_SEED, accs.locker.key.as_ref(), &[accs.bump]];
    invoke_signed(
        &system_instruction::allocate(accs.lock_acc.key, LOCK_LEN as u64),
        &[accs.lock_acc.clone(), accs.system.clone()],
        &[seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(accs.lock_acc.key, program_id),
        &[accs.lock_acc.clone(), accs.system.clone()],
        &[seeds],
    )?;
    Ok(())
}

fn lock(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    if amount == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let accs = TokenAccounts::parse(program_id, accounts)?;
    let new_account = accs.lock_acc.owner == &system_program::id() && accs.lock_acc.data_is_empty();
    let mut state = if new_account {
        LockState::default()
    } else {
        read_state(program_id, accs.lock_acc)?
    };
    if state.unbond_ts != 0 {
        return Err(VaultError::Unbonding.into());
    }
    let now = lock_clock(&state)?;
    let total = state
        .amount
        .checked_add(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    check_tokens(accs.source, accs.locker.key)?;
    if new_account {
        init_lock(program_id, &accs)?;
    }
    accs.create_ata(accs.vault, accs.lock_acc)?;
    check_vault(&accs)?;
    accs.transfer(amount, TransferMode::Deposit)?;
    if state.amount == 0 {
        state.lock_time = now;
    }
    state.amount = total;
    state.pack(&mut accs.lock_acc.try_borrow_mut_data()?);
    Ok(())
}

fn withdraw(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accs = TokenAccounts::parse(program_id, accounts)?;
    let state = read_state(program_id, accs.lock_acc)?;
    if state.amount == 0 {
        return Err(VaultError::EmptyLock.into());
    }
    if state.unbond_ts == 0 {
        return Err(VaultError::NotUnbonding.into());
    }
    let deadline = state
        .unbond_ts
        .checked_add(UNBOND_SECS)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    if lock_clock(&state)? < deadline {
        return Err(VaultError::UnbondPending.into());
    }
    check_vault(&accs)?;
    accs.create_ata(accs.source, accs.locker)?;
    check_tokens(accs.source, accs.locker.key)?;
    accs.transfer(state.amount, TransferMode::Withdraw)?;
    LockState::default().pack(&mut accs.lock_acc.try_borrow_mut_data()?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declared_ids() {
        assert_eq!(
            id().to_string(),
            "4FGcyxUtzqMJG4HqtYPiGk7zCMn75N5aLSCDFe3BJPjB"
        );
        assert_eq!(
            TOKEN_MINT.to_string(),
            "PovfzmSRWs1spwusPpW3ED3B2o26Zhsm8CSDWeXciV3"
        );
    }
}
