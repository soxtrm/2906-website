BEGIN;

ALTER TABLE villages
  ADD COLUMN IF NOT EXISTS centroid_latitude double precision,
  ADD COLUMN IF NOT EXISTS centroid_longitude double precision;

ALTER TABLE villages DROP CONSTRAINT IF EXISTS villages_centroid_latitude_check;
ALTER TABLE villages DROP CONSTRAINT IF EXISTS villages_centroid_longitude_check;
ALTER TABLE villages
  ADD CONSTRAINT villages_centroid_latitude_check
    CHECK (centroid_latitude IS NULL OR centroid_latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT villages_centroid_longitude_check
    CHECK (centroid_longitude IS NULL OR centroid_longitude BETWEEN -180 AND 180);

CREATE INDEX IF NOT EXISTS properties_workspace_locality_status_idx
  ON properties (locality_id, available_status, is_staging);
CREATE INDEX IF NOT EXISTS properties_workspace_updated_idx
  ON properties (GREATEST(created_at, updated_at) DESC);
CREATE INDEX IF NOT EXISTS properties_workspace_rules_idx
  ON properties (pets_allowed, sharing_allowed, subletting_considered)
  WHERE is_staging IS NOT TRUE;
CREATE INDEX IF NOT EXISTS properties_workspace_rental_modes_idx
  ON properties USING gin (rental_modes);
CREATE INDEX IF NOT EXISTS client_assistant_workspace_visibility_idx
  ON client_assistant_state (assigned_agent_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS owner_contacts_workspace_status_idx
  ON owner_contacts (status, do_not_contact, updated_at DESC);

CREATE TABLE IF NOT EXISTS argus_property_filter_facts (
  property_id bigint PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  pets_allowed boolean,
  pets_source text,
  sharing_allowed boolean,
  sharing_source text,
  subletting_considered boolean,
  subletting_source text,
  derived_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE VIEW argus_workspace_property_index AS
SELECT
  p.id AS property_id,
  p.ref,
  p.owner_id,
  p.listed_by_agent_id,
  p.property_type,
  p.town,
  p.sub_location,
  p.bedrooms,
  p.bathrooms,
  COALESCE(p.longlet_price, p.sale_price) AS price,
  p.available_status,
  p.available_date,
  p.created_at,
  p.updated_at,
  COALESCE(p.pets_allowed, apff.pets_allowed) AS pets_allowed,
  CASE WHEN p.pets_allowed IS NOT NULL THEN 'structured_owner_fact' ELSE apff.pets_source END AS pets_source,
  COALESCE(p.sharing_allowed, apff.sharing_allowed) AS sharing_allowed,
  CASE WHEN p.sharing_allowed IS NOT NULL THEN 'structured_owner_fact' ELSE apff.sharing_source END AS sharing_source,
  COALESCE(p.subletting_considered, apff.subletting_considered) AS subletting_considered,
  CASE WHEN p.subletting_considered IS NOT NULL THEN 'structured_owner_fact' ELSE apff.subletting_source END AS subletting_source,
  p.rental_modes,
  p.locality_id,
  v.code AS village_key,
  v.display_name AS village_name,
  ar.code AS area_key,
  ar.display_name AS area_name,
  v.centroid_latitude AS locality_latitude,
  v.centroid_longitude AS locality_longitude,
  COALESCE(npl.latitude, v.centroid_latitude) AS map_latitude,
  COALESCE(npl.longitude, v.centroid_longitude) AS map_longitude,
  CASE WHEN npl.property_id IS NOT NULL THEN npl.precision ELSE 'locality' END AS map_precision,
  ag.name AS agent_name,
  ag.username AS agent_username,
  oc.name AS owner_name,
  oc.phone_normalized AS owner_phone,
  oc.email AS owner_email,
  oc.status AS owner_status,
  COALESCE(oc.do_not_contact, FALSE) AS owner_do_not_contact,
  (SELECT COUNT(*)::int FROM property_matches pm
    WHERE pm.property_id = p.id AND COALESCE(pm.status, '') <> 'invalidated') AS client_match_count,
  (SELECT COUNT(*)::int FROM locality_travel_times ltt
    WHERE lower(ltt.from_locality) IN (lower(v.code), lower(v.display_name))
       OR lower(ltt.to_locality) IN (lower(v.code), lower(v.display_name))) AS modelled_route_count,
  lower(concat_ws(' ',
    p.ref, p.town, p.sub_location, p.property_type,
    ag.name, ag.username,
    oc.name, oc.phone_normalized, oc.email,
    v.code, v.display_name, ar.code, ar.display_name
  )) AS private_search_text,
  lower(concat_ws(' ',
    p.ref, p.town, p.sub_location, p.property_type,
    ag.name, ag.username,
    v.code, v.display_name, ar.code, ar.display_name
  )) AS board_search_text
FROM properties p
LEFT JOIN agents ag ON ag.id = p.listed_by_agent_id
LEFT JOIN owner_contacts oc ON oc.id = p.owner_id
LEFT JOIN argus_property_filter_facts apff ON apff.property_id = p.id
LEFT JOIN villages v ON v.id = p.locality_id
LEFT JOIN areas ar ON ar.id = v.primary_area_id
LEFT JOIN nexus_property_locations npl ON npl.property_id = p.id;

COMMENT ON VIEW argus_workspace_property_index IS
  'Internal ARGUS join across property, owner, agent, client-match and map domains. API routes must project role-safe fields; private_search_text is never returned.';

COMMIT;
