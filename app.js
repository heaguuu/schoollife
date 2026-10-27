/* QR 영상은 이 브라우저에서만 해석합니다. 서버에는 QR 문자열만 전달합니다. */
const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('canvas');
const context = canvas.getContext('2d', { willReadFrequently: true });
let stream = null;
let frame = 0;
let cameraVersion = 0;
let busy = false;
let scan = null;
let pending = null;
let lastFrameAt = 0;

function message(text = '') { $('message').textContent = text; }
function panel(name) {
  ['scan', 'student', 'done'].forEach((value, i) => {
    $(`${value}-panel`).hidden = value !== name;
    $(`step${i + 1}`).classList.toggle('active', value === name);
  });
}
function stopCamera() {
  cameraVersion++;
  cancelAnimationFrame(frame);
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  $('start').hidden = false;
  $('start').disabled = false;
  $('stop').hidden = true;
  $('camera-hint').textContent = '카메라를 켜면 스캔이 시작됩니다';
}
async function api(action, payload) {
  const response = await fetch('/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }), signal: AbortSignal.timeout(30000)
  });
  const result = await response.json();
  if (!result.ok) {
    const error = new Error(result.error || '요청을 처리하지 못했습니다.');
    error.retryable = Boolean(result.retryable);
    throw error;
  }
  return result.data;
}
async function lookup(qr) {
  if (busy) return;
  busy = true;
  stopCamera();
  message('테스트 학생을 확인하고 있습니다…');
  try {
    scan = await api('lookup', { qr });
    pending = null;
    $('student-name').textContent = scan.student.name;
    $('student-detail').textContent = `${scan.student.grade}학년 ${scan.student.classNo}반 ${scan.student.number}번 · ${scan.student.id}`;
    $('criteria').replaceChildren();
    for (const item of scan.criteria) {
      const label = document.createElement('label');
      label.className = 'criterion';
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'criterion'; input.value = item.code;
      input.addEventListener('change', () => { pending = null; $('submit').disabled = false; });
      const reason = document.createElement('span');
      reason.textContent = item.reason;
      const score = document.createElement('b');
      score.textContent = `${item.score}점`;
      label.append(input, reason, score);
      $('criteria').append(label);
    }
    $('limits').textContent = `이번 테스트 남은 등록: 전체 ${scan.remaining.total}건 / 이 학생 ${scan.remaining.student}건. QR 확인은 5분간 유효합니다.`;
    $('submit').disabled = true;
    panel('student');
    message();
  } catch (error) {
    scan = null;
    message(error.message || '학생 조회에 실패했습니다. 카메라를 켜고 다시 스캔해 주세요.');
  } finally { busy = false; }
}
function decode(time) {
  if (!stream) return;
  if (video.readyState >= 2 && time - lastFrameAt > 150) {
    lastFrameAt = time;
    const scale = Math.min(1, 800 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const code = window.jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' });
    if (code) { void lookup(code.data); return; }
  }
  frame = requestAnimationFrame(decode);
}
async function startCamera() {
  if (busy || stream || $('start').disabled) return;
  message();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return message('카메라를 사용할 수 없습니다. HTTPS 주소로 접속해 주세요. PC에서는 localhost도 사용할 수 있습니다.');
  }
  if (!window.jsQR) return message('QR 해석 파일을 불러오지 못했습니다. 인터넷 연결과 CDN 차단 여부를 확인해 주세요.');
  const version = ++cameraVersion;
  $('start').disabled = true;
  $('stop').hidden = false;
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    if (version !== cameraVersion) { acquired.getTracks().forEach((track) => track.stop()); return; }
    stream = acquired;
    video.srcObject = stream;
    await video.play();
    if (version !== cameraVersion) return;
    $('start').hidden = true;
    $('stop').hidden = false;
    $('camera-hint').textContent = 'QR 코드를 중앙에 맞춰 주세요';
    frame = requestAnimationFrame(decode);
  } catch (error) {
    if (version !== cameraVersion) return;
    stopCamera();
    message(error.name === 'NotAllowedError' ? '카메라 접근을 허용한 뒤 다시 켜 주세요.' : '카메라를 열 수 없습니다. 다른 앱의 카메라 사용을 종료하고 다시 시도해 주세요.');
  }
}
async function submit() {
  if (busy || !scan) return;
  const code = document.querySelector('input[name="criterion"]:checked')?.value;
  if (!code) return;
  pending ??= { scanToken: scan.scanToken, code, requestId: crypto.randomUUID() };
  busy = true;
  $('submit').disabled = true;
  $('rescan').disabled = true;
  document.querySelectorAll('input[name="criterion"]').forEach((input) => { input.disabled = true; });
  message('승인 요청을 저장하고 있습니다…');
  try {
    const result = await api('submit', pending);
    $('receipt').textContent = `${result.requestId} · ${result.status}`;
    panel('done');
    scan = null; pending = null; message();
  } catch (error) {
    // 응답 유실 시 항목 변경/다른 QR로 이동하면 중복 등록할 수 있으므로 재시도만 허용합니다.
    message(`${error.message || '연결이 끊겼습니다.'}\n응답이 불확실하면 같은 요청으로 다시 시도해 주세요. 같은 요청ID는 한 번만 저장됩니다.`);
    $('submit').textContent = '같은 요청으로 다시 확인';
    if (error.retryable === false) {
      pending = null;
      $('rescan').disabled = false;
      document.querySelectorAll('input[name="criterion"]').forEach((input) => { input.disabled = false; });
    }
  } finally { busy = false; $('submit').disabled = false; }
}
function reset() {
  if (busy) return;
  scan = null; pending = null;
  $('submit').textContent = '승인대기로 저장';
  $('rescan').disabled = false;
  panel('scan'); message();
  void startCamera();
}
$('start').addEventListener('click', startCamera);
$('stop').addEventListener('click', stopCamera);
$('submit').addEventListener('click', submit);
$('rescan').addEventListener('click', reset);
$('again').addEventListener('click', reset);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
window.addEventListener('pagehide', stopCamera);
