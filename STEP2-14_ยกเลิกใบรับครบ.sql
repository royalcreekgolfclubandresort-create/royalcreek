-- STEP2-14: อัปเดต core_wh_po_order_cancel ให้รองรับ status='received'
-- เจ้าของเท่านั้นสำหรับใบที่รับครบ — ถอนสต๊อกออกทั้งหมด + บันทึก movement

CREATE OR REPLACE FUNCTION public.core_wh_po_order_cancel(
  p_emp    uuid,
  p_order  bigint,
  p_reason text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare
  v_ord   record;
  v_wh    uuid;
  v_line  record;
  v_qty   numeric;
  v_after numeric;
  v_is_owner boolean;
begin
  select * into v_ord from core_wh_po_orders where id = p_order;
  if v_ord is null then raise exception 'ไม่พบใบสั่งซื้อ'; end if;

  if v_ord.status = 'cancelled' then
    raise exception 'ใบนี้ยกเลิกไปแล้ว';
  end if;

  -- ตรวจสิทธิ์
  if not core_can(p_emp, 'wh.po.cancel') then
    raise exception 'ไม่มีสิทธิ์ยกเลิกใบสั่งซื้อ';
  end if;

  -- ใบที่รับครบแล้ว — ต้องเป็นเจ้าของ (level ≥ 90)
  v_is_owner := core_emp_max_level(p_emp, null, null) >= 90;
  if v_ord.status = 'received' and not v_is_owner then
    raise exception 'ใบที่รับครบแล้ว — ยกเลิกได้เฉพาะเจ้าของเท่านั้น';
  end if;

  select id into v_wh from core_venues where code = 'WH';

  -- ถ้ามีของเข้าสต๊อกแล้ว (partial หรือ received) ให้ถอนออก
  if v_ord.status in ('partial', 'received') then
    for v_line in
      select rl.product_id,
             sum(rl.qty_good + coalesce(rl.qty_free, 0)) as total_qty
      from   core_wh_receive_logs rlog
      join   core_wh_receive_lines rl on rl.log_id = rlog.id
      where  rlog.order_id = p_order
        and  coalesce(rlog.undone, false) = false
      group by rl.product_id
      having sum(rl.qty_good + coalesce(rl.qty_free, 0)) > 0
    loop
      update core_pos_stock
         set qty = qty - v_line.total_qty
       where product_id = v_line.product_id and venue_id = v_wh
      returning qty into v_after;

      insert into core_pos_movements(product_id, venue_id, employee_id, kind, delta, qty_after, reason)
      values (v_line.product_id, v_wh, p_emp, 'cancel_po', -v_line.total_qty,
              coalesce(v_after, 0),
              'ยกเลิกใบ ' || coalesce(v_ord.po_number, '#' || p_order::text)
              || coalesce(' — ' || p_reason, ''));
    end loop;
  end if;

  update core_wh_po_orders
     set status        = 'cancelled',
         cancel_reason = coalesce(p_reason, 'ยกเลิก'),
         updated_at    = now()
   where id = p_order;

  return 'cancelled';
end;
$$;
