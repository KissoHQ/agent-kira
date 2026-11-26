-- The history stays append-only, with one exception: erasing the personal data of a person who asks
-- for it (GDPR, article 17). The erasure command sets request_agent.erasing for its transaction and
-- only removes text from the details of events; no row is deleted. Only the owner of the database
-- may update events: the roles of the application have no such right, whatever they set.
CREATE OR REPLACE FUNCTION "reject_event_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('request_agent.erasing', true) = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'events are append-only: % is not allowed', TG_OP;
END;
$$;
