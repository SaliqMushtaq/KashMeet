const $ = s => document.querySelector(s);
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }]; // add a TURN server here for users behind strict NATs
let token = localStorage.getItem('km_token'), me = localStorage.getItem('km_user');
let socket, local, room, peers = {}, camTrack, screenTrack;

/* ---------- auth ---------- */
const show = id => ['auth', 'lobby', 'call'].forEach(x => $('#' + x).hidden = x !== id);
async function authenticate(kind) {
  $('#authErr').textContent = '';
  let r, d;
  try {
    r = await fetch('/api/' + kind, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#u').value.trim(), password: $('#p').value }) });
    d = await r.json();
  } catch (error) {
    $('#authErr').textContent = error instanceof TypeError
      ? 'Cannot reach the app server. Start it with `npm start` and open its URL; static hosting such as GitHub Pages cannot run login.'
      : 'The app server returned an invalid response. Check that the login API is running.';
    return;
  }
  if (!r.ok) return $('#authErr').textContent = d.error;
  token = d.token; me = d.username; localStorage.setItem('km_token', token); localStorage.setItem('km_user', me);
  $('#p').value = ''; lobby();
}
function lobby() { show('lobby'); $('#room').value = location.hash.slice(1); }
$('#login').onclick = () => authenticate('login');
$('#register').onclick = () => authenticate('register');
$('#logout').onclick = () => { localStorage.clear(); location.hash = ''; location.reload(); };
$('#join').onclick = () => {
  const r = $('#room').value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z0-9-]{3,40}$/.test(r)) return $('#lobbyErr').textContent = 'Room names use 3-40 letters, numbers or hyphens.';
  joinRoom(r);
};

/* ---------- media + peers ---------- */
function tile(id, name, stream, muted) {
  let t = document.getElementById('t-' + id);
  if (!t) { t = document.createElement('div'); t.className = 'tile'; t.id = 't-' + id;
    t.innerHTML = '<video autoplay playsinline></video><span></span>'; $('#grid').append(t); }
  const v = t.querySelector('video'); v.srcObject = stream; v.muted = !!muted; t.querySelector('span').textContent = name;
}
function makePeer(id, name) {
  const pc = new RTCPeerConnection({ iceServers: ICE }), p = peers[id] = { pc, q: Promise.resolve(), name };
  local.getTracks().forEach(t => pc.addTrack(screenTrack && t.kind === 'video' ? screenTrack : t, local));
  pc.onicecandidate = e => e.candidate && socket.emit('signal', { to: id, data: { ice: e.candidate } });
  pc.ontrack = e => tile(id, name, e.streams[0]);
  pc.onconnectionstatechange = () => ['failed', 'closed'].includes(pc.connectionState) && drop(id);
  return p;
}
function drop(id) { peers[id]?.pc.close(); delete peers[id]; document.getElementById('t-' + id)?.remove(); }
async function offer(id, name) {
  const { pc } = makePeer(id, name);
  await pc.setLocalDescription(await pc.createOffer());
  socket.emit('signal', { to: id, data: { sdp: pc.localDescription } });
}

async function joinRoom(r) {
  room = r; location.hash = r;
  try { local = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); }
  catch { try { local = await navigator.mediaDevices.getUserMedia({ audio: true }); }
          catch { return $('#lobbyErr').textContent = 'Allow camera and microphone access, then try again. (Needs HTTPS or localhost.)'; } }
  camTrack = local.getVideoTracks()[0];
  show('call'); tile('me', me + ' (you)', local, true);

  socket = io({ auth: { token } });
  socket.on('connect_error', () => { localStorage.clear(); location.reload(); });
  socket.on('connect', () => socket.emit('join', room));
  socket.on('full', () => { alert('This room is full (8 people).'); leave(); });
  socket.on('peers', list => list.forEach(p => offer(p.id, p.name)));      // newcomer calls everyone already here
  socket.on('signal', ({ from, name, data }) => {
    const p = peers[from] || makePeer(from, name);
    p.q = p.q.then(async () => {                                            // process in order per peer
      if (data.sdp) {
        await p.pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          await p.pc.setLocalDescription(await p.pc.createAnswer());
          socket.emit('signal', { to: from, data: { sdp: p.pc.localDescription } });
        }
      } else if (data.ice) await p.pc.addIceCandidate(data.ice).catch(() => {});
    });
  });
  socket.on('peer-left', drop);
  socket.on('wb:history', segs => { ctx.clearRect(0, 0, cv.width, cv.height); segs.forEach(draw); });
  socket.on('wb:seg', draw);
  socket.on('wb:clear', () => ctx.clearRect(0, 0, cv.width, cv.height));
  socket.on('files', list => { $('#fileList').innerHTML = ''; list.forEach(addFile); });
  socket.on('file', addFile);
}
function leave() { socket?.disconnect(); local?.getTracks().forEach(t => t.stop()); screenTrack?.stop(); location.reload(); }

