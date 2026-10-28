# Gateway สำหรับ Raspberry Pi — ดึงข้อมูล i-ALERT3 ตลอด 24 ชม.

Gateway คือโปรแกรมที่รันบน Raspberry Pi ซึ่งวางไว้ใกล้เครื่องจักร
- ใช้ **Bluetooth** ของ Pi คุยกับเซนเซอร์ โดยดึง trend ทุก 60 นาที (ตั้งได้)
- ใช้ **WiFi หรือสาย LAN** เปิดหน้าแดชบอร์ดให้ทุกเครื่องในวงเดียวกัน และส่งข้อความเตือนไป **Telegram** หรือ **LINE**

> **ความปลอดภัยของเซนเซอร์:** Gateway อ่านอย่างเดียว คำสั่งที่ส่งไปมีแค่ "ขอดาวน์โหลดข้อมูล" แบบเดียวกับหน้าเว็บและแอป i-ALERT ไม่มีการเขียนค่าตั้งค่าหรือสั่งวัด FFT

## สิ่งที่ต้องมี
- Raspberry Pi 4 หรือ 5 (มี Bluetooth และ WiFi ในตัว) พร้อม Raspberry Pi OS (64-bit)
- วาง Pi ห่างจากเซนเซอร์ไม่เกิน ~10–30 เมตร ยิ่งมีผนังกั้นน้อยยิ่งดี
- ระหว่างที่ Gateway เชื่อมต่อเซนเซอร์อยู่ (ประมาณ 5–30 วินาทีต่อรอบ) แอป i-ALERT และหน้าเว็บจะเชื่อมต่อตัวนั้นไม่ได้ชั่วคราว

## ติดตั้ง (พิมพ์ใน Terminal ของ Pi)

```bash
sudo apt update && sudo apt install -y git nodejs npm bluetooth bluez libbluetooth-dev libudev-dev build-essential
```

```bash
cd ~ && git clone https://github.com/mechanicalwsb-ui/vibration-monitor.git && cd vibration-monitor/gateway && npm install
```

ให้ Node ใช้ Bluetooth ได้โดยไม่ต้องเป็น root:

```bash
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

## ตั้งค่า

```bash
cp config.example.json config.json && nano config.json
```

| ค่า | ความหมาย |
|---|---|
| `sensors` | รายการเซนเซอร์: `mac` = ที่อยู่ Bluetooth (ตัวอย่าง `30:5A:85:4C:07:AC`), `asset` = **ชื่อเครื่องให้ตรงกับในหน้าเว็บ** (ข้อมูลจะได้รวมกัน), `scale` = 816 (รุ่นมาตรฐาน) หรือ 1289 (Digital Accelerometer) |

> **ห้ามใส่เซนเซอร์พกพา (วัดรายจุด) ในรายการนี้** Gateway ดึงข้อมูลย้อนหลังทั้งหมดในเซนเซอร์ ซึ่งของเซนเซอร์พกพาปนหลายจุดที่ถือไปวัด ใส่เฉพาะเซนเซอร์ที่ติดตั้งถาวร
| `intervalMin` | ดึงทุกกี่นาที (แนะนำ 60 เพื่อถนอมแบตเซนเซอร์ · ต่ำสุด 15) |
| `pollToken` | รหัสสำหรับสั่งอ่านทันที `POST /api/poll?token=...` (เว้นว่าง = ไม่ต้องใช้รหัส) · สั่งซ้ำได้ทุก 10 นาทีขึ้นไป |
| `port` | พอร์ตเว็บ (ค่าเริ่มต้น 8080) |
| `alertGapH` | ไม่แจ้งเรื่องเดิมซ้ำภายในกี่ชั่วโมง |
| `dailyAt` | เวลาส่งสรุปประจำวัน เช่น `"08:00"` |
| `telegram` | `token` จาก @BotFather และ `chatId` ของคุณ (ดูวิธีด้านล่าง) |
| `line` | `channelToken` (Channel access token ของ LINE Official Account / Messaging API) และ `to` (User ID หรือ Group ID) |

### ตั้ง Telegram (ฟรี ง่ายสุด)
1. ใน Telegram ค้นหา **@BotFather** → พิมพ์ `/newbot` → ตั้งชื่อ → จะได้ **token**
2. ทักบอทที่สร้าง 1 ข้อความ จากนั้นเปิด `https://api.telegram.org/bot<token>/getUpdates` ในเบราว์เซอร์ แล้วดูตัวเลข `"chat":{"id":...}` = **chatId**

### ตั้ง LINE
LINE Notify ปิดบริการแล้ว (31 มี.ค. 2568) ต้องใช้ **LINE Official Account + Messaging API**: สร้าง channel ที่ LINE Developers Console → ออก Channel access token → เพิ่มบอทเป็นเพื่อน แล้วใช้ User ID ของคุณ (อยู่ในหน้า Basic settings) เป็น `to`
หมายเหตุ: บัญชีฟรีมีโควตาข้อความต่อเดือนจำกัด

## ทดลองรัน

```bash
node ia3-gateway.js config.json
```

ถ้าเห็น `i-ALERT3: เพิ่ม N ค่า` แสดงว่าใช้ได้ กด Ctrl+C เพื่อหยุด

ทดลองบนคอมเครื่องไหนก็ได้ (ไม่ต้องมีเซนเซอร์):

```bash
node ia3-gateway.js --mock
```

## ให้รันเองทุกครั้งที่เปิด Pi

```bash
sudo cp ia3-gateway.service /etc/systemd/system/ && sudo systemctl enable --now ia3-gateway
```

ดูสถานะและ log:

```bash
journalctl -u ia3-gateway -f
```

(ถ้าโฟลเดอร์ไม่ใช่ `/home/pi/vibration-monitor/gateway` หรือชื่อผู้ใช้ไม่ใช่ `pi` ให้แก้ในไฟล์ `ia3-gateway.service` ก่อน)

## เปิดดูข้อมูล
- เปิด `http://<IP ของ Pi>:8080/` จากแท็บเล็ตหรือคอมในวง WiFi เดียวกัน (ดู IP ด้วยคำสั่ง `hostname -I`)
- หน้าเว็บจะดึงข้อมูลจาก Gateway มารวมให้อัตโนมัติ
- หน้าเว็บที่เปิดจาก Gateway เป็น http จึง**ใช้ Bluetooth จากเบราว์เซอร์ไม่ได้** ถ้าจะเชื่อมเซนเซอร์เองหรือสั่งวัด FFT ให้ใช้หน้า GitHub Pages ตามปกติ แล้วใช้ "สำรอง/กู้คืนข้อมูล" รวมข้อมูลสองฝั่ง
- ข้อมูลบน Pi อยู่ที่ `gateway/data/state.json` และดึงเป็นไฟล์สำรองได้ที่ `http://<IP>:8080/api/backup`

## อัปเดตโปรแกรม

```bash
cd ~/vibration-monitor && git pull && sudo systemctl restart ia3-gateway
```
