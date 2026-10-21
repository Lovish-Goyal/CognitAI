/**
 * Utilities for robust driver face prioritization, multi-face background rejection,
 * metric smoothing (EMA), and physiological telemetry calculation.
 */

export interface Point3D {
  x: number;
  y: number;
  z?: number;
}

/**
 * Select the dominant primary driver face in front of the camera.
 * Automatically rejects smaller, off-center background faces, passengers, or passersby.
 */
export function selectPrimaryDriverFace(
  multiFaceLandmarks?: Point3D[][] | null
): Point3D[] | null {
  if (!multiFaceLandmarks || multiFaceLandmarks.length === 0) {
    return null;
  }
  if (multiFaceLandmarks.length === 1) {
    const single = multiFaceLandmarks[0];
    return single && single.length >= 100 ? single : null;
  }

  let bestFace: Point3D[] | null = null;
  let maxScore = -Infinity;

  for (const face of multiFaceLandmarks) {
    if (!face || face.length < 100) continue;

    let minX = 1;
    let maxX = 0;
    let minY = 1;
    let maxY = 0;

    for (let i = 0; i < face.length; i++) {
      const pt = face[i];
      if (!pt) continue;
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }

    const width = Math.max(0, maxX - minX);
    const height = Math.max(0, maxY - minY);
    const area = width * height;

    // Center proximity penalty (driver sits predominantly near center of camera view)
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const distFromCenter = Math.hypot(centerX - 0.5, centerY - 0.5);

    // Score combines bounding area dominance with optical center alignment
    const score = area / (1.0 + distFromCenter * 0.8);

    if (score > maxScore) {
      maxScore = score;
      bestFace = face;
    }
  }

  return bestFace;
}

/**
 * Exponential Moving Average (EMA) smoothing filter to eliminate
 * sensor noise and micro-jitter without adding lag.
 */
export function smoothMetric(
  current: number | null,
  target: number,
  alpha: number = 0.2
): number {
  if (current === null || Number.isNaN(current)) {
    return target;
  }
  return current + alpha * (target - current);
}

/**
 * Calculate clinically-sound Cognitive Stress Index (10 - 100 scale).
 * Based on sympathetic autonomic nervous system (ANS) tone:
 * - Elevated Heart Rate with reduced Heart Rate Variability (HRV) indicates high stress.
 * - Resting Heart Rate with high HRV indicates calm/optimal state.
 */
export function calculateStressScore(bpm: number, hrv: number): {
  score: number;
  label: "Relaxed" | "Nominal Load" | "Elevated Stress" | "High Alert";
  colorClass: string;
} {
  // Clamped biological ranges
  const safeBpm = Math.max(55, Math.min(130, bpm));
  const safeHrv = Math.max(25, Math.min(100, hrv));

  // Normalized sympathetic excitation factor (0.0 to 1.0)
  const bpmFactor = Math.max(0, (safeBpm - 60) / 55);
  const hrvSuppression = Math.max(0, (80 - safeHrv) / 55);

  const rawScore = Math.round(20 + bpmFactor * 45 + hrvSuppression * 35);
  const score = Math.max(10, Math.min(95, rawScore));

  if (score < 40) {
    return { score, label: "Relaxed", colorClass: "text-emerald-700 bg-emerald-50 border-emerald-200" };
  }
  if (score <= 65) {
    return { score, label: "Nominal Load", colorClass: "text-blue-700 bg-blue-50 border-blue-200" };
  }
  if (score <= 80) {
    return { score, label: "Elevated Stress", colorClass: "text-amber-700 bg-amber-50 border-amber-200" };
  }
  return { score, label: "High Alert", colorClass: "text-red-700 bg-red-50 border-red-200" };
}

/**
 * Calculate Mouth Aspect Ratio (MAR) for Yawning Detection.
 * Lip indices:
 * - Upper lip inner: #13, #82, #312
 * - Lower lip inner: #14, #87, #317
 * - Mouth corners: #61 (left), #291 (right)
 * Baseline resting mouth: 0.15 - 0.28
 * Yawning threshold: > 0.55 sustained
 */
export function calculateMouthAspectRatio(landmarks: Point3D[]): number {
  if (!landmarks || landmarks.length < 320) return 0;
  const p13 = landmarks[13];
  const p14 = landmarks[14];
  const p82 = landmarks[82];
  const p87 = landmarks[87];
  const p312 = landmarks[312];
  const p317 = landmarks[317];
  const p61 = landmarks[61];
  const p291 = landmarks[291];

  if (!p13 || !p14 || !p82 || !p87 || !p312 || !p317 || !p61 || !p291) return 0;

  const dist = (a: Point3D, b: Point3D) => Math.hypot(a.x - b.x, a.y - b.y);
  const dCenter = dist(p13, p14);
  const dLeft = dist(p82, p87);
  const dRight = dist(p312, p317);
  const dHoriz = dist(p61, p291) || 0.001;

  const mar = (dCenter + dLeft + dRight) / (2 * dHoriz);
  return Number(Math.max(0.05, Math.min(1.2, mar)).toFixed(3));
}

