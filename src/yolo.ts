import * as ort from "onnxruntime-web";
import type { AppSettings } from "./api";

const INPUT_SIZE = 640;
const PERSON_CLASS = 0;

export type YoloResult = {
  present: boolean;
  confidence: number;
  source: string;
  inferenceMs: number;
  note?: string;
  boxes?: YoloBox[];
};

export type YoloBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
};

export type YoloRuntime = {
  session: ort.InferenceSession;
  inputName: string;
  outputName: string;
};

let runtimePromise: Promise<YoloRuntime> | null = null;

export async function getYoloRuntime() {
  if (!runtimePromise) {
    runtimePromise = ort.InferenceSession.create("/models/yolov8n.onnx", {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    })
      .then((session: ort.InferenceSession) => ({
        session,
        inputName: session.inputNames[0],
        outputName: session.outputNames[0]
      }))
      .catch((error) => {
        runtimePromise = null;
        throw error;
      });
  }
  return runtimePromise as Promise<YoloRuntime>;
}

export async function detectPersonFromVideo(
  runtime: YoloRuntime,
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  settings: AppSettings
): Promise<YoloResult> {
  const prepared = prepareInput(video, canvas, settings);
  if (!prepared.usable) {
    return {
      present: false,
      confidence: 0,
      source: "YOLO",
      inferenceMs: 0,
      note: prepared.reason
    };
  }

  const tensor = new ort.Tensor("float32", prepared.input, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const started = performance.now();
  const output = await runtime.session.run({ [runtime.inputName]: tensor });
  const inferenceMs = performance.now() - started;
  const result = output[runtime.outputName] ?? Object.values(output)[0];
  if (!result || !(result.data instanceof Float32Array)) {
    return {
      present: false,
      confidence: 0,
      source: "YOLO",
      inferenceMs,
      note: "YOLO 输出为空或格式不支持。"
    };
  }

  const parsed = parseYoloOutput(
    result.data,
    result.dims,
    settings.yolo_confidence_threshold,
    settings.yolo_min_box_area_ratio,
    prepared.transform
  );
  return {
    present: parsed.present,
    confidence: parsed.confidence,
    source: `YOLO ${Math.round(inferenceMs)}ms`,
    inferenceMs,
    boxes: parsed.boxes
  };
}

function prepareInput(video: HTMLVideoElement, canvas: HTMLCanvasElement, settings: AppSettings) {
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  if (videoWidth <= 0 || videoHeight <= 0) {
    return { usable: false as const, input: new Float32Array(), reason: "摄像头尚未输出有效画面。" };
  }

  canvas.width = INPUT_SIZE;
  canvas.height = INPUT_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return { usable: false as const, input: new Float32Array(), reason: "无法创建画面缓冲区。" };
  }

  let sx = 0;
  let sy = 0;
  let sw = videoWidth;
  let sh = videoHeight;
  if (settings.roi_enabled) {
    sx = Math.floor(videoWidth * clamp(settings.roi_x_percent, 0, 99) / 100);
    sy = Math.floor(videoHeight * clamp(settings.roi_y_percent, 0, 99) / 100);
    sw = Math.max(1, Math.floor(videoWidth * clamp(settings.roi_w_percent, 1, 100) / 100));
    sh = Math.max(1, Math.floor(videoHeight * clamp(settings.roi_h_percent, 1, 100) / 100));
    sw = Math.min(sw, videoWidth - sx);
    sh = Math.min(sh, videoHeight - sy);
  }

  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);

  const scale = Math.min(INPUT_SIZE / sw, INPUT_SIZE / sh);
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const dx = Math.floor((INPUT_SIZE - dw) / 2);
  const dy = Math.floor((INPUT_SIZE - dh) / 2);
  ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);

  const imageData = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const stats = getLumaStats(imageData.data);
  if (isUnusableDarkFrame(stats.mean, stats.stddev, settings)) {
    return { usable: false as const, input: new Float32Array(), reason: "画面过暗或近似黑屏，跳过 YOLO 计时。" };
  }
  if (stats.mean < settings.yolo_low_signal_mean_threshold || stats.stddev < settings.yolo_low_signal_stddev_threshold) {
    return { usable: false as const, input: new Float32Array(), reason: "画面信号不足，跳过 YOLO 计时。" };
  }

  const input = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const pixels = imageData.data;
  const plane = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0, p = 0; i < pixels.length; i += 4, p += 1) {
    input[p] = pixels[i] / 255;
    input[plane + p] = pixels[i + 1] / 255;
    input[plane * 2 + p] = pixels[i + 2] / 255;
  }

  return {
    usable: true as const,
    input,
    transform: { sx, sy, sw, sh, scale, dx, dy, videoWidth, videoHeight }
  };
}

