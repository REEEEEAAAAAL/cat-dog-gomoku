CREATE OR REPLACE FUNCTION public.gomoku_command(
  p_room text,
  p_action text,
  p_client uuid,
  p_operation uuid DEFAULT NULL,
  p_version integer DEFAULT NULL,
  p_game uuid DEFAULT NULL,
  p_data jsonb DEFAULT '{}',
  p_protocol integer DEFAULT 1
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  caller text := auth.uid();
  s public.gomoku_rooms;
  now_at timestamptz;
  seat integer;
  name_value text;
  changed boolean := false;
  rejection text;
  receipt jsonb;
  fingerprint jsonb;
  duplicate boolean := false;
  stale_at timestamptz;
  owner_online boolean;
  guest_online boolean;
  is_mutation boolean;
  x integer;
  y integer;
  dx integer;
  dy integer;
  nx integer;
  ny integer;
  direction integer;
  sign_value integer;
  color_value integer;
  line_value jsonb;
  move_value jsonb;
  target_move jsonb;
  target_index integer;
  target_id text;
  restore_ms integer;
  undo_seat integer;
  events jsonb;
  event_count integer;
  last_event_at numeric;
BEGIN
  IF caller IS NULL OR caller = '' OR
    (auth.role() IS DISTINCT FROM 'authenticated' AND
      NOT (auth.role() = 'anon' AND coalesce(auth.jwt()->>'is_anonymous','false') = 'true')) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  IF p_protocol IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'protocol_mismatch'; END IF;
  IF p_client IS NULL OR p_room IS NULL OR length(p_room) > 36 OR p_data IS NULL OR
    jsonb_typeof(p_data) <> 'object' OR octet_length(p_data::text) > 1024 THEN
    RAISE EXCEPTION 'invalid_request';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('create','apply','connect','snapshot','sync','approve','reject','ready','move','rematch','leave','undo_request','undo_respond','undo_cancel','emoji','withdraw') THEN
    RAISE EXCEPTION 'invalid_action';
  END IF;
  name_value := btrim(coalesce(p_data->>'name',''));
  IF p_action IN ('create','apply') AND
    (char_length(name_value) NOT BETWEEN 1 AND 12 OR name_value ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'invalid_name';
  END IF;

  IF p_action = 'create' THEN
    IF p_room !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR
      coalesce(p_data->>'animal','') NOT IN ('dog','cat') THEN RAISE EXCEPTION 'invalid_request'; END IF;
    PERFORM pg_advisory_xact_lock(hashtext(caller));
    IF NOT EXISTS (SELECT 1 FROM public.gomoku_rooms WHERE id = p_room::uuid) THEN
      IF (SELECT count(*) FROM public.gomoku_rooms WHERE owner_uid=caller AND created_at > clock_timestamp()-interval '1 hour') >= 5 THEN
        RAISE EXCEPTION 'create_limit';
      END IF;
      INSERT INTO public.gomoku_rooms(id,code,owner_uid,owner_name,owner_animal,black_seat,owner_client,owner_seen_at)
      VALUES(p_room::uuid,upper(left(replace(p_room,'-',''),10)),caller,name_value,p_data->>'animal',
        CASE WHEN random()<0.5 THEN 1 ELSE 2 END,p_client,clock_timestamp());
    END IF;
  END IF;

  SELECT * INTO s FROM public.gomoku_rooms WHERE id::text = lower(p_room) OR code = upper(p_room) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  now_at := clock_timestamp();
  IF s.expires_at <= now_at THEN RAISE EXCEPTION 'expired'; END IF;
  IF p_action='create' AND s.owner_uid<>caller THEN RAISE EXCEPTION 'forbidden'; END IF;

  seat := CASE WHEN caller=s.owner_uid THEN 1 WHEN caller=s.guest_uid THEN 2 ELSE 0 END;
  IF seat=0 THEN
    IF p_action='withdraw' THEN
      IF s.applicant_uid=caller THEN
        IF s.application_id::text IS DISTINCT FROM p_data->>'application' THEN RAISE EXCEPTION 'application_changed'; END IF;
        UPDATE public.gomoku_rooms SET applicant_uid='',applicant_name='',application_id=NULL,version=version+1 WHERE id=s.id;
      END IF;
      RETURN jsonb_build_object('pending',true,'withdrawn',true,'applicationId',NULL,'room',s.id,'code',s.code,'serverNow',extract(epoch FROM now_at)*1000);
    END IF;
    IF s.phase='closed' THEN RAISE EXCEPTION 'room_closed'; END IF;
    IF s.guest_uid<>'' THEN RAISE EXCEPTION 'room_full'; END IF;
    IF p_action='apply' THEN
      IF s.applicant_uid<>'' AND s.applicant_uid<>caller THEN RAISE EXCEPTION 'application_pending'; END IF;
      IF s.applicant_uid='' THEN
        s.applicant_uid:=caller;
        s.applicant_name:=CASE WHEN p_data->>'autoName'='true' THEN CASE WHEN s.owner_animal='dog' THEN '猫猫' ELSE '狗狗' END ELSE name_value END;
        s.application_id:=gen_random_uuid();
        UPDATE public.gomoku_rooms SET applicant_uid=s.applicant_uid,applicant_name=s.applicant_name,
          application_id=s.application_id,version=version+1 WHERE id=s.id;
      END IF;
    ELSIF p_action<>'snapshot' OR s.applicant_uid<>caller THEN RAISE EXCEPTION 'forbidden'; END IF;
    RETURN jsonb_build_object('pending',true,'applicationId',s.application_id,'room',s.id,'code',s.code,'serverNow',extract(epoch FROM now_at)*1000);
  END IF;
  IF p_action='withdraw' THEN RAISE EXCEPTION 'application_changed'; END IF;
  IF p_action='snapshot' AND (CASE WHEN seat=1 THEN s.owner_client ELSE s.guest_client END) IS NULL THEN
    RAISE EXCEPTION 'connect_required';
  END IF;

  is_mutation := p_action IN ('approve','reject','ready','move','rematch','leave','undo_request','undo_respond','undo_cancel','emoji');
  IF is_mutation AND (p_operation IS NULL OR p_version IS NULL OR p_version<0 OR p_game IS NULL) THEN
    RAISE EXCEPTION 'invalid_operation';
  END IF;
  fingerprint := jsonb_build_object('uid',caller,'action',p_action,'version',p_version,'game',p_game,'data',p_data);
  IF is_mutation THEN
    SELECT value INTO receipt FROM jsonb_array_elements(s.receipts) WHERE value->>'id'=p_operation::text;
    IF receipt IS NOT NULL THEN
      IF receipt->'request' IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'id_conflict'; END IF;
      duplicate:=true;
    END IF;
  END IF;
  IF p_action NOT IN ('connect','create','apply') AND
    p_client IS DISTINCT FROM (CASE WHEN seat=1 THEN s.owner_client ELSE s.guest_client END) THEN
    RAISE EXCEPTION 'superseded';
  END IF;

  IF s.phase='paused' AND s.offline_deadline<=now_at THEN
    s.phase:='finished'; s.reason:='disconnect_timeout'; s.winner:=NULL;
    s.offline_deadline:=NULL; changed:=true;
  ELSIF s.phase='running' THEN
    IF s.owner_seen_at<=now_at-interval '25 seconds' OR s.owner_seen_at IS NULL THEN
      stale_at:=coalesce(s.owner_seen_at+interval '25 seconds',now_at); s.owner_synced:=false;
    END IF;
    IF s.guest_seen_at<=now_at-interval '25 seconds' OR s.guest_seen_at IS NULL THEN
      stale_at:=least(stale_at,coalesce(s.guest_seen_at+interval '25 seconds',now_at)); s.guest_synced:=false;
    END IF;
    IF s.turn_deadline<=coalesce(stale_at,now_at) THEN
      s.phase:='finished'; s.reason:='timeout'; s.winner:=3-s.turn_seat;
      s.remaining_ms:=0; s.turn_deadline:=NULL; changed:=true;
    ELSIF stale_at IS NOT NULL THEN
      s.phase:='paused';
      s.remaining_ms:=greatest(0,least(60000,floor(extract(epoch FROM (s.turn_deadline-stale_at))*1000)::integer));
      s.turn_deadline:=NULL; s.offline_deadline:=stale_at+interval '5 minutes'; changed:=true;
    END IF;
  END IF;
  IF s.phase='paused' AND s.offline_deadline<=now_at THEN
    s.phase:='finished'; s.reason:='disconnect_timeout'; s.winner:=NULL;
    s.offline_deadline:=NULL; changed:=true;
  END IF;
  IF s.phase='finished' AND changed THEN s.owner_ready:=false; s.guest_ready:=false; END IF;

  IF s.phase='paused' THEN
    IF s.owner_seen_at IS NULL OR s.owner_seen_at<=now_at-interval '25 seconds' THEN
      stale_at:=coalesce(s.owner_seen_at+interval '25 seconds',now_at); s.owner_synced:=false;
    END IF;
    IF s.guest_seen_at IS NULL OR s.guest_seen_at<=now_at-interval '25 seconds' THEN
      stale_at:=least(stale_at,coalesce(s.guest_seen_at+interval '25 seconds',now_at)); s.guest_synced:=false;
    END IF;
    IF stale_at IS NOT NULL THEN
      IF s.undo_request IS NOT NULL THEN s.undo_request:=NULL; changed:=true; END IF;
      IF s.offline_deadline IS NULL THEN s.offline_deadline:=stale_at+interval '5 minutes'; changed:=true; END IF;
    END IF;
    IF s.offline_deadline<=now_at THEN
      s.phase:='finished'; s.reason:='disconnect_timeout'; s.winner:=NULL;
      s.offline_deadline:=NULL; s.owner_ready:=false; s.guest_ready:=false; changed:=true;
    ELSIF s.undo_request IS NOT NULL AND (s.undo_request->>'expiresAt')::numeric<=extract(epoch FROM now_at)*1000 THEN
      s.undo_request:=NULL; changed:=true;
    END IF;
  END IF;
  IF s.phase IN ('finished','closed') THEN s.undo_request:=NULL; END IF;

  IF p_action IN ('connect','create','apply') THEN
    IF seat=1 THEN s.owner_client:=p_client; s.owner_synced:=false;
    ELSE s.guest_client:=p_client; s.guest_synced:=false; END IF;
    IF s.phase='running' THEN
      s.phase:='paused';
      s.remaining_ms:=greatest(0,least(60000,floor(extract(epoch FROM(s.turn_deadline-now_at))*1000)::integer));
      s.turn_deadline:=NULL; s.offline_deadline:=now_at+interval '5 minutes'; changed:=true;
    ELSIF s.phase='paused' AND s.offline_deadline IS NULL THEN
      s.offline_deadline:=now_at+interval '5 minutes'; changed:=true;
    END IF;
  END IF;
  IF seat=1 THEN s.owner_seen_at:=now_at; ELSE s.guest_seen_at:=now_at; END IF;
  owner_online:=coalesce(s.owner_seen_at>now_at-interval '25 seconds',false);
  guest_online:=s.guest_uid<>'' AND coalesce(s.guest_seen_at>now_at-interval '25 seconds',false);
  IF NOT owner_online THEN s.owner_synced:=false; END IF;
  IF NOT guest_online THEN s.guest_synced:=false; END IF;

  IF p_action='sync' THEN
    IF p_version IS DISTINCT FROM s.version OR changed THEN rejection:='state_conflict';
    ELSIF seat=1 THEN s.owner_synced:=true; ELSE s.guest_synced:=true; END IF;
  END IF;

  IF is_mutation AND NOT duplicate THEN
    IF changed OR (p_action<>'emoji' AND p_version<>s.version) THEN rejection:='state_conflict';
    ELSIF p_game<>s.game_id THEN rejection:='old_game';
    ELSIF s.phase='closed' THEN rejection:='room_closed';
    ELSIF NOT (CASE WHEN seat=1 THEN s.owner_synced ELSE s.guest_synced END) THEN rejection:='sync_required';
    ELSIF p_action IN ('approve','reject') THEN
      IF seat<>1 THEN rejection:='owner_only';
      ELSIF s.applicant_uid='' OR s.application_id::text IS DISTINCT FROM p_data->>'application' THEN rejection:='application_changed';
      ELSE
        IF p_action='approve' THEN s.guest_uid:=s.applicant_uid; s.guest_name:=s.applicant_name; END IF;
        s.applicant_uid:=''; s.applicant_name:=''; s.application_id:=NULL; changed:=true;
      END IF;
    ELSIF p_action='leave' THEN
      s.phase:='closed'; s.reason:='left'; s.winner:=NULL;
      s.turn_deadline:=NULL; s.offline_deadline:=NULL; s.undo_request:=NULL; changed:=true;
    ELSIF p_action='emoji' THEN
      IF p_data->>'emoji' IS NULL OR p_data->>'emoji' NOT IN ('plead','cat','dog','heart','laugh','cry','angry','celebrate') THEN rejection:='invalid_emoji';
      ELSIF NOT owner_online OR NOT guest_online OR NOT s.owner_synced OR NOT s.guest_synced THEN rejection:='opponent_offline';
      ELSE
        SELECT coalesce(jsonb_agg(value),'[]'::jsonb) INTO events FROM jsonb_array_elements(s.emoji_events)
          WHERE (value->>'at')::numeric>extract(epoch FROM now_at)*1000-60000;
        SELECT count(*),max((value->>'at')::numeric) INTO event_count,last_event_at FROM jsonb_array_elements(events) WHERE (value->>'seat')::integer=seat;
        IF event_count>=10 OR last_event_at>extract(epoch FROM now_at)*1000-2000 THEN rejection:='emoji_rate_limit';
        ELSE
          s.emoji_events:=events||jsonb_build_array(jsonb_build_object('id',p_operation,'seat',seat,'emoji',p_data->>'emoji','at',extract(epoch FROM now_at)*1000));
        END IF;
      END IF;
    ELSIF p_action='undo_request' THEN
      IF s.phase<>'running' THEN rejection:='not_running';
      ELSIF NOT owner_online OR NOT guest_online OR NOT s.owner_synced OR NOT s.guest_synced THEN rejection:='opponent_offline';
      ELSIF s.undo_used[seat]>=2 THEN rejection:='undo_limit';
      ELSE
        SELECT value,(ordinality-1)::integer INTO target_move,target_index
          FROM jsonb_array_elements(s.moves) WITH ORDINALITY WHERE (value->>'seat')::integer=seat ORDER BY ordinality DESC LIMIT 1;
        target_id:=coalesce(target_move->>'id','legacy-'||target_index::text);
        IF target_move IS NULL THEN rejection:='no_undo_move';
        ELSIF p_data->>'target' IS DISTINCT FROM target_id THEN rejection:='undo_target_changed';
        ELSIF s.undo_targets ? (seat::text||':'||target_id) THEN rejection:='undo_already_requested';
        ELSIF coalesce((s.undo_last_at->>seat::text)::numeric,0)>extract(epoch FROM now_at)*1000-30000 THEN rejection:='undo_cooldown';
        ELSIF jsonb_array_length(s.moves)-target_index NOT BETWEEN 1 AND 2 THEN rejection:='undo_target_changed';
        ELSE
          restore_ms:=least(60000,greatest(15000,coalesce((target_move->>'remainingMs')::integer,60000)));
          s.undo_request:=jsonb_build_object('id',p_operation,'seat',seat,'target',target_id,'removeCount',jsonb_array_length(s.moves)-target_index,
            'restoreMs',restore_ms,'expiresAt',extract(epoch FROM now_at+interval '30 seconds')*1000);
          s.undo_targets:=s.undo_targets||jsonb_build_array(seat::text||':'||target_id);
          s.undo_last_at:=s.undo_last_at||jsonb_build_object(seat::text,extract(epoch FROM now_at)*1000);
          s.remaining_ms:=greatest(0,least(60000,floor(extract(epoch FROM(s.turn_deadline-now_at))*1000)::integer));
          s.turn_deadline:=NULL; s.phase:='paused'; changed:=true;
        END IF;
      END IF;
    ELSIF p_action IN ('undo_respond','undo_cancel') THEN
      IF s.undo_request IS NULL OR s.undo_request->>'id' IS DISTINCT FROM p_data->>'request' THEN rejection:='undo_expired';
      ELSE
        undo_seat:=(s.undo_request->>'seat')::integer;
        IF (p_action='undo_cancel' AND seat<>undo_seat) OR (p_action='undo_respond' AND seat=undo_seat) THEN rejection:='forbidden';
        ELSIF p_action='undo_respond' AND jsonb_typeof(p_data->'accept') IS DISTINCT FROM 'boolean' THEN rejection:='invalid_request';
        ELSIF NOT owner_online OR NOT guest_online OR NOT s.owner_synced OR NOT s.guest_synced THEN rejection:='opponent_offline';
        ELSE
          IF p_action='undo_respond' AND p_data->>'accept'='true' THEN
            SELECT coalesce(jsonb_agg(value ORDER BY ordinality),'[]'::jsonb) INTO s.moves FROM jsonb_array_elements(s.moves) WITH ORDINALITY
              WHERE ordinality<=jsonb_array_length(s.moves)-(s.undo_request->>'removeCount')::integer;
            s.turn_seat:=undo_seat; s.remaining_ms:=(s.undo_request->>'restoreMs')::integer;
            s.undo_used[undo_seat]:=s.undo_used[undo_seat]+1; s.win_line:='[]';
          END IF;
          s.undo_request:=NULL; changed:=true;
        END IF;
      END IF;
    ELSIF p_action IN ('ready','rematch') THEN
      IF (p_action='ready' AND s.phase<>'waiting') OR (p_action='rematch' AND s.phase<>'finished') THEN rejection:='wrong_phase';
      ELSIF s.guest_uid='' THEN rejection:='waiting_guest';
      ELSE
        IF seat=1 THEN s.owner_ready:=true; ELSE s.guest_ready:=true; END IF;
        changed:=true;
      END IF;
    ELSIF p_action='move' THEN
      IF s.phase<>'running' THEN rejection:='not_running';
      ELSIF NOT owner_online OR NOT guest_online OR NOT s.owner_synced OR NOT s.guest_synced THEN rejection:='opponent_offline';
      ELSIF s.turn_seat<>seat THEN rejection:='not_your_turn';
      ELSIF jsonb_typeof(p_data->'x') IS DISTINCT FROM 'number' OR jsonb_typeof(p_data->'y') IS DISTINCT FROM 'number'
        OR (p_data->>'x') !~ '^(0|[1-9][0-9]?)$' OR (p_data->>'y') !~ '^(0|[1-9][0-9]?)$' THEN rejection:='invalid_position';
      ELSE
        x:=(p_data->>'x')::integer; y:=(p_data->>'y')::integer;
        IF x NOT BETWEEN 0 AND 14 OR y NOT BETWEEN 0 AND 14 THEN rejection:='invalid_position';
        ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(s.moves) m WHERE (m->>'x')::integer=x AND (m->>'y')::integer=y) THEN rejection:='occupied';
        ELSE
          color_value:=CASE WHEN seat=s.black_seat THEN 1 ELSE 2 END;
          move_value:=jsonb_build_object('id',p_operation,'x',x,'y',y,'seat',seat,'color',color_value,
            'remainingMs',greatest(0,floor(extract(epoch FROM(s.turn_deadline-now_at))*1000)::integer));
          s.moves:=s.moves||jsonb_build_array(move_value);
          FOR direction IN 1..4 LOOP
            dx:=CASE direction WHEN 2 THEN 0 ELSE 1 END;
            dy:=CASE direction WHEN 1 THEN 0 WHEN 4 THEN -1 ELSE 1 END;
            line_value:=jsonb_build_array(jsonb_build_object('x',x,'y',y));
            FOREACH sign_value IN ARRAY ARRAY[-1,1] LOOP
              nx:=x+sign_value*dx; ny:=y+sign_value*dy;
              WHILE nx BETWEEN 0 AND 14 AND ny BETWEEN 0 AND 14 LOOP
                EXIT WHEN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.moves) m
                  WHERE (m->>'x')::integer=nx AND (m->>'y')::integer=ny AND (m->>'color')::integer=color_value);
                line_value:=line_value||jsonb_build_array(jsonb_build_object('x',nx,'y',ny));
                nx:=nx+sign_value*dx; ny:=ny+sign_value*dy;
              END LOOP;
            END LOOP;
            IF jsonb_array_length(line_value)>=5 THEN
              s.phase:='finished'; s.reason:='five'; s.winner:=seat; s.win_line:=line_value; EXIT;
            END IF;
          END LOOP;
          IF s.phase='running' AND jsonb_array_length(s.moves)=225 THEN s.phase:='finished'; s.reason:='draw'; END IF;
          IF s.phase='running' THEN s.turn_seat:=3-seat; s.remaining_ms:=60000; s.turn_deadline:=now_at+interval '60 seconds';
          ELSE s.turn_deadline:=NULL; s.owner_ready:=false; s.guest_ready:=false; END IF;
          changed:=true;
        END IF;
      END IF;
    END IF;
  END IF;

  IF s.phase='paused' AND owner_online AND guest_online AND s.owner_synced AND s.guest_synced THEN
    IF s.undo_request IS NULL THEN
      s.phase:='running'; s.turn_deadline:=now_at+s.remaining_ms*interval '1 millisecond'; changed:=true;
    END IF;
    IF s.offline_deadline IS NOT NULL THEN s.offline_deadline:=NULL; changed:=true; END IF;
  END IF;
  IF s.phase IN ('waiting','finished') AND s.owner_ready AND s.guest_ready AND owner_online AND guest_online AND s.owner_synced AND s.guest_synced THEN
    IF s.phase='finished' THEN s.round:=s.round+1; s.game_id:=gen_random_uuid(); s.black_seat:=3-s.black_seat; END IF;
    s.moves:='[]'; s.win_line:='[]'; s.winner:=NULL; s.reason:=NULL;
    s.undo_request:=NULL; s.undo_used:=ARRAY[0,0]; s.undo_targets:='[]'; s.undo_last_at:='{}'; s.emoji_events:='[]';
    s.phase:='running'; s.turn_seat:=s.black_seat; s.remaining_ms:=60000; s.turn_deadline:=now_at+interval '60 seconds';
    s.offline_deadline:=NULL; s.owner_ready:=false; s.guest_ready:=false; changed:=true;
  END IF;
  IF changed THEN s.version:=s.version+1; END IF;
  IF is_mutation AND NOT duplicate AND rejection IS NULL THEN
    s.receipts:=s.receipts||jsonb_build_array(jsonb_build_object('id',p_operation,'request',fingerprint));
    IF jsonb_array_length(s.receipts)>512 THEN s.receipts:=s.receipts-0; END IF;
  END IF;
  UPDATE public.gomoku_rooms SET
    guest_uid=s.guest_uid,guest_name=s.guest_name,applicant_uid=s.applicant_uid,applicant_name=s.applicant_name,application_id=s.application_id,
    owner_client=s.owner_client,guest_client=s.guest_client,owner_synced=s.owner_synced,guest_synced=s.guest_synced,
    owner_seen_at=s.owner_seen_at,guest_seen_at=s.guest_seen_at,owner_ready=s.owner_ready,guest_ready=s.guest_ready,
    phase=s.phase,game_id=s.game_id,round=s.round,black_seat=s.black_seat,turn_seat=s.turn_seat,moves=s.moves,win_line=s.win_line,
    winner=s.winner,reason=s.reason,remaining_ms=s.remaining_ms,turn_deadline=s.turn_deadline,offline_deadline=s.offline_deadline,
    version=s.version,receipts=s.receipts,undo_request=s.undo_request,undo_used=s.undo_used,
    undo_targets=s.undo_targets,undo_last_at=s.undo_last_at,emoji_events=s.emoji_events WHERE id=s.id;
  RETURN jsonb_build_object(
    'pending',false,'room',s.id,'code',s.code,'seat',seat,'version',s.version,'gameId',s.game_id,'round',s.round,
    'phase',s.phase,'blackSeat',s.black_seat,'turnSeat',s.turn_seat,'moves',s.moves,'winLine',s.win_line,'winner',s.winner,'reason',s.reason,
    'players',jsonb_build_array(
      jsonb_build_object('name',s.owner_name,'animal',s.owner_animal,'online',owner_online,'synced',s.owner_synced,'ready',s.owner_ready,'undoLeft',2-s.undo_used[1]),
      jsonb_build_object('name',s.guest_name,'animal',CASE WHEN s.owner_animal='dog' THEN 'cat' ELSE 'dog' END,'online',guest_online,'synced',s.guest_synced,'ready',s.guest_ready,'undoLeft',2-s.undo_used[2])),
    'undoRequest',s.undo_request,'emojis',s.emoji_events,
    'application',CASE WHEN seat=1 AND s.applicant_uid<>'' THEN jsonb_build_object('id',s.application_id,'name',s.applicant_name) ELSE NULL END,
    'remainingMs',CASE WHEN s.phase='running' THEN greatest(0,floor(extract(epoch FROM(s.turn_deadline-now_at))*1000)::integer) ELSE s.remaining_ms END,
    'turnDeadline',extract(epoch FROM s.turn_deadline)*1000,'offlineDeadline',extract(epoch FROM s.offline_deadline)*1000,
    'serverNow',extract(epoch FROM now_at)*1000,'expiresAt',extract(epoch FROM s.expires_at)*1000,
    'accepted',rejection IS NULL,'rejection',rejection,'duplicate',duplicate);
END;
$$;
REVOKE ALL ON FUNCTION public.gomoku_command(text,text,uuid,uuid,integer,uuid,jsonb,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gomoku_command(text,text,uuid,uuid,integer,uuid,jsonb,integer) TO authenticated, anon;
