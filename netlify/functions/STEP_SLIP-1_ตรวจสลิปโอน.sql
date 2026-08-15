-- =====================================================================
-- Royal Creek — ระบบตรวจสลิปโอน POS   (STEP SLIP-1)
-- ปลอดภัยต่อระบบเดิม 100% :
--   • สร้างตารางใหม่ 2 ตาราง + ฟังก์ชันใหม่ 5 ตัว
--   • ไม่แตะ core_pos_checkout / core_pos_report / core_pos_void_bill เลย
--   • ถ้าไม่อัปหน้าเว็บ ระบบขายเดิมทำงานเหมือนเดิมทุกอย่าง
-- =====================================================================

-- ---------- 1) ตารางบันทึกการรับโอนต่อ 1 บิล ----------
create table if not exists core_pos_slips (
  id           uuid primary key default gen_random_uuid(),
  bill_no      text not null,
  venue        text,
  bill_total   numeric(12,2) not null default 0,   -- ยอดที่ต้องได้รับ
  slip_total   numeric(12,2) not null default 0,   -- ยอดรวมจากสลิปที่แนบ
  slip_count   int           not null default 0,
  flags        text[]        not null default '{}',-- ป้ายเตือนทั้งหมดที่เจอ
  reason       text,                               -- เหตุผลที่พนักงานกดผ่าน
  emp          uuid,
  emp_name     text,
  created_at   timestamptz   not null default now()
);
create index if not exists idx_pos_slips_bill on core_pos_slips(bill_no);
create index if not exists idx_pos_slips_at   on core_pos_slips(created_at desc);
create index if not exists idx_pos_slips_flag on core_pos_slips using gin(flags);

-- ---------- 2) ตารางสลิปแต่ละใบ (1 บิลมีได้หลายใบ) ----------
create table if not exists core_pos_slip_items (
  id          uuid primary key default gen_random_uuid(),
  slip_id     uuid references core_pos_slips(id) on delete cascade,
  ref_no      text,                    -- เลขอ้างอิงบนสลิป = กุญแจกันใช้ซ้ำ
  amount      numeric(12,2),
  slip_at     timestamptz,             -- วันเวลาบนสลิป
  slip_at_txt text,                    -- ข้อความวันเวลาดิบ เผื่ออ่านไม่เป็นวันที่
  bank        text,
  payer       text,
  payee       text,
  img_url     text,
  dup_of      text,                    -- ถ้าเลขอ้างอิงนี้เคยใช้แล้ว = เลขบิลเดิม
  ai_ok       boolean default true,    -- false = AI อ่านไม่ได้ พนักงานพิมพ์เอง
  created_at  timestamptz not null default now()
);
create index if not exists idx_pos_slipitem_ref  on core_pos_slip_items(ref_no);
create index if not exists idx_pos_slipitem_slip on core_pos_slip_items(slip_id);

-- ---------- 3) ระดับสิทธิ์ (ยืดหยุ่น เผื่อชื่อฟังก์ชันต่างกัน) ----------
create or replace function core_pos_slip_lvl(p_emp uuid)
returns int language plpgsql stable security definer set search_path=public as $$
declare v int;
begin
  if p_emp is null then return 0; end if;
  begin
    execute 'select core_emp_max_level($1)' into v using p_emp;
    if v is not null then return v; end if;
  exception when others then
    null;   -- ถ้าไม่มีฟังก์ชันนี้ ให้ตกไปใช้วิธีสำรองข้างล่าง
  end;
  if exists(select 1 from core_employees where id=p_emp) then return 50; end if;
  return 0;
end; $$;
grant execute on function core_pos_slip_lvl(uuid) to anon, authenticated;

-- ---------- 4) เช็คเลขอ้างอิงซ้ำ (เรียกก่อนกดยืนยัน) ----------
-- คืน: [{ref, used_bill, used_at, used_by}] เฉพาะเลขที่เคยใช้แล้ว
create or replace function core_pos_slip_check(p_emp uuid, p_refs text[])
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v jsonb;
begin
  if core_pos_slip_lvl(p_emp) < 50 then raise exception 'ไม่มีสิทธิ์ตรวจสลิป'; end if;
  if p_refs is null or array_length(p_refs,1) is null then return '[]'::jsonb; end if;

  select coalesce(jsonb_agg(x order by x->>'ref'), '[]'::jsonb) into v
  from (
    select distinct on (i.ref_no)
           jsonb_build_object(
             'ref',       i.ref_no,
             'used_bill', s.bill_no,
             'used_at',   s.created_at,
             'used_by',   s.emp_name
           ) as x
      from core_pos_slip_items i
      join core_pos_slips s on s.id = i.slip_id
     where i.ref_no is not null
       and length(btrim(i.ref_no)) >= 6      -- เลขสั้นเกินไปไม่น่าเชื่อถือ ไม่เอามาตัดสิน
       and btrim(upper(i.ref_no)) = any(
             select btrim(upper(r)) from unnest(p_refs) r where r is not null
           )
     order by i.ref_no, s.created_at desc
  ) t;
  return v;
