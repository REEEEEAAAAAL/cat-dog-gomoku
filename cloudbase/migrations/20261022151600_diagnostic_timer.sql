DO $$
DECLARE
  existing_rows bigint;
  invalid_rows bigint;
BEGIN
  SELECT count(*) INTO existing_rows FROM public.gomoku_diag_probe;
  SELECT count(*) INTO invalid_rows
  FROM public.gomoku_diag_probe
  WHERE count < 0 OR version < 0 OR jsonb_typeof(receipts) IS DISTINCT FROM 'array';

  RAISE NOTICE 'Preserving % existing diagnostic rows', existing_rows;
  IF invalid_rows > 0 THEN
    RAISE EXCEPTION 'diagnostic preflight failed: % existing rows have invalid counters or receipts', invalid_rows;
  END IF;
END;
$$;

ALTER TABLE public.gomoku_diag_probe
  ADD COLUMN phase text NOT NULL DEFAULT 'waiting'
    CHECK (phase IN ('waiting', 'running', 'paused', 'timeout', 'aborted')),
  ADD COLUMN turn_seat smallint NOT NULL DEFAULT 1 CHECK (turn_seat IN (1, 2)),
  ADD COLUMN remaining_ms integer NOT NULL DEFAULT 60000 CHECK (remaining_ms BETWEEN 0 AND 60000),
  ADD COLUMN turn_deadline timestamptz,
  ADD COLUMN offline_since timestamptz,
  ADD COLUMN offline_deadline timestamptz,
  ADD COLUMN owner_seen_at timestamptz,
  ADD COLUMN guest_seen_at timestamptz;

