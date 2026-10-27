"use strict";

// QR 테스트용: 학생명부나 Google Sheets에는 접근하지 않습니다.
const video = document.querySelector("#camera-preview");
const statusText = document.querySelector("#scan-status");
const resultCard = document.querySelector("#result-card");
const resultId = document.querySelector("#result-id");
const placeholder = document.querySelector("#camera-placeholder");
const photoInput = document.querySelector("#qr-photo-input");
const startButton = document.querySelector("#start-scan");

const canvas = document.createElement("canvas");
const context = canvas.getContext("2d", { willReadFrequently: true });

let stream = null;
let scanning = false;
let generation = 0;
let barcodeDetector = null;

function setStatus(message) {
  statusText.textContent = message;
}

function stopCamera() {
  generation += 1;
  scanning = false;

  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }

  video.pause();
  video.srcObject = null;
  placeholder.hidden = false;
}

function showResult(value) {
  const raw = String(value ?? "").trim();

  if (!raw) {
    setStatus("QR에 식별값이 들어 있지 않습니다.");
    return;
  }

  stopCamera();
  resultId.textContent = raw;
  resultCard.hidden = false;
  setStatus("QR 인식에 성공했습니다.");
  resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function prepareDetector() {
  // 지원되는 브라우저에서는 내장 QR 인식 기능을 먼저 사용합니다.
  if ("BarcodeDetector" in window) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes("qr_code")) {
        barcodeDetector = new BarcodeDetector({ formats: ["qr_code"] });
        return true;
      }
    } catch (error) {
      console.warn("내장 QR 인식기를 사용할 수 없습니다.", error);
    }
  }

  // 내장 기능이 없으면 jsQR 라이브러리를 사용합니다.
  return typeof window.jsQR === "function";
}

async function decodeImage(source, width, height) {
  if (barcodeDetector) {
    const codes = await barcodeDetector.detect(source);
    return codes[0]?.rawValue ?? null;
  }

  if (typeof window.jsQR !== "function") {
    throw new Error("QR 인식 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해주세요.");
  }

  const scale = Math.min(1, 1200 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  context.drawImage(source, 0, 0, canvas.width, canvas.height);

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const result = window.jsQR(pixels.data, pixels.width, pixels.height, {
    inversionAttempts: "attemptBoth"
  });

  return result?.data ?? null;
}

async function scanFrame(currentGeneration) {
  if (!scanning || currentGeneration !== generation) return;

  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    try {
      const value = await decodeImage(video, video.videoWidth, video.videoHeight);

      if (!scanning || currentGeneration !== generation) return;
      if (value) {
        showResult(value);
        return;
      }
    } catch (error) {
      if (currentGeneration === generation) setStatus(error.message);
      stopCamera();
      return;
    }
  }

  if (scanning && currentGeneration === generation) {
    window.setTimeout(() => scanFrame(currentGeneration), 220);
  }
}

async function startCamera() {
  stopCamera();
  resultCard.hidden = true;
  const currentGeneration = generation;

  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("카메라를 사용할 수 없어요. GitHub Pages의 HTTPS 주소로 접속해주세요.");
    return;
  }

  startButton.disabled = true;
  setStatus("카메라를 연결하고 있어요.");

  try {
    if (!await prepareDetector()) {
      throw new Error("QR 인식 기능을 사용할 수 없습니다. 인터넷 연결을 확인해주세요.");
    }

    const camera = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });

    if (currentGeneration !== generation) {
      camera.getTracks().forEach(track => track.stop());
      return;
    }

    stream = camera;
    video.srcObject = camera;
    await video.play();

    if (currentGeneration !== generation) return;

    placeholder.hidden = true;
    scanning = true;
    setStatus("QR 코드를 사각형 안에 맞춰주세요.");
    scanFrame(currentGeneration);
  } catch (error) {
    if (currentGeneration === generation) {
      setStatus(error.name === "NotAllowedError"
        ? "카메라 권한이 거부되었습니다. 브라우저 설정에서 허용해주세요."
        : error.message || "카메라 연결에 실패했습니다.");
      stopCamera();
    }
  } finally {
    startButton.disabled = false;
  }
}

async function readPhoto(file) {
  if (!file) return;

  if (file.size > 15 * 1024 * 1024) {
    setStatus("15MB 이하의 이미지를 선택해주세요.");
    return;
  }

  stopCamera();
  setStatus("사진에서 QR 코드를 찾고 있어요.");

  let image = null;
  let url = null;

  try {
    if (!await prepareDetector()) {
      throw new Error("QR 인식 기능을 사용할 수 없습니다.");
    }

    url = URL.createObjectURL(file);
    image = new Image();
    image.src = url;
    await image.decode();

    const value = await decodeImage(image, image.naturalWidth, image.naturalHeight);
    if (value) showResult(value);
    else setStatus("사진에서 QR 코드를 찾지 못했습니다. 더 선명한 사진으로 시도해주세요.");
  } catch (error) {
    setStatus(error.message || "사진을 읽지 못했습니다.");
  } finally {
    if (url) URL.revokeObjectURL(url);
    photoInput.value = "";
  }
}

// 화면 버튼 연결
startButton.addEventListener("click", startCamera);

document.querySelector("#stop-scan").addEventListener("click", () => {
  stopCamera();
  setStatus("카메라를 종료했습니다.");
});

document.querySelector("#choose-photo").addEventListener("click", () => {
  photoInput.click();
});

photoInput.addEventListener("change", event => {
  readPhoto(event.target.files[0]);
});

document.querySelector("#scan-again").addEventListener("click", startCamera);

document.querySelector("#check-manual").addEventListener("click", () => {
  const value = document.querySelector("#manual-id").value.trim();
  if (value) showResult(value);
  else setStatus("학생 식별값을 입력해주세요.");
});

window.addEventListener("pagehide", stopCamera);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopCamera();
});
