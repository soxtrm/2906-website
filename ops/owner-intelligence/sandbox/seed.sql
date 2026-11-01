-- Synthetic sandbox fixtures (test DB only). Numbers 3569900xxxx are fake.
BEGIN;
DELETE FROM property_location_requests; DELETE FROM agent_listing_notifications; DELETE FROM property_viewings;
DELETE FROM website_publication_state; DELETE FROM website_properties WHERE property_reference LIKE '2906-S%';
DELETE FROM owner_account_labels; DELETE FROM owner_chat_events; DELETE FROM owner_assignment_events;
DELETE FROM properties WHERE ref LIKE '2906-S%';
DELETE FROM book_relay_threads WHERE owner_id IN (SELECT id FROM owner_contacts WHERE phone_normalized LIKE '3569900%');
DELETE FROM properties WHERE owner_id IN (SELECT id FROM owner_contacts WHERE phone_normalized LIKE '3569900%');
DELETE FROM owner_assistant_events WHERE state_id IN (SELECT id FROM owner_assistant_state WHERE owner_contact_id IN (SELECT id FROM owner_contacts WHERE phone_normalized LIKE '3569900%'));
DELETE FROM owner_assistant_state WHERE owner_contact_id IN (SELECT id FROM owner_contacts WHERE phone_normalized LIKE '3569900%');
DELETE FROM conversation_outbound_guard WHERE state_id IN (SELECT id FROM conversation_intelligence_state WHERE owner_contact_id IN (SELECT id FROM owner_contacts WHERE phone_normalized LIKE '3569900%'));
DELETE FROM conversation_message_revisions WHERE state_id IN (SELECT id FROM conversation_intelligence_state WHERE owner_contact_id IN (SELECT id FROM owner_contacts WHERE phone_normalized LIKE '3569900%'));
DELETE FROM conversation_facts WHERE state_id IN (SELECT id FROM conversation_intelligence_state WHERE owner_contact_id IN (SELECT id FROM owner_contacts WHERE phone_normalized LIKE '3569900%'));
DELETE FROM conversation_intelligence_state WHERE owner_contact_id IN (SELECT id FROM owner_contacts WHERE phone_normalized LIKE '3569900%');
DELETE FROM owner_auto_conversations WHERE phone LIKE '3569900%';
DELETE FROM owner_contacts WHERE phone_normalized LIKE '3569900%';
DELETE FROM calendar_events WHERE agent_id IN (SELECT id FROM agents WHERE username LIKE 'sandbox-%');
DELETE FROM agents WHERE username LIKE 'sandbox-%';
DELETE FROM whatsapp_accounts WHERE session_name IN ('Kevsecond','Cedric','Argus3');

INSERT INTO whatsapp_accounts (session_name, phone, label, account_persona, outreach_enabled, is_active) VALUES
 ('Kevsecond','35699000901','Kev second','kev',TRUE,TRUE),
 ('Cedric','35699000902','Cedric','cedric',TRUE,TRUE),
 ('Argus3','35699000903','Argus 3','kev',TRUE,TRUE);

INSERT INTO agents (username, name, role, active, password_hash, board_access) VALUES
 ('sandbox-admin','Sandbox Admin','admin',TRUE,'x',TRUE),
 ('sandbox-jason','Jason','agent',TRUE,'x',TRUE),
 ('sandbox-lister','Listing Agent','agent',TRUE,'x',TRUE);

INSERT INTO owner_contacts (phone_normalized, name, status) VALUES
 ('35699000101','Sandbox Owner One','new'),
 ('35699000102','Sandbox Owner Two','new');

INSERT INTO properties (ref, owner_id, listed_by_agent_id, town, property_type, bedrooms, bathrooms, longlet_price, available_status, published, public_payload, street, rental_modes)
SELECT '2906-S001', (SELECT id FROM owner_contacts WHERE phone_normalized='35699000101'), (SELECT id FROM agents WHERE username='sandbox-lister'),
       'St Julians', 'Apartment', 2, 1, 1600, 'available', TRUE,
       '{"images":["https://example.invalid/s1a.jpg"],"description_public":"Bright two-bedroom apartment close to the promenade, fully furnished and ready."}'::jsonb,
       NULL, ARRAY['long_let']
UNION ALL
SELECT '2906-S002', (SELECT id FROM owner_contacts WHERE phone_normalized='35699000102'), (SELECT id FROM agents WHERE username='sandbox-lister'),
       'Sliema', 'Apartment', 3, 2, 2400, 'available', TRUE,
       '{"images":["https://example.invalid/s2a.jpg"],"description_public":"Spacious three-bedroom apartment with sea views, recently refurbished."}'::jsonb,
       'Triq it-Torri', ARRAY['winter_let'];

-- confirmed viewing today 19:30 Malta for Jason, no address on file
INSERT INTO property_viewings (property_id, viewing_date, viewing_time, starts_at, status, viewing_agent_id, viewing_agent_name)
SELECT p.id, (NOW() AT TIME ZONE 'Europe/Malta')::date, '19:30',
       (((NOW() AT TIME ZONE 'Europe/Malta')::date + time '19:30') AT TIME ZONE 'Europe/Malta'), 'confirmed',
       (SELECT id FROM agents WHERE username='sandbox-jason'), 'Jason'
  FROM properties p WHERE p.ref = '2906-S001';

-- attribution history: Cedric started (5 days ago), Kevsecond wrote yesterday, owner replied 2 h ago
INSERT INTO owner_account_labels (contact_id, account_session, label, source, created_at, last_we_sent_at, last_reply_at, total_msgs_out, total_msgs_in)
SELECT id, 'Cedric', 'cold', 'outreach', NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days', NULL, 1, 0 FROM owner_contacts WHERE phone_normalized='35699000101'
UNION ALL
SELECT id, 'Kevsecond', 'warm', 'outreach', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', NOW() - INTERVAL '2 hours', 2, 1 FROM owner_contacts WHERE phone_normalized='35699000101';
COMMIT;
SELECT ref, id FROM properties WHERE ref LIKE '2906-S%' ORDER BY ref;