function parseYoloOutput(
  data: Float32Array,
  dims: readonly number[],
  threshold: number,
  minBoxAreaRatio: number,
  transform: {
    sx: number;
    sy: number;
    sw: number;
    sh: number;
    scale: number;
    dx: number;
    dy: number;
    videoWidth: number;
    videoHeight: number;
  }
) {
  let attrs = 0;
  let anchors = 0;
  let layout: "attrs-first" | "anchors-first" = "attrs-first";

  if (dims.length === 3) {
    const a = dims[1];
    const b = dims[2];
    if (a <= b) {
      attrs = a;
      anchors = b;
      layout = "attrs-first";
    } else {
      anchors = a;
      attrs = b;
      layout = "anchors-first";
    }
  } else if (dims.length === 2) {
    const a = dims[0];
    const b = dims[1];
    if (a <= b) {
      attrs = a;
      anchors = b;
      layout = "attrs-first";
    } else {
      anchors = a;
      attrs = b;
      layout = "anchors-first";
    }
  }

  if (attrs < 5 || anchors <= 0) {
    return { present: false, confidence: 0, boxes: [] as YoloBox[] };
  }

  const get = (attr: number, anchor: number) => {
    if (layout === "attrs-first") {
      return data[attr * anchors + anchor] ?? 0;
    }
    return data[anchor * attrs + attr] ?? 0;
  };

  let best = 0;
  const boxes: YoloBox[] = [];
  for (let anchor = 0; anchor < anchors; anchor += 1) {
    const score = get(4 + PERSON_CLASS, anchor);
    if (score < threshold) {
      continue;
    }
    const w = get(2, anchor);
    const h = get(3, anchor);
    const areaRatio = (w * h) / (INPUT_SIZE * INPUT_SIZE);
    if (areaRatio < minBoxAreaRatio) {
      continue;
    }
    if (score > best) {
      best = score;
    }
    boxes.push(toVideoBox(get(0, anchor), get(1, anchor), w, h, score, transform));
  }

  boxes.sort((a, b) => b.confidence - a.confidence);
  return { present: best >= threshold, confidence: best, boxes: boxes.slice(0, 5) };
}

function toVideoBox(
  cx: number,
  cy: number,
  width: number,
  height: number,
  confidence: number,
  transform: {
    sx: number;
    sy: number;
    sw: number;
    sh: number;
    scale: number;
    dx: number;
    dy: number;
    videoWidth: number;
    videoHeight: number;
  }
): YoloBox {
  const inputX = cx - width / 2;
  const inputY = cy - height / 2;
  const cropX = (inputX - transform.dx) / transform.scale;
  const cropY = (inputY - transform.dy) / transform.scale;
  const cropW = width / transform.scale;
  const cropH = height / transform.scale;
  const x1 = clamp(transform.sx + cropX, 0, transform.videoWidth);
  const y1 = clamp(transform.sy + cropY, 0, transform.videoHeight);
  const x2 = clamp(transform.sx + cropX + cropW, 0, transform.videoWidth);
  const y2 = clamp(transform.sy + cropY + cropH, 0, transform.videoHeight);
  return {
    x: x1,
    y: y1,
    width: Math.max(1, x2 - x1),
    height: Math.max(1, y2 - y1),
    confidence
  };
}

function getLumaStats(pixels: Uint8ClampedArray) {
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  let dark = 0;
  let bright = 0;
  for (let i = 0; i < pixels.length; i += 16) {
    const luma = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
    sum += luma;
    sumSq += luma * luma;
    count += 1;
    if (luma < 55) dark += 1;
    if (luma > 100) bright += 1;
  }
  const mean = count > 0 ? sum / count : 0;
  const variance = count > 0 ? Math.max(0, sumSq / count - mean * mean) : 0;
  return {
    mean,
    stddev: Math.sqrt(variance),
    darkRatio: count > 0 ? dark / count : 1,
    brightRatio: count > 0 ? bright / count : 0
  };
}

function isUnusableDarkFrame(mean: number, stddev: number, settings: AppSettings) {
  const darkMean = settings.yolo_dark_mean_threshold;
  const darkStddev = settings.yolo_dark_stddev_threshold;
  if (mean < darkMean || (mean < darkMean + 14 && stddev < darkStddev)) {
    return true;
  }
  if (mean >= 85) {
    return false;
  }
  return mean < settings.yolo_low_signal_mean_threshold + 35 && stddev < settings.yolo_low_signal_stddev_threshold;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
