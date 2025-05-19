// 환경변수로부터 키 파일 쓰기
if (process.env.GOOGLE_CREDENTIALS_JSON) {
  const fs = require('fs');
  fs.writeFileSync('google-credentials.json', process.env.GOOGLE_CREDENTIALS_JSON);
}

// 기본 모듈 로딩
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

// 구글 드라이브 연동 모듈 (키 파일이 생성된 뒤에 require)
const { downloadLog, uploadLog } = require('./googleDrive');
const TMP_LOG = path.join(__dirname, 'temp-log.xlsx');

// 데이터 경로 설정
const DATA_DIR     = path.join(__dirname, 'data');
const USERS_FILE   = path.join(DATA_DIR, 'users.xlsx');
const LAYOUT_FILE  = path.join(DATA_DIR, 'layout.xlsx');
const TIME_FILE    = path.join(DATA_DIR, 'time.xlsx');
const CONFIG_FILE  = path.join(DATA_DIR, 'config.json');
const DB_FILE      = path.join(DATA_DIR, 'reservation.db');

// SQLite 초기화
const db    = new sqlite3.Database(DB_FILE);
const dbAll = promisify(db.all.bind(db));
const dbRun = promisify(db.run.bind(db));

app.use(bodyParser.json());
app.use(express.static('public'));

// ----------------------------------------
// 유틸 함수들
// ----------------------------------------
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
function timeStringToSec(str) {
  const [h, m] = str.split(':').map(Number);
  return h * 3600 + m * 60;
}
function getTodaySchedule() {
  const days = ['일요일','월요일','화요일','수요일','목요일','금요일','토요일'];
  const wb    = xlsx.readFile(TIME_FILE);
  const sheet = wb.Sheets[days[new Date().getDay()]];
  return sheet ? xlsx.utils.sheet_to_json(sheet) : [];
}
function getCurrentPeriod() {
  const now    = new Date();
  const nowSec = now.getHours()*3600 + now.getMinutes()*60 + now.getSeconds();
  for (const row of getTodaySchedule()) {
    if (!row['시작시간'] || !row['종료시간']) continue;
    const startSec = timeStringToSec(row['시작시간']) - 600;
    const endSec   = timeStringToSec(row['종료시간']) - 1;
    if (nowSec >= startSec && nowSec <= endSec) {
      return { 교시: row['교시'], 시작시간: row['시작시간'], 종료시간: row['종료시간'] };
    }
  }
  return null;
}
function isReservationAllowed() {
  try {
    const cfg      = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    if (cfg.allowAnytimeReservation) return true;

    const nowSec   = new Date().getHours()*3600 + new Date().getMinutes()*60 + new Date().getSeconds();
    const schedule = getTodaySchedule();

    for (let i = 0; i < schedule.length; i++) {
      const row = schedule[i];
      if (!row['시작시간'] || !row['종료시간']) continue;

      const startSec   = timeStringToSec(row['시작시간']);
      const endSec     = timeStringToSec(row['종료시간']);
      const allowStart = startSec - 600;

      if (nowSec >= allowStart && nowSec <= endSec - 1) {
        return true;
      }
      const nextRow = schedule[i + 1];
      if (nextRow) {
        const nextStartSec = timeStringToSec(nextRow['시작시간']);
        if (nowSec >= endSec && nowSec < nextStartSec - 600) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return true;
  }
}

// ----------------------------------------
// 로그 기록 및 초기화
// ----------------------------------------
async function clearAndLog(oldPeriod) {
  const rows = await dbAll('SELECT id, class, seat FROM reservations');
  console.log('[clearAndLog] 예약 수:', rows.length);
  if (!rows.length) {
    console.log('[clearAndLog] 삭제할 예약 없음');
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  let uploadSucceeded = false;

  try {
    console.log('[clearAndLog] 다운로드 시작');
    await downloadLog(TMP_LOG);
    console.log('[clearAndLog] 다운로드 완료');

    console.log('[clearAndLog] 로그 합치기');
    const logData = loadXlsx(TMP_LOG);
    const entries = rows.map(r => ({
      id:     r.id,
      date:   today,
      period: oldPeriod || '',
      class:  r.class,
      seat:   r.seat
    }));
    saveXlsx(TMP_LOG, logData.concat(entries));
    console.log('[clearAndLog] 로컬 저장 완료');

    console.log('[clearAndLog] 업로드 시작');
    await uploadLog(TMP_LOG);
    uploadSucceeded = true;
    console.log('[clearAndLog] 업로드 완료');
  } catch (err) {
    console.error('[clearAndLog] 오류 발생:', err);
  } finally {
    console.log('[clearAndLog] 예약 삭제 시작');
    await dbRun('DELETE FROM reservations');
    console.log(`[clearAndLog] 예약 삭제 완료 (업로드 성공: ${uploadSucceeded})`);
  }
}

// ----------------------------------------
// JWT 인증
// ----------------------------------------
function verifyToken(req) {
  let token;
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) token = auth.split(' ')[1];
  else if (req.query.token) token = req.query.token;
  if (!token) return null;
  try { return jwt.verify(token, SECRET); }
  catch { return null; }
}
function requireToken(req, res, next) {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ success:false, message:'인증 실패' });
  req.user = user;
  next();
}

