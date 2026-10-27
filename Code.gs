/**
 * GitHub Pages 전용 QR 테스트 API. 이 파일은 Google Apps Script에만 넣습니다.
 * 기존 Code.gs 전체를 교체하고 웹 앱의 '새 버전'을 배포하세요.
 */
const SPREADSHEET_ID = '15xI5N2V8aalI4jYUIOKtSdp6ubHDdfi0RUXkwcvafuY';
// ★ 본인 GitHub Pages 주소의 출처만 입력합니다. 저장소 경로와 마지막 / 제외.
// 예: https://honggildong.github.io/school/ → https://honggildong.github.io
const PAGES_ORIGIN = 'https://YOUR-USERNAME.github.io';

const STUDENTS = '학생명부';
const CRITERIA = '점수기준';
const RECORDS = '점수 부여';
const TEST_IDS = ['TEST-001', 'TEST-002'];
const STUDENT_HEADERS = ['학생ID', '학년도', '학년', '반', '번호', '이름', 'QR식별값', '재학상태'];
const CRITERIA_HEADERS = ['항목코드', '구분', '사유', '점수', '당일중복허용', '사용여부'];
const RECORD_HEADERS = ['요청ID', '요청 유형', '학생ID', '항목코드', '점수', '요청일시', '요청자ID', '승인상태', '승인자ID', '처리일시', '비고'];
const MAX_TOTAL = 20;
const MAX_PER_STUDENT = 5;

function doGet() {
  return HtmlService.createHtmlOutput('GitHub Pages QR 테스트 연결 API입니다. 카메라는 GitHub Pages 주소에서 열어 주세요.');
}

/** 폼 POST만 처리합니다. 읽기/쓰기 모두 GET으로 실행하지 않습니다. */
function doPost(e) {
  let request;
  try {
    const raw = e && e.parameter && e.parameter.packet;
    if (typeof raw !== 'string' || raw.length > 4096) throw new Error('요청 형식이 올바르지 않습니다.');
    request = JSON.parse(raw);
    if (!request || !/^[a-f0-9-]{36}$/.test(request.nonce || '')) throw new Error('요청 식별값이 올바르지 않습니다.');
    if (PAGES_ORIGIN.indexOf('YOUR-USERNAME') !== -1 || request.replyOrigin !== PAGES_ORIGIN || !/^https:\/\/[^/]+$/.test(PAGES_ORIGIN)) {
      throw new Error('Code.gs의 PAGES_ORIGIN을 본인 GitHub Pages 출처로 설정해 주세요.');
    }
    if (['lookup', 'submit'].indexOf(request.action) === -1) throw new Error('허용하지 않는 작업입니다.');
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const config = config_();
      throttle_();
      const data = request.action === 'lookup' ? lookup_(request.payload, config) : submit_(request.payload, config);
      return reply_(request, { ok: true, data: data });
    } finally { lock.releaseLock(); }
  } catch (error) {
    // 저장 직후 응답 생성에 실패했을 수도 있으므로 내부 오류는 같은 ID 재시도만 허용합니다.
    const known = error && /^(테스트|QR|등록|학생|벌점|동일|사용|요청|허용|점수|시트|Code.gs)/.test(error.message || '');
    console.error(known ? error.message : 'QR API 내부 처리 오류');
    return reply_(request, {
      ok: false, retryable: !known,
      error: known ? error.message : 'GAS 처리 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.'
    });
  }
}

