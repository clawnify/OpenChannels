-- Synthetic conversations, loaded only by the disposable demo runtime.
INSERT INTO contacts (id, org_id, channel, handle, name, profile_name, created_at) VALUES
 ('demo-jamie', 'demo', 'email', 'jamie@harbour.example', 'Jamie Chen', 'Jamie', strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')),
 ('demo-alex', 'demo', 'whatsapp', '+12125550101', 'Alex Morgan', 'Alex', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')),
 ('demo-sam', 'demo', 'telegram', 'sample_sam', 'Sam Taylor', 'Sam', strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 days'));
INSERT INTO conversations (id, org_id, contact_id, channel, subject, status, unread, last_message_at, last_message_preview, assignee_id, assignee_name, created_at) VALUES
 ('thread-jamie', 'demo', 'demo-jamie', 'email', 'Property viewing', 'open', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes'), 'Could we arrange a viewing for Thursday?', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')),
 ('thread-alex', 'demo', 'demo-alex', 'whatsapp', NULL, 'open', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours'), 'Thanks, I have the information I need.', '00000000-0000-4000-8000-000000000001', 'You', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')),
 ('thread-sam', 'demo', 'demo-sam', 'telegram', NULL, 'closed', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'), 'All sorted, thank you.', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 days'));
INSERT INTO messages (id, org_id, conversation_id, kind, body, author_name, created_at) VALUES
 ('message-jamie', 'demo', 'thread-jamie', 'inbound', 'Could we arrange a viewing for Thursday?', 'Jamie Chen', strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')),
 ('message-jamie-note', 'demo', 'thread-jamie', 'comment', 'Prepare the property details before confirming the viewing.', 'You', strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')),
 ('message-alex', 'demo', 'thread-alex', 'inbound', 'Thanks, I have the information I need.', 'Alex Morgan', strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours')),
 ('message-sam', 'demo', 'thread-sam', 'inbound', 'All sorted, thank you.', 'Sam Taylor', strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'));
