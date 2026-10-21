CREATE INDEX deliveries_open ON deliveries(account_id,endpoint,seq) WHERE acked_at IS NULL AND rejected_at IS NULL;
CREATE INDEX messages_reply ON messages(account_id,reply_to,kind);
CREATE INDEX deliveries_message ON deliveries(account_id,message_id,endpoint,seq);
