/* GitHub Pages 전용. QR 영상은 브라우저에서 해석하고 GAS에는 문자열만 보냅니다. */
// 같은 GAS 배포를 새 버전으로 갱신하면 이 URL은 그대로 사용합니다.
const GAS_URL = 'https://script.google.com/macros/library/d/12-ybkCW4hs_qlp6oxP3kwQ7eDkgc18UAOF0_imQhsPjUVR_zexjQj-5M/5';
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
let barcodeDetector = null;

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
async function prepareDecoder() {
  barcodeDetector = null;
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
    } catch { /* 지원하지 않는 환경에서는 jsQR로 처리합니다. */ }
  }
  if (!barcodeDetector && typeof window.jsQR !== 'function') {
    throw new Error('QR 인식 파일을 불러오지 못했습니다. 인터넷 연결을 확인하고 페이지를 다시 열어 주세요.');
  }
}
async function decodeVideo() {
  if (barcodeDetector) {
    try {
      const codes = await barcodeDetector.detect(video);
      if (codes[0]?.rawValue) return codes[0].rawValue;
    } catch {
      barcodeDetector = null;
      if (typeof window.jsQR !== 'function') throw new Error('기기 QR 인식기를 사용할 수 없고 대체 인식 파일도 없습니다. 페이지를 다시 열어 주세요.');
    }
  }
  if (typeof window.jsQR !== 'function') return null;
  // 기존에 인식되던 버전과 같은 최대 1200px 해상도를 사용합니다.
  const scale = Math.min(1, 1200 / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  return window.jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })?.data || null;
}
async function api(action, payload) {
  if (location.protocol !== 'https:' || window.top !== window.self) {
    throw new Error('GitHub Pages의 HTTPS 주소를 브라우저에서 직접 열어 주세요.');
  }
  // HTML 폼 제출은 CORS fetch가 아닙니다. GAS의 응답 페이지가 postMessage로
  // 처리 결과를 반환합니다. HTML을 JSON으로 읽거나 no-cors로 성공을 추측하지 않습니다.
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomUUID();
    const frame = document.createElement('iframe');
    frame.name = 'gas_' + nonce.replaceAll('-', '');
    frame.hidden = true;
    frame.referrerPolicy = 'no-referrer';
    const form = document.createElement('form');
    form.method = 'POST'; form.action = GAS_URL; form.target = frame.name; form.hidden = true;
    const field = document.createElement('input');
    field.type = 'hidden'; field.name = 'packet';
    field.value = JSON.stringify({ action, payload, nonce, replyOrigin: location.origin });
    form.append(field);
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      form.remove(); frame.remove();
    };
    const onMessage = (event) => {
      // GAS는 내부 iframe에서 응답하므로 source가 바깥 iframe과 다릅니다.
      // Google 응답 출처·요청별 난수·고정 프로토콜을 모두 확인합니다.
      let host;
      try { const url = new URL(event.origin); if (url.protocol !== 'https:') return; host = url.hostname; } catch { return; }
      if (host !== 'script.google.com' && host !== 'script.googleusercontent.com' && !host.endsWith('-script.googleusercontent.com')) return;
      const packet = event.data;
      if (!packet || packet.channel !== 'qr-test-v1' || packet.nonce !== nonce || typeof packet.ok !== 'boolean') return;
      cleanup();
      if (packet.ok) resolve(packet.data);
      else {
        const error = new Error(packet.error || 'GAS에서 요청을 처리하지 못했습니다.');
        error.retryable = Boolean(packet.retryable);
        reject(error);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      const error = new Error('GAS 응답이 없습니다. 새 버전 웹 앱 배포, 모든 사용자 접근 권한, Code.gs의 PAGES_ORIGIN 설정을 확인해 주세요.');
      error.retryable = true;
      reject(error);
    }, 45000);
    window.addEventListener('message', onMessage);
    document.body.append(frame, form);
    form.submit();
  });
}
async function lookup(qr) {
  if (busy) return;
  busy = true;
  stopCamera();
  $('camera-hint').textContent = 'QR 인식 완료 · 학생 조회 중';
  $('start').disabled = true;
  $('start').textContent = 'QR 인식 완료 · 학생 조회 중…';
  message('QR 인식 성공! 테스트 학생을 확인하고 있습니다…');
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
    message('QR은 인식했습니다.\n' + (error.message || '학생 조회에 실패했습니다. 카메라를 켜고 다시 스캔해 주세요.'));
  } finally {
    busy = false;
    $('start').disabled = false;
    $('start').textContent = 'QR 다시 스캔';
  }
}
async function decode(time, version) {
  if (!stream || version !== cameraVersion) return;
  if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && time - lastFrameAt > 220) {
    lastFrameAt = time;
    try {
      const value = await decodeVideo();
      if (!stream || version !== cameraVersion) return;
      if (value) { void lookup(value); return; }
    } catch (error) {
      if (version !== cameraVersion) return;
      stopCamera();
      message(error.message || 'QR 영상을 처리하지 못했습니다. 카메라를 다시 켜 주세요.');
      return;
    }
  }
  if (stream && version === cameraVersion) frame = requestAnimationFrame((next) => { void decode(next, version); });
}
async function startCamera() {
  if (busy || stream || $('start').disabled) return;
  message();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return message('카메라를 사용할 수 없습니다. HTTPS 주소로 접속해 주세요. PC에서는 localhost도 사용할 수 있습니다.');
  }
  const version = ++cameraVersion;
  $('start').disabled = true;
  $('stop').hidden = false;
  try {
    await prepareDecoder();
    if (version !== cameraVersion) return;
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
    message('카메라 연결 완료 · QR을 찾고 있어요. QR 전체가 보이도록 맞춰 주세요.');
    lastFrameAt = 0;
    frame = requestAnimationFrame((time) => { void decode(time, version); });
  } catch (error) {
    if (version !== cameraVersion) return;
    stopCamera();
    message(error.name === 'NotAllowedError' ? '카메라 접근을 허용한 뒤 다시 켜 주세요.' : error.message || '카메라를 열 수 없습니다. 다른 앱의 카메라 사용을 종료하고 다시 시도해 주세요.');
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