end; $$;
grant execute on function core_pos_slip_check(uuid, text[]) to anon, authenticated;

-- ---------- 5) บันทึกสลิปของบิล ----------
-- p_slips = jsonb array: [{ref,amount,slip_at,slip_at_txt,bank,payer,payee,img_url,dup_of,ai_ok}]
-- p_flags = ป้ายเตือนที่หน้าจอตรวจพบ เช่น {'mismatch','old','dup','noslip'}
create or replace function core_pos_slip_save(
  p_emp uuid, p_bill_no text, p_venue text,
  p_bill_total numeric, p_slips jsonb,
  p_flags text[] default '{}', p_reason text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_name text; v_sum numeric := 0; v_cnt int := 0; it jsonb;
begin
  if core_pos_slip_lvl(p_emp) < 50 then raise exception 'ไม่มีสิทธิ์บันทึกสลิป'; end if;
  if p_bill_no is null or btrim(p_bill_no)='' then raise exception 'ไม่มีเลขบิล'; end if;

  select coalesce(nickname, full_name_th) into v_name from core_employees where id=p_emp;

  if p_slips is not null and jsonb_typeof(p_slips)='array' then
    select coalesce(sum((e->>'amount')::numeric),0), count(*)
      into v_sum, v_cnt
      from jsonb_array_elements(p_slips) e;
  end if;

  insert into core_pos_slips(bill_no,venue,bill_total,slip_total,slip_count,flags,reason,emp,emp_name)
  values (btrim(p_bill_no), p_venue, coalesce(p_bill_total,0), coalesce(v_sum,0),
          coalesce(v_cnt,0), coalesce(p_flags,'{}'), nullif(btrim(coalesce(p_reason,'')),''), p_emp, v_name)
  returning id into v_id;

  if v_cnt > 0 then
    for it in select * from jsonb_array_elements(p_slips) loop
      insert into core_pos_slip_items(slip_id,ref_no,amount,slip_at,slip_at_txt,bank,payer,payee,img_url,dup_of,ai_ok)
      values (
        v_id,
        nullif(btrim(coalesce(it->>'ref','')),''),
        nullif(it->>'amount','')::numeric,
        case when coalesce(it->>'slip_at','')='' then null
             else (it->>'slip_at')::timestamptz end,
        nullif(it->>'slip_at_txt',''),
        nullif(it->>'bank',''),
        nullif(it->>'payer',''),
        nullif(it->>'payee',''),
        nullif(it->>'img_url',''),
        nullif(it->>'dup_of',''),
        coalesce((it->>'ai_ok')::boolean, true)
      );
    end loop;
  end if;

  return v_id;
end; $$;
grant execute on function core_pos_slip_save(uuid, text, text, numeric, jsonb, text[], text) to anon, authenticated;

-- ---------- 6) รายงานบิลโอนที่ต้องตรวจ (ผู้จัดการขึ้นไป) ----------
create or replace function core_pos_slip_report(
  p_emp uuid, p_from date, p_to date, p_only_problem boolean default true)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v jsonb; v_sum jsonb;
begin
  if core_pos_slip_lvl(p_emp) < 80 then raise exception 'เฉพาะผู้จัดการขึ้นไป'; end if;

  with s as (
    select * from core_pos_slips
     where created_at >= p_from::timestamptz
       and created_at <  (p_to + 1)::timestamptz
       and (not p_only_problem or array_length(flags,1) > 0)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'bill_no', s.bill_no, 'venue', s.venue,
           'at', s.created_at, 'by', s.emp_name,
           'bill_total', s.bill_total, 'slip_total', s.slip_total,
           'diff', s.bill_total - s.slip_total,
           'count', s.slip_count, 'flags', s.flags, 'reason', s.reason,
           'items', (
             select coalesce(jsonb_agg(jsonb_build_object(
               'ref', i.ref_no, 'amount', i.amount, 'at', i.slip_at,
               'at_txt', i.slip_at_txt, 'bank', i.bank, 'payer', i.payer,
               'payee', i.payee, 'img', i.img_url, 'dup_of', i.dup_of, 'ai_ok', i.ai_ok
             ) order by i.created_at), '[]'::jsonb)
             from core_pos_slip_items i where i.slip_id = s.id)
         ) order by s.created_at desc), '[]'::jsonb)
    into v from s;

  -- สรุปว่าใครกดผ่านกี่ครั้ง
  select coalesce(jsonb_agg(jsonb_build_object('by',emp_name,'n',n,'amt',amt) order by n desc), '[]'::jsonb)
    into v_sum
  from (select emp_name, count(*) n, coalesce(sum(bill_total-slip_total),0) amt
          from core_pos_slips
         where created_at >= p_from::timestamptz
           and created_at <  (p_to + 1)::timestamptz
           and array_length(flags,1) > 0
         group by emp_name) q;

  return jsonb_build_object('rows', v, 'by_staff', v_sum);
