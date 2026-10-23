CREATE OR REPLACE FUNCTION public.gomoku_diag_command(p_room uuid, p_action text,
  p_operation uuid DEFAULT NULL, p_version integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  caller text := auth.uid();
  session public.gomoku_diag_probe;
  receipt jsonb;
  changed boolean := false;
BEGIN
  IF caller IS NULL OR caller = '' OR (auth.role() IS DISTINCT FROM 'authenticated' AND NOT (auth.role() = 'anon' AND coalesce(auth.jwt()->>'is_anonymous','false') = 'true')) THEN RAISE EXCEPTION 'unauthorized'; END IF;
  IF p_action NOT IN ('join', 'snapshot', 'pulse') OR p_action IS NULL THEN RAISE EXCEPTION 'invalid_action'; END IF;
  IF p_room IS NULL THEN RAISE EXCEPTION 'invalid_room'; END IF;
  IF p_action = 'join' THEN
    INSERT INTO public.gomoku_diag_probe(id, owner) VALUES(p_room, caller) ON CONFLICT(id) DO NOTHING;
  END IF;
  SELECT * INTO session FROM public.gomoku_diag_probe WHERE id = p_room FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF session.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'expired'; END IF;
  IF p_action = 'join' AND caller <> session.owner AND caller <> session.guest THEN
    IF session.guest <> '' THEN RAISE EXCEPTION 'room_full'; END IF;
    session.guest := caller;
    session.version := session.version + 1;
    changed := true;
  END IF;
  IF caller <> session.owner AND caller <> session.guest THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF p_action = 'pulse' THEN
    IF p_operation IS NULL OR p_version IS NULL OR p_version < 0 THEN RAISE EXCEPTION 'invalid_operation'; END IF;
    SELECT value INTO receipt FROM jsonb_array_elements(session.receipts) WHERE value->>'id' = p_operation::text;
    IF receipt IS NOT NULL THEN
      IF receipt->>'uid' <> caller OR (receipt->>'version')::integer <> p_version THEN RAISE EXCEPTION 'id_conflict'; END IF;
    ELSE
      IF session.version <> p_version THEN RAISE EXCEPTION 'state_conflict'; END IF;
      session.count := session.count + 1;
      session.version := session.version + 1;
      changed := true;
      session.receipts := session.receipts || jsonb_build_array(jsonb_build_object('id',p_operation,'uid',caller,'version',p_version));
      IF jsonb_array_length(session.receipts) > 200 THEN session.receipts := session.receipts - 0; END IF;
    END IF;
  END IF;
  IF changed THEN
    UPDATE public.gomoku_diag_probe SET guest=session.guest, count=session.count,
      version=session.version, receipts=session.receipts WHERE id=p_room;
  END IF;
  RETURN jsonb_build_object('count',session.count,'version',session.version,
    'seat',CASE WHEN caller=session.owner THEN 1 ELSE 2 END,
    'serverNow',extract(epoch FROM clock_timestamp())*1000,
    'expiresAt',extract(epoch FROM session.expires_at)*1000);
END;
$$;

REVOKE ALL ON FUNCTION public.gomoku_diag_command(uuid,text,uuid,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gomoku_diag_command(uuid,text,uuid,integer) TO authenticated;

GRANT EXECUTE ON FUNCTION public.gomoku_diag_command(uuid,text,uuid,integer) TO anon;
