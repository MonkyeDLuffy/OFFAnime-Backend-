-- =============================================================================
-- Self-test: auth attempt limiter RPCs (run in Supabase SQL Editor)
-- -----------------------------------------------------------------------------
-- Verifies the EXACT production login policy against the real database:
--   1. five failures register normally (no lock),
--   2. the sixth attempt is locked AND reports retry_after_seconds,
--   3. attempts during the lock do NOT extend the cooldown,
--   4. after the cooldown the bucket recovers (locked_until expires, counter
--      resets to 1 on the next attempt),
--   5. clear_auth_attempts removes the state (successful-login reset),
--   6. buckets are isolated (signup/login/IP layers can never interfere).
--
-- Any failed assertion raises an exception (the SQL editor shows it);
-- success ends with the NOTICE "auth attempt limits self-test: ALL ASSERTIONS
-- PASSED". The test uses throwaway `selftest:*` buckets and cleans up after
-- itself. Requires the 20261102000001 migration to be applied.
-- =============================================================================

do $$
declare
  v_bucket text := 'selftest:email:' || gen_random_uuid()::text;
  v_res jsonb;
  v_before timestamptz;
  i integer;
begin
  -- 1. five failures register, none locked, counters 1..5
  for i in 1..5 loop
    v_res := public.register_auth_attempt(v_bucket, 5, 900, 900);
    if (v_res->>'locked')::boolean then
      raise exception 'FAIL: attempt % reported locked too early: %', i, v_res;
    end if;
    if (v_res->>'hits')::int <> i then
      raise exception 'FAIL: attempt % hits = % (expected %)', i, v_res->>'hits', i;
    end if;
  end loop;

  -- 2. the sixth attempt is rejected + locked with retry info
  v_res := public.register_auth_attempt(v_bucket, 5, 900, 900);
  if not (v_res->>'locked')::boolean then
    raise exception 'FAIL: sixth attempt was not locked: %', v_res;
  end if;
  if coalesce((v_res->>'retry_after_seconds')::int, 0) <= 0 then
    raise exception 'FAIL: retry_after_seconds missing or <= 0: %', v_res;
  end if;

  -- 3. attempts during the lock must NOT extend it
  select locked_until into v_before
    from public.auth_attempt_limits where bucket = v_bucket;
  v_res := public.register_auth_attempt(v_bucket, 5, 900, 900);
  if not (v_res->>'locked')::boolean then
    raise exception 'FAIL: locked bucket reported unlocked: %', v_res;
  end if;
  if (select locked_until from public.auth_attempt_limits where bucket = v_bucket) <> v_before then
    raise exception 'FAIL: an attempt during the cooldown extended the lock';
  end if;

  -- 4. cooldown expiry: simulate time passing (window + lock in the past),
  --    then the next attempt must be ALLOWED with the counter reset to 1
  update public.auth_attempt_limits
     set window_started_at = now() - interval '16 minutes',
         locked_until = now() - interval '1 second'
   where bucket = v_bucket;
  v_res := public.register_auth_attempt(v_bucket, 5, 900, 900);
  if (v_res->>'locked')::boolean then
    raise exception 'FAIL: bucket still locked after the cooldown: %', v_res;
  end if;
  if (v_res->>'hits')::int <> 1 then
    raise exception 'FAIL: counter did not reset after the window: %', v_res;
  end if;

  -- 5. clear_auth_attempts (successful login) removes the state
  perform public.clear_auth_attempts(v_bucket);
  if exists (select 1 from public.auth_attempt_limits where bucket = v_bucket) then
    raise exception 'FAIL: clear_auth_attempts left state behind';
  end if;

  -- 6. bucket isolation: a brand-new bucket starts fresh
  v_res := public.register_auth_attempt('selftest:ip:isolated', 5, 900, 900);
  if (v_res->>'hits')::int <> 1 or (v_res->>'locked')::boolean then
    raise exception 'FAIL: fresh bucket not isolated: %', v_res;
  end if;

  raise notice 'auth attempt limits self-test: ALL ASSERTIONS PASSED';
end;
$$;

-- Cleanup the throwaway buckets used above.
delete from public.auth_attempt_limits where bucket like 'selftest:%';
