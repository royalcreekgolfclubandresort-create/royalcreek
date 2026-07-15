// Royal Creek Caddy — อ่านใบจองด้วย AI (ฝั่งเซิร์ฟเวอร์ ซ่อน API key)
// ต้องตั้ง Environment variable: ANTHROPIC_API_KEY ใน Netlify ก่อนใช้งาน

const PROMPT = `คุณคือระบบอ่านรายงาน "Booking T-Time" ของสนามกอล์ฟ Royal Creek จากรูปถ่าย (อาจมีหลายหน้า เรียงตามลำดับ)

โครงสร้างรายงาน:
- ตารางหลัก: แถวละ 1 ก๊วน มีเวลา, ชื่อลูกค้า, ตัวเลข 3 ช่อง = นักกอล์ฟ/แคดดี้/รถ, ช่อง Remark มีเลขเบอร์แคดดี้คั่นจุลภาค (เช่น 34,22)
- ท้ายรายงาน (หน้าสุดท้าย): ลิสต์บรรทัดละรายการ "HH:MM NNN (ชื่อเล่น)ชื่อจริง" เช่น "08:30 043 (ปอ)มลัย" — แหล่งข้อมูลหลักที่แม่นที่สุด
- แถวรวมท้ายตาราง: รวมนักกอล์ฟ/แคดดี้/รถทั้งวัน
- หัวรายงานมีวันที่ เช่น Wednesday 15/07/2026

ขั้นตอน:
1. อ่านวันที่จากหัวรายงาน
2. อ่านลิสต์ท้ายรายงานครบทุกบรรทัด
3. อ่านตารางหลักทุกก๊วน
4. CROSS-CHECK ลิสต์ท้าย ↔ Remark เวลาเดียวกัน ไม่ตรงให้เชื่อลิสต์ท้าย + ใส่ warning
5. ตรวจยอด: จำนวนเบอร์ที่อ่านได้ = ตัวเลขรวมแคดดี้ในแถวรวม ไม่เท่าให้ใส่ warning
6. เบอร์เดียวหลายเวลาได้ (จอง 2 รอบ) ห้ามตัดทิ้ง
7. สำคัญ: แถวที่ชื่อลูกค้าเป็น "ลา" / "ลากิจ" / "ลาป่วย" / "ลาพักร้อน" ไม่ใช่การจอง แต่เป็นบันทึกว่าแคดดี้เบอร์นั้นลาหยุด ให้ใส่ "type":"leave" กับก๊วนนั้น ก๊วนปกติใส่ "type":"booking"

ตอบ JSON เท่านั้น ห้าม markdown:
{"report_date":"15/07/2026",
 "groups":[{"time":"07:00","customer":"แม่ปิ่น","type":"booking","golfers":2,"caddies_count":2,
   "caddies":[{"no":"034","nick":"อ้อน","name":"นุจรี"}]},
  {"time":"18:20","customer":"ลา","type":"leave","golfers":0,"caddies_count":3,
   "caddies":[{"no":"087","nick":"แอม","name":"วราภรณ์"}]}],
 "totals_row":{"golfers":28,"caddies":27,"carts":26},
 "caddies_read":27,
 "warnings":[]}
- เบอร์เป็น string 3 หลัก (43 → "043")
- อ่านไม่ชัดให้เดาที่ใกล้สุด + ใส่ warning บอกจุด`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key)
    return { statusCode: 500, body: JSON.stringify({ error: 'ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY ใน Netlify (Site configuration → Environment variables)' }) };

  try {
    const { images } = JSON.parse(event.body || '{}');
    if (!Array.isArray(images) || images.length === 0)
      return { statusCode: 400, body: JSON.stringify({ error: 'ไม่มีรูปส่งมา' }) };

    const content = images.slice(0, 6).map(im => ({
      type: 'image',
      source: { type: 'base64', media_type: im.mime || 'image/jpeg', data: im.b64 }
    }));
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
        max_tokens: 4000,
        messages: [{ role: 'user', content }]
      })
    });

    const j = await rs.json();
    if (!rs.ok)
      return { statusCode: rs.status, body: JSON.stringify({ error: (j.error && j.error.message) || 'Anthropic API error' }) };

    const text = (j.content || []).map(b => b.text || '').join('');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
