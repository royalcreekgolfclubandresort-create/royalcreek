-- FIX v2: core_wh_po_reopen — คืนสต๊อกกลับเมื่อ reopen จาก cancelled
-- cancelled → ordered + คืนของที่ถอนออกไปตอนยกเลิกกลับเข้าสต๊อก
-- received (มีของขาด) → partial (ไม่ต้องแตะสต๊อก ของยังอยู่)

CREATE OR REPLACE FUNCTION public.core_wh_po_reopen(
  p_emp   uuid,
  p_order bigint
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare
  v_ord  record;
  v_wh   uuid;
  v_line record;
  v_after numeric;
begin
  select * into v_ord from core_wh_po_orders where id = p_order;
  if v_ord is null then raise exception 'ไม่พบใบสั่งซื้อ'; end if;

  if not core_can(p_emp, 'wh.po.cancel') then
    raise exception 'ไม่มีสิทธิ์เปิดใบกลับ';
  end if;

  select id into v_wh from core_venues where code = 'WH';

  if v_ord.status = 'cancelled' then
    -- คืนสต๊อกทุกรายการที่เคยถอนออกตอนยกเลิก (movement kind='cancel_po')
    for v_line in
      select product_id, abs(sum(delta)) as qty_to_restore
      from   core_pos_movements
      where  venue_id  = v_wh
        and  kind      = 'cancel_po'
        and  reason    like '%' || coalesce(v_ord.po_number, '#' || p_order::text) || '%'
      group by product_id
      having abs(sum(delta)) > 0
    loop
      insert into core_pos_stock(product_id, venue_id, qty)
        values (v_line.product_id, v_wh, v_line.qty_to_restore)
        on conflict (product_id, venue_id)
        do update set qty = core_pos_stock.qty + v_line.qty_to_restore
        returning qty into v_after;

      insert into core_pos_movements(product_id, venue_id, employee_id, kind, delta, qty_after, reason)
      values (v_line.product_id, v_wh, p_emp, 'reopen_po', v_line.qty_to_restore,
              coalesce(v_after, 0),
              'เปิดใบกลับ ' || coalesce(v_ord.po_number, '#' || p_order::text));
    end loop;

    update core_wh_po_orders
       set status        = 'ordered',
           cancel_reason = null
     where id = p_order;
    return 'ordered';

  elsif v_ord.status = 'received' then
    -- รับครบ (มีของขาด) → partial ไม่ต้องแตะสต๊อก
    update core_wh_po_orders
       set status = 'partial'
     where id = p_order;
    return 'partial';

  else
    raise exception 'ใบสถานะ % เปิดกลับไม่ได้', v_ord.status;
  end if;
end;
$$;
