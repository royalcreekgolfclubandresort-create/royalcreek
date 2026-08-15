// Royal Creek POS — อ่านสลิปโอนเงินด้วย AI (ฝั่งเซิร์ฟเวอร์ ซ่อน API key)
// ใช้ Environment variable: ANTHROPIC_API_KEY (ตัวเดียวกับ read-booking)

const PROMPT = `คุณคือระบบอ่านสลิปโอนเงินของธนาคารไทย จากรูปถ่ายหน้าจอมือถือ

รูปที่ส่งมาอาจมีหลายใบ = ลูกค้าโอนหลายครั้ง/หลายคน ให้อ่านทุกใบแยกกัน เรียงตามลำดับรูปที่ส่งมา

ธนาคารที่พบบ่อย: กสิกรไทย (K PLUS / K+), ไทยพาณิชย์ (SCB), กรุงไทย (Krungthai NEXT),
กรุงเทพ (Bualuang), ออมสิน (MyMo), ทหารไทยธนชาต (ttb), กรุงศรี (KMA), พร้อมเพย์ (PromptPay), TrueMoney

สิ่งที่ต้องอ่านจากแต่ละใบ:
1. amount = จำนวนเงินที่โอน (ตัวเลขล้วน ไม่มีลูกน้ำ ไม่มีคำว่าบาท)
   ระวัง: อย่าเอา "ค่าธรรมเนียม" มาเป็นยอดโอน ยอดโอนคือช่อง "จำนวน" / "จำนวนเงิน"
2. ref = เลขที่รายการ / รหัสอ้างอิง / เลขอ้างอิง / Transaction ID / รหัสธุรกรรม
   เอาตัวที่ยาวที่สุดและดูเป็นรหัสเฉพาะของรายการนั้น คัดลอกให้ตรงตัวอักษรทุกตัว
   ถ้ามีทั้ง "รหัสอ้างอิง" และ "รหัสธุรกรรม" ให้เอา "รหัสอ้างอิง" เป็น ref
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
    const { images } = JSON.parse(event.body || '{}');
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

    const rs = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content }]
      })
    });

    const j = await rs.json();
    if (!rs.ok)
      return { statusCode: rs.status, body: JSON.stringify({ error: (j.error && j.error.message) || 'Anthropic API error' }) };

    let text = (j.content || []).map(b => b.text || '').join('').trim();
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    let out;
    try { out = JSON.parse(text); }
    catch (e) {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return { statusCode: 502, body: JSON.stringify({ error: 'AI ตอบไม่เป็น JSON' }) };
      out = JSON.parse(m[0]);
    }

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slips: Array.isArray(out.slips) ? out.slips : [] })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