end; $$;
grant execute on function core_pos_slip_report(uuid, date, date, boolean) to anon, authenticated;

-- ---------- 7) รายชื่อบิลที่บันทึกสลิปแล้ว (ใช้หาบิลโอนที่ยังไม่มีสลิป) ----------
create or replace function core_pos_slip_bills(p_emp uuid, p_date date)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v jsonb;
begin
  if core_pos_slip_lvl(p_emp) < 50 then raise exception 'ไม่มีสิทธิ์'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'bill_no',bill_no,'slip_total',slip_total,'bill_total',bill_total,
           'flags',flags,'count',slip_count)), '[]'::jsonb)
    into v
    from core_pos_slips
   where created_at >= p_date::timestamptz
     and created_at <  (p_date + 1)::timestamptz;
  return v;
end; $$;
grant execute on function core_pos_slip_bills(uuid, date) to anon, authenticated;

-- ---------- 8) ลบรูปสลิปเก่าเกิน 1 ปี (ล้างเฉพาะลิงก์ในฐานข้อมูล) ----------
create or replace function core_pos_slip_cleanup(p_emp uuid, p_days int default 365)
returns int language plpgsql security definer set search_path=public as $$
declare n int;
begin
  if core_pos_slip_lvl(p_emp) < 100 then raise exception 'เฉพาะเจ้าของ'; end if;
  update core_pos_slip_items set img_url = null
   where img_url is not null
     and created_at < now() - make_interval(days => greatest(coalesce(p_days,365),30));
  get diagnostics n = row_count;
  return n;
end; $$;
grant execute on function core_pos_slip_cleanup(uuid, int) to anon, authenticated;

-- ---------- 9) สวิตช์เปิด/ปิดระบบตรวจสลิป ----------
-- ค่าที่ใช้ได้:
--   'off'    = ปิดสนิท ขายเหมือนเดิมทุกอย่าง ไม่มีหน้าสลิปโผล่
--   'soft'   = ช่วงทดลอง เปิดหน้าสลิปให้ใช้ แต่มีปุ่ม "ข้ามไปก่อน" กดได้เลย
--   'strict' = บังคับ ต้องแนบสลิป หรือเลือกเหตุผลถึงจะขายได้
create table if not exists core_pos_settings (
  k          text primary key,
  v          text,
  updated_at timestamptz default now(),
  updated_by uuid
);
insert into core_pos_settings(k,v) values ('slip_mode','soft')
  on conflict (k) do nothing;      -- ตั้งต้นเป็นช่วงทดลอง ไม่บังคับใคร

create or replace function core_pos_setting_get(p_emp uuid, p_k text)
returns text language plpgsql stable security definer set search_path=public as $$
declare v text;
begin
  if core_pos_slip_lvl(p_emp) < 50 then return null; end if;
  select core_pos_settings.v into v from core_pos_settings where k = p_k;
  return v;
end; $$;
grant execute on function core_pos_setting_get(uuid, text) to anon, authenticated;

create or replace function core_pos_setting_set(p_emp uuid, p_k text, p_v text)
returns text language plpgsql security definer set search_path=public as $$
begin
  if core_pos_slip_lvl(p_emp) < 100 then raise exception 'เฉพาะเจ้าของเท่านั้น'; end if;
  if p_k = 'slip_mode' and coalesce(p_v,'') not in ('off','soft','strict') then
    raise exception 'ค่าไม่ถูกต้อง: %', p_v;
  end if;
  insert into core_pos_settings(k,v,updated_at,updated_by)
  values (p_k, p_v, now(), p_emp)
  on conflict (k) do update set v=excluded.v, updated_at=now(), updated_by=excluded.updated_by;
  return p_v;
end; $$;
grant execute on function core_pos_setting_set(uuid, text, text) to anon, authenticated;

-- ---------- ตรวจผลติดตั้ง ----------
select proname from pg_proc
 where proname in ('core_pos_slip_lvl','core_pos_slip_check','core_pos_slip_save',
                   'core_pos_slip_report','core_pos_slip_bills','core_pos_slip_cleanup',
                   'core_pos_setting_get','core_pos_setting_set')
 order by 1;
select k as "การตั้งค่า", v as "ค่าปัจจุบัน" from core_pos_settings;