/* ---------- controls ---------- */
function toggle(btn, kind, on, off) {
  const t = local.getTracks().find(x => x.kind === kind); if (!t) return;
  t.enabled = !t.enabled; btn.textContent = t.enabled ? on : off; btn.setAttribute('aria-pressed', !t.enabled);
}
$('#mic').onclick = e => toggle(e.target, 'audio', 'Mute', 'Unmute');
$('#cam').onclick = e => toggle(e.target, 'video', 'Camera off', 'Camera on');
function swapVideo(track) {
  Object.values(peers).forEach(p => p.pc.getSenders().find(s => s.track?.kind === 'video')?.replaceTrack(track));
  tile('me', me + ' (you)', new MediaStream([track, ...local.getAudioTracks()]), true);
}
$('#share').onclick = async e => {
  if (screenTrack) return stopShare();
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
    screenTrack = s.getVideoTracks()[0]; screenTrack.onended = stopShare;
    swapVideo(screenTrack); e.target.textContent = 'Stop sharing'; e.target.setAttribute('aria-pressed', true);
  } catch {}
};
function stopShare() {
  screenTrack?.stop(); screenTrack = null; if (camTrack) swapVideo(camTrack);
  $('#share').textContent = 'Share screen'; $('#share').setAttribute('aria-pressed', false);
}
$('#copy').onclick = () => navigator.clipboard.writeText(location.href).then(() => $('#copy').textContent = 'Link copied');
$('#leave').onclick = leave;

/* ---------- tabs ---------- */
function tab(b) {
  $('#paneBoard').hidden = !b; $('#paneFiles').hidden = b;
  $('#tabBoard').setAttribute('aria-selected', b); $('#tabFiles').setAttribute('aria-selected', !b);
}
$('#tabBoard').onclick = () => tab(true); $('#tabFiles').onclick = () => tab(false);

/* ---------- whiteboard (segments are synced live; coordinates are canvas pixels) ---------- */
const cv = $('#board'), ctx = cv.getContext('2d'); let last = null, erasing = false;
ctx.lineCap = 'round';
function draw(s) { ctx.strokeStyle = s.c; ctx.lineWidth = s.w; ctx.beginPath(); ctx.moveTo(...s.a); ctx.lineTo(...s.b); ctx.stroke(); }
const pos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
cv.onpointerdown = e => { cv.setPointerCapture(e.pointerId); last = pos(e); };
cv.onpointermove = e => {
  if (!last) return; const p = pos(e);
  const seg = { a: last, b: p, c: erasing ? '#ffffff' : $('#color').value, w: erasing ? $('#size').value * 4 : +$('#size').value };
  draw(seg); socket.emit('wb:seg', seg); last = p;
};
cv.onpointerup = cv.onpointercancel = () => last = null;
$('#eraser').onclick = e => { erasing = !erasing; e.target.setAttribute('aria-pressed', erasing); };
$('#clear').onclick = () => confirm('Clear the board for everyone?') && socket.emit('wb:clear');

/* ---------- files (uploaded over TLS, downloaded only with a valid sign-in) ---------- */
function addFile(f) {
  const li = document.createElement('li'), b = document.createElement('button');
  b.textContent = `${f.name} (${(f.size / 1024).toFixed(0)} KB) from ${f.uploader}`;
  b.onclick = async () => {
    const r = await fetch('/api/files/' + f.id, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) return $('#fileErr').textContent = 'Could not download that file.';
    const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = f.name; a.click();
  };
  li.append(b); $('#fileList').append(li);
}
$('#file').onchange = async e => {
  const file = e.target.files[0]; if (!file) return;
  const fd = new FormData(); fd.append('file', file); $('#fileErr').textContent = '';
  const r = await fetch('/api/upload/' + room, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  if (!r.ok) $('#fileErr').textContent = (await r.json()).error; e.target.value = '';
};

token && me ? lobby() : show('auth');