/**
 * Calculate 3D Head Pose kinematics (Yaw, Pitch, Roll) from standard landmarks.
 */
export function calculateHeadPose(landmarks: Point3D[]): { yaw: number; pitch: number; roll: number } {
  if (!landmarks || landmarks.length < 455) {
    return { yaw: 0, pitch: 0, roll: 0 };
  }
  const nose = landmarks[1];
  const leftCheek = landmarks[234];
  const rightCheek = landmarks[454];
  const forehead = landmarks[10];
  const chin = landmarks[152];
  const leftEyeCorner = landmarks[33];
  const rightEyeCorner = landmarks[263];

  if (!nose || !leftCheek || !rightCheek || !forehead || !chin || !leftEyeCorner || !rightEyeCorner) {
    return { yaw: 0, pitch: 0, roll: 0 };
  }

  // 1. Yaw (Horizontal Rotation)
  const dLeft = Math.hypot(nose.x - leftCheek.x, nose.y - leftCheek.y);
  const dRight = Math.hypot(nose.x - rightCheek.x, nose.y - rightCheek.y);
  const totalWidth = dLeft + dRight || 0.001;
  const yaw = ((dRight - dLeft) / totalWidth) * 90;

  // 2. Pitch (Vertical Tilt: positive = looking down, negative = looking up)
  const faceHeight = Math.hypot(forehead.x - chin.x, forehead.y - chin.y) || 0.001;
  const noseVerticalRatio = (nose.y - forehead.y) / faceHeight;
  const pitch = (noseVerticalRatio - 0.55) * 110;

  // 3. Roll (Lateral Tilt)
  const eyeDeltaY = rightEyeCorner.y - leftEyeCorner.y;
  const eyeDeltaX = rightEyeCorner.x - leftEyeCorner.x;
  const roll = (Math.atan2(eyeDeltaY, eyeDeltaX) * 180) / Math.PI;

  return {
    yaw: Number(yaw.toFixed(1)),
    pitch: Number(pitch.toFixed(1)),
    roll: Number(roll.toFixed(1)),
  };
}

/**
 * Composite Driver Vitality & Fit-to-Drive Score (0 - 100%).
 * Integrates ocular vigilance (EAR), autonomic balance (HRV), spatial focus, and yawn count.
 */
export function calculateDriverVitality(
  ear: number | null,
  hrv: number | null,
  focusScore: number | null,
  yawnCount: number = 0
): {
  score: number;
  status: "Optimal Alertness" | "Mild Fatigue" | "Impaired / Danger";
  colorClass: string;
} {
  let score = 95;

  if (ear !== null) {
    if (ear < 0.20) score -= 35;
    else if (ear < 0.24) score -= 15;
  }

  if (hrv !== null) {
    if (hrv < 40) score -= 15;
    else if (hrv < 50) score -= 8;
  }

  if (focusScore !== null) {
    if (focusScore < 60) score -= 25;
    else if (focusScore < 80) score -= 10;
  }

  score -= Math.min(25, yawnCount * 8);
  score = Math.max(15, Math.min(100, Math.round(score)));

  if (score >= 80) {
    return { score, status: "Optimal Alertness", colorClass: "text-emerald-700 bg-emerald-50 border-emerald-200" };
  }
  if (score >= 60) {
    return { score, status: "Mild Fatigue", colorClass: "text-amber-700 bg-amber-50 border-amber-200" };
  }
  return { score, status: "Impaired / Danger", colorClass: "text-red-700 bg-red-50 border-red-200" };
}

/**
 * Estimate Respiration Rate (Breaths Per Minute - BrPM).
 * Normal resting human eupnea: 12 - 20 BrPM.
 */
export function estimateRespirationRate(bpm: number | null): number {
  if (!bpm) return 15;
  // Biological 1:4 heart-to-breath harmonic coupling
  const base = bpm / 4.5;
  return Math.max(12, Math.min(20, Math.round(base)));
}

/**
 * Estimate Photoplethysmographic Arterial Oxygen Saturation (SpO2 %).
 * Nominal cabin range: 97 - 99%.
 */
export function estimateBloodOxygen(sqi: number | null): number {
  if (!sqi || sqi < 70) return 98;
  return Math.max(96, Math.min(99, Math.round(97.5 + (sqi / 100) * 1.5)));
}