/** HtmlService 내부 iframe → GitHub 최상위 창으로 응답. 값은 스크립트 안전 JSON으로 넣습니다. */
function reply_(request, result) {
  if (!request || request.replyOrigin !== PAGES_ORIGIN || !/^[a-f0-9-]{36}$/.test(request.nonce || '')) {
    return HtmlService.createHtmlOutput('허용하지 않는 요청입니다. PAGES_ORIGIN 설정을 확인하세요.');
  }
  const packet = Object.assign({ channel: 'qr-test-v1', nonce: request.nonce }, result);
  const safeJson = function (value) {
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  };
  return HtmlService.createHtmlOutput('<!doctype html><meta charset="utf-8"><script>window.top.postMessage(' + safeJson(packet) + ',' + safeJson(PAGES_ORIGIN) + ');</script>')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function sheet_(name, headers) {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name);
  if (!sheet) throw new Error('시트가 없습니다: ' + name);
  const actual = sheet.getRange(1, 1, 1, Math.max(headers.length, sheet.getLastColumn())).getDisplayValues()[0];
  if (!headers.every(function (h) { return actual.indexOf(h) !== -1; }) || new Set(actual.filter(Boolean)).size !== actual.filter(Boolean).length) throw new Error('시트 헤더를 확인하세요: ' + name);
  if (name === RECORDS && !headers.every(function (h, i) { return actual[i] === h; })) throw new Error('점수 부여 시트의 A~K 헤더 순서를 확인하세요.');
  return sheet;
}
function rows_(name, headers) {
  const values = sheet_(name, headers).getDataRange().getDisplayValues();
  const keys = values.shift();
  return values.map(function (row) {
    const item = {};
    keys.forEach(function (key, i) { if (key) item[key] = row[i] || ''; });
    return item;
  });
}
function config_() {
  const p = PropertiesService.getScriptProperties();
  const run = p.getProperty('TEST_RUN');
  const deadline = Number(p.getProperty('TEST_DEADLINE'));
  if (p.getProperty('TEST_ENABLED') !== 'true' || !run || !deadline || Date.now() >= deadline) throw new Error('테스트가 종료되어 있습니다. 소유자가 startTest_를 실행해 주세요.');
  return { run: run };
}
function throttle_() {
  // 캐시는 조기 소실될 수 있으므로 저장 한도는 아래에서 시트로 별도 검사합니다.
  const cache = CacheService.getScriptCache();
  const key = 'rate_' + Math.floor(Date.now() / 60000);
  const count = Number(cache.get(key) || 0);
  if (count >= 60) throw new Error('요청이 많습니다. 1분 후 다시 시도해 주세요.');
  cache.put(key, String(count + 1), 120);
}
function testStudents_() {
  return rows_(STUDENTS, STUDENT_HEADERS).filter(function (s) {
    return TEST_IDS.indexOf(s['학생ID']) !== -1 && /^테스트학생[12]$/.test(s['이름']) && s['재학상태'] === '재학' && s['QR식별값'] !== '';
  });
}
function criteria_() {
  return rows_(CRITERIA, CRITERIA_HEADERS).filter(function (c) {
    return c['사용여부'] === '사용' && c['구분'] === '벌점' && c['점수'].trim() !== '' && Number.isFinite(Number(c['점수'])) && Number(c['점수']) !== 0 && c['항목코드'] !== '';
  }).map(function (c) {
    return { code: c['항목코드'], reason: c['사유'], score: Number(c['점수']), duplicateRule: c['당일중복허용'] };
  });
}
function records_(run) {
  return rows_(RECORDS, RECORD_HEADERS).filter(function (r) { return r['비고'].indexOf('[TEST:' + run + ']') === 0; });
}
function capacity_(records, studentId) {
  const own = records.filter(function (r) { return r['학생ID'] === studentId; }).length;
  if (records.length >= MAX_TOTAL) throw new Error('등록 한도(전체20건)에 도달했습니다.');
  if (own >= MAX_PER_STUDENT) throw new Error('학생별 등록 한도(5건)에 도달했습니다.');
  return { total: MAX_TOTAL - records.length, student: MAX_PER_STUDENT - own };
}
function random_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }
function scanTag_(token) {
  return '[SCAN:' + Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token).map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('') + ']';
}
function lookup_(payload, config) {
  if (!payload || typeof payload.qr !== 'string' || !payload.qr || payload.qr.length > 1000) throw new Error('QR 값이 올바르지 않습니다.');
  const students = testStudents_().filter(function (s) { return s['QR식별값'] === payload.qr; });
  if (students.length !== 1) throw new Error('학생명부의 테스트 학생 QR이 아닙니다. TEST-001/002 행의 QR식별값을 확인하세요.');
  const student = students[0];
  const remaining = capacity_(records_(config.run), student['학생ID']);
  const criteria = criteria_();
  if (!criteria.length) throw new Error('사용 가능한 벌점 항목이 없습니다. 점수기준을 확인하세요.');
  const token = random_();
  CacheService.getScriptCache().put('scan_' + token, JSON.stringify({ run: config.run, studentId: student['학생ID'], qr: payload.qr }), 300);
  return {
    scanToken: token,
    student: { id: student['학생ID'], name: student['이름'], grade: student['학년'], classNo: student['반'], number: student['번호'] },
    criteria: criteria, remaining: remaining
  };
}
function submit_(payload, config) {
  if (!payload || !/^[a-f0-9]{64}$/.test(payload.scanToken || '') || !/^[a-f0-9-]{36}$/.test(payload.requestId || '') || typeof payload.code !== 'string' || payload.code.length > 100) throw new Error('요청 정보가 올바르지 않습니다.');
  const id = 'TEST-' + payload.requestId;
  const records = records_(config.run);
  const tag = scanTag_(payload.scanToken);
  const existing = records.find(function (r) { return r['요청ID'] === id; });
  if (existing) {
    if (existing['항목코드'] !== payload.code || existing['비고'].indexOf(tag) === -1) throw new Error('동일 요청의 학생이나 항목을 바꿀 수 없습니다.');
    return { requestId: id, status: existing['승인상태'] };
  }
  if (records.some(function (r) { return r['비고'].indexOf(tag) !== -1; })) throw new Error('QR 확인이 이미 사용되었습니다. 다시 스캔해 주세요.');
  const cached = CacheService.getScriptCache().get('scan_' + payload.scanToken);
  if (!cached) throw new Error('QR 확인이 만료되었습니다. 다시 스캔해 주세요.');
  const scan = JSON.parse(cached);
  if (scan.run !== config.run) throw new Error('테스트가 다시 시작되었습니다. QR을 다시 스캔해 주세요.');
  const students = testStudents_().filter(function (s) { return s['학생ID'] === scan.studentId && s['QR식별값'] === scan.qr; });
  if (students.length !== 1) throw new Error('학생명부의 테스트 학생 상태를 확인하세요.');
  capacity_(records, scan.studentId);
  const criteria = criteria_().filter(function (c) { return c.code === payload.code; });
  if (criteria.length !== 1) throw new Error('벌점 항목이 없거나 항목코드가 중복입니다.');
  const criterion = criteria[0];
  const today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  const allowsDuplicate = ['허용', 'Y', 'TRUE', '예'].indexOf(criterion.duplicateRule.toUpperCase()) !== -1;
  if (!allowsDuplicate && records.some(function (r) { return r['학생ID'] === scan.studentId && r['항목코드'] === criterion.code && r['요청일시'].slice(0, 10) === today; })) throw new Error('동일 학생의 같은 항목은 당일 중복 등록할 수 없습니다.');
  sheet_(RECORDS, RECORD_HEADERS).appendRow([
    id, '벌점', scan.studentId, cell_(criterion.code), criterion.score,
    Utilities.formatDate(new Date(), 'Asia/Seoul', "yyyy-MM-dd'T'HH:mm:ssXXX"),
    'TEST-QR', '승인대기', '', '', '[TEST:' + config.run + ']' + tag
  ]);
  SpreadsheetApp.flush();
  return { requestId: id, status: '승인대기' };
}
function cell_(value) { return /^[=+\-@]/.test(value) ? "'" + value : value; }