CREATE OR REPLACE FUNCTION public.gomoku_diag_command(
  p_room uuid,
  p_action text,
  p_operation uuid DEFAULT NULL,
  p_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller text := auth.uid();
  session public.gomoku_diag_probe;
  receipt jsonb;
  now_at timestamptz := clock_timestamp();
  caller_seat smallint;
  stale_at timestamptz;
  owner_online boolean;
  guest_online boolean;
  rejection text;
  changed boolean := false;
  write_row boolean := false;
  server_remaining integer;
BEGIN
  IF caller IS NULL OR caller = '' OR
    (auth.role() IS DISTINCT FROM 'authenticated' AND
      NOT (auth.role() = 'anon' AND coalesce(auth.jwt()->>'is_anonymous', 'false') = 'true')) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('join', 'snapshot', 'pulse', 'start') THEN
    RAISE EXCEPTION 'invalid_action';
  END IF;
  IF p_room IS NULL THEN RAISE EXCEPTION 'invalid_room'; END IF;

  IF p_action = 'join' THEN
    INSERT INTO public.gomoku_diag_probe(id, owner) VALUES (p_room, caller)
      ON CONFLICT (id) DO NOTHING;
  END IF;

  SELECT * INTO session
  FROM public.gomoku_diag_probe
  WHERE id = p_room
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF session.expires_at <= now_at THEN RAISE EXCEPTION 'expired'; END IF;

  IF p_action = 'join' AND caller <> session.owner AND caller <> session.guest THEN
    IF session.guest <> '' THEN RAISE EXCEPTION 'room_full'; END IF;
    session.guest := caller;
    changed := true;
    write_row := true;
  END IF;
  IF caller <> session.owner AND caller <> session.guest THEN RAISE EXCEPTION 'forbidden'; END IF;
  caller_seat := CASE WHEN caller = session.owner THEN 1 ELSE 2 END;

  IF session.phase = 'paused' AND session.offline_deadline <= now_at THEN
    session.phase := 'aborted';
    session.offline_since := NULL;
    session.offline_deadline := NULL;
    changed := true;
    write_row := true;
  ELSIF session.phase = 'running' THEN
    stale_at := NULL;
    IF session.owner_seen_at IS NULL OR session.owner_seen_at <= now_at - interval '25 seconds' THEN
      stale_at := coalesce(session.owner_seen_at + interval '25 seconds', now_at);
    END IF;
    IF session.guest_seen_at IS NULL OR session.guest_seen_at <= now_at - interval '25 seconds' THEN
      stale_at := CASE WHEN stale_at IS NULL
        THEN coalesce(session.guest_seen_at + interval '25 seconds', now_at)
        ELSE least(stale_at, coalesce(session.guest_seen_at + interval '25 seconds', now_at)) END;
    END IF;

    IF stale_at IS NOT NULL THEN
      IF session.turn_deadline IS NULL OR session.turn_deadline <= stale_at THEN
        session.phase := 'timeout';
        session.remaining_ms := 0;
        session.turn_deadline := NULL;
        session.offline_since := NULL;
        session.offline_deadline := NULL;
      ELSE
        session.remaining_ms := greatest(0, least(60000,
          floor(extract(epoch FROM (session.turn_deadline - stale_at)) * 1000)::integer));
        session.phase := 'paused';
        session.turn_deadline := NULL;
        session.offline_since := stale_at;
        session.offline_deadline := stale_at + interval '5 minutes';
      END IF;
      changed := true;
      write_row := true;
    ELSIF session.turn_deadline IS NULL OR session.turn_deadline <= now_at THEN
      session.phase := 'timeout';
      session.remaining_ms := 0;
      session.turn_deadline := NULL;
      changed := true;
      write_row := true;
    END IF;
  END IF;

  IF caller_seat = 1 THEN
    IF p_action = 'join' OR session.owner_seen_at IS NULL OR session.owner_seen_at <= now_at - interval '15 seconds' THEN
      session.owner_seen_at := now_at;
      write_row := true;
    END IF;
  ELSE
    IF p_action = 'join' OR session.guest_seen_at IS NULL OR session.guest_seen_at <= now_at - interval '15 seconds' THEN
      session.guest_seen_at := now_at;
      write_row := true;
    END IF;
  END IF;

  owner_online := coalesce(session.owner_seen_at > now_at - interval '25 seconds', false);
  guest_online := session.guest <> '' AND coalesce(session.guest_seen_at > now_at - interval '25 seconds', false);

  IF session.phase = 'paused' AND session.offline_deadline > now_at AND owner_online AND guest_online THEN
    session.phase := 'running';
    session.turn_deadline := now_at + (session.remaining_ms * interval '1 millisecond');
    session.offline_since := NULL;
    session.offline_deadline := NULL;
    changed := true;
    write_row := true;
  END IF;

  IF p_action = 'start' THEN
    IF changed THEN
      rejection := 'state_changed';
    ELSIF session.phase <> 'waiting' THEN
      rejection := 'timer_already_started';
    ELSIF NOT owner_online OR NOT guest_online THEN
      rejection := 'both_seats_must_be_online';
    ELSE
      session.phase := 'running';
      session.turn_seat := 1;
      session.remaining_ms := 60000;
      session.turn_deadline := now_at + interval '60 seconds';
      changed := true;
      write_row := true;
    END IF;
  ELSIF p_action = 'pulse' THEN
    IF p_operation IS NULL OR p_version IS NULL OR p_version < 0 THEN
      RAISE EXCEPTION 'invalid_operation';
    END IF;
    SELECT value INTO receipt
    FROM jsonb_array_elements(session.receipts)
    WHERE value->>'id' = p_operation::text;
    IF receipt IS NOT NULL THEN
      IF receipt->>'uid' <> caller OR (receipt->>'version')::integer <> p_version THEN
        RAISE EXCEPTION 'id_conflict';
      END IF;
    ELSE
      IF changed THEN
        rejection := 'state_changed';
      ELSIF session.version <> p_version THEN
        rejection := 'state_conflict';
      ELSIF session.phase = 'paused' THEN
        rejection := 'paused';
      ELSIF session.phase IN ('timeout', 'aborted') THEN
        rejection := 'round_finished';
      ELSIF session.phase = 'running' AND caller_seat <> session.turn_seat THEN
        rejection := 'not_your_turn';
      ELSE
        session.count := session.count + 1;
        session.version := session.version + 1;
        session.receipts := session.receipts || jsonb_build_array(jsonb_build_object(
          'id', p_operation, 'uid', caller, 'version', p_version));
        IF jsonb_array_length(session.receipts) > 200 THEN session.receipts := session.receipts - 0; END IF;
        IF session.phase = 'running' THEN
          session.turn_seat := CASE WHEN caller_seat = 1 THEN 2 ELSE 1 END;
          session.remaining_ms := 60000;
          session.turn_deadline := now_at + interval '60 seconds';
        END IF;
        changed := false;
        write_row := true;
      END IF;
    END IF;
  END IF;

  IF session.phase = 'paused' AND session.offline_deadline <= now_at THEN
    session.phase := 'aborted';
    session.offline_since := NULL;
    session.offline_deadline := NULL;
    changed := true;
    write_row := true;
  END IF;

  IF changed THEN session.version := session.version + 1; END IF;
  IF write_row THEN
    UPDATE public.gomoku_diag_probe SET
      guest = session.guest,
      count = session.count,
      version = session.version,
      receipts = session.receipts,
      phase = session.phase,
      turn_seat = session.turn_seat,
      remaining_ms = session.remaining_ms,
      turn_deadline = session.turn_deadline,
      offline_since = session.offline_since,
      offline_deadline = session.offline_deadline,
      owner_seen_at = session.owner_seen_at,
      guest_seen_at = session.guest_seen_at
    WHERE id = p_room;
  END IF;

  server_remaining := CASE WHEN session.phase = 'running' AND session.turn_deadline IS NOT NULL
    THEN greatest(0, floor(extract(epoch FROM (session.turn_deadline - now_at)) * 1000)::integer)
    ELSE session.remaining_ms END;

  RETURN jsonb_build_object(
    'count', session.count,
    'version', session.version,
    'seat', caller_seat,
    'phase', session.phase,
    'turnSeat', session.turn_seat,
    'remainingMs', server_remaining,
    'turnDeadline', CASE WHEN session.turn_deadline IS NULL THEN NULL ELSE extract(epoch FROM session.turn_deadline) * 1000 END,
    'offlineDeadline', CASE WHEN session.offline_deadline IS NULL THEN NULL ELSE extract(epoch FROM session.offline_deadline) * 1000 END,
    'ownerOnline', owner_online,
    'guestOnline', guest_online,
    'loserSeat', CASE WHEN session.phase = 'timeout' THEN session.turn_seat ELSE NULL END,
    'winnerSeat', CASE WHEN session.phase = 'timeout' THEN CASE WHEN session.turn_seat = 1 THEN 2 ELSE 1 END ELSE NULL END,
    'accepted', rejection IS NULL,
    'rejection', rejection,
    'serverNow', extract(epoch FROM now_at) * 1000,
    'expiresAt', extract(epoch FROM session.expires_at) * 1000
  );
END;
$$;

REVOKE ALL ON FUNCTION public.gomoku_diag_command(uuid, text, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gomoku_diag_command(uuid, text, uuid, integer) TO authenticated, anon;
