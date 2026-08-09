/**
 * AugmentWorker — 海克斯强化图标模板匹配 Worker
 *
 * 使用归一化互相关 (Normalized Cross-Correlation) 在捕获画面中匹配海克斯图标。
 * 对标 cv.TM_CCOEFF_NORMED 的效果，纯 JS 实现，无外部依赖。
 *
 * 消息协议:
 *   Main → Worker: { type: 'init', augmentIcons: Array<{ id: string, iconUrl: string }> }
 *   Worker → Main: { type: 'ready', count: number }
 *   Main → Worker: { type: 'detect', imageData: ImageData, regions: Region[], threshold: number }
 *   Worker → Main: { type: 'result', matches: AugmentMatch[] }
 */

interface AugmentIcon {
  id: string;
  iconUrl: string;
}

interface Region {
  x: number;      // 在 imageData 中的起始 x
  y: number;      // 在 imageData 中的起始 y
  w: number;      // 宽度
  h: number;      // 高度
  index: number;  // 区域索引 (0, 1, 2)
}

interface AugmentMatch {
  augmentId: string;
  regionIndex: number;
  confidence: number;
  x: number;
  y: number;
}

interface TemplateData {
  id: string;
  pixels: Uint8ClampedArray; // RGBA
  width: number;
  height: number;
}

// ============================================================
// 归一化互相关 (NCC) 模板匹配
// ============================================================

/**
 * 从 ImageData 中提取指定区域的灰度像素。
 * 对区域做降采样以加速匹配（目标尺寸 ≤ 120px）。
 */
function extractGrayRegion(
  imageData: ImageData,
  rx: number, ry: number, rw: number, rh: number,
  maxDim = 120,
): { pixels: Float32Array; width: number; height: number; scaleX: number; scaleY: number } {
  const scale = Math.min(1, maxDim / Math.max(rw, rh));
  const sw = Math.max(1, Math.round(rw * scale));
  const sh = Math.max(1, Math.round(rh * scale));
  const pixels = new Float32Array(sw * sh);

  for (let sy = 0; sy < sh; sy++) {
    for (let sx = 0; sx < sw; sx++) {
      // 双线性采样
      const srcX = rx + (sx / sw) * rw;
      const srcY = ry + (sy / sh) * rh;
      const ix = Math.min(imageData.width - 1, Math.max(0, Math.floor(srcX)));
      const iy = Math.min(imageData.height - 1, Math.max(0, Math.floor(srcY)));
      const idx = (iy * imageData.width + ix) * 4;
      // 灰度 = 0.299R + 0.587G + 0.114B
      pixels[sy * sw + sx] =
        0.299 * imageData.data[idx] +
        0.587 * imageData.data[idx + 1] +
        0.114 * imageData.data[idx + 2];
    }
  }
  return { pixels, width: sw, height: sh, scaleX: scale, scaleY: scale };
}

/**
 * 将 RGBA 模板转为灰度，可选降采样。
 */
function templateToGray(data: Uint8ClampedArray, width: number, height: number, maxDim = 64): {
  pixels: Float32Array;
  width: number;
  height: number;
} {
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const sw = Math.max(1, Math.round(width * scale));
  const sh = Math.max(1, Math.round(height * scale));
  const pixels = new Float32Array(sw * sh);

  for (let sy = 0; sy < sh; sy++) {
    for (let sx = 0; sx < sw; sx++) {
      const srcX = (sx / sw) * width;
      const srcY = (sy / sh) * height;
      const ix = Math.min(width - 1, Math.max(0, Math.floor(srcX)));
      const iy = Math.min(height - 1, Math.max(0, Math.floor(srcY)));
      const idx = (iy * width + ix) * 4;
      pixels[sy * sw + sx] =
        0.299 * data[idx] +
        0.587 * data[idx + 1] +
        0.114 * data[idx + 2];
    }
  }
  return { pixels, width: sw, height: sh };
}

/**
 * 归一化互相关匹配。
 * 在 region 中滑动 template，返回每个位置的 NCC 分数。
 * 返回最佳匹配位置和分数。
 */
