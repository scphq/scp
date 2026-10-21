use super::*;
use scp_relay_store::Contact;

const DAY: i64 = 86_400_000;
#[derive(Clone, Default)]
struct Window {
    at: i64,
    n: i64,
}
#[derive(Default)]
struct Pair {
    minute: Window,
    hour: Window,
}
#[derive(Serialize, Deserialize)]
struct Reservation {
    day: i64,
    sent: i64,
    at: i64,
}
struct Day {
    day: i64,
    count: i64,
    reserved: i64,
    recent: Vec<i64>,
    last: i64,
    wrote: i64,
}
#[derive(Default)]
pub(super) struct Counters {
    pairs: HashMap<String, Pair>,
    threads: HashMap<String, Window>,
    days: HashMap<String, Day>,
}
pub(super) struct Refund {
    pair: String,
    thread: String,
    peer: String,
    minute: i64,
    hour: i64,
    thread_at: i64,
    day: i64,
    at: i64,
}
pub(super) fn day_start(now: i64) -> i64 {
    now - now.rem_euclid(DAY)
}
pub(super) fn until_tomorrow(now: i64) -> i64 {
    ((day_start(now) + DAY - now + 999) / 1000).max(1)
}
pub(super) fn caps(
    own: Option<&scp_relay_store::XLimits>,
    declared: Option<&scp_relay_store::XLimits>,
) -> (i64, i64, i64) {
    let own = own.cloned().unwrap_or_default();
    let dec = declared.cloned().unwrap_or_default();
    (
        10.min(own.per_minute.unwrap_or(10))
            .min(dec.per_minute.unwrap_or(i64::MAX)),
        100.min(own.per_hour.unwrap_or(100))
            .min(dec.per_hour.unwrap_or(i64::MAX)),
        own.per_day
            .unwrap_or(0)
            .clamp(200, 2000)
            .min(dec.per_day.unwrap_or(i64::MAX)),
    )
}
impl Counters {
    async fn load(
        &mut self,
        store: &dyn RelayStore,
        account: &str,
        peer: &str,
        now: i64,
    ) -> Result<()> {
        if !self.days.contains_key(peer) {
            let row = store.state(account, &format!("xcounters:{peer}")).await?;
            let r = match row {
                Some(r) => serde_json::from_str::<Reservation>(&r)
                    .map_err(|_| Error::new("unavailable", "invalid reservation"))?,
                None => Reservation {
                    day: day_start(now),
                    sent: 0,
                    at: 0,
                },
            };
            self.days.insert(
                peer.into(),
                Day {
                    day: r.day,
                    count: r.sent,
                    reserved: r.sent,
                    recent: vec![],
                    last: 0,
                    wrote: r.at,
                },
            );
        }
        let d = self.days.get_mut(peer).expect("loaded day");
        if d.day != day_start(now) {
            d.day = day_start(now);
            d.count = 0;
            d.reserved = 0;
            d.recent.clear();
        }
        Ok(())
    }
    fn windows(&mut self, pair: &str, thread: &str, now: i64) {
        let p = self.pairs.entry(pair.into()).or_insert_with(|| Pair {
            minute: Window { at: now, n: 0 },
            hour: Window { at: now, n: 0 },
        });
        for (w, ms) in [(&mut p.minute, 60_000), (&mut p.hour, 3_600_000)] {
            if now - w.at >= ms {
                *w = Window { at: now, n: 0 };
            }
        }
        let w = self
            .threads
            .entry(thread.into())
            .or_insert(Window { at: now, n: 0 });
        if now - w.at >= DAY {
            *w = Window { at: now, n: 0 };
        }
    }
    pub(super) async fn check(
        &mut self,
        store: &dyn RelayStore,
        account: &str,
        c: &Contact,
        route: (&str, &str, &str),
        now: i64,
    ) -> Result<()> {
        let (sender, target, thread) = route;
        self.load(store, account, &c.peer_id, now).await?;
        let key = format!("{sender} {target}");
        self.windows(&key, thread, now);
        let p = &self.pairs[&key];
        let (minute, hour, day) = caps(c.config.limits.as_ref(), None);
        for (w, cap, ms, unit) in [
            (&p.minute, minute, 60_000, "minute"),
            (&p.hour, hour, 3_600_000, "hour"),
        ] {
            if w.n >= cap {
                return Err(Error::rate(
                    &format!("{cap} messages to {target} a {unit}"),
                    (w.at + ms - now + 999) / 1000,
                ));
            }
        }
        if self.days[&c.peer_id].count >= day {
            return Err(Error::rate(
                &format!("{day} messages to {} today", c.peer_handle),
                until_tomorrow(now),
            ));
        }
        if self.threads[thread].n >= 50 {
            return Err(Error::new(
                "loop_guard",
                &format!("thread {thread} reached 50 messages across accounts"),
            ));
        }
        Ok(())
    }
    pub(super) async fn sent(
        &mut self,
        store: &dyn RelayStore,
        account: &str,
        c: &Contact,
        route: (&str, &str, &str),
        now: i64,
    ) -> Result<Refund> {
        let (sender, target, thread) = route;
        self.load(store, account, &c.peer_id, now).await?;
        let key = format!("{sender} {target}");
        self.windows(&key, thread, now);
        let d = self.days.get_mut(&c.peer_id).expect("loaded day");
        d.recent.retain(|at| now - at < 60_000);
        if d.recent.len() > 20 {
            d.recent.drain(..d.recent.len() - 20);
        }
        if d.count + 1 > d.reserved {
            let reserved = d.count + (1 + d.recent.len() as i64).min(20);
            Self::write(store, account, &c.peer_id, d, reserved, now).await?;
        }
        d.count += 1;
        d.recent.push(now);
        d.last = now;
        let day = d.day;
        let p = self.pairs.get_mut(&key).expect("pair");
        p.minute.n += 1;
        p.hour.n += 1;
        let t = self.threads.get_mut(thread).expect("thread");
        t.n += 1;
        let refund = Refund {
            pair: key,
            thread: thread.into(),
            peer: c.peer_id.clone(),
            minute: p.minute.at,
            hour: p.hour.at,
            thread_at: t.at,
            day,
            at: now,
        };
        self.true_up(store, account, now, Some(&c.peer_id)).await?;
        Ok(refund)
    }
    async fn write(
        store: &dyn RelayStore,
        account: &str,
        peer: &str,
        d: &mut Day,
        reserved: i64,
        now: i64,
    ) -> Result<()> {
        store
            .put_state(
                account,
                &format!("xcounters:{peer}"),
                Some(
                    &json!(Reservation {
                        day: d.day,
                        sent: reserved,
                        at: now
                    })
                    .to_string(),
                ),
            )
            .await?;
        d.reserved = reserved;
        d.wrote = now;
        Ok(())
    }
    pub(super) async fn true_up(
        &mut self,
        store: &dyn RelayStore,
        account: &str,
        now: i64,
        skip: Option<&str>,
    ) -> Result<()> {
        for (peer, d) in &mut self.days {
            if Some(peer.as_str()) != skip
                && d.reserved > d.count
                && d.day == day_start(now)
                && now >= (d.last + 60_000).max(d.wrote + 300_000)
            {
                Self::write(store, account, peer, d, d.count, now).await?;
            }
        }
        self.pairs
            .retain(|_, p| now - p.hour.at < 3_600_000 && (p.hour.n > 0 || p.minute.n > 0));
        self.threads.retain(|_, w| now - w.at < DAY && w.n > 0);
        Ok(())
    }
    pub(super) fn refund(&mut self, r: Refund) {
        if let Some(p) = self.pairs.get_mut(&r.pair) {
            for (w, at) in [(&mut p.minute, r.minute), (&mut p.hour, r.hour)] {
                if w.at == at {
                    w.n = (w.n - 1).max(0);
                }
            }
        }
        if let Some(w) = self.threads.get_mut(&r.thread)
            && w.at == r.thread_at
        {
            w.n = (w.n - 1).max(0);
        }
        if let Some(d) = self.days.get_mut(&r.peer)
            && d.day == r.day
        {
            d.count = (d.count - 1).max(0);
            if let Some(i) = d.recent.iter().rposition(|at| *at == r.at) {
                d.recent.remove(i);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use scp_relay_store::ContactConfig;
    #[test]
    fn limits_only_raise_the_day_cap() {
        use scp_relay_store::XLimits;
        assert_eq!(caps(None, None), (10, 100, 200));
        assert_eq!(
            caps(
                Some(&XLimits {
                    per_minute: Some(30),
                    per_hour: Some(7),
                    per_day: Some(5000)
                }),
                Some(&XLimits {
                    per_minute: Some(3),
                    per_hour: None,
                    per_day: None
                })
            ),
            (3, 7, 2000)
        );
        assert_eq!(
            caps(
                Some(&XLimits {
                    per_day: Some(1),
                    ..XLimits::default()
                }),
                None
            ),
            (10, 100, 200)
        );
    }
    #[tokio::test]
    async fn day_thread_and_hour_boundaries() {
        let store = scp_relay_store::connect("sqlite::memory:").await.unwrap();
        let a = crate::admin::account(store.as_ref(), "alpha")
            .await
            .unwrap();
        let mut c = Contact {
            peer_id: "day-peer".into(),
            peer_handle: "beta".into(),
            state: "active".into(),
            updated_at: 0,
            config: ContactConfig::default(),
        };
        let mut counters = Counters::default();
        let now = 1_000_000;
        for n in 0..200 {
            let target = format!("beta/{n}");
            let thread = format!("t{n}");
            counters
                .check(store.as_ref(), &a.id, &c, ("desk/a", &target, &thread), now)
                .await
                .unwrap();
            counters
                .sent(store.as_ref(), &a.id, &c, ("desk/a", &target, &thread), now)
                .await
                .unwrap();
        }
        assert_eq!(
            counters
                .check(store.as_ref(), &a.id, &c, ("desk/a", "new", "new"), now)
                .await
                .unwrap_err()
                .retry,
            Some(until_tomorrow(now))
        );
        counters
            .check(store.as_ref(), &a.id, &c, ("desk/a", "new", "new"), DAY)
            .await
            .unwrap();
        c.peer_id = "thread-peer".into();
        for n in 0..50 {
            let target = format!("other/{n}");
            counters
                .check(
                    store.as_ref(),
                    &a.id,
                    &c,
                    ("desk/a", &target, "shared"),
                    now,
                )
                .await
                .unwrap();
            counters
                .sent(
                    store.as_ref(),
                    &a.id,
                    &c,
                    ("desk/a", &target, "shared"),
                    now,
                )
                .await
                .unwrap();
        }
        assert_eq!(
            counters
                .check(store.as_ref(), &a.id, &c, ("desk/a", "last", "shared"), now)
                .await
                .unwrap_err()
                .code,
            "loop_guard"
        );
        c.peer_id = "hour-peer".into();
        for n in 0..100 {
            let at = now + (n / 10) * 60_000;
            let thread = format!("hour{n}");
            counters
                .check(
                    store.as_ref(),
                    &a.id,
                    &c,
                    ("desk/a", "one-pair", &thread),
                    at,
                )
                .await
                .unwrap();
            counters
                .sent(
                    store.as_ref(),
                    &a.id,
                    &c,
                    ("desk/a", "one-pair", &thread),
                    at,
                )
                .await
                .unwrap();
        }
        let err = counters
            .check(
                store.as_ref(),
                &a.id,
                &c,
                ("desk/a", "one-pair", "next"),
                now + 600_000,
            )
            .await
            .unwrap_err();
        assert_eq!(err.code, "rate_limited");
        assert_eq!(err.retry, Some(3000));
    }
    #[tokio::test]
    async fn reservation_refund_restart_and_true_up() {
        let store = scp_relay_store::connect("sqlite::memory:").await.unwrap();
        let a = crate::admin::account(store.as_ref(), "alpha")
            .await
            .unwrap();
        let c = Contact {
            peer_id: "peer".into(),
            peer_handle: "beta".into(),
            state: "active".into(),
            updated_at: 0,
            config: ContactConfig::default(),
        };
        let mut counters = Counters::default();
        let now = 1_000_000;
        for _ in 0..10 {
            counters
                .check(store.as_ref(), &a.id, &c, ("desk/a", "beta/b", "t"), now)
                .await
                .unwrap();
            counters
                .sent(store.as_ref(), &a.id, &c, ("desk/a", "beta/b", "t"), now)
                .await
                .unwrap();
        }
        let d = &counters.days["peer"];
        assert_eq!(d.count, 10);
        assert_eq!(d.reserved, 15);
        let mut restarted = Counters::default();
        restarted
            .load(store.as_ref(), &a.id, "peer", now)
            .await
            .unwrap();
        assert_eq!(restarted.days["peer"].count, 15);
        assert!(
            counters
                .check(store.as_ref(), &a.id, &c, ("desk/a", "beta/b", "t"), now)
                .await
                .is_err()
        );
        let refund = counters
            .sent(
                store.as_ref(),
                &a.id,
                &c,
                ("desk/a", "beta/b", "t"),
                now + 1,
            )
            .await
            .unwrap();
        counters.refund(refund);
        assert_eq!(counters.days["peer"].count, 10);
        assert_eq!(counters.days["peer"].reserved, 15);
        assert_eq!(counters.pairs["desk/a beta/b"].minute.n, 10);
        assert_eq!(counters.threads["t"].n, 10);
        counters
            .true_up(store.as_ref(), &a.id, now + 299_999, None)
            .await
            .unwrap();
        assert_eq!(counters.days["peer"].reserved, 15);
        counters
            .true_up(store.as_ref(), &a.id, now + 300_000, None)
            .await
            .unwrap();
        assert_eq!(counters.days["peer"].reserved, 10);
        assert_eq!(until_tomorrow(86_399_999), 1);
        assert_eq!(until_tomorrow(86_400_000), 86_400);
    }
}
