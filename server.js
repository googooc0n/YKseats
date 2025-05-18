const express = require('express');
const bodyParser = require('body-parser');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = 'jwt-secret-key';

// 데이터 디렉토리 및 파일 경로
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.xlsx');
const LAYOUT_FILE = path.join(DATA_DIR, 'layout.xlsx');
const TIME_FILE = path.join(DATA_DIR, 'time.xlsx');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOG_FILE = path.join(DATA_DIR, 'log.xlsx');
const DB_FILE = path.join(DATA_DIR, 'reservation.db');

// SQLite 연결 및 프라미스화
const db = new sqlite3.Database(DB_FILE);
const dbAll = promisify(db.all.bind(db));
const dbRun = promisify(db.run.bind(db));

app.use(bodyParser.json());
app.use(express.static('public'));

// SSE 클라이언트 목록
const sseClients = [];

// 엑셀 유틸
function loadXlsx(file) {
  if (!fs.existsSync(file)) return [];
  const wb = xlsx.readFile(file);
  return xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
}
function saveXlsx(file, data) {
  const ws = xlsx.utils.json_to_sheet(data);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
  xlsx.writeFile(wb, file);
}
// 시간 변환
function timeStringToSec(str) {
  const [h, m] = str.split(':').map(Number);
  return h * 3600 + m * 60;
}
// 오늘 요일 시트
function getTodaySchedule() {
  const days = ['일요일','월요일','화요일','수요일','목요일','금요일','토요일'];
  const wb = xlsx.readFile(TIME_FILE);
  const sheet = wb.Sheets[days[new Date().getDay()]];
  return sheet ? xlsx.utils.sheet_to_json(sheet) : [];
}
// 현재 교시 (종료시간 비교용: -1초)
function getCurrentPeriod() {
  const now = new Date();
  const nowSec = now.getHours()*3600 + now.getMinutes()*60 + now.getSeconds();
  for (const row of getTodaySchedule()) {
    if (!row['시작시간'] || !row['종료시간']) continue;
    const startSec = timeStringToSec(row['시작시간']) - 600;
    const endSec = timeStringToSec(row['종료시간']) - 1;
    if (nowSec >= startSec && nowSec <= endSec) {
      return { 교시: row['교시'], 시작시간: row['시작시간'], 종료시간: row['종료시간'] };
    }
  }
  return null;
}
// 예약 가능 검사
function isReservationAllowed() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    if (cfg.allowAnytimeReservation) return true;
    return !!getCurrentPeriod();
  } catch {
    return true;
  }
}

// 로그 기록 및 DB 초기화: 인자로 넘긴 oldPeriod 사용
async function clearAndLog(oldPeriod) {
  const rows = await dbAll('SELECT id, class, seat FROM reservations');
  if (!rows.length) return;
  const today = new Date().toISOString().split('T')[0];
  const logData = loadXlsx(LOG_FILE);
  const entries = rows.map(r => ({
    id: r.id,
    date: today,
    period: oldPeriod || '',
    class: r.class,
    seat: r.seat
  }));
  saveXlsx(LOG_FILE, logData.concat(entries));
  await dbRun('DELETE FROM reservations');
}

// JWT 검증
function verifyToken(req) {
  let token = null;
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) token = auth.split(' ')[1];
  else if (req.query.token) token = req.query.token;
  if (!token) return null;
  try { return jwt.verify(token, SECRET); } catch { return null; }
}
function requireToken(req, res, next) {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ success:false, message:'인증 실패' });
  req.user = user;
  next();
}

// SSE 전송
async function sendUpdate(client) {
  const {res, className, userId} = client;
  const wb = xlsx.readFile(LAYOUT_FILE);
  const sheet = wb.Sheets[className];
  const layout = sheet ? xlsx.utils.sheet_to_json(sheet, {header:1}) : [];
  const classRows = await dbAll('SELECT id, seat FROM reservations WHERE class = ?', [className]);
  const seats = layout.flat().filter(Boolean).map(name => ({
    name,
    reservedBy: (classRows.find(r=>r.seat===name)?.id) || null
  }));
  const reservation = (await dbAll('SELECT id,class,seat FROM reservations WHERE id=?',[userId]))[0]||null;
  const period = getCurrentPeriod();
  res.write(`data: ${JSON.stringify({layout,seats,reservation,period})}\n\n`);
}
async function broadcastUpdate() {
  for (const c of sseClients) await sendUpdate(c);
}

