-- FIX: recreate core_wh_po_reopen (หายไปตอน DROP)
-- received (มีของขาด) → partial (กลับไปรอรับ)
-- cancelled → ordered (เปิดใบกลับมาสั่งใหม่)

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
  v_ord record;
begin
  select * into v_ord from core_wh_po_orders where id = p_order;
  if v_ord is null then raise exception 'ไม่พบใบสั่งซื้อ'; end if;

  if not core_can(p_emp, 'wh.po.cancel') then
    raise exception 'ไม่มีสิทธิ์เปิดใบกลับ';
  end if;

  if v_ord.status = 'cancelled' then
    -- ยกเลิกแล้ว → กลับเป็น ordered (ของถูกถอนออกไปแล้ว)
    update core_wh_po_orders
       set status = 'ordered',
           cancel_reason = null
     where id = p_order;
    return 'ordered';

  elsif v_ord.status = 'received' then
    -- รับครบแล้ว (มีของขาด) → กลับเป็น partial
    update core_wh_po_orders
       set status = 'partial'
     where id = p_order;
    return 'partial';

  else
    raise exception 'ใบสถานะ % เปิดกลับไม่ได้', v_ord.status;
  end if;
end;
$$;
