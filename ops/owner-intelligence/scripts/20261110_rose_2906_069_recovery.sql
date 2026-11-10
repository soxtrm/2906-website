-- Targeted, idempotent recovery for the verified 2026-11-10 Rose incident.
-- This never republishes the listing and never sends an owner message.
BEGIN;

DO $$
DECLARE
  p properties%ROWTYPE;
  oc owner_contacts%ROWTYPE;
  source_message TEXT;
  source_time TIMESTAMPTZ;
  evidence TEXT;
  agent_id INTEGER;
  ctx JSONB;
  ctx_hash TEXT;
BEGIN
  SELECT * INTO p FROM properties WHERE ref='2906-069' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'rose recovery guard: property 2906-069 not found'; END IF;
  IF EXISTS (
    SELECT 1 FROM property_activities
     WHERE property_id=p.id AND activity_type='owner_shared_place_recovery'
       AND details->>'source'='rose_p0_recovery_20261110'
  ) THEN
    RAISE NOTICE 'rose recovery already applied';
    RETURN;
  END IF;
  SELECT h.source_message_id,h.source_timestamp,h.reason
    INTO source_message,source_time,evidence
    FROM property_operational_status_history h
   WHERE h.property_id=p.id AND h.status='RENTED' AND h.reason ILIKE '%needs%share%'
   ORDER BY h.id DESC LIMIT 1;
  IF source_message IS NULL THEN RAISE EXCEPTION 'rose recovery guard: verified shared-place RENTED event not found'; END IF;
  IF p.available_status <> 'rented' OR p.operational_status <> 'RENTED' THEN
    RAISE EXCEPTION 'rose recovery guard: current status changed since incident (% / %)',p.available_status,p.operational_status;
  END IF;
  SELECT * INTO oc FROM owner_contacts WHERE id=p.owner_id;
  IF NOT FOUND OR COALESCE(oc.phone_normalized,'')='' THEN RAISE EXCEPTION 'rose recovery guard: owner contact missing'; END IF;

  ctx=jsonb_build_object(
    'propertyId',p.id,'ref',p.ref,'sourceMessageId',source_message,'sourceTimestamp',source_time,
    'occupancyState','PARTIALLY_OCCUPIED','wholePropertyAvailable',false,
    'availablePlaceCount',1,'availableRoomCount',NULL,'occupiedPersonCount',1,
    'perPersonRent',800,'wholePropertyTotalRent',1600,'viewingInvited',true,
    'priorState',jsonb_build_object('availableStatus',p.available_status,'operationalStatus',p.operational_status,'published',p.published),
    'recovery','rose_p0_recovery_20261110'
  );
  ctx_hash=md5(ctx::text);

  UPDATE properties SET
    available_status='pending_check',operational_status='NEEDS_HUMAN_REVIEW',
    sharing_allowed=TRUE,sharing_price=800,occupancy_state='PARTIALLY_OCCUPIED',
    whole_property_available=FALSE,available_place_count=1,available_room_count=NULL,
    occupied_person_count=1,whole_property_total_rent=1600,viewing_invited=TRUE,
    published=FALSE,updated_at=NOW()
  WHERE id=p.id;

  INSERT INTO owner_recheck_tasks
    (owner_contact_id,owner_phone,topic,state,decision,reason,property_id,source_type,source_id,
     context_hash,context_snapshot,proposed_action,proposed_message,created_at,updated_at)
  VALUES
    (oc.id,oc.phone_normalized,'shared_place_offer:'||p.id,'DECISION_REQUIRED','REVIEW_SHARED_PLACE',
     'Verified false whole-property RENTED mutation. Review shared-place facts, listing presentation and corrective reply.',
     p.id,'rose_p0_recovery',source_message,ctx_hash,ctx,
     'Approve targeted status correction and the corrective owner reply; do not auto-republish.',
     'Sorry, I misunderstood earlier. I understand the flat is shared and there''s still one place available at €800 per person. I''ll let my colleagues know and we''ll see if we can find someone suitable. Thank you!',
     NOW(),NOW())
  ON CONFLICT (owner_phone,topic) DO UPDATE SET
    state='DECISION_REQUIRED',decision=EXCLUDED.decision,reason=EXCLUDED.reason,
    property_id=EXCLUDED.property_id,source_type=EXCLUDED.source_type,source_id=EXCLUDED.source_id,
    context_hash=EXCLUDED.context_hash,context_snapshot=EXCLUDED.context_snapshot,
    proposed_action=EXCLUDED.proposed_action,proposed_message=EXCLUDED.proposed_message,
    approval_context_hash=NULL,approved_at=NULL,approved_by=NULL,resolved_at=NULL,resolution=NULL,updated_at=NOW();

  agent_id=COALESCE(p.listed_by_agent_id,p.activity_agent_id);
  IF agent_id IS NOT NULL THEN
    INSERT INTO agent_listing_notifications(agent_id,property_id,kind,status_label,detail,notified_at)
    VALUES(agent_id,p.id,'owner_shared_place','Review shared-place offer',
      'Verified owner evidence: one additional shared-accommodation place at EUR 800 per person; viewing welcomed. Corrective reply requires approval.',NOW())
    ON CONFLICT(agent_id,property_id,kind) DO UPDATE SET
      status_label=EXCLUDED.status_label,detail=EXCLUDED.detail,notified_at=NOW(),seen_at=NULL;
  END IF;

  INSERT INTO property_activities(property_id,activity_type,details,is_significant,created_at)
  VALUES(p.id,'owner_shared_place_recovery',
    jsonb_build_object('source','rose_p0_recovery_20261110','source_message_id',source_message,
      'context_hash',ctx_hash,'old_status',jsonb_build_object('available',p.available_status,'operational',p.operational_status,'published',p.published),
      'new_status',jsonb_build_object('available','pending_check','operational','NEEDS_HUMAN_REVIEW','published',false),
      'outbound_review_required',true,'automatic_message_sent',false),TRUE,NOW());

  INSERT INTO conversation_facts
    (state_id,entity_id,property_id,sender_account_id,field_name,field_value,fact_status,
     source_message_id,source_type,source_timestamp,confidence,effective_timestamp,last_confirmed_at,evidence,access_scope)
  SELECT s.id,oc.id,p.id,s.sender_account_id,v.field_name,v.field_value,'KNOWN',
         source_message,'rose_p0_recovery',source_time,1,source_time,source_time,evidence,'AUTHORIZED_AGENT'
    FROM conversation_intelligence_state s
    CROSS JOIN (VALUES
      ('occupancyState',to_jsonb('PARTIALLY_OCCUPIED'::text)),
      ('wholePropertyAvailable','false'::jsonb),
      ('availablePlaceCount','1'::jsonb),
      ('occupiedPersonCount','1'::jsonb),
      ('perPersonRent','800'::jsonb),
      ('wholePropertyTotalRent','1600'::jsonb),
      ('viewingInvited','true'::jsonb)
    ) AS v(field_name,field_value)
   WHERE s.owner_contact_id=oc.id
     AND NOT EXISTS (
       SELECT 1 FROM conversation_facts f
        WHERE f.state_id=s.id AND f.property_id=p.id AND f.field_name=v.field_name
          AND f.source_message_id=source_message AND f.fact_status<>'SUPERSEDED'
     );
END $$;

COMMIT;
