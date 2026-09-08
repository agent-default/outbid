use solana_program::program_error::ProgramError;

pub const LOCK_LEN: usize = 32;
pub const STATE_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LockState {
    pub amount: u64,
    pub unbond_ts: i64,
    pub lock_time: i64,
}

impl LockState {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() != LOCK_LEN || data[24] != STATE_VERSION || data[25..] != [0; 7] {
            return Err(ProgramError::InvalidAccountData);
        }
        let state = Self {
            amount: u64::from_le_bytes(data[0..8].try_into().unwrap()),
            unbond_ts: i64::from_le_bytes(data[8..16].try_into().unwrap()),
            lock_time: i64::from_le_bytes(data[16..24].try_into().unwrap()),
        };
        if state.amount == 0 {
            if state.lock_time != 0 || state.unbond_ts != 0 {
                return Err(ProgramError::InvalidAccountData);
            }
        } else if state.lock_time <= 0
            || (state.unbond_ts != 0 && state.unbond_ts < state.lock_time)
        {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(state)
    }

    pub fn pack(&self, data: &mut [u8]) {
        data.fill(0);
        data[0..8].copy_from_slice(&self.amount.to_le_bytes());
        data[8..16].copy_from_slice(&self.unbond_ts.to_le_bytes());
        data[16..24].copy_from_slice(&self.lock_time.to_le_bytes());
        data[24] = STATE_VERSION;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_roundtrip() {
        for state in [
            LockState::default(),
            LockState {
                amount: 1,
                lock_time: 100,
                unbond_ts: 200,
            },
        ] {
            let mut data = [0u8; LOCK_LEN];
            state.pack(&mut data);
            assert_eq!(LockState::unpack(&data).unwrap(), state);
        }
    }

    #[test]
    fn rejects_old_or_invalid_state() {
        assert!(LockState::unpack(&[0; 16]).is_err());
        let mut data = [0u8; LOCK_LEN];
        assert!(LockState::unpack(&data).is_err());
        LockState::default().pack(&mut data);
        data[31] = 1;
        assert!(LockState::unpack(&data).is_err());
        for state in [
            LockState {
                amount: 1,
                lock_time: 0,
                unbond_ts: 0,
            },
            LockState {
                amount: 1,
                lock_time: 100,
                unbond_ts: 99,
            },
            LockState {
                amount: 0,
                lock_time: 100,
                unbond_ts: 0,
            },
        ] {
            state.pack(&mut data);
            assert!(LockState::unpack(&data).is_err());
        }
    }
}
