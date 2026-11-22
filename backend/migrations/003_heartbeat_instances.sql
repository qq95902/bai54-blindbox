DO $$
DECLARE current_pk text;
BEGIN
  SELECT conname INTO current_pk
  FROM pg_constraint
  WHERE conrelid = 'service_heartbeats'::regclass AND contype = 'p';
  IF current_pk IS NOT NULL THEN
    EXECUTE format('ALTER TABLE service_heartbeats DROP CONSTRAINT %I', current_pk);
  END IF;
  ALTER TABLE service_heartbeats
    ADD CONSTRAINT service_heartbeats_pkey PRIMARY KEY (service_name, instance_id);
END $$;