// 교시 변경 감지용
let lastPeriod = null;

// 10초마다 교시 변경 시 clearAndLog(oldPeriod) 호출 및 SSE 푸시
setInterval(async () => {
  const periodObj = getCurrentPeriod();
  const current = periodObj ? periodObj.교시 : null;
  if (lastPeriod !== null && current !== lastPeriod) {
    await clearAndLog(lastPeriod);
  }
  lastPeriod = current;
  await broadcastUpdate();
}, 10000);

// SSE endpoint
app.get('/api/seat-updates', requireToken, (req, res) => {
  const className = req.query.class;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('\n');
  const client = {res, className, userId: req.user.id};
  sseClients.push(client);
  req.on('close', () => {
    const idx = sseClients.indexOf(client);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

// 로그인
app.post('/api/login', (req, res) => {
  const {id, pw} = req.body;
  const users = loadXlsx(USERS_FILE);
  const u = users.find(u => String(u['학번']).trim()===id && String(u['비밀번호']).trim()===pw);
  if (!u) return res.json({success:false});
  const token = jwt.sign({id: u['학번'], name: u['이름']||''}, SECRET, {expiresIn:'1y'});
  res.json({success:true, token, user:{id:u['학번'], name:u['이름']||''}});
});
// 로그인 상태
app.get('/api/check-login', requireToken, (req, res) => res.json({success:true, user:req.user}));
// 반 목록
app.get('/api/class-list', (req, res) => {
  try { const wb = xlsx.readFile(LAYOUT_FILE); res.json({classes:wb.SheetNames}); }
  catch { res.json({classes:[]}); }
});
// 동기식 좌석 조회
app.get('/api/seats', requireToken, async(req,res) => {
  const periodObj = getCurrentPeriod();
  const className = req.query.class;
  const wb = xlsx.readFile(LAYOUT_FILE);
  const sheet = wb.Sheets[className];
  const layout = sheet? xlsx.utils.sheet_to_json(sheet, {header:1}) : [];
  const classRows = await dbAll('SELECT id,seat FROM reservations WHERE class=?',[className]);
  const seats = layout.flat().filter(Boolean).map(name => ({
    name,
    reservedBy: (classRows.find(r=>r.seat===name)?.id)||null
  }));
  const reservation = (await dbAll('SELECT id,class,seat FROM reservations WHERE id=?',[req.user.id]))[0]||null;
  res.json({layout, seats, reservation, period: periodObj});
});
// 예약
app.post('/api/reserve', requireToken, async(req,res) => {
  if (!isReservationAllowed()) return res.json({success:false, message:'현재 예약 불가'});
  const {class:cls, seat} = req.body;
  const ex = await dbAll('SELECT 1 FROM reservations WHERE class=? AND seat=?',[cls,seat]); if(ex.length) return res.json({success:false,message:'이미 예약된 자리입니다.'});
  const self = await dbAll('SELECT 1 FROM reservations WHERE id=?',[req.user.id]); if(self.length) return res.json({success:false,message:'이미 예약한 좌석이 있습니다.'});
  await dbRun('INSERT INTO reservations(id,class,seat) VALUES(?,?,?)',[req.user.id,cls,seat]);
  await broadcastUpdate(); res.json({success:true});
});
// 취소
app.post('/api/cancel', requireToken, async (req, res) => {
  const rows = await dbAll('SELECT class FROM reservations WHERE id = ?', [req.user.id]);
  if (!rows.length) return res.json({ success: false, message: '예약 정보가 없습니다.' });

  const cls = rows[0].class; // 실제 예약된 반
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
  const period = getCurrentPeriod();
  if (period) {
    const [sh, sm] = period.시작시간.split(':').map(Number);
    if (nowMinutes > sh * 60 + sm + 20)
      return res.json({ success: false, message: '취소 제한 시간이 지났습니다.' });
  }

  await dbRun('DELETE FROM reservations WHERE id = ? AND class = ?', [req.user.id, cls]);
  res.json({ success: true });
});


app.get('/api/download-log', (req, res) => {
  const filePath = path.join(__dirname, 'data', 'log.xlsx');
  res.download(filePath, 'log.xlsx', err => {
    if (err) {
      console.error('Log download error:', err);
      res.status(500).send('다운로드 중 오류 발생');
    }
  });
});

app.listen(PORT, () => console.log(`✅ 서버 실행: http://localhost:${PORT}`));