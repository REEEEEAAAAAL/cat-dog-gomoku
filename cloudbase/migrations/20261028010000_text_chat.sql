CREATE TABLE public.gomoku_chat_state (
  room uuid PRIMARY KEY REFERENCES public.gomoku_rooms(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0
);
CREATE TABLE public.gomoku_chat_receipts (
  room uuid NOT NULL REFERENCES public.gomoku_rooms(id) ON DELETE CASCADE,
  operation uuid NOT NULL,
  seat integer NOT NULL CHECK (seat IN (1,2)),
  fingerprint bytea NOT NULL,
  seq integer NOT NULL,
  sent_at timestamptz NOT NULL,
  PRIMARY KEY (room, operation)
);
CREATE INDEX gomoku_chat_rate ON public.gomoku_chat_receipts(room, seat, sent_at DESC);
CREATE TABLE public.gomoku_chat_messages (
  room uuid NOT NULL REFERENCES public.gomoku_rooms(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  operation uuid NOT NULL,
  seat integer NOT NULL CHECK (seat IN (1,2)),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 100),
  sent_at timestamptz NOT NULL,
  PRIMARY KEY (room, seq)
);
ALTER TABLE public.gomoku_chat_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gomoku_chat_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gomoku_chat_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gomoku_chat_state, public.gomoku_chat_receipts, public.gomoku_chat_messages FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.gomoku_chat_snapshot(p_room uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('room',p_room,'revision',coalesce((SELECT revision FROM public.gomoku_chat_state WHERE room=p_room),0),
    'messages',coalesce((SELECT jsonb_agg(jsonb_build_object('id',operation,'seq',seq,'seat',seat,'text',body,
      'at',extract(epoch FROM sent_at)*1000) ORDER BY seq) FROM public.gomoku_chat_messages WHERE room=p_room),'[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.gomoku_chat_snapshot(uuid) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.gomoku_chat(p_room uuid, p_client uuid, p_operation uuid DEFAULT NULL, p_text text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  caller text := auth.uid();
  s public.gomoku_rooms;
  sender integer;
  now_at timestamptz;
  receipt public.gomoku_chat_receipts;
  revision_value integer;
  last_at timestamptz;
  recent_count integer;
BEGIN
  IF caller IS NULL OR caller='' OR (auth.role() IS DISTINCT FROM 'authenticated' AND
    NOT (auth.role()='anon' AND coalesce(auth.jwt()->>'is_anonymous','false')='true')) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  IF p_operation IS NULL AND p_text IS NOT NULL THEN RAISE EXCEPTION 'invalid_chat'; END IF;
  IF p_operation IS NULL THEN
    SELECT * INTO s FROM public.gomoku_rooms WHERE id=p_room;
  ELSE
    SELECT * INTO s FROM public.gomoku_rooms WHERE id=p_room FOR SHARE;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  sender := CASE WHEN caller=s.owner_uid THEN 1 WHEN caller=s.guest_uid THEN 2 ELSE 0 END;
  IF sender=0 THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF p_client IS NULL OR p_client IS DISTINCT FROM (CASE WHEN sender=1 THEN s.owner_client ELSE s.guest_client END) THEN
    RAISE EXCEPTION 'superseded';
  END IF;
  IF s.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'expired'; END IF;
  IF p_operation IS NULL THEN RETURN public.gomoku_chat_snapshot(s.id); END IF;
  IF p_text IS NULL OR char_length(p_text) NOT BETWEEN 1 AND 100
    OR p_text !~ U&'[^\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]'
    OR p_text ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' THEN
    RAISE EXCEPTION 'invalid_chat';
  END IF;
  INSERT INTO public.gomoku_chat_state(room) VALUES(s.id) ON CONFLICT DO NOTHING;
  SELECT revision INTO revision_value FROM public.gomoku_chat_state WHERE room=s.id FOR UPDATE;
  SELECT * INTO receipt FROM public.gomoku_chat_receipts WHERE room=s.id AND operation=p_operation;
  IF FOUND THEN
    IF receipt.seat<>sender OR receipt.fingerprint<>sha256(convert_to(p_text,'UTF8')) THEN RAISE EXCEPTION 'chat_id_conflict'; END IF;
    RETURN public.gomoku_chat_snapshot(s.id)||jsonb_build_object('ack',p_operation,'duplicate',true);
  END IF;
  IF s.phase='closed' THEN RAISE EXCEPTION 'room_closed'; END IF;
  now_at := clock_timestamp();
  IF s.expires_at<=now_at THEN RAISE EXCEPTION 'expired'; END IF;
  SELECT count(*),max(sent_at) INTO recent_count,last_at FROM public.gomoku_chat_receipts
    WHERE room=s.id AND seat=sender AND sent_at>now_at-interval '1 minute';
  IF recent_count>=10 OR last_at>now_at-interval '2 seconds' THEN RAISE EXCEPTION 'chat_rate_limit'; END IF;
  revision_value := revision_value+1;
  UPDATE public.gomoku_chat_state SET revision=revision_value WHERE room=s.id;
  INSERT INTO public.gomoku_chat_receipts VALUES(s.id,p_operation,sender,sha256(convert_to(p_text,'UTF8')),revision_value,now_at);
  INSERT INTO public.gomoku_chat_messages VALUES(s.id,revision_value,p_operation,sender,p_text,now_at);
  DELETE FROM public.gomoku_chat_messages WHERE room=s.id AND seq<=revision_value-50;
  RETURN public.gomoku_chat_snapshot(s.id)||jsonb_build_object('ack',p_operation,'duplicate',false);
END;
$$;
REVOKE ALL ON FUNCTION public.gomoku_chat(uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gomoku_chat(uuid,uuid,uuid,text) TO anon, authenticated;

ALTER FUNCTION public.gomoku_command(text,text,uuid,uuid,integer,uuid,jsonb,integer) RENAME TO gomoku_game_command;
REVOKE ALL ON FUNCTION public.gomoku_game_command(text,text,uuid,uuid,integer,uuid,jsonb,integer) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.gomoku_command(
  p_room text, p_action text, p_client uuid, p_operation uuid DEFAULT NULL,
  p_version integer DEFAULT NULL, p_game uuid DEFAULT NULL, p_data jsonb DEFAULT '{}', p_protocol integer DEFAULT 1
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE reply jsonb;
BEGIN
  reply := public.gomoku_game_command(p_room,p_action,p_client,p_operation,p_version,p_game,p_data,p_protocol);
  IF reply->>'pending'='false' THEN
    reply := reply||jsonb_build_object('chat',public.gomoku_chat_snapshot((reply->>'room')::uuid));
  END IF;
  RETURN reply;
END;
$$;
REVOKE ALL ON FUNCTION public.gomoku_command(text,text,uuid,uuid,integer,uuid,jsonb,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gomoku_command(text,text,uuid,uuid,integer,uuid,jsonb,integer) TO anon, authenticated;
