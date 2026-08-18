// Royal Creek POS — อ่านสลิปโอนเงินด้วย AI (ฝั่งเซิร์ฟเวอร์ ซ่อน API key)
// ใช้ Environment variable: ANTHROPIC_API_KEY (ตัวเดียวกับ read-booking)

const PROMPT = `คุณคือระบบอ่านสลิปโอนเงินของธนาคารไทย จากรูปถ่ายหน้าจอมือถือ

รูปที่ส่งมาอาจมีหลายใบ = ลูกค้าโอนหลายครั้ง/หลายคน ให้อ่านทุกใบแยกกัน เรียงตามลำดับรูปที่ส่งมา

ธนาคารที่พบบ่อย: กสิกรไทย (K PLUS / K+), ไทยพาณิชย์ (SCB), กรุงไทย (Krungthai NEXT),
กรุงเทพ (Bualuang), ออมสิน (MyMo), ทหารไทยธนชาต (ttb), กรุงศรี (KMA), พร้อมเพย์ (PromptPay), TrueMoney

สิ่งที่ต้องอ่านจากแต่ละใบ:
1. amount = จำนวนเงินที่โอน (ตัวเลขล้วน ไม่มีลูกน้ำ ไม่มีคำว่าบาท)
   ระวัง: อย่าเอา "ค่าธรรมเนียม" มาเป็นยอดโอน ยอดโอนคือช่อง "จำนวน" / "จำนวนเงิน"
2. ref = รหัสเฉพาะของ "รายการโอนครั้งนี้" ที่ไม่ซ้ำกับรายการอื่น

   *** สำคัญที่สุด อ่านให้ดี ***
   สลิปมีรหัสหลายตัว บางตัวเป็นของ "ร้านค้าปลายทาง" ซึ่งเหมือนกันทุกใบ ห้ามเอามาใช้เด็ดขาด

   ให้เอาตัวนี้ (เรียงตามลำดับความสำคัญ):
     1) "รหัสอ้างอิง"  2) "เลขที่รายการ"  3) "หมายเลขอ้างอิง"  4) "Transaction Reference"
   มักอยู่บนสุดใต้คำว่า "จ่ายบิลสำเร็จ" / "โอนเงินสำเร็จ" / "ชำระเงินสำเร็จ"

   ห้ามใช้เด็ดขาด (เป็นรหัสของร้านค้า เหมือนกันทุกใบ):
     - "รหัสร้านค้า" / Merchant ID  (เช่น KB000001572457)
     - "รหัสธุรกรรม" ที่มีรหัสร้านค้าอยู่ข้างใน (เช่น KPS004KB000001572457)
     - "Biller ID" / เลขในวงเล็บใต้ชื่อร้าน (เช่น 010753600031508)
     - เลขบัญชี / เลขพร้อมเพย์ / เบอร์โทร

   ตัวอย่างสลิปกรุงไทย:
     รหัสอ้างอิง  C20260817622913047640   <-- เอาตัวนี้ ถูกต้อง
     รหัสร้านค้า  KB000001572457          <-- ห้ามเอา
     รหัสธุรกรรม  KPS004KB000001572457    <-- ห้ามเอา

   วิธีสังเกต: รหัสอ้างอิงจริงมักขึ้นต้นด้วยวันที่ (เช่น 2026, C2026) หรือเป็นชุดตัวเลข
   ยาวที่ไม่ซ้ำใคร  ถ้ารหัสไหนขึ้นต้นด้วย KB / KPS / ชื่อร้าน แสดงว่าเป็นรหัสร้านค้า

   ถ้าเห็นแต่รหัสร้านค้า ไม่เห็นรหัสอ้างอิง ให้ใส่ ref เป็น null (ห้ามเดา ห้ามเอารหัสร้านค้ามาแทน)
   คัดลอกให้ตรงตัวอักษรทุกตัว ไม่ต้องเว้นวรรค
3. date_txt = วันที่บนสลิปตามที่เขียนไว้จริง เช่น "14 ส.ค. 69" หรือ "14 ส.ค. 2569"
4. time_txt = เวลาบนสลิป เช่น "14:37"
5. date_iso = แปลงวันเวลาเป็น ISO "YYYY-MM-DDTHH:MM:00+07:00"
   สำคัญ: ปีบนสลิปไทยมักเป็น พ.ศ. ("69" = 2569, "2569" = 2569) ต้องลบ 543 เป็น ค.ศ. ก่อน
   เช่น "14 ส.ค. 69 14:37" -> "2026-08-14T14:37:00+07:00"
   ถ้าอ่านวันหรือเวลาไม่ได้ ให้ date_iso เป็น null
6. bank = ธนาคารต้นทาง (ผู้โอน)
7. payer = ชื่อผู้โอน
8. payee = ชื่อบัญชี/ร้านค้าปลายทางที่รับเงิน
9. confident = true ถ้าอ่านยอดเงินได้ชัดเจนมั่นใจ, false ถ้าเบลอ/ถูกบัง/เดา

ข้อควรระวัง:
- รูปอาจเป็นภาพถ่ายจอมือถืออีกที มีแสงสะท้อน จอแตก นิ้วบัง ให้พยายามอ่านให้ดีที่สุด
- อาจมีแถบแจ้งเตือนด้านบนจอที่มีตัวเลขเงินด้วย อย่าสับสนกับยอดในสลิป ให้ใช้ยอดในตัวสลิป
- ถ้ารูปไหนไม่ใช่สลิปโอนเงิน ให้ใส่ is_slip: false และ amount: null
- ห้ามเดาเลขอ้างอิง ถ้าอ่านไม่ออกให้ใส่ null
- ย้ำอีกครั้ง: ถ้ารหัสที่จะใส่ใน ref มีคำว่า KB000 / KPS / Biller อยู่ข้างใน แสดงว่าผิด ให้ใส่ null แทน

ตอบเป็น JSON เท่านั้น ห้ามใส่ markdown ห้ามใส่คำอธิบายใดๆ:
{"slips":[
  {"is_slip":true,"amount":70,"ref":"016226094350DQR02661","date_txt":"14 ส.ค. 69","time_txt":"09:43",
   "date_iso":"2026-08-14T09:43:00+07:00","bank":"กสิกรไทย","payer":"น.ส. ปาริชาติ พ",
   "payee":"รอยัล ครีค กอล์ฟ คลับ แอนด์ รีสอร์ท","confident":true,"note":""}
]}`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key)
    return { statusCode: 500, body: JSON.stringify({ error: 'ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY ใน Netlify' }) };

  try {
    const body = JSON.parse(event.body || '{}');

    /* โหมดทดสอบ: {"ping":true} — ตรวจว่าฟังก์ชันขึ้นแล้วและ API key ใช้งานได้ */
    if (body.ping) {
      try {
        const t = Date.now();
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: process.env.SLIP_MODEL || 'claude-haiku-4-5-20251001',
            max_tokens: 16,
            messages: [{ role: 'user', content: 'ตอบคำว่า OK คำเดียว' }]
          })
        });
        const rj = await r.json();
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ok: r.ok,
            ms: Date.now() - t,
            model: process.env.SLIP_MODEL || 'claude-haiku-4-5-20251001',
            reply: r.ok ? (rj.content || []).map(b => b.text || '').join('') : null,
            error: r.ok ? null : ((rj.error && rj.error.message) || ('HTTP ' + r.status))
          })
        };
      } catch (e) {
        return { statusCode: 200, body: JSON.stringify({ ok: false, error: e.message }) };
      }
    }

    const images = body.images;
    if (!Array.isArray(images) || images.length === 0)
      return { statusCode: 400, body: JSON.stringify({ error: 'ไม่มีรูปส่งมา' }) };

    const content = [];
    images.slice(0, 5).forEach((im, i) => {
      content.push({ type: 'text', text: 'รูปที่ ' + (i + 1) });
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: im.mime || 'image/jpeg', data: im.b64 }
      });
    });
    content.push({ type: 'text', text: PROMPT });

    const t0 = Date.now();
    const ctl = new AbortController();
    const killer = setTimeout(() => ctl.abort(), 8500);   // ตัดเองก่อน Netlify ตัดที่ 10 วิ

    const rs = await fetch('https://api.anthropic.com/v1/messages', {
      signal: ctl.signal,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        // Haiku เร็วกว่ามาก — สำคัญเพราะ Netlify ตัดการทำงานที่ 10 วินาที
        // เปลี่ยนรุ่นได้โดยตั้ง env var SLIP_MODEL ใน Netlify
        model: process.env.SLIP_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content }]
      })
    });

    clearTimeout(killer);
    const ms = Date.now() - t0;

    const j = await rs.json();
    if (!rs.ok)
      return { statusCode: rs.status, body: JSON.stringify({ error: (j.error && j.error.message) || 'Anthropic API error' }) };

    let text = (j.content || []).map(b => b.text || '').join('').trim();
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    let out;
    try { out = JSON.parse(text); }
    catch (e) {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return { statusCode: 502, body: JSON.stringify({ error: 'AI ตอบไม่เป็น JSON', raw: text.slice(0, 400) }) };
      out = JSON.parse(m[0]);
    }

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slips: Array.isArray(out.slips) ? out.slips : [],
        _ms: ms,
        _model: process.env.SLIP_MODEL || 'claude-haiku-4-5-20251001',
        _n: images.length
      })
    };
  } catch (e) {
    const msg = (e && e.name === 'AbortError')
      ? 'AI ใช้เวลานานเกิน 8.5 วินาที — ลองลดจำนวนรูปต่อครั้ง หรือถ่ายรูปให้เล็กลง'
      : (e.message || String(e));
    return { statusCode: 500, body: JSON.stringify({ error: msg }) };
  }
};
