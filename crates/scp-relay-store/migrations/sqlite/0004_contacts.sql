CREATE TABLE contacts (account_id TEXT NOT NULL REFERENCES accounts(id), peer_id TEXT NOT NULL REFERENCES accounts(id), state TEXT NOT NULL CHECK(state IN ('pending_out','pending_in','active','blocked')), payload TEXT NOT NULL, dir TEXT NOT NULL CHECK(dir IN ('in','out','both')), updated_at BIGINT NOT NULL, PRIMARY KEY(account_id,peer_id), CHECK(account_id != peer_id));
CREATE TABLE contact_invites (account_id TEXT NOT NULL REFERENCES accounts(id), at BIGINT NOT NULL);
CREATE INDEX contact_invites_day ON contact_invites(account_id,at);
CREATE TABLE xinbox (account_id TEXT NOT NULL REFERENCES accounts(id), seq BIGINT NOT NULL REFERENCES deliveries(seq) ON DELETE CASCADE, id TEXT NOT NULL, endpoint TEXT NOT NULL, from_account TEXT NOT NULL REFERENCES accounts(id), sender TEXT NOT NULL, client_id TEXT NOT NULL, message TEXT NOT NULL, thread TEXT NOT NULL, reply_grant TEXT, expires_at BIGINT NOT NULL, at BIGINT NOT NULL, PRIMARY KEY(account_id,seq), UNIQUE(account_id,from_account,client_id));
CREATE INDEX xinbox_pair ON xinbox(account_id,from_account,sender,endpoint,at);
CREATE INDEX xinbox_thread ON xinbox(account_id,endpoint,thread);
CREATE TABLE xcursor (account_id TEXT NOT NULL REFERENCES accounts(id), endpoint TEXT NOT NULL, acked_seq BIGINT NOT NULL, at BIGINT NOT NULL, old_seq BIGINT, old_at BIGINT, PRIMARY KEY(account_id,endpoint));
