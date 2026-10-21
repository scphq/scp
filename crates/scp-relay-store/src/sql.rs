use crate::*;
use serde::de::DeserializeOwned;
use sqlx::{
    Row,
    postgres::PgPoolOptions,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::{str::FromStr, time::Duration};

/// SQLite backend with WAL, foreign keys, and a five second busy timeout.
/// In-memory stores use one connection. File stores permit concurrent readers.
pub struct SqliteStore {
    db: Database,
}
/// PostgreSQL backend using a connection pool and transactional migrations.
pub struct PostgresStore {
    db: Database,
}
enum Database {
    Sqlite(sqlx::SqlitePool),
    Postgres(sqlx::PgPool),
}
enum Transaction {
    Sqlite(sqlx::Transaction<'static, sqlx::Sqlite>),
    Postgres(sqlx::Transaction<'static, sqlx::Postgres>),
}
enum DataRow {
    Sqlite(sqlx::sqlite::SqliteRow),
    Postgres(sqlx::postgres::PgRow),
}
#[derive(Clone)]
enum Bind {
    Text(Option<String>),
    Int(Option<i64>),
}
impl From<&str> for Bind {
    fn from(v: &str) -> Self {
        Self::Text(Some(v.to_owned()))
    }
}
impl From<&String> for Bind {
    fn from(v: &String) -> Self {
        Self::from(v.as_str())
    }
}
impl From<i64> for Bind {
    fn from(v: i64) -> Self {
        Self::Int(Some(v))
    }
}
impl From<Option<i64>> for Bind {
    fn from(v: Option<i64>) -> Self {
        Self::Int(v)
    }
}
impl From<&Option<String>> for Bind {
    fn from(v: &Option<String>) -> Self {
        Self::Text(v.clone())
    }
}
macro_rules! args { ($($v:expr),* $(,)?) => { vec![$(Bind::from($v)),*] }; }
mod contacts;
fn err(e: sqlx::Error) -> StoreError {
    if let sqlx::Error::Database(d) = &e
        && (d.is_unique_violation() || d.is_foreign_key_violation() || d.is_check_violation())
    {
        return StoreError::Conflict;
    }
    StoreError::Backend(e.to_string())
}
fn json<T: Serialize>(v: &T) -> Result<String> {
    serde_json::to_string(v).map_err(|e| StoreError::Backend(e.to_string()))
}
fn valid(v: &str) -> Result<()> {
    serde_json::from_str::<serde_json::Value>(v)
        .map(|_| ())
        .map_err(|_| StoreError::Conflict)
}
fn parse<T: DeserializeOwned>(s: &str) -> Result<T> {
    serde_json::from_str(s).map_err(|e| StoreError::Backend(e.to_string()))
}
fn delivery(r: &DataRow) -> Result<Delivery> {
    Ok(Delivery {
        seq: r.int("seq")?,
        message_id: r.text("message_id")?,
        endpoint: r.text("endpoint")?,
        expires_at: r.int("expires_at")?,
        acked_at: r.optional_int("acked_at")?,
        rejected_at: r.optional_int("rejected_at")?,
        rejection: r.optional_text("rejection")?,
        state: r.text("state")?,
    })
}
impl DataRow {
    fn text(&self, k: &str) -> Result<String> {
        match self {
            Self::Sqlite(r) => r.try_get(k),
            Self::Postgres(r) => r.try_get(k),
        }
        .map_err(err)
    }
    fn optional_text(&self, k: &str) -> Result<Option<String>> {
        match self {
            Self::Sqlite(r) => r.try_get(k),
            Self::Postgres(r) => r.try_get(k),
        }
        .map_err(err)
    }
    fn int(&self, k: &str) -> Result<i64> {
        match self {
            Self::Sqlite(r) => r.try_get(k),
            Self::Postgres(r) => r.try_get(k),
        }
        .map_err(err)
    }
    fn optional_int(&self, k: &str) -> Result<Option<i64>> {
        match self {
            Self::Sqlite(r) => r.try_get(k),
            Self::Postgres(r) => r.try_get(k),
        }
        .map_err(err)
    }
    fn payload<T: DeserializeOwned>(&self) -> Result<T> {
        parse(&self.text("payload")?)
    }
}
macro_rules! bound_query {
    ($sql:expr, $args:expr) => {{
        let mut q = sqlx::query($sql);
        for a in $args {
            q = match a {
                Bind::Text(v) => q.bind(v),
                Bind::Int(v) => q.bind(v),
            };
        }
        q
    }};
}
impl Database {
    async fn rows(&self, sql: &str, args: Vec<Bind>) -> Result<Vec<DataRow>> {
        match self {
            Self::Sqlite(p) => Ok(bound_query!(sql, args)
                .fetch_all(p)
                .await
                .map_err(err)?
                .into_iter()
                .map(DataRow::Sqlite)
                .collect()),
            Self::Postgres(p) => Ok(bound_query!(sql, args)
                .fetch_all(p)
                .await
                .map_err(err)?
                .into_iter()
                .map(DataRow::Postgres)
                .collect()),
        }
    }
    async fn execute(&self, sql: &str, args: Vec<Bind>) -> Result<u64> {
        match self {
            Self::Sqlite(p) => Ok(bound_query!(sql, args)
                .execute(p)
                .await
                .map_err(err)?
                .rows_affected()),
            Self::Postgres(p) => Ok(bound_query!(sql, args)
                .execute(p)
                .await
                .map_err(err)?
                .rows_affected()),
        }
    }
    async fn one<T: DeserializeOwned>(&self, sql: &str, args: Vec<Bind>) -> Result<Option<T>> {
        self.rows(sql, args)
            .await?
            .first()
            .map(DataRow::payload)
            .transpose()
    }
    async fn all<T: DeserializeOwned>(&self, sql: &str, args: Vec<Bind>) -> Result<Vec<T>> {
        self.rows(sql, args)
            .await?
            .iter()
            .map(DataRow::payload)
            .collect()
    }
    async fn begin(&self, key: &str) -> Result<Transaction> {
        match self {
            Self::Sqlite(p) => Ok(Transaction::Sqlite(
                p.begin_with("BEGIN IMMEDIATE").await.map_err(err)?,
            )),
            Self::Postgres(p) => {
                let mut t = Transaction::Postgres(p.begin().await.map_err(err)?);
                t.rows(
                    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                    args![key],
                )
                .await?;
                Ok(t)
            }
        }
    }
    async fn migrate(&self) -> Result<()> {
        let mut tx = self.begin("scp-relay-migrations").await?;
        tx.execute("CREATE TABLE IF NOT EXISTS relay_migrations (name TEXT PRIMARY KEY, at BIGINT NOT NULL)",vec![]).await?;
        let migrations = match self {
            Self::Sqlite(_) => [
                (
                    "0001_init",
                    include_str!("../migrations/sqlite/0001_init.sql"),
                ),
                (
                    "0002_query_fields",
                    include_str!("../migrations/sqlite/0002_query_fields.sql"),
                ),
                (
                    "0003_open_deliveries",
                    include_str!("../migrations/sqlite/0003_open_deliveries.sql"),
                ),
                (
                    "0004_contacts",
                    include_str!("../migrations/sqlite/0004_contacts.sql"),
                ),
            ],
            Self::Postgres(_) => [
                (
                    "0001_init",
                    include_str!("../migrations/postgres/0001_init.sql"),
                ),
                (
                    "0002_query_fields",
                    include_str!("../migrations/postgres/0002_query_fields.sql"),
                ),
                (
                    "0003_open_deliveries",
                    include_str!("../migrations/postgres/0003_open_deliveries.sql"),
                ),
                (
                    "0004_contacts",
                    include_str!("../migrations/postgres/0004_contacts.sql"),
                ),
            ],
        };
        for (name, sql) in migrations {
            if tx
                .rows(
                    "SELECT name FROM relay_migrations WHERE name=$1",
                    args![name],
                )
                .await?
                .is_empty()
            {
                for statement in sql.split(';').filter(|s| !s.trim().is_empty()) {
                    tx.execute(statement, vec![]).await?;
                }
                tx.execute(
                    "INSERT INTO relay_migrations(name,at) VALUES($1,$2)",
                    args![name, 0_i64],
                )
                .await?;
            }
        }
        tx.commit().await
    }
    async fn lookup(&self, column: &str, value: &str, now: i64) -> Result<CredentialLookup> {
        let row: Option<Credential> = self
            .one(
                &format!("SELECT payload FROM credentials WHERE {column}=$1"),
                args![value],
            )
            .await?;
        let Some(c) = row else {
            return Ok(CredentialLookup::Invalid);
        };
        if c.revoked_at.is_some() {
            return Ok(CredentialLookup::Revoked);
        }
        if c.expires_at.is_some_and(|at| at <= now) {
            return Ok(CredentialLookup::Expired);
        }
        let a: Option<Account> = self
            .one(
                "SELECT payload FROM accounts WHERE id=$1",
                args![&c.account_id],
            )
            .await?;
        let m: Option<Member> = self
            .one(
                "SELECT payload FROM members WHERE account_id=$1 AND id=$2",
                args![&c.account_id, &c.member_id],
            )
            .await?;
        match (a, m) {
            (Some(account), Some(member)) => Ok(CredentialLookup::Active(Box::new(Identity {
                credential: c,
                account,
                member,
            }))),
            _ => Ok(CredentialLookup::Revoked),
        }
    }
}
impl Transaction {
    async fn purge_device_codes(&mut self, now: i64) -> Result<u64> {
        self.execute(
            "DELETE FROM device_codes WHERE expires_at<=$1 OR state IN ('redeemed','denied')",
            args![now],
        )
        .await
    }
    async fn hub_write(&mut self, a: &str, changes: HubWrite) -> Result<()> {
        if let Some(now) = changes.sweep_at {
            self.execute("DELETE FROM messages WHERE account_id=$1 AND id IN (SELECT x.id FROM xinbox x LEFT JOIN xcursor c ON c.account_id=x.account_id AND c.endpoint=x.endpoint WHERE x.account_id=$1 AND x.at<=$2 AND (x.expires_at<=$3 OR (c.at<=$2 AND x.seq<=c.acked_seq) OR (c.old_at<=$2 AND x.seq<=c.old_seq)))",args![a,now.saturating_sub(86400000),now]).await?;
            self.execute(
                "DELETE FROM messages WHERE account_id=$1 AND expires_at<=$2",
                args![a, now.saturating_sub(604800000)],
            )
            .await?;
            self.execute(
                "DELETE FROM idempotency WHERE account_id=$1 AND created_at<$2",
                args![a, now.saturating_sub(86400000)],
            )
            .await?;
            for table in ["pair_events", "local_events"] {
                self.execute(
                    &format!("DELETE FROM {table} WHERE account_id=$1 AND at<=$2"),
                    args![a, now.saturating_sub(3600000)],
                )
                .await?;
            }
            self.execute(
                "DELETE FROM audit WHERE account_id=$1 AND at<$2",
                args![a, now.saturating_sub(2592000000)],
            )
            .await?;
            self.execute("DELETE FROM activity WHERE account_id=$1 AND id NOT IN (SELECT id FROM activity WHERE account_id=$1 ORDER BY id DESC LIMIT 5000)",args![a]).await?;
            self.execute("DELETE FROM hub_state WHERE account_id=$1 AND CASE WHEN key LIKE 'pause:%' THEN CAST(payload AS BIGINT) END <= $2",args![a,now]).await?;
        }
        if let Some(before) = changes.denied_before {
            self.execute("DELETE FROM hub_state WHERE account_id=$1 AND key LIKE 'denied:%' AND CAST(payload AS BIGINT)<=$2", args![a, before]).await?;
        }
        if changes.purge {
            for table in [
                "xinbox",
                "xcursor",
                "deliveries",
                "messages",
                "idempotency",
                "endpoints",
                "machines",
                "machine_tombstones",
                "hub_state",
                "pair_events",
                "local_events",
                "activity",
                "audit",
            ] {
                self.execute(
                    &format!("DELETE FROM {table} WHERE account_id=$1"),
                    args![a],
                )
                .await?;
            }
        }
        for (key, value) in changes.states {
            if let Some(value) = value {
                valid(&value)?;
                self.execute("INSERT INTO hub_state(account_id,key,payload) VALUES($1,$2,$3) ON CONFLICT(account_id,key) DO UPDATE SET payload=excluded.payload",args![a,&key,&value]).await?;
            } else {
                self.execute(
                    "DELETE FROM hub_state WHERE account_id=$1 AND key=$2",
                    args![a, &key],
                )
                .await?;
            }
        }
        for (log, e) in changes.events {
            valid(&e.detail)?;
            self.execute(&format!("INSERT INTO {}(account_id,at,kind,endpoint,reference,detail) VALUES($1,$2,$3,$4,$5,$6)",event_table(log)),args![a,e.at,&e.kind,&e.endpoint,&e.reference,&e.detail]).await?;
        }
        for endpoint in changes.clear_inboxes {
            self.execute("DELETE FROM messages WHERE account_id=$1 AND id IN (SELECT x.id FROM xinbox x JOIN deliveries d ON d.seq=x.seq WHERE x.account_id=$1 AND d.endpoint=$2)",args![a,&endpoint]).await?;
            self.execute(
                "DELETE FROM deliveries WHERE account_id=$1 AND endpoint=$2",
                args![a, &endpoint],
            )
            .await?;
        }
        for id in changes.remove_endpoints {
            self.execute("DELETE FROM messages WHERE account_id=$1 AND id IN (SELECT x.id FROM xinbox x JOIN deliveries d ON d.seq=x.seq WHERE x.account_id=$1 AND d.endpoint=$2)",args![a,&id]).await?;
            self.execute(
                "DELETE FROM deliveries WHERE account_id=$1 AND endpoint=$2",
                args![a, &id],
            )
            .await?;
            self.execute(
                "DELETE FROM endpoints WHERE account_id=$1 AND id=$2",
                args![a, &id],
            )
            .await?;
        }
        for name in changes.remove_machines {
            self.execute(
                "DELETE FROM machines WHERE account_id=$1 AND name=$2",
                args![a, &name],
            )
            .await?;
            self.execute(
                "DELETE FROM machine_tombstones WHERE account_id=$1 AND name=$2",
                args![a, &name],
            )
            .await?;
            self.execute(
                "DELETE FROM hub_state WHERE account_id=$1 AND key=$2",
                args![a, &format!("wake:{name}")],
            )
            .await?;
        }
        for m in changes.machines {
            self.execute("INSERT INTO machines(account_id,name,token_id,actor_id,user_id,kind,created_at,last_seen,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(account_id,name) DO UPDATE SET token_id=excluded.token_id,actor_id=excluded.actor_id,user_id=excluded.user_id,kind=excluded.kind,created_at=excluded.created_at,last_seen=excluded.last_seen,payload=excluded.payload",args![a,&m.name,&m.token_id,&m.actor_id,&m.user_id,&m.kind,m.created_at,m.last_seen,&json(&m)?]).await?;
            self.execute(
                "DELETE FROM machine_tombstones WHERE account_id=$1 AND name=$2",
                args![a, &m.name],
            )
            .await?;
        }
        for v in changes.tombstones {
            self.execute("INSERT INTO machine_tombstones(account_id,name,at,payload,actor_id,user_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(account_id,name) DO UPDATE SET at=excluded.at,payload=excluded.payload,actor_id=excluded.actor_id,user_id=excluded.user_id",args![a,&v.name,v.at,&json(&v)?,&v.actor_id,&v.user_id]).await?;
        }
        // Free names before upserts so a transaction can swap them.
        for e in &changes.endpoints {
            self.execute(
                "UPDATE endpoints SET handle=$1 WHERE account_id=$2 AND id=$3",
                args![&format!("\u{1}{}", e.id), a, &e.id],
            )
            .await?;
        }
        for e in changes.endpoints {
            valid(&e.fields)?;
            self.execute("INSERT INTO endpoints(account_id,id,machine,handle,kind,token_hash,created_at,last_seen,payload,fields) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(account_id,id) DO UPDATE SET machine=excluded.machine,handle=excluded.handle,kind=excluded.kind,token_hash=excluded.token_hash,created_at=excluded.created_at,last_seen=excluded.last_seen,payload=excluded.payload,fields=excluded.fields",args![a,&e.id,&e.machine,&e.handle,&e.kind,&e.token_hash,e.created_at,e.last_seen,&json(&e)?,&e.fields]).await?;
        }
        for d in changes.deliveries {
            valid(&d.state)?;
            if self.execute("UPDATE deliveries SET acked_at=$1,rejected_at=$2,rejection=$3,state=$4 WHERE account_id=$5 AND seq=$6 AND message_id=$7 AND endpoint=$8 AND expires_at=$9",args![d.acked_at,d.rejected_at,&d.rejection,&d.state,a,d.seq,&d.message_id,&d.endpoint,d.expires_at]).await? == 0 { return Err(StoreError::NotFound); }
        }
        for (endpoint, now) in changes.renew_deliveries {
            let rows = self.rows("SELECT seq,message_id,expires_at,state FROM deliveries WHERE account_id=$1 AND endpoint=$2 AND acked_at IS NULL AND rejected_at IS NULL AND expires_at>$3 AND NOT EXISTS (SELECT 1 FROM xinbox x WHERE x.account_id=deliveries.account_id AND x.seq=deliveries.seq) ORDER BY seq",args![a,&endpoint,now]).await?;
            for row in rows {
                self.execute(
                    "DELETE FROM deliveries WHERE account_id=$1 AND seq=$2",
                    args![a, row.int("seq")?],
                )
                .await?;
                self.execute("INSERT INTO deliveries(account_id,message_id,endpoint,expires_at,state) VALUES($1,$2,$3,$4,$5)",args![a,&row.text("message_id")?,&endpoint,row.int("expires_at")?,&row.text("state")?]).await?;
            }
        }
        for (e, local) in changes.pairs {
            let table = if local { "local_events" } else { "pair_events" };
            self.execute(
                &format!("INSERT INTO {table}(account_id,from_ep,to_ep,at) VALUES($1,$2,$3,$4)"),
                args![a, &e.from_ep, &e.to_ep, e.at],
            )
            .await?;
        }
        Ok(())
    }

    async fn rows(&mut self, sql: &str, args: Vec<Bind>) -> Result<Vec<DataRow>> {
        match self {
            Self::Sqlite(t) => Ok(bound_query!(sql, args)
                .fetch_all(&mut **t)
                .await
                .map_err(err)?
                .into_iter()
                .map(DataRow::Sqlite)
                .collect()),
            Self::Postgres(t) => Ok(bound_query!(sql, args)
                .fetch_all(&mut **t)
                .await
                .map_err(err)?
                .into_iter()
                .map(DataRow::Postgres)
                .collect()),
        }
    }
    async fn execute(&mut self, sql: &str, args: Vec<Bind>) -> Result<u64> {
        match self {
            Self::Sqlite(t) => Ok(bound_query!(sql, args)
                .execute(&mut **t)
                .await
                .map_err(err)?
                .rows_affected()),
            Self::Postgres(t) => Ok(bound_query!(sql, args)
                .execute(&mut **t)
                .await
                .map_err(err)?
                .rows_affected()),
        }
    }
    async fn one<T: DeserializeOwned>(&mut self, sql: &str, args: Vec<Bind>) -> Result<Option<T>> {
        self.rows(sql, args)
            .await?
            .first()
            .map(DataRow::payload)
            .transpose()
    }
    async fn commit(self) -> Result<()> {
        match self {
            Self::Sqlite(t) => t.commit().await,
            Self::Postgres(t) => t.commit().await,
        }
        .map_err(err)
    }
    async fn credential(&mut self, c: &Credential) -> Result<()> {
        self.execute("INSERT INTO credentials(id,account_id,member_id,kind,name,secret_hash,created_at,expires_at,revoked_at,last_used_at,payload,labels) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",args![&c.id,&c.account_id,&c.member_id,kind(c.kind),&c.name,&c.secret_hash,c.created_at,c.expires_at,c.revoked_at,c.last_used_at,&json(c)?,&json(&c.labels)?]).await?;
        Ok(())
    }
    async fn save_code(&mut self, c: &DeviceCode) -> Result<()> {
        self.execute(
            "UPDATE device_codes SET payload=$1,last_poll_at=$3,state=$4,account_id=$5,member_id=$6,credential_id=$7 WHERE device_code_hash=$2",
            args![&json(c)?, &c.device_code_hash, c.last_poll_at, device_state(c.state), &c.account_id, &c.member_id, &c.credential_id],
        )
        .await?;
        Ok(())
    }
}
fn kind(k: CredentialKind) -> &'static str {
    match k {
        CredentialKind::Device => "device",
        CredentialKind::Token => "token",
    }
}
fn role(r: Role) -> &'static str {
    match r {
        Role::Owner => "owner",
        Role::Admin => "admin",
        Role::Member => "member",
    }
}
fn device_state(s: DeviceState) -> &'static str {
    match s {
        DeviceState::Pending => "pending",
        DeviceState::Approved => "approved",
        DeviceState::Denied => "denied",
        DeviceState::Redeemed => "redeemed",
    }
}
impl SqliteStore {
    /// Connect and apply embedded migrations. Both SQLite memory URL forms work.
    pub async fn connect(url: &str) -> Result<Self> {
        let memory = matches!(url, "sqlite::memory:" | "sqlite://:memory:");
        let options = SqliteConnectOptions::from_str(if memory { "sqlite::memory:" } else { url })
            .map_err(err)?
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(if memory { 1 } else { 8 })
            .connect_with(options)
            .await
            .map_err(err)?;
        let db = Database::Sqlite(pool);
        db.migrate().await?;
        Ok(Self { db })
    }
}
impl PostgresStore {
    /// Connect to an existing database and apply embedded migrations.
    pub async fn connect(url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(5))
            .connect(url)
            .await
            .map_err(err)?;
        let db = Database::Postgres(pool);
        db.migrate().await?;
        Ok(Self { db })
    }
}
/// Select SQLite or PostgreSQL by URL scheme and apply migrations at connect.
pub async fn connect(url: &str) -> Result<Arc<dyn RelayStore>> {
    if url.starts_with("sqlite:") {
        Ok(Arc::new(SqliteStore::connect(url).await?))
    } else if url.starts_with("postgres://") || url.starts_with("postgresql://") {
        Ok(Arc::new(PostgresStore::connect(url).await?))
    } else {
        Err(StoreError::Backend("unsupported store scheme".into()))
    }
}
trait Backend: Send + Sync + 'static {
    fn db(&self) -> &Database;
}
impl Backend for SqliteStore {
    fn db(&self) -> &Database {
        &self.db
    }
}
impl Backend for PostgresStore {
    fn db(&self) -> &Database {
        &self.db
    }
}
#[async_trait]
impl<T: Backend> RelayStore for T {
    async fn create_account(&self, a: Account) -> Result<Account> {
        let mut t = self.db().begin("host-accounts").await?;
        t.execute("INSERT INTO accounts(id,handle,created_at,payload) VALUES($1,$2,$3,$4) ON CONFLICT(handle) DO NOTHING",args![&a.id,&a.handle,a.created_at,&json(&a)?]).await?;
        let row = t
            .one(
                "SELECT payload FROM accounts WHERE handle=$1",
                args![&a.handle],
            )
            .await?
            .ok_or(StoreError::NotFound)?;
        t.commit().await?;
        Ok(row)
    }
    async fn account(&self, handle: &str) -> Result<Option<Account>> {
        self.db()
            .one(
                "SELECT payload FROM accounts WHERE handle=$1",
                args![handle],
            )
            .await
    }
    async fn contact(&self, a: &str, p: &str) -> Result<Option<Contact>> {
        self.db().contact(a, p).await
    }
    async fn contacts(&self, a: &str) -> Result<Vec<Contact>> {
        self.db().contacts(a).await
    }
    async fn contact_invite(&self, a: &str, p: &str, now: i64) -> Result<()> {
        self.db().change_contact(a, p, "invite", None, now).await
    }
    async fn contact_accept(&self, a: &str, p: &str, now: i64) -> Result<()> {
        self.db().change_contact(a, p, "accept", None, now).await
    }
    async fn contact_decline(&self, a: &str, p: &str, now: i64) -> Result<()> {
        self.db().change_contact(a, p, "decline", None, now).await
    }
    async fn contact_revoke(&self, a: &str, p: &str, now: i64) -> Result<()> {
        self.db().change_contact(a, p, "revoke", None, now).await
    }
    async fn contact_block(&self, a: &str, p: &str, now: i64) -> Result<()> {
        self.db().change_contact(a, p, "block", None, now).await
    }
    async fn contact_update(&self, a: &str, p: &str, c: ContactConfig, now: i64) -> Result<()> {
        self.db().change_contact(a, p, "update", Some(c), now).await
    }
    async fn xinbox(&self, a: &str) -> Result<Vec<XInbox>> {
        self.db().xinbox(a).await
    }
    async fn xinsert(&self, a: &str, m: Message, x: XInbox) -> Result<(XInbox, bool)> {
        self.db().xinsert(a, m, x).await
    }
    async fn xack(&self, a: &str, e: &[String], s: &[i64], now: i64) -> Result<usize> {
        self.db().xack(a, e, s, now).await
    }
    async fn acknowledge(
        &self,
        a: &str,
        changes: HubWrite,
        endpoints: &[String],
        seqs: &[i64],
        now: i64,
    ) -> Result<usize> {
        let mut t = self.db().begin(a).await?;
        let local = changes.deliveries.len();
        t.hub_write(a, changes).await?;
        let cross = t.xack(a, endpoints, seqs, now).await?;
        t.commit().await?;
        Ok(local + cross)
    }
    async fn xprune(&self, a: &str) -> Result<u64> {
        self.db().xprune(a).await
    }
    async fn create_member(&self, m: Member) -> Result<()> {
        let mut t = self
            .db()
            .begin(&format!("host-members:{}", m.account_id))
            .await?;
        t.execute(
            "INSERT INTO members(id,account_id,name,created_at,payload,email,role) VALUES($1,$2,$3,$4,$5,$6,$7)",
            args![&m.id, &m.account_id, &m.name, m.created_at, &json(&m)?, &m.email, role(m.role)],
        )
        .await?;
        t.commit().await
    }
    async fn ensure_member(&self, mut m: Member, automatic_role: bool) -> Result<Member> {
        let mut t = self
            .db()
            .begin(&format!("host-members:{}", m.account_id))
            .await?;
        if let Some(existing) = t
            .one(
                "SELECT payload FROM members WHERE account_id=$1 AND name=$2",
                args![&m.account_id, &m.name],
            )
            .await?
        {
            t.commit().await?;
            return Ok(existing);
        }
        if automatic_role {
            m.role = if t
                .rows(
                    "SELECT id FROM members WHERE account_id=$1 LIMIT 1",
                    args![&m.account_id],
                )
                .await?
                .is_empty()
            {
                Role::Owner
            } else {
                Role::Member
            };
        }
        t.execute(
            "INSERT INTO members(id,account_id,name,created_at,payload,email,role) VALUES($1,$2,$3,$4,$5,$6,$7)",
            args![&m.id, &m.account_id, &m.name, m.created_at, &json(&m)?, &m.email, role(m.role)],
        )
        .await?;
        t.commit().await?;
        Ok(m)
    }
    async fn member(&self, a: &str, name: &str) -> Result<Option<Member>> {
        self.db()
            .one(
                "SELECT payload FROM members WHERE account_id=$1 AND name=$2",
                args![a, name],
            )
            .await
    }
    async fn members(&self, a: &str) -> Result<Vec<Member>> {
        self.db()
            .all(
                "SELECT payload FROM members WHERE account_id=$1 ORDER BY created_at,id",
                args![a],
            )
            .await
    }
    async fn create_credential(&self, c: Credential) -> Result<()> {
        let mut t = self.db().begin("host-credentials").await?;
        t.credential(&c).await?;
        t.commit().await
    }
    async fn credential_by_hash(&self, h: &str, now: i64) -> Result<CredentialLookup> {
        self.db().lookup("secret_hash", h, now).await
    }
    async fn credential_by_id(&self, id: &str, now: i64) -> Result<CredentialLookup> {
        self.db().lookup("id", id, now).await
    }
    async fn touch_credential(&self, id: &str, now: i64) -> Result<()> {
        let mut t = self.db().begin("host-credentials").await?;
        let mut c: Credential = t
            .one("SELECT payload FROM credentials WHERE id=$1", args![id])
            .await?
            .ok_or(StoreError::NotFound)?;
        if c.last_used_at.is_none_or(|at| at < now) {
            c.last_used_at = Some(now);
            t.execute(
                "UPDATE credentials SET last_used_at=$1,payload=$2 WHERE id=$3",
                args![now, &json(&c)?, id],
            )
            .await?;
        }
        t.commit().await
    }
    async fn revoke_credential(&self, id: &str, now: i64) -> Result<bool> {
        let mut t = self.db().begin("host-credentials").await?;
        let c: Option<Credential> = t
            .one("SELECT payload FROM credentials WHERE id=$1", args![id])
            .await?;
        let changed = if let Some(mut c) = c {
            if c.revoked_at.is_none() {
                c.revoked_at = Some(now);
                t.execute(
                    "UPDATE credentials SET revoked_at=$1,payload=$2 WHERE id=$3",
                    args![now, &json(&c)?, id],
                )
                .await?;
                true
            } else {
                false
            }
        } else {
            false
        };
        t.commit().await?;
        Ok(changed)
    }
    async fn purge_device_codes(&self, now: i64) -> Result<u64> {
        let mut t = self.db().begin("host-device").await?;
        let count = t.purge_device_codes(now).await?;
        t.commit().await?;
        Ok(count)
    }
    async fn create_device_code(&self, c: DeviceCode) -> Result<()> {
        if c.state != DeviceState::Pending
            || c.account_id.is_some()
            || c.member_id.is_some()
            || c.credential_id.is_some()
        {
            return Err(StoreError::Conflict);
        }
        let mut t = self.db().begin("host-device").await?;
        t.purge_device_codes(c.created_at).await?;
        let count = t
            .rows(
                "SELECT COUNT(*) AS n FROM device_codes WHERE state='pending' AND expires_at>$1",
                args![c.created_at],
            )
            .await?[0]
            .int("n")?;
        if count >= 1000 {
            t.commit().await?;
            return Err(StoreError::Capacity);
        }
        t.execute("INSERT INTO device_codes(device_code_hash,user_code,expires_at,payload,label,created_at,last_poll_at,state,account_id,member_id,credential_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",args![&c.device_code_hash,&c.user_code,c.expires_at,&json(&c)?,&c.label,c.created_at,c.last_poll_at,device_state(c.state),&c.account_id,&c.member_id,&c.credential_id]).await?;
        t.commit().await
    }
    async fn device_code(&self, code: &str) -> Result<Option<DeviceCode>> {
        self.db()
            .one(
                "SELECT payload FROM device_codes WHERE user_code=$1",
                args![code],
            )
            .await
    }
    async fn approve_device(&self, code: &str, a: &str, m: &str, now: i64) -> Result<()> {
        let mut t = self.db().begin("host-device").await?;
        let mut c: DeviceCode = t
            .one(
                "SELECT payload FROM device_codes WHERE user_code=$1",
                args![code],
            )
            .await?
            .ok_or(StoreError::NotFound)?;
        if c.state != DeviceState::Pending || c.expires_at <= now {
            return Err(StoreError::Conflict);
        }
        if t.rows(
            "SELECT id FROM members WHERE account_id=$1 AND id=$2",
            args![a, m],
        )
        .await?
        .is_empty()
        {
            return Err(StoreError::Conflict);
        }
        c.state = DeviceState::Approved;
        c.account_id = Some(a.into());
        c.member_id = Some(m.into());
        t.save_code(&c).await?;
        t.commit().await
    }
    async fn deny_device(&self, code: &str, now: i64) -> Result<()> {
        let mut t = self.db().begin("host-device").await?;
        let mut c: DeviceCode = t
            .one(
                "SELECT payload FROM device_codes WHERE user_code=$1",
                args![code],
            )
            .await?
            .ok_or(StoreError::NotFound)?;
        if c.state != DeviceState::Pending || c.expires_at <= now {
            return Err(StoreError::Conflict);
        }
        c.state = DeviceState::Denied;
        t.save_code(&c).await?;
        t.commit().await
    }
    async fn poll_device(&self, h: &str, now: i64, interval: i64) -> Result<DevicePoll> {
        let mut t = self.db().begin("host-device").await?;
        let c: Option<DeviceCode> = t
            .one(
                "SELECT payload FROM device_codes WHERE device_code_hash=$1",
                args![h],
            )
            .await?;
        let result = if let Some(mut c) = c {
            if c.state == DeviceState::Redeemed {
                DevicePoll::Invalid
            } else if c.state == DeviceState::Denied {
                DevicePoll::Denied
            } else if c.expires_at <= now {
                DevicePoll::Expired
            } else {
                let slow = c
                    .last_poll_at
                    .is_some_and(|at| now.saturating_sub(at) < interval);
                c.last_poll_at = Some(now);
                t.save_code(&c).await?;
                if slow {
                    DevicePoll::SlowDown
                } else if c.state == DeviceState::Approved {
                    DevicePoll::Approved(c)
                } else {
                    DevicePoll::Pending
                }
            }
        } else {
            DevicePoll::Invalid
        };
        t.commit().await?;
        Ok(result)
    }
    async fn redeem_device(&self, h: &str, credential: Credential, now: i64) -> Result<()> {
        let mut t = self.db().begin("host-device").await?;
        let mut c: DeviceCode = t
            .one(
                "SELECT payload FROM device_codes WHERE device_code_hash=$1",
                args![h],
            )
            .await?
            .ok_or(StoreError::NotFound)?;
        if c.state != DeviceState::Approved
            || c.expires_at <= now
            || c.account_id.as_ref() != Some(&credential.account_id)
            || c.member_id.as_ref() != Some(&credential.member_id)
            || credential.kind != CredentialKind::Device
            || credential.name != c.label
            || credential.revoked_at.is_some()
        {
            return Err(StoreError::Conflict);
        }
        c.state = DeviceState::Redeemed;
        c.credential_id = Some(credential.id.clone());
        t.credential(&credential).await?;
        t.save_code(&c).await?;
        t.commit().await
    }
    async fn put_machine(&self, a: &str, m: Machine) -> Result<()> {
        let mut t = self.db().begin(a).await?;
        t.execute("INSERT INTO machines(account_id,name,token_id,actor_id,user_id,kind,created_at,last_seen,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(account_id,name) DO UPDATE SET token_id=excluded.token_id,actor_id=excluded.actor_id,user_id=excluded.user_id,kind=excluded.kind,created_at=excluded.created_at,last_seen=excluded.last_seen,payload=excluded.payload",args![a,&m.name,&m.token_id,&m.actor_id,&m.user_id,&m.kind,m.created_at,m.last_seen,&json(&m)?]).await?;
        t.execute(
            "DELETE FROM machine_tombstones WHERE account_id=$1 AND name=$2",
            args![a, &m.name],
        )
        .await?;
        t.execute(
            "DELETE FROM hub_state WHERE account_id=$1 AND key='idle_since'",
            args![a],
        )
        .await?;
        t.commit().await
    }
    async fn machines(&self, a: &str) -> Result<Vec<Machine>> {
        self.db()
            .all(
                "SELECT payload FROM machines WHERE account_id=$1 ORDER BY name",
                args![a],
            )
            .await
    }
    async fn remove_machine(&self, a: &str, name: &str, tomb: Option<Tombstone>) -> Result<()> {
        if tomb.as_ref().is_some_and(|t| t.name != name) {
            return Err(StoreError::Conflict);
        }
        let mut t = self.db().begin(a).await?;
        if t.execute(
            "DELETE FROM machines WHERE account_id=$1 AND name=$2",
            args![a, name],
        )
        .await?
            == 0
        {
            return Err(StoreError::NotFound);
        }
        if let Some(v) = tomb {
            t.execute("INSERT INTO machine_tombstones(account_id,name,at,payload,actor_id,user_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(account_id,name) DO UPDATE SET at=excluded.at,payload=excluded.payload,actor_id=excluded.actor_id,user_id=excluded.user_id",args![a,name,v.at,&json(&v)?,&v.actor_id,&v.user_id]).await?;
        }
        t.commit().await
    }
    async fn tombstones(&self, a: &str) -> Result<Vec<Tombstone>> {
        self.db()
            .all(
                "SELECT payload FROM machine_tombstones WHERE account_id=$1 ORDER BY name",
                args![a],
            )
            .await
    }
    async fn remove_tombstone(&self, a: &str, n: &str) -> Result<bool> {
        Ok(self
            .db()
            .execute(
                "DELETE FROM machine_tombstones WHERE account_id=$1 AND name=$2",
                args![a, n],
            )
            .await?
            > 0)
    }
    async fn put_endpoint(&self, a: &str, e: Endpoint) -> Result<()> {
        valid(&e.fields)?;
        self.db().execute("INSERT INTO endpoints(account_id,id,machine,handle,kind,token_hash,created_at,last_seen,payload,fields) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(account_id,id) DO UPDATE SET machine=excluded.machine,handle=excluded.handle,kind=excluded.kind,token_hash=excluded.token_hash,created_at=excluded.created_at,last_seen=excluded.last_seen,payload=excluded.payload,fields=excluded.fields",args![a,&e.id,&e.machine,&e.handle,&e.kind,&e.token_hash,e.created_at,e.last_seen,&json(&e)?,&e.fields]).await?;
        Ok(())
    }
    async fn endpoints(&self, a: &str, m: Option<&str>) -> Result<Vec<Endpoint>> {
        match m {Some(m)=>self.db().all("SELECT payload FROM endpoints WHERE account_id=$1 AND machine=$2 ORDER BY machine,handle,id",args![a,m]).await,None=>self.db().all("SELECT payload FROM endpoints WHERE account_id=$1 ORDER BY machine,handle,id",args![a]).await}
    }
    async fn remove_endpoint(&self, a: &str, id: &str) -> Result<bool> {
        Ok(self
            .db()
            .execute(
                "DELETE FROM endpoints WHERE account_id=$1 AND id=$2",
                args![a, id],
            )
            .await?
            > 0)
    }
    async fn hub_write(&self, a: &str, changes: HubWrite) -> Result<()> {
        let mut t = self.db().begin(a).await?;
        t.hub_write(a, changes).await?;
        t.commit().await
    }
    async fn store_message(
        &self,
        a: &str,
        m: Message,
        ds: Vec<NewDelivery>,
        i: Option<Idempotency>,
    ) -> Result<Vec<Delivery>> {
        self.route_message(a, m, ds, i, HubWrite::default()).await
    }
    async fn route_message(
        &self,
        a: &str,
        m: Message,
        ds: Vec<NewDelivery>,
        i: Option<Idempotency>,
        changes: HubWrite,
    ) -> Result<Vec<Delivery>> {
        valid(&m.envelope)?;
        let mut t = self.db().begin(a).await?;
        t.execute("INSERT INTO messages(account_id,id,thread,reply_to,kind,from_ep,to_addr,created_at,expires_at,payload,envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",args![a,&m.id,&m.thread,&m.reply_to,&m.kind,&m.from_ep,&m.to_addr,m.created_at,m.expires_at,&json(&m)?,&m.envelope]).await?;
        let mut out = Vec::with_capacity(ds.len());
        for d in ds {
            valid(&d.state)?;
            let rows=t.rows("INSERT INTO deliveries(account_id,message_id,endpoint,expires_at,state) VALUES($1,$2,$3,$4,$5) RETURNING seq",args![a,&m.id,&d.endpoint,d.expires_at,&d.state]).await?;
            let seq = rows.first().ok_or(StoreError::NotFound)?.int("seq")?;
            out.push(Delivery {
                seq,
                message_id: m.id.clone(),
                endpoint: d.endpoint,
                expires_at: d.expires_at,
                acked_at: None,
                rejected_at: None,
                rejection: None,
                state: d.state,
            });
        }
        t.hub_write(a, changes).await?;
        if let Some(mut i) = i {
            valid(&i.result)?;
            let mut result: serde_json::Value = parse(&i.result)?;
            if let Some(deliveries) = result
                .get_mut("deliveries")
                .and_then(serde_json::Value::as_array_mut)
            {
                for (value, delivery) in deliveries.iter_mut().zip(&out) {
                    value["seq"] = serde_json::json!(delivery.seq);
                }
                i.result = result.to_string();
            }
            t.execute("INSERT INTO idempotency(account_id,from_ep,client_id,created_at,payload,payload_hash,result) VALUES($1,$2,$3,$4,$5,$6,$7)",args![a,&i.from_ep,&i.client_id,i.created_at,&json(&i)?,&i.payload_hash,&i.result]).await?;
        }
        t.commit().await?;
        Ok(out)
    }
    async fn message(&self, a: &str, id: &str) -> Result<Option<Message>> {
        self.db()
            .one(
                "SELECT payload FROM messages WHERE account_id=$1 AND id=$2",
                args![a, id],
            )
            .await
    }
    async fn stored_bytes(&self, a: &str) -> Result<u64> {
        let sql = match self.db() {
            Database::Sqlite(_) => {
                "SELECT (SELECT COALESCE(SUM(length(CAST(json_extract(envelope,'$.body.text') AS BLOB))),0) FROM messages m WHERE account_id=$1 AND NOT EXISTS (SELECT 1 FROM xinbox x WHERE x.account_id=m.account_id AND x.id=m.id))+(SELECT COALESCE(SUM(length(CAST(message AS BLOB))),0) FROM xinbox WHERE account_id=$1) AS n"
            }
            Database::Postgres(_) => {
                "SELECT ((SELECT COALESCE(SUM(octet_length(envelope::jsonb #>> '{body,text}')),0) FROM messages m WHERE account_id=$1 AND NOT EXISTS (SELECT 1 FROM xinbox x WHERE x.account_id=m.account_id AND x.id=m.id))+(SELECT COALESCE(SUM(octet_length(message)),0) FROM xinbox WHERE account_id=$1))::bigint AS n"
            }
        };
        Ok(self
            .db()
            .rows(sql, args![a])
            .await?
            .first()
            .ok_or(StoreError::NotFound)?
            .int("n")? as u64)
    }
    async fn sent_count(&self, a: &str, since: i64) -> Result<i64> {
        self.db().rows("SELECT COUNT(*) AS n FROM messages WHERE account_id=$1 AND created_at>=$2 AND from_ep!='system' AND NOT EXISTS (SELECT 1 FROM xinbox x WHERE x.account_id=messages.account_id AND x.id=messages.id)",args![a,since]).await?.first().ok_or(StoreError::NotFound)?.int("n")
    }
    async fn messages(
        &self,
        a: &str,
        thread: Option<&str>,
        since: i64,
        limit: usize,
    ) -> Result<Vec<Message>> {
        let limit = limit.clamp(1, 2001) as i64;
        self.db().all("SELECT payload FROM messages WHERE account_id=$1 AND created_at>=$2 AND ($3 IS NULL OR thread=$3) AND NOT EXISTS (SELECT 1 FROM xinbox x WHERE x.account_id=messages.account_id AND x.id=messages.id) ORDER BY created_at,id LIMIT $4",args![a,since,&thread.map(str::to_owned),limit]).await
    }
    async fn machine_busy(&self, a: &str, machine: &str, now: i64) -> Result<bool> {
        let queued = self.db().rows("SELECT 1 FROM deliveries d JOIN endpoints e ON e.account_id=d.account_id AND e.id=d.endpoint WHERE d.account_id=$1 AND e.machine=$2 AND d.acked_at IS NULL AND d.expires_at>$3 LIMIT 1",args![a,machine,now]).await?;
        if !queued.is_empty() {
            return Ok(true);
        }
        Ok(!self.db().rows("SELECT 1 FROM messages m JOIN endpoints e ON e.account_id=m.account_id AND e.id=m.from_ep WHERE m.account_id=$1 AND e.machine=$2 AND m.kind='request' AND m.expires_at>$3 AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.account_id=m.account_id AND r.reply_to=m.id AND r.kind='reply') LIMIT 1",args![a,machine,now]).await?.is_empty())
    }
    async fn pending_machine(
        &self,
        a: &str,
        m: &str,
        after: i64,
        now: i64,
        limit: usize,
    ) -> Result<Vec<Delivery>> {
        self.pending_machine_x(a, m, after, after, now, limit).await
    }
    async fn pending_machine_x(
        &self,
        a: &str,
        machine: &str,
        after: i64,
        xafter: i64,
        now: i64,
        limit: usize,
    ) -> Result<Vec<Delivery>> {
        self.db().rows("SELECT d.seq,d.message_id,d.endpoint,d.expires_at,d.acked_at,d.rejected_at,d.rejection,d.state FROM deliveries d JOIN endpoints e ON e.account_id=d.account_id AND e.id=d.endpoint LEFT JOIN xinbox x ON x.account_id=d.account_id AND x.seq=d.seq WHERE d.account_id=$1 AND e.machine=$2 AND e.token_hash IS NULL AND ((x.seq IS NULL AND d.seq>$3) OR (x.seq>$6 AND x.endpoint=e.machine || '/' || e.handle AND EXISTS (SELECT 1 FROM contacts c WHERE c.account_id=x.account_id AND c.peer_id=x.from_account AND c.state='active' AND c.dir!='out'))) AND d.expires_at>$4 AND d.acked_at IS NULL AND d.rejected_at IS NULL ORDER BY d.seq LIMIT $5",args![a,machine,after,now,limit.clamp(1,200) as i64,xafter]).await?.iter().map(delivery).collect()
    }
    async fn thread_member(&self, a: &str, thread: &str, endpoint: &str) -> Result<bool> {
        Ok(!self.db().rows("SELECT 1 FROM messages m WHERE m.account_id=$1 AND m.thread=$2 AND (m.from_ep=$3 OR EXISTS (SELECT 1 FROM deliveries d WHERE d.account_id=m.account_id AND d.message_id=m.id AND d.endpoint=$3)) LIMIT 1",args![a,thread,endpoint]).await?.is_empty())
    }
    async fn member_messages(
        &self,
        a: &str,
        endpoint: &str,
        reference: &str,
    ) -> Result<Vec<Message>> {
        let sql = "SELECT m.payload FROM messages m WHERE m.account_id=$1 AND (m.id=$3 OR (length($3)>=4 AND substr(m.id,length(m.id)-length($3)+1)=$3)) AND EXISTS (SELECT 1 FROM messages member WHERE member.account_id=m.account_id AND member.thread=m.thread AND (member.from_ep=$2 OR EXISTS (SELECT 1 FROM deliveries d WHERE d.account_id=member.account_id AND d.message_id=member.id AND d.endpoint=$2))) ORDER BY m.created_at DESC,m.id DESC LIMIT 2";
        let rows: Vec<Message> = self.db().all(sql, args![a, endpoint, reference]).await?;
        if let Some(exact) = rows.iter().find(|m| m.id == reference) {
            return Ok(vec![exact.clone()]);
        }
        Ok(rows)
    }
    async fn message_deliveries(&self, a: &str, message: &str) -> Result<Vec<Delivery>> {
        self.db().rows("SELECT seq,message_id,endpoint,expires_at,acked_at,rejected_at,rejection,state FROM deliveries WHERE account_id=$1 AND message_id=$2 ORDER BY seq",args![a,message]).await?.iter().map(|r|Ok(Delivery{seq:r.int("seq")?,message_id:r.text("message_id")?,endpoint:r.text("endpoint")?,expires_at:r.int("expires_at")?,acked_at:r.optional_int("acked_at")?,rejected_at:r.optional_int("rejected_at")?,rejection:r.optional_text("rejection")?,state:r.text("state")?})).collect()
    }
    async fn deliveries(&self, a: &str, e: &str, after: i64) -> Result<Vec<Delivery>> {
        self.db().rows("SELECT seq,message_id,endpoint,expires_at,acked_at,rejected_at,rejection,state FROM deliveries WHERE account_id=$1 AND endpoint=$2 AND seq>$3 ORDER BY seq",args![a,e,after]).await?.iter().map(|r|Ok(Delivery{seq:r.int("seq")?,message_id:r.text("message_id")?,endpoint:r.text("endpoint")?,expires_at:r.int("expires_at")?,acked_at:r.optional_int("acked_at")?,rejected_at:r.optional_int("rejected_at")?,rejection:r.optional_text("rejection")?,state:r.text("state")?})).collect()
    }
    async fn open_deliveries(
        &self,
        a: &str,
        e: &str,
        after: i64,
        now: i64,
        limit: usize,
    ) -> Result<Vec<Delivery>> {
        self.db().rows("SELECT seq,message_id,endpoint,expires_at,acked_at,rejected_at,rejection,state FROM deliveries WHERE account_id=$1 AND endpoint=$2 AND seq>$3 AND acked_at IS NULL AND rejected_at IS NULL AND expires_at>$4 AND (NOT EXISTS (SELECT 1 FROM xinbox x WHERE x.account_id=deliveries.account_id AND x.seq=deliveries.seq) OR EXISTS (SELECT 1 FROM xinbox x JOIN contacts c ON c.account_id=x.account_id AND c.peer_id=x.from_account JOIN endpoints e ON e.account_id=x.account_id AND e.id=deliveries.endpoint WHERE x.account_id=deliveries.account_id AND x.seq=deliveries.seq AND c.state='active' AND c.dir!='out' AND e.token_hash IS NULL AND x.endpoint=e.machine || '/' || e.handle)) ORDER BY seq LIMIT $5", args![a,e,after,now,limit.clamp(1,200) as i64]).await?.iter().map(delivery).collect()
    }
    async fn open_delivery_count(&self, a: &str, e: &str, now: i64) -> Result<i64> {
        self.db().rows("SELECT COUNT(*) AS n FROM deliveries WHERE account_id=$1 AND endpoint=$2 AND acked_at IS NULL AND rejected_at IS NULL AND expires_at>$3 AND (NOT EXISTS (SELECT 1 FROM xinbox x WHERE x.account_id=deliveries.account_id AND x.seq=deliveries.seq) OR EXISTS (SELECT 1 FROM xinbox x JOIN contacts c ON c.account_id=x.account_id AND c.peer_id=x.from_account JOIN endpoints e ON e.account_id=x.account_id AND e.id=deliveries.endpoint WHERE x.account_id=deliveries.account_id AND x.seq=deliveries.seq AND c.state='active' AND c.dir!='out' AND e.token_hash IS NULL AND x.endpoint=e.machine || '/' || e.handle))", args![a,e,now]).await?[0].int("n")
    }
    async fn reply_delivery(
        &self,
        a: &str,
        e: &str,
        request: &str,
        now: i64,
    ) -> Result<Option<Delivery>> {
        self.db().rows("SELECT d.seq,d.message_id,d.endpoint,d.expires_at,d.acked_at,d.rejected_at,d.rejection,d.state FROM deliveries d JOIN messages m ON m.account_id=d.account_id AND m.id=d.message_id JOIN messages asked ON asked.account_id=m.account_id AND asked.id=m.reply_to WHERE d.account_id=$1 AND d.endpoint=$2 AND asked.id=$3 AND asked.from_ep=$2 AND m.kind='reply' AND d.expires_at>$4 AND (EXISTS (SELECT 1 FROM deliveries addressed WHERE addressed.account_id=m.account_id AND addressed.message_id=asked.id AND addressed.endpoint=m.from_ep) OR NOT EXISTS (SELECT 1 FROM deliveries addressed WHERE addressed.account_id=m.account_id AND addressed.message_id=asked.id)) AND (NOT EXISTS (SELECT 1 FROM xinbox x WHERE x.account_id=d.account_id AND x.seq=d.seq) OR EXISTS (SELECT 1 FROM xinbox x JOIN contacts c ON c.account_id=x.account_id AND c.peer_id=x.from_account WHERE x.account_id=d.account_id AND x.seq=d.seq AND c.state='active' AND c.dir!='out')) ORDER BY d.seq LIMIT 1", args![a,e,request,now]).await?.first().map(delivery).transpose()
    }
    async fn update_delivery(&self, a: &str, d: Delivery) -> Result<()> {
        valid(&d.state)?;
        if self.db().execute("UPDATE deliveries SET acked_at=$1,rejected_at=$2,rejection=$3,state=$4 WHERE account_id=$5 AND seq=$6 AND message_id=$7 AND endpoint=$8 AND expires_at=$9",args![d.acked_at,d.rejected_at,&d.rejection,&d.state,a,d.seq,&d.message_id,&d.endpoint,d.expires_at]).await?==0 {return Err(StoreError::NotFound);}
        Ok(())
    }
    async fn idempotency(&self, a: &str, f: &str, c: &str) -> Result<Option<Idempotency>> {
        self.db().one("SELECT payload FROM idempotency WHERE account_id=$1 AND from_ep=$2 AND client_id=$3",args![a,f,c]).await
    }
    async fn purge_messages(&self, a: &str, now: i64, before: i64) -> Result<u64> {
        let mut t = self.db().begin(a).await?;
        let n = t
            .execute(
                "DELETE FROM messages WHERE account_id=$1 AND expires_at<=$2",
                args![a, now],
            )
            .await?;
        t.execute(
            "DELETE FROM idempotency WHERE account_id=$1 AND created_at<$2",
            args![a, before],
        )
        .await?;
        t.commit().await?;
        Ok(n)
    }
    async fn state(&self, a: &str, k: &str) -> Result<Option<String>> {
        self.db()
            .rows(
                "SELECT payload FROM hub_state WHERE account_id=$1 AND key=$2",
                args![a, k],
            )
            .await?
            .first()
            .map(|r| r.text("payload"))
            .transpose()
    }
    async fn put_state(&self, a: &str, k: &str, v: Option<&str>) -> Result<()> {
        if let Some(v) = v {
            valid(v)?;
            self.db().execute("INSERT INTO hub_state(account_id,key,payload) VALUES($1,$2,$3) ON CONFLICT(account_id,key) DO UPDATE SET payload=excluded.payload",args![a,k,v]).await?;
        } else {
            self.db()
                .execute(
                    "DELETE FROM hub_state WHERE account_id=$1 AND key=$2",
                    args![a, k],
                )
                .await?;
        }
        Ok(())
    }
    async fn append_pair(&self, a: &str, e: PairEvent, local: bool) -> Result<()> {
        let table = if local { "local_events" } else { "pair_events" };
        self.db()
            .execute(
                &format!("INSERT INTO {table}(account_id,from_ep,to_ep,at) VALUES($1,$2,$3,$4)"),
                args![a, &e.from_ep, &e.to_ep, e.at],
            )
            .await?;
        Ok(())
    }
    async fn pairs(
        &self,
        a: &str,
        f: Option<&str>,
        to: Option<&str>,
        since: i64,
        local: bool,
    ) -> Result<Vec<PairEvent>> {
        let table = if local { "local_events" } else { "pair_events" };
        self.db().rows(&format!("SELECT from_ep,to_ep,at FROM {table} WHERE account_id=$1 AND at>=$2 AND ($3 IS NULL OR from_ep=$3) AND ($4 IS NULL OR to_ep=$4) ORDER BY at,from_ep,to_ep"),args![a,since,&f.map(str::to_owned),&to.map(str::to_owned)]).await?.iter().map(|r|Ok(PairEvent{from_ep:r.text("from_ep")?,to_ep:r.text("to_ep")?,at:r.int("at")?})).collect()
    }
    async fn append_event(&self, a: &str, log: EventLog, e: Event) -> Result<i64> {
        valid(&e.detail)?;
        let table = event_table(log);
        self.db().rows(&format!("INSERT INTO {table}(account_id,at,kind,endpoint,reference,detail) VALUES($1,$2,$3,$4,$5,$6) RETURNING id"),args![a,e.at,&e.kind,&e.endpoint,&e.reference,&e.detail]).await?.first().ok_or(StoreError::NotFound)?.int("id")
    }
    async fn events(&self, a: &str, log: EventLog, after: i64) -> Result<Vec<Event>> {
        self.db().rows(&format!("SELECT id,at,kind,endpoint,reference,detail FROM {} WHERE account_id=$1 AND id>$2 ORDER BY id",event_table(log)),args![a,after]).await?.iter().map(|r|Ok(Event{id:r.int("id")?,at:r.int("at")?,kind:r.text("kind")?,endpoint:r.optional_text("endpoint")?,reference:r.optional_text("reference")?,detail:r.text("detail")?})).collect()
    }
    async fn purge_events(&self, a: &str, before: i64) -> Result<()> {
        let mut t = self.db().begin(a).await?;
        for table in ["activity", "audit", "pair_events", "local_events"] {
            t.execute(
                &format!("DELETE FROM {table} WHERE account_id=$1 AND at<$2"),
                args![a, before],
            )
            .await?;
        }
        t.commit().await
    }
}
fn event_table(log: EventLog) -> &'static str {
    match log {
        EventLog::Activity => "activity",
        EventLog::Audit => "audit",
    }
}