// ----------------------------------------
// SSE (실시간 업데이트)
// ----------------------------------------
const sseClients = [];
async function sendUpdate(client) {
  const {res, className, userId} = client;
  const wb    = xlsx.readFile(LAYOUT_FILE);
  const sheet = wb.Sheets[className];
  const layout = sheet ? xlsx.utils.sheet_to_json(sheet, {header:1}) : [];
  const classRows = await dbAll('SELECT id, seat FROM reservations WHERE class = ?', [className]);
  const seats = layout.flat().filter(Boolean).map(name => ({
    name,
    reservedBy: classRows.find(r=>r.seat===name)?.id || null
  }));
  const reservation = (await dbAll('SELECT id,class,seat FROM reservations WHERE id=?',[userId]))[0]||null;
  const period = getCurrentPeriod();
  res.write(`data: ${JSON.stringify({layout,seats,reservation,period})}\n\n`);
}
async function broadcastUpdate() {
  for (const c of sseClients) {
    try { await sendUpdate(c); }
    catch(err) { console.error('[broadcastUpdate] 오류:', err); }
  }
}

// ----------------------------------------
// 교시 변경 감지 & 초기화
// ----------------------------------------
let lastPeriod = null;
setInterval(async () => {
  try {
    const periodObj = getCurrentPeriod();
    const current = periodObj ? periodObj.교시 : null;
    if (lastPeriod !== null && current !== lastPeriod) {
      console.log(`[교시 변경] ${lastPeriod} → ${current}`);
      await clearAndLog(lastPeriod);
    }
    lastPeriod = current;
    await broadcastUpdate();
  } catch (err) {
    console.error('[정기작업] 오류 발생:', err);
  }
}, 10000);

// ----------------------------------------
// API 라우트
// ----------------------------------------
app.get('/api/seat-updates', requireToken, (req, res) => {
  const className = req.query.class;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control':  'no-cache',
    Connection:       'keep-alive'
  });
  res.write('\n');
  const client = { res, className, userId: req.user.id };
  sseClients.push(client);
  req.on('close', () => {
    const idx = sseClients.indexOf(client);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

app.post('/api/login', (req, res) => {
  const {id, pw} = req.body;
  const users = loadXlsx(USERS_FILE);
  const u = users.find(u => String(u['학번']).trim()===id && String(u['비밀번호']).trim()===pw);
  if (!u) return res.json({success:false});
  const token = jwt.sign({id: u['학번'], name: u['이름']||''}, SECRET, {expiresIn:'1y'});
  res.json({success:true, token, user:{id:u['학번'], name:u['이름']||''}});
});

app.get('/api/check-login', requireToken, (req, res) =>
  res.json({success:true, user:req.user})
);

app.get('/api/class-list', (req, res) => {
  try {
    const wb = xlsx.readFile(LAYOUT_FILE);
    res.json({classes: wb.SheetNames});
  } catch {
    res.json({classes: []});
  }
});

app.get('/api/seats', requireToken, async (req, res) => {
  const periodObj = getCurrentPeriod();
  const className = req.query.class;
  const wb    = xlsx.readFile(LAYOUT_FILE);
  const sheet = wb.Sheets[className];
  const layout = sheet ? xlsx.utils.sheet_to_json(sheet, {header:1}) : [];
  const classRows = await dbAll('SELECT id,seat FROM reservations WHERE class=?',[className]);
  const seats = layout.flat().filter(Boolean).map(name => ({
    name,
    reservedBy: classRows.find(r=>r.seat===name)?.id || null
  }));
  const reservation = (await dbAll('SELECT id,class,seat FROM reservations WHERE id=?',[req.user.id]))[0] || null;
  res.json({layout, seats, reservation, period: periodObj});
});

app.post('/api/reserve', requireToken, async (req, res) => {
  if (!isReservationAllowed()) return res.json({success:false, message:'현재 예약 불가'});
  const {class:cls, seat} = req.body;
  const ex   = await dbAll('SELECT 1 FROM reservations WHERE class=? AND seat=?',[cls,seat]);
  const self = await dbAll('SELECT 1 FROM reservations WHERE id=?',[req.user.id]);
  if (ex.length)   return res.json({success:false,message:'이미 예약된 자리입니다.'});
  if (self.length) return res.json({success:false,message:'이미 예약한 좌석이 있습니다.'});
  await dbRun('INSERT INTO reservations(id,class,seat) VALUES(?,?,?)',[req.user.id,cls,seat]);
  await broadcastUpdate();
  res.json({success:true});
});

app.post('/api/cancel', requireToken, async (req, res) => {
  const rows = await dbAll('SELECT class FROM reservations WHERE id = ?', [req.user.id]);
  if (!rows.length) return res.json({ success: false, message: '예약 정보가 없습니다.' });

  const cls = rows[0].class;
  const nowMinutes = new Date().getHours()*60 + new Date().getMinutes();
  const period     = getCurrentPeriod();
  if (period) {
    const [sh, sm] = period.시작시간.split(':').map(Number);
    if (nowMinutes > sh*60 + sm + 20)
      return res.json({ success: false, message: '취소 제한 시간이 지났습니다.' });
  }

  await dbRun('DELETE FROM reservations WHERE id = ? AND class = ?', [req.user.id, cls]);
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`✅ 서버 실행: http://localhost:${PORT}`));
