// 교실 좌석 예약 시스템 스크립트 (JWT 기반 인증, SSE 푸시 지원)

const UI = {
  login: document.getElementById('login-screen'),
  main: document.getElementById('main-ui'),
  form: document.getElementById('login-form'),
  error: document.getElementById('login-error'),
  id: document.getElementById('student-id'),
  pw: document.getElementById('password'),
  time: document.getElementById('current-time'),
  refresh: document.getElementById('refresh-button'),
  classSelect: document.getElementById('class-select'),
  seatLayout: document.getElementById('seat-layout'),
  name: document.getElementById('user-name'),
  info: document.getElementById('reservation-info'),
  cancel: document.getElementById('cancel-reservation'),
  logout: document.getElementById('logout-button'),
  popup: document.getElementById('seat-popup'),
  popupText: document.getElementById('seat-popup-info'),
  popupConfirm: document.getElementById('seat-popup-confirm'),
  popupClose: document.getElementById('seat-popup-close'),
  period: document.getElementById('current-period')
};

let currentUser = null;
let reservation = null;
let seatData = [];
let allSeats = [];
let currentPeriod = null;
let evtSource = null;

// 시계 업데이트
function updateClock() {
  const now = new Date();
  UI.time.textContent = now.toLocaleString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}
updateClock();
setInterval(updateClock, 60000);

// 토큰 관리
function getToken() {
  return localStorage.getItem('token');
}
function setToken(token) {
  localStorage.setItem('token', token);
}
function clearToken() {
  localStorage.removeItem('token');
}

// 로그인 처리
UI.form.addEventListener('submit', async e => {
  e.preventDefault();
  UI.error.textContent = '';
  const id = UI.id.value.trim();
  const pw = UI.pw.value.trim();
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, pw })
    });
    const result = await res.json();
    if (result.success) {
      setToken(result.token);
      currentUser = result.user;
      UI.name.textContent = currentUser.id;
      UI.login.style.display = 'none';
      UI.main.style.display = 'flex';
      await loadClassOptions();
      connectSSE();
    } else {
      UI.error.textContent = '학번 또는 비밀번호가 틀렸습니다.';
    }
  } catch {
    UI.error.textContent = '서버 오류가 발생했습니다.';
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('/api/check-login', {
      headers: { Authorization: 'Bearer ' + getToken() }
    });
    const data = await res.json();
    if (data.success) {
      currentUser = data.user;
      UI.name.textContent = currentUser.id;
      UI.login.style.display = 'none';
      UI.main.style.display = 'flex';
      await loadClassOptions();
      connectSSE();
    }
  } catch {
    console.warn('자동 로그인 체크 실패');
  }
});

// 반 목록 로드
async function loadClassOptions() {
  const res = await fetch('/api/class-list');
  const data = await res.json();
  UI.classSelect.innerHTML = '';
  data.classes.forEach(cls => {
    const opt = document.createElement('option');
    opt.value = cls;
    opt.textContent = cls;
    UI.classSelect.appendChild(opt);
  });
  await loadSeats();
}

// 좌석 및 예약 정보 로드
async function loadSeats() {
  const className = UI.classSelect.value;
  const res = await fetch(`/api/seats?class=${className}`, {
    headers: { Authorization: 'Bearer ' + getToken() }
  });
  const data = await res.json();
  seatData = data.layout;
  allSeats = data.seats;
  reservation = data.reservation || null;
  currentPeriod = data.period;
  updatePeriodUI();
  renderSeats();
}

// SSE 연결
function connectSSE() {
  if (evtSource) evtSource.close();
  const cls = UI.classSelect.value;
  evtSource = new EventSource(
    `/api/seat-updates?class=${encodeURIComponent(cls)}&token=${getToken()}`
  );
  evtSource.onmessage = e => {
    const data = JSON.parse(e.data);
    seatData = data.layout;
    allSeats = data.seats;
    reservation = data.reservation;
    currentPeriod = data.period;
    updatePeriodUI();
    renderSeats();
  };
  evtSource.onerror = () => console.error('SSE 연결 오류');
}

// 교시 정보 표시
function updatePeriodUI() {
  if (currentPeriod && currentPeriod.교시) {
    UI.period.textContent = `${currentPeriod.교시}교시 ` +
      `(${currentPeriod.시작시간}~${currentPeriod.종료시간})`;
  } else {
    UI.period.textContent = '현재 수업시간 아님';
  }
}

// 좌석 렌더링
function renderSeats() {
  UI.seatLayout.innerHTML = '';
  const rowCount = seatData.length;
  const colCount = Math.max(...seatData.map(row => row.length));
  UI.seatLayout.style.display = 'grid';
  UI.seatLayout.style.gridTemplateRows = `repeat(${rowCount}, 1fr)`;
  UI.seatLayout.style.gridTemplateColumns = `repeat(${colCount}, 1fr)`;
  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < colCount; c++) {
      const name = seatData[r][c];
      const div = document.createElement('div');
      div.className = 'seat';
      if (!name) { div.style.visibility = 'hidden'; UI.seatLayout.appendChild(div); continue; }
      div.textContent = name;
      const seat = allSeats.find(s => s.name === name);
      if (seat) {
        div.classList.add(
          seat.reservedBy ?
            (seat.reservedBy === currentUser.id ? 'own' : 'reserved') :
            'available'
        );
        div.onclick = () => handleSeatClick(seat);
      }
      UI.seatLayout.appendChild(div);
    }
  }
  UI.info.textContent = reservation ?
    `${reservation.class} - ${reservation.seat}` : '없음';
  UI.cancel.disabled = !reservation;
}

// 좌석 클릭 처리
function handleSeatClick(seat) {
  UI.popup.style.display = 'flex';
  if (seat.reservedBy) {
    UI.popupText.textContent = seat.reservedBy === currentUser.id
      ? '내가 예약한 좌석입니다.'
      : `이미 예약된 좌석입니다. (예약자: ${seat.reservedBy})`;
    UI.popupConfirm.style.display = 'none';
  } else if (reservation) {
    UI.popupText.textContent = '이미 예약한 좌석이 있습니다. 취소 후 다시 예약해주세요.';
    UI.popupConfirm.style.display = 'none';
  } else {
    UI.popupText.textContent = `${seat.name} 좌석을 예약하시겠습니까?`;
    UI.popupConfirm.style.display = 'inline-block';
    UI.popupConfirm.onclick = () => reserveSeat(seat);
  }
}
UI.popupClose.addEventListener('click', () => UI.popup.style.display = 'none');

// 예약 요청
async function reserveSeat(seat) {
  const res = await fetch('/api/reserve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
    body: JSON.stringify({ class: UI.classSelect.value, seat: seat.name })
  });
  const result = await res.json();
  if (result.success) { UI.popup.style.display = 'none'; loadSeats(); connectSSE(); }
  else alert(result.message || '예약 실패');
}

// 취소 요청
UI.cancel.addEventListener('click', async () => {
  const res = await fetch('/api/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
    body: JSON.stringify({ class: UI.classSelect.value })
  });
  const result = await res.json();
  if (result.success) { loadSeats(); connectSSE(); }
  else alert(result.message || '취소 실패');
});

// 클래스 변경 및 새로고침 이벤트
UI.classSelect.addEventListener('change', () => { loadSeats(); connectSSE(); });
UI.refresh.addEventListener('click', () => { loadSeats(); });
UI.logout.addEventListener('click', () => {
  clearToken();
  currentUser = null;
  UI.login.style.display = 'block';
  UI.main.style.display = 'none';
  if (evtSource) evtSource.close();
});