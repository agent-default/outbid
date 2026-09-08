//! Lock amount → grant. Pure. Intel may re-derive the same table.

pub const DECIMALS: u32 = 6;
pub const ATOMIC: u64 = 1_000_000;
pub const UNBOND_SECS: i64 = 86_400;

pub const TIER1_MIN: u64 = 1_000;
pub const TIER1_WALLETS: u16 = 1;
pub const TIER1_CAP_USD: u64 = 100;
pub const TIER1_WINDOW_H: u16 = 24;

pub const TIER2_MIN: u64 = 10_000;
pub const TIER2_WALLETS: u16 = 5;
pub const TIER2_CAP_USD: u64 = 1_000;
pub const TIER2_WINDOW_H: u16 = 72;

pub const TIER3_MIN: u64 = 100_000;
pub const TIER3_WALLETS: u16 = 25;
pub const TIER3_CAP_USD: u64 = 10_000;
pub const TIER3_WINDOW_H: u16 = 168;

/// Wire field kept; 0 = unbound (QPS is not the meter).
pub const QPS_UNBOUND: u16 = 0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grant {
    pub amount: u64,
    pub wallets: u16,
    pub qps: u16,
    pub cap_usd: u64,
    pub window_h: u16,
    pub unbond_ts: i64,
}

pub fn grant_from_lock(amount: u64, unbond_ts: i64) -> Grant {
    if unbond_ts != 0 {
        return Grant {
            amount,
            wallets: 0,
            qps: QPS_UNBOUND,
            cap_usd: 0,
            window_h: 0,
            unbond_ts,
        };
    }
    let whole = amount / ATOMIC;
    let (wallets, cap_usd, window_h) = if whole >= TIER3_MIN {
        (TIER3_WALLETS, TIER3_CAP_USD, TIER3_WINDOW_H)
    } else if whole >= TIER2_MIN {
        (TIER2_WALLETS, TIER2_CAP_USD, TIER2_WINDOW_H)
    } else if whole >= TIER1_MIN {
        (TIER1_WALLETS, TIER1_CAP_USD, TIER1_WINDOW_H)
    } else {
        (0, 0, 0)
    };
    Grant {
        amount,
        wallets,
        qps: QPS_UNBOUND,
        cap_usd,
        window_h,
        unbond_ts: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_and_dust() {
        let g = grant_from_lock(999 * ATOMIC, 0);
        assert_eq!(g.wallets, 0);
        assert_eq!(g.cap_usd, 0);
    }

    #[test]
    fn tier1_from_1000() {
        let g = grant_from_lock(TIER1_MIN * ATOMIC, 0);
        assert_eq!(g.wallets, 1);
        assert_eq!(g.qps, QPS_UNBOUND);
        assert_eq!(g.cap_usd, 100);
        assert_eq!(g.window_h, 24);
        assert_eq!(g.amount, 1_000_000_000);
    }

    #[test]
    fn highest_tier_wins() {
        let g = grant_from_lock(TIER3_MIN * ATOMIC, 0);
        assert_eq!(g.wallets, 25);
        assert_eq!(g.qps, QPS_UNBOUND);
        assert_eq!(g.cap_usd, 10_000);
        assert_eq!(g.window_h, 168);
    }

    #[test]
    fn unbond_drops_grant() {
        let g = grant_from_lock(TIER3_MIN * ATOMIC, 1);
        assert_eq!(g.wallets, 0);
        assert_eq!(g.qps, QPS_UNBOUND);
        assert_eq!(g.cap_usd, 0);
        assert_eq!(g.window_h, 0);
        assert_eq!(g.amount, TIER3_MIN * ATOMIC);
        assert_eq!(g.unbond_ts, 1);
    }

    #[test]
    fn atomic_tier_boundaries() {
        for (amount, wallets, cap, hours) in [
            (0, 0, 0, 0),
            (1_000 * ATOMIC - 1, 0, 0, 0),
            (1_000 * ATOMIC, 1, 100, 24),
            (10_000 * ATOMIC - 1, 1, 100, 24),
            (10_000 * ATOMIC, 5, 1_000, 72),
            (100_000 * ATOMIC - 1, 5, 1_000, 72),
            (100_000 * ATOMIC, 25, 10_000, 168),
        ] {
            let grant = grant_from_lock(amount, 0);
            assert_eq!(
                (grant.wallets, grant.cap_usd, grant.window_h),
                (wallets, cap, hours)
            );
            assert_eq!(grant.qps, 0);
            let unbond = grant_from_lock(amount, 100);
            assert_eq!((unbond.wallets, unbond.cap_usd, unbond.window_h), (0, 0, 0));
        }
    }
}
