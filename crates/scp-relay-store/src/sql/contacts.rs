use super::*;

fn contact_row(r: &DataRow) -> Result<Contact> {
    Ok(Contact {
        peer_id: r.text("peer_id")?,
        peer_handle: r.text("handle")?,
        state: r.text("state")?,
        updated_at: r.int("updated_at")?,
        config: r.payload()?,
    })
}
fn inbox_row(r: &DataRow) -> Result<XInbox> {
    Ok(XInbox {
        seq: r.int("seq")?,
        id: r.text("id")?,
        endpoint: r.text("endpoint")?,
        from_account: r.text("from_account")?,
        sender: r.text("sender")?,
        client_id: r.text("client_id")?,
        message: r.text("message")?,
        thread: r.text("thread")?,
        grant: r.optional_text("reply_grant")?,
        expires_at: r.int("expires_at")?,
        at: r.int("at")?,
        acked: r.int("seq")? <= r.int("cursor")?,
    })
}
impl Database {
    pub(super) async fn contact(&self, a: &str, peer: &str) -> Result<Option<Contact>> {
        self.rows("SELECT c.*,p.handle FROM contacts c JOIN accounts p ON p.id=c.peer_id WHERE c.account_id=$1 AND c.peer_id=$2",args![a,peer]).await?.first().map(contact_row).transpose()
    }
    pub(super) async fn contacts(&self, a: &str) -> Result<Vec<Contact>> {
        let mut rows: Vec<Contact> = self.rows("SELECT c.*,p.handle FROM contacts c JOIN accounts p ON p.id=c.peer_id WHERE c.account_id=$1 AND c.state='active'",args![a]).await?.iter().map(contact_row).collect::<Result<_>>()?;
        rows.sort_by(|a, b| (&a.peer_handle, &a.peer_id).cmp(&(&b.peer_handle, &b.peer_id)));
        Ok(rows)
    }
    pub(super) async fn change_contact(
        &self,
        a: &str,
        peer: &str,
        action: &str,
        config: Option<ContactConfig>,
        now: i64,
    ) -> Result<()> {
        if a == peer {
            return Err(StoreError::Conflict);
        }
        let mut t = self.begin("host-contacts").await?;
        if t.rows(
            "SELECT id FROM accounts WHERE id=$1 OR id=$2",
            args![a, peer],
        )
        .await?
        .len()
            != 2
        {
            return Err(StoreError::NotFound);
        }
        let here = t
            .rows(
                "SELECT state FROM contacts WHERE account_id=$1 AND peer_id=$2",
                args![a, peer],
            )
            .await?
            .first()
            .map(|r| r.text("state"))
            .transpose()?;
        let there = t
            .rows(
                "SELECT state FROM contacts WHERE account_id=$1 AND peer_id=$2",
                args![peer, a],
            )
            .await?
            .first()
            .map(|r| r.text("state"))
            .transpose()?;
        match action {
            "invite" if here.as_deref() == Some("blocked") => {}
            "invite"
                if here.as_deref() == Some("pending_in")
                    && there.as_deref() == Some("pending_out") =>
            {
                t.activate(a, peer, now).await?
            }
            "invite" if there.is_none() => {
                let day = now - now.rem_euclid(86_400_000);
                let n = t
                    .rows(
                        "SELECT COUNT(*) AS n FROM contact_invites WHERE account_id=$1 AND at>=$2",
                        args![a, day],
                    )
                    .await?[0]
                    .int("n")?;
                if n >= 20 {
                    return Err(StoreError::Capacity);
                }
                t.execute(
                    "DELETE FROM contact_invites WHERE account_id=$1 AND at<$2",
                    args![a, day],
                )
                .await?;
                t.execute(
                    "INSERT INTO contact_invites(account_id,at) VALUES($1,$2)",
                    args![a, now],
                )
                .await?;
                let mut empty = ContactConfig::default();
                empty.allow.clear();
                t.save_contact(a, peer, "pending_out", &empty, now).await?;
                t.save_contact(peer, a, "pending_in", &empty, now).await?;
            }
            "invite" => {}
            "accept" => {
                if here.as_deref() != Some("pending_in") || there.as_deref() == Some("blocked") {
                    return Err(StoreError::Conflict);
                }
                t.activate(a, peer, now).await?;
            }
            "decline" => {
                t.execute("DELETE FROM contacts WHERE account_id=$1 AND peer_id=$2 AND state='pending_in'",args![a,peer]).await?;
            }
            "revoke" => {
                t.execute("DELETE FROM contacts WHERE ((account_id=$1 AND peer_id=$2) OR (account_id=$2 AND peer_id=$1)) AND state!='blocked'",args![a,peer]).await?;
            }
            "block" => {
                let mut empty = ContactConfig::default();
                empty.allow.clear();
                t.save_contact(a, peer, "blocked", &empty, now).await?;
                t.execute(
                    "DELETE FROM contacts WHERE account_id=$1 AND peer_id=$2",
                    args![peer, a],
                )
                .await?;
            }
            "update" => {
                if here.as_deref() != Some("active") {
                    return Err(StoreError::Conflict);
                }
                let config = config.ok_or(StoreError::Conflict)?;
                validate_config(&config)?;
                t.save_contact(a, peer, "active", &config, now).await?;
            }
            _ => return Err(StoreError::Conflict),
        }
        t.commit().await
    }
    pub(super) async fn xinbox(&self, a: &str) -> Result<Vec<XInbox>> {
        self.rows("SELECT x.*,COALESCE(c.acked_seq,0) AS cursor FROM xinbox x LEFT JOIN xcursor c ON c.account_id=x.account_id AND c.endpoint=x.endpoint WHERE x.account_id=$1 ORDER BY x.seq",args![a]).await?.iter().map(inbox_row).collect()
    }
    pub(super) async fn xinsert(&self, a: &str, m: Message, x: XInbox) -> Result<(XInbox, bool)> {
        valid(&x.message)?;
        valid(&m.envelope)?;
        if x.id != m.id || x.thread != m.thread || x.expires_at != m.expires_at {
            return Err(StoreError::Conflict);
        }
        let mut t = self.begin(a).await?;
        let prior=t.rows("SELECT x.*,COALESCE(c.acked_seq,0) AS cursor FROM xinbox x LEFT JOIN xcursor c ON c.account_id=x.account_id AND c.endpoint=x.endpoint WHERE x.account_id=$1 AND x.from_account=$2 AND x.client_id=$3",args![a,&x.from_account,&x.client_id]).await?;
        if let Some(row) = prior.first() {
            let out = inbox_row(row)?;
            t.commit().await?;
            return Ok((out, true));
        }
        t.execute("INSERT INTO messages(account_id,id,thread,reply_to,kind,from_ep,to_addr,created_at,expires_at,payload,envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",args![a,&m.id,&m.thread,&m.reply_to,&m.kind,&m.from_ep,&m.to_addr,m.created_at,m.expires_at,&json(&m)?,&m.envelope]).await?;
        let endpoint=t.rows("SELECT id FROM endpoints WHERE account_id=$1 AND machine || '/' || handle=$2 AND token_hash IS NULL AND kind!='system'",args![a,&x.endpoint]).await?.first().ok_or(StoreError::NotFound)?.text("id")?;
        let seq=t.rows("INSERT INTO deliveries(account_id,message_id,endpoint,expires_at,state) VALUES($1,$2,$3,$4,'{}') RETURNING seq",args![a,&m.id,&endpoint,m.expires_at]).await?[0].int("seq")?;
        t.execute("INSERT INTO xinbox(account_id,seq,id,endpoint,from_account,sender,client_id,message,thread,reply_grant,expires_at,at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",args![a,seq,&x.id,&x.endpoint,&x.from_account,&x.sender,&x.client_id,&x.message,&x.thread,&x.grant,x.expires_at,x.at]).await?;
        t.commit().await?;
        Ok((XInbox { seq, ..x }, false))
    }
    pub(super) async fn xack(
        &self,
        a: &str,
        endpoints: &[String],
        seqs: &[i64],
        now: i64,
    ) -> Result<usize> {
        let mut t = self.begin(a).await?;
        let count = t.xack(a, endpoints, seqs, now).await?;
        t.commit().await?;
        Ok(count)
    }
    pub(super) async fn xprune(&self, a: &str) -> Result<u64> {
        let mut t = self.begin(a).await?;
        let n=t.execute("DELETE FROM messages WHERE account_id=$1 AND id IN (SELECT x.id FROM xinbox x WHERE x.account_id=$1 AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.account_id=x.account_id AND c.peer_id=x.from_account AND c.state='active' AND c.dir!='out'))",args![a]).await?;
        t.commit().await?;
        Ok(n)
    }
}
impl Transaction {
    async fn save_contact(
        &mut self,
        a: &str,
        peer: &str,
        state: &str,
        c: &ContactConfig,
        now: i64,
    ) -> Result<()> {
        self.execute("INSERT INTO contacts(account_id,peer_id,state,payload,dir,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(account_id,peer_id) DO UPDATE SET state=excluded.state,payload=excluded.payload,dir=excluded.dir,updated_at=excluded.updated_at",args![a,peer,state,&json(c)?,&c.dir,now]).await?;
        Ok(())
    }
    async fn activate(&mut self, a: &str, peer: &str, now: i64) -> Result<()> {
        for id in [a, peer] {
            if self
                .rows(
                    "SELECT COUNT(*) AS n FROM contacts WHERE account_id=$1 AND state='active'",
                    args![id],
                )
                .await?[0]
                .int("n")?
                >= 50
            {
                return Err(StoreError::Capacity);
            }
        }
        for (id, other) in [(a, peer), (peer, a)] {
            self.save_contact(id, other, "active", &ContactConfig::default(), now)
                .await?;
        }
        Ok(())
    }
    pub(super) async fn xack(
        &mut self,
        a: &str,
        endpoints: &[String],
        seqs: &[i64],
        now: i64,
    ) -> Result<usize> {
        let mut count = 0;
        let max = seqs.iter().copied().max().unwrap_or(0);
        for endpoint in endpoints {
            let remote=self.rows("SELECT machine || '/' || handle AS remote FROM endpoints WHERE account_id=$1 AND id=$2",args![a,endpoint]).await?.first().map(|r|r.text("remote")).transpose()?;
            let Some(remote) = remote else {
                continue;
            };
            let mut to = 0;
            for r in self.rows("SELECT x.seq FROM xinbox x WHERE x.account_id=$1 AND x.endpoint=$2 AND x.expires_at>$3 AND x.seq>COALESCE((SELECT acked_seq FROM xcursor WHERE account_id=$1 AND endpoint=$2),0) AND x.seq<=$4 ORDER BY x.seq",args![a,&remote,now,max]).await? {
                let seq=r.int("seq")?;
                if !seqs.contains(&seq) { break; }
                to=seq; count+=1;
            }
            if to == 0 {
                continue;
            }
            self.execute("INSERT INTO xcursor(account_id,endpoint,acked_seq,at) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,endpoint) DO UPDATE SET old_seq=CASE WHEN xcursor.old_at IS NULL OR excluded.at-xcursor.old_at>=86400000 THEN xcursor.acked_seq ELSE xcursor.old_seq END,old_at=CASE WHEN xcursor.old_at IS NULL OR excluded.at-xcursor.old_at>=86400000 THEN xcursor.at ELSE xcursor.old_at END,acked_seq=excluded.acked_seq,at=excluded.at",args![a,&remote,to,now]).await?;
            self.execute("UPDATE deliveries SET acked_at=$1 WHERE account_id=$2 AND seq IN (SELECT seq FROM xinbox WHERE account_id=$2 AND endpoint=$3 AND seq<=$4)",args![now,a,&remote,to]).await?;
        }
        Ok(count)
    }
}
fn validate_config(c: &ContactConfig) -> Result<()> {
    fn machine(s: &str) -> bool {
        !s.is_empty()
            && s.len() <= 32
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    }
    if c.allow.len() > 32 || !matches!(c.dir.as_str(), "in" | "out" | "both") {
        return Err(StoreError::Conflict);
    }
    for e in &c.allow {
        if e.machine != "*" && !machine(&e.machine) {
            return Err(StoreError::Conflict);
        }
        if e.sel != "tree:root" {
            let valid = e
                .sel
                .strip_prefix("ep:")
                .and_then(|v| v.split_once('/'))
                .is_some_and(|(m, h)| {
                    machine(m)
                        && !h.is_empty()
                        && h.len() <= 63
                        && h.as_bytes()[0].is_ascii_alphanumeric()
                        && h.bytes().all(|b| {
                            b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b)
                        })
                });
            if !valid {
                return Err(StoreError::Conflict);
            }
        }
    }
    if let Some(l) = &c.limits {
        for n in [l.per_minute, l.per_hour, l.per_day].into_iter().flatten() {
            if !(1..=10000).contains(&n) {
                return Err(StoreError::Conflict);
            }
        }
    }
    Ok(())
}