/** 소유자만 GAS 편집기에서 실행: 합성 학생과 테스트 벌점 준비. 기본 상태는 종료입니다. */
function setupTest_() {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    PropertiesService.getScriptProperties().setProperty('TEST_ENABLED', 'false');
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    [[STUDENTS, STUDENT_HEADERS], [CRITERIA, CRITERIA_HEADERS], [RECORDS, RECORD_HEADERS]].forEach(function (entry) {
      let sheet = ss.getSheetByName(entry[0]);
      if (!sheet) { sheet = ss.insertSheet(entry[0]); sheet.appendRow(entry[1]); }
      sheet_(entry[0], entry[1]);
    });
    const students = rows_(STUDENTS, STUDENT_HEADERS);
    const studentSheet = sheet_(STUDENTS, STUDENT_HEADERS);
    const headers = studentSheet.getRange(1, 1, 1, studentSheet.getLastColumn()).getDisplayValues()[0];
    TEST_IDS.forEach(function (id, index) {
      const matches = students.filter(function (s) { return s['학생ID'] === id; });
      if (matches.length) {
        if (matches.length !== 1 || matches[0]['이름'] !== '테스트학생' + (index + 1) || !matches[0]['QR식별값']) throw new Error('테스트 학생ID가 기존 데이터와 충돌합니다: ' + id);
        return;
      }
      const row = { '학생ID': id, '학년도': '2026', '학년': '1', '반': '99', '번호': String(index + 1), '이름': '테스트학생' + (index + 1), 'QR식별값': 'TESTQR-' + random_(), '재학상태': '재학' };
      studentSheet.appendRow(headers.map(function (key) { return row[key] || ''; }));
    });
    // 사용 가능한 벌점이 없을 때만 합성 기준 한 개 추가합니다. 기존 항목은 변경하지 않습니다.
    if (!criteria_().length) {
      const criterionSheet = sheet_(CRITERIA, CRITERIA_HEADERS);
      const keys = criterionSheet.getRange(1, 1, 1, criterionSheet.getLastColumn()).getDisplayValues()[0];
      const all = rows_(CRITERIA, CRITERIA_HEADERS);
      if (all.some(function (c) { return c['항목코드'] === 'TEST-P01'; })) throw new Error('벌점 TEST-P01 코드가 이미 있습니다. 점수기준을 직접 확인하세요.');
      const item = { '항목코드': 'TEST-P01', '구분': '벌점', '사유': '테스트 지각', '점수': '2', '당일중복허용': '허용', '사용여부': '사용' };
      criterionSheet.appendRow(keys.map(function (key) { return item[key] || ''; }));
    }
    console.log('준비 완료. 학생명부 TEST-001/002의 QR식별값으로 QR 이미지를 준비하세요. PAGES_ORIGIN을 설정한 뒤 startTest_를 실행하세요.');
  } finally { lock.releaseLock(); }
}
/** 소유자만 실행: 새 테스트 30분 시작. 학생별 5건, 전체20건. 기존 기록 보존. */
function startTest_() {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    if (PAGES_ORIGIN.indexOf('YOUR-USERNAME') !== -1 || !/^https:\/\/[^/]+$/.test(PAGES_ORIGIN)) throw new Error('Code.gs의 PAGES_ORIGIN을 먼저 설정하세요.');
    if (testStudents_().length !== 2 || !criteria_().length) throw new Error('테스트 학생과 벌점 항목을 먼저 준비하세요. setupTest_를 실행하세요.');
    sheet_(RECORDS, RECORD_HEADERS);
    PropertiesService.getScriptProperties().setProperties({ TEST_ENABLED: 'true', TEST_RUN: Utilities.getUuid(), TEST_DEADLINE: String(Date.now() + 30 * 60 * 1000) });
    console.log('30분 테스트 시작. 즉시 종료하려면 stopTest_를 실행하세요.');
  } finally { lock.releaseLock(); }
}
function stopTest_() {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try { PropertiesService.getScriptProperties().setProperty('TEST_ENABLED', 'false'); }
  finally { lock.releaseLock(); }
}