function matchTemplate(
  region: { pixels: Float32Array; width: number; height: number },
  template: { pixels: Float32Array; width: number; height: number },
): { x: number; y: number; confidence: number } {
  const { pixels: R, width: rw, height: rh } = region;
  const { pixels: T, width: tw, height: th } = template;

  if (tw > rw || th > rh) {
    return { x: 0, y: 0, confidence: 0 };
  }

  // 预计算模板统计量
  let tMean = 0;
  for (let i = 0; i < T.length; i++) tMean += T[i];
  tMean /= T.length;

  let tStd = 0;
  for (let i = 0; i < T.length; i++) {
    const d = T[i] - tMean;
    tStd += d * d;
  }
  tStd = Math.sqrt(tStd / T.length);
  if (tStd < 1e-6) return { x: 0, y: 0, confidence: 0 };

  const Tnorm = new Float32Array(T.length);
  for (let i = 0; i < T.length; i++) {
    Tnorm[i] = (T[i] - tMean) / tStd;
  }

  // 滑动窗口匹配（步长 2px 加速）
  const step = 2;
  let bestConfidence = -Infinity;
  let bestX = 0;
  let bestY = 0;

  for (let y = 0; y <= rh - th; y += step) {
    for (let x = 0; x <= rw - tw; x += step) {
      // 计算窗口均值 & 标准差
      let wMean = 0;
      const windowSize = tw * th;
      for (let ty = 0; ty < th; ty++) {
        const rowOff = (y + ty) * rw + x;
        for (let tx = 0; tx < tw; tx++) {
          wMean += R[rowOff + tx];
        }
      }
      wMean /= windowSize;

      let wStd = 0;
      for (let ty = 0; ty < th; ty++) {
        const rowOff = (y + ty) * rw + x;
        for (let tx = 0; tx < tw; tx++) {
          const d = R[rowOff + tx] - wMean;
          wStd += d * d;
        }
      }
      wStd = Math.sqrt(wStd / windowSize);

      if (wStd < 1e-6) continue;

      // NCC
      let ncc = 0;
      for (let ty = 0; ty < th; ty++) {
        const rowOff = (y + ty) * rw + x;
        for (let tx = 0; tx < tw; tx++) {
          const wNorm = (R[rowOff + tx] - wMean) / wStd;
          ncc += wNorm * Tnorm[ty * tw + tx];
        }
      }
      ncc /= windowSize;

      if (ncc > bestConfidence) {
        bestConfidence = ncc;
        bestX = x;
        bestY = y;
      }
    }
  }

  // NCC 范围是 [-1, 1]，转换到 [0, 1]
  return {
    x: bestX,
    y: bestY,
    confidence: (bestConfidence + 1) / 2,
  };
}

// ============================================================
// Worker 状态
// ============================================================

const templates: TemplateData[] = [];

async function handleInit(augmentIcons: AugmentIcon[]): Promise<void> {
  templates.length = 0;

  for (const icon of augmentIcons) {
    try {
      const response = await fetch(icon.iconUrl);
      if (!response.ok) continue;

      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);

      // 提取 RGBA 像素
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;

      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

      templates.push({
        id: icon.id,
        pixels: new Uint8ClampedArray(imageData.data),
        width: bitmap.width,
        height: bitmap.height,
      });
      bitmap.close();
    } catch {
      // 跳过加载失败的图标
      console.warn(`[AugmentWorker] Failed to load icon: ${icon.iconUrl}`);
    }
  }

  self.postMessage({ type: 'ready', count: templates.length });
}

function handleDetect(
  imageData: ImageData,
  regions: Region[],
  threshold: number,
): void {
  const matches: AugmentMatch[] = [];

  for (const region of regions) {
    // 边界检查
    const rx = Math.max(0, Math.min(imageData.width, region.x));
    const ry = Math.max(0, Math.min(imageData.height, region.y));
    const rw = Math.min(imageData.width - rx, region.w);
    const rh = Math.min(imageData.height - ry, region.h);
    if (rw < 10 || rh < 10) continue;

    // 提取区域灰度图
    const regionGray = extractGrayRegion(imageData, rx, ry, rw, rh);

    for (const template of templates) {
      const tGray = templateToGray(template.pixels, template.width, template.height);

      const result = matchTemplate(regionGray, tGray);

      if (result.confidence >= threshold) {
        // 将匹配位置从降采样坐标映射回原始坐标
        const origX = rx + result.x / regionGray.scaleX;
        const origY = ry + result.y / regionGray.scaleY;
        matches.push({
          augmentId: template.id,
          regionIndex: region.index,
          confidence: Math.round(result.confidence * 1000) / 1000,
          x: Math.round(origX),
          y: Math.round(origY),
        });
      }
    }
  }

  // 按置信度降序排列
  matches.sort((a, b) => b.confidence - a.confidence);

  // 每个区域只保留最佳匹配
  const bestPerRegion = new Map<number, AugmentMatch>();
  for (const m of matches) {
    if (!bestPerRegion.has(m.regionIndex)) {
      bestPerRegion.set(m.regionIndex, m);
    }
  }

  self.postMessage({
    type: 'result',
    matches: Array.from(bestPerRegion.values()),
  });
}

// ============================================================
// 消息循环
// ============================================================

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init':
      await handleInit(msg.augmentIcons);
      break;
    case 'detect':
      handleDetect(msg.imageData, msg.regions, msg.threshold);
      break;
  }
};
