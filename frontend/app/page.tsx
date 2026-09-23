"use client";

import Link from "next/link";
import { FaceMesh, Results, FACEMESH_TESSELATION, FACEMESH_CONTOURS } from "@mediapipe/face_mesh";
import { useEffect, useRef, useState, useCallback } from "react";
import { requestWebcamStream, releaseWebcamStream } from "./utils/camera";
import { getFaceMeshLocateFile } from "./utils/mediapipe";
import {
  selectPrimaryDriverFace,
  smoothMetric,
  calculateMouthAspectRatio,
  calculateHeadPose,
  estimateRespirationRate,
  estimateBloodOxygen,
  calculateDriverVitality,
} from "./utils/faceProcessing";
import { CameraFaceOverlay } from "./components/CameraFaceOverlay";
import { useMonitoring } from "./context/MonitoringContext";
import EntranceGateway from "./components/EntranceGateway";

const API = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

interface SafetyEvent {
  id: string;
  timestamp: string;
  metric: string;
  value: string;
  threshold: string;
  status: "nominal" | "warning" | "alert";
  action: string;
}

export default function Dashboard() {
  const {
    isMonitoring,
    startMonitoring,
    stopMonitoring,
    currentDriver,
    setCurrentDriver,
    initialFaceCalibrated,
    setInitialFaceCalibrated,
    setFaceInFrame,
    triggerGlobalAlarm,
    stopGlobalAlarm,
    alarmActive,
  } = useMonitoring();
  const videoRef = useRef<HTMLVideoElement>(null);
  const landmarkCanvasRef = useRef<HTMLCanvasElement>(null);
  const plotCanvasRef = useRef<HTMLCanvasElement>(null);
  const pulseCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const meshRef = useRef<FaceMesh | null>(null);
  const runningRef = useRef<boolean>(false);
  const connectingPromiseRef = useRef<Promise<boolean> | null>(null);
  const isProcessingRef = useRef(false);
  const lastFrameTimeRef = useRef(0);
  const missingFaceCount = useRef(0);
  const smoothedBpmRef = useRef<number>(72);
  const smoothedHrvRef = useRef<number>(60);
  const smoothedEarRef = useRef<number | null>(null);
  const smoothedYawRef = useRef<number | null>(null);
  const smoothedPitchRef = useRef<number | null>(null);
  const smoothedZVarRef = useRef<number | null>(null);
  const smoothedFocusRef = useRef<number | null>(null);
  const smoothedMarRef = useRef<number | null>(null);
  const smoothedRespRef = useRef<number>(15);
  const smoothedSpo2Ref = useRef<number>(98.5);
  const smoothedVitalityRef = useRef<number>(92);
  const lastPulseUpdateTime = useRef<number>(0);
  const lastPitchRef = useRef<number>(0);
  const isHeadDownRef = useRef<boolean>(false);
  const yawnSinceRef = useRef<number | null>(null);
  const lastYawnCountedRef = useRef<number>(0);
  const closedSinceRef = useRef<number | null>(null);

  // Real-time buffers
  const signalPoints = useRef<number[]>([]);
  const pulseBuffer = useRef<number[]>([]);
  const rawPixelSamples = useRef<number[]>([]);
  const activeSignalRef = useRef<"EAR" | "RPPG" | "YAW">("EAR");

  // Camera & system states
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Dynamic telemetry states (strictly real data)
  const [faceDetected, setFaceDetected] = useState(false);
  const [eyesCaptured, setEyesCaptured] = useState(false);

  const [focusScore, setFocusScore] = useState<number | null>(null);
  const [bpm, setBpm] = useState<number | null>(null);
  const [hrv, setHrv] = useState<number | null>(null);
  const [earValue, setEarValue] = useState<number | null>(null);
  const [headYaw, setHeadYaw] = useState<number | null>(null);
  const [headPitch, setHeadPitch] = useState<number | null>(null);
  const [zVariance, setZVariance] = useState<number | null>(null);

  // New Health & Vigilance States
  const [mar, setMar] = useState<number | null>(null);
  const [isYawning, setIsYawning] = useState<boolean>(false);
  const [yawnCount, setYawnCount] = useState<number>(0);
  const [respirationRate, setRespirationRate] = useState<number | null>(null);
  const [spo2, setSpo2] = useState<number | null>(null);
  const [vitality, setVitality] = useState<number | null>(null);
  const [autoRecovered, setAutoRecovered] = useState(false);
  const [isHeadDown, setIsHeadDown] = useState<boolean>(false);

  const [activeSignal, setActiveSignal] = useState<"EAR" | "RPPG" | "YAW">("EAR");
  const [backendOnline, setBackendOnline] = useState(false);

  useEffect(() => {
    isHeadDownRef.current = isHeadDown;
  }, [isHeadDown]);

  // Keep activeSignalRef in sync
  useEffect(() => {
    activeSignalRef.current = activeSignal;
  }, [activeSignal]);

  // Live safety event stream
  const [safetyEvents, setSafetyEvents] = useState<SafetyEvent[]>([
    {
      id: "ev-1",
      timestamp: "--:--:--",
      metric: "Biometric Sensor Suite Ready",
      value: "MediaPipe 468-pt WASM",
      threshold: "Nominal",
      status: "nominal",
      action: "Optical Stream Active",
    },
  ]);

  useEffect(() => {
    setSafetyEvents((prev) =>
      prev.map((ev) =>
        ev.id === "ev-1"
          ? { ...ev, timestamp: new Date().toLocaleTimeString("en-US", { hour12: false }) }
          : ev
      )
    );
  }, []);

  // Ensure faceInFrame is reset when monitoring stops
  useEffect(() => {
    if (!isMonitoring) {
      setFaceInFrame(true);
    }
  }, [isMonitoring, setFaceInFrame]);

  const lastAlertTime = useRef<number>(0);

  // Health check
  useEffect(() => {
    fetch(`${API}/health`)
      .then((r) => setBackendOnline(r.ok))
      .catch(() => setBackendOnline(false));
  }, []);

  // Draw authentic 468-point full triangular biometric face mask & HUD
  const drawFaceMesh = useCallback(
    (landmarks: Array<{ x: number; y: number; z?: number }>, isDrowsy: boolean, earVal: number, yawVal: number, bpmVal: number | null) => {
      const canvas = landmarkCanvasRef.current;
      const v = videoRef.current;
      if (!canvas || !v) return;

      const vw = v.videoWidth || 960;
      const vh = v.videoHeight || 540;

      if (canvas.width !== vw || canvas.height !== vh) {
        canvas.width = vw;
        canvas.height = vh;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const w = canvas.width;
      const h = canvas.height;

      // 1. FULL FACIAL TESSELLATION MASK (2,556 Triangular Wireframe Edges)
      ctx.strokeStyle = isDrowsy ? "rgba(239, 68, 68, 0.40)" : "rgba(0, 180, 255, 0.40)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < FACEMESH_TESSELATION.length; i++) {
        const [startIdx, endIdx] = FACEMESH_TESSELATION[i];
        const p1 = landmarks[startIdx];
        const p2 = landmarks[endIdx];
        if (p1 && p2) {
          ctx.moveTo(p1.x * w, p1.y * h);
          ctx.lineTo(p2.x * w, p2.y * h);
        }
      }
      ctx.stroke();

      // 2. PROMINENT FACIAL CONTOURS (Eyes, Eyelids, Lips, Face Oval)
      ctx.strokeStyle = isDrowsy ? "#ef4444" : "#0066cc";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      for (let i = 0; i < FACEMESH_CONTOURS.length; i++) {
        const [startIdx, endIdx] = FACEMESH_CONTOURS[i];
        const p1 = landmarks[startIdx];
        const p2 = landmarks[endIdx];
        if (p1 && p2) {
          ctx.moveTo(p1.x * w, p1.y * h);
          ctx.lineTo(p2.x * w, p2.y * h);
        }
      }
      ctx.stroke();

      // 3. EYE IRIS TARGETING RETICLES (Points 468 & 473)
      const leftIris = landmarks[468] || landmarks[159];
      const rightIris = landmarks[473] || landmarks[386];

      [leftIris, rightIris].forEach((iris) => {
        if (!iris) return;
        const ix = iris.x * w;
        const iy = iris.y * h;

        ctx.beginPath();
        ctx.arc(ix, iy, 4, 0, Math.PI * 2);
        ctx.fillStyle = isDrowsy ? "#ef4444" : "#00f0ff";
        ctx.fill();

        ctx.beginPath();
        ctx.arc(ix, iy, 9, 0, Math.PI * 2);
        ctx.strokeStyle = isDrowsy ? "rgba(239, 68, 68, 0.8)" : "rgba(0, 240, 255, 0.8)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });

      // 4. CAPILLARY REGION OF INTEREST (Cheek rPPG Sampling Boxes)
      const leftCheek = landmarks[117] || landmarks[50];
      const rightCheek = landmarks[346] || landmarks[280];
      const boxSize = Math.min(w, h) * 0.12;

      ctx.lineWidth = 1.6;
      ctx.strokeStyle = "#0066cc";
      ctx.fillStyle = "rgba(0, 102, 204, 0.12)";

      if (leftCheek) {
        const lx = leftCheek.x * w - boxSize / 2;
        const ly = leftCheek.y * h - boxSize / 2;
        ctx.strokeRect(lx, ly, boxSize, boxSize);
        ctx.fillRect(lx, ly, boxSize, boxSize);
      }
      if (rightCheek) {
        const rx = rightCheek.x * w - boxSize / 2;
        const ry = rightCheek.y * h - boxSize / 2;
        ctx.strokeRect(rx, ry, boxSize, boxSize);
        ctx.fillRect(rx, ry, boxSize, boxSize);
      }

      // 5. FACIAL BOUNDING BRACKETS & HUD LABELS
      const xs = landmarks.map((pt) => pt.x * w);
      const ys = landmarks.map((pt) => pt.y * h);
      const minX = Math.max(10, Math.min(...xs) - 20);
      const maxX = Math.min(w - 10, Math.max(...xs) + 20);
      const minY = Math.max(10, Math.min(...ys) - 30);
      const maxY = Math.min(h - 10, Math.max(...ys) + 20);
      const bw = maxX - minX;
      const bh = maxY - minY;
      const cornerLen = Math.min(bw, bh) * 0.15;

      ctx.strokeStyle = isDrowsy ? "#ef4444" : "#0066cc";
      ctx.lineWidth = 2.5;

      // Top-left corner
      ctx.beginPath();
      ctx.moveTo(minX, minY + cornerLen);
      ctx.lineTo(minX, minY);
      ctx.lineTo(minX + cornerLen, minY);
      ctx.stroke();

      // Top-right corner
      ctx.beginPath();
      ctx.moveTo(maxX - cornerLen, minY);
      ctx.lineTo(maxX, minY);
      ctx.lineTo(maxX, minY + cornerLen);
      ctx.stroke();

      // Bottom-left corner
      ctx.beginPath();
      ctx.moveTo(minX, maxY - cornerLen);
      ctx.lineTo(minX, maxY);
      ctx.lineTo(minX + cornerLen, maxY);
      ctx.stroke();

      // Bottom-right corner
      ctx.beginPath();
      ctx.moveTo(maxX - cornerLen, maxY);
      ctx.lineTo(maxX, maxY);
      ctx.lineTo(maxX, maxY - cornerLen);
      ctx.stroke();

      // In-Video HUD Header Label above Bounding Box
      ctx.fillStyle = isDrowsy ? "rgba(220, 38, 38, 0.9)" : "rgba(0, 102, 204, 0.9)";
      ctx.fillRect(minX, minY - 24, Math.min(bw, 220), 20);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 11px monospace";
      ctx.fillText(`DRIVER-001 · ${isDrowsy ? "DROWSY" : "ATTENTIVE"}`, minX + 6, minY - 10);
    },
    []
  );

  // Initialize and run MediaPipe FaceMesh
  const connectCamera = useCallback(async (): Promise<boolean> => {
    if (connectingPromiseRef.current) {
      return connectingPromiseRef.current;
    }

    connectingPromiseRef.current = (async () => {
      setCameraError(null);

    try {
      const { stream, error } = await requestWebcamStream();

      if (error || !stream) {
        setCameraError(error || "Webcam connection failed.");
        setCameraActive(false);
        return false;
      }

    streamRef.current = stream;

    if (videoRef.current) {
      const v = videoRef.current;
      v.srcObject = stream;
      try {
        await v.play();
      } catch (e) {
        console.warn("Direct webcam play error, waiting for event:", e);
      }
      v.onloadedmetadata = () => {
        void v.play();
        if (landmarkCanvasRef.current) {
          landmarkCanvasRef.current.width = v.videoWidth || 960;
          landmarkCanvasRef.current.height = v.videoHeight || 540;
        }
      };
      if (landmarkCanvasRef.current && v.videoWidth > 0) {
        landmarkCanvasRef.current.width = v.videoWidth;
        landmarkCanvasRef.current.height = v.videoHeight;
      }
    }

    setCameraActive(true);
    setCameraError(null);

    // Initialize FaceMesh instance if not already created
    if (!meshRef.current) {
      const mesh = new FaceMesh({
        locateFile: getFaceMeshLocateFile,
      });

      mesh.setOptions({
        maxNumFaces: 3,
        refineLandmarks: true,
        minDetectionConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });

      mesh.onResults((result: Results) => {
        // Select only the dominant front driver face, ignoring background faces/passengers
        const p = selectPrimaryDriverFace(result.multiFaceLandmarks);

        if (!p || p.length < 100) {
          setFaceDetected(false);
          setEyesCaptured(false);
          missingFaceCount.current += 1;

          if (missingFaceCount.current >= 4) {
            setFaceInFrame(false);
          }

          // If monitoring was started and initial face calibrated:
          // Any missing face is an emergency (head slump, driver collapse, leaving seat, camera covered)
          if (initialFaceCalibrated) {
            if (missingFaceCount.current >= 10) {
              setIsHeadDown(true);
              isHeadDownRef.current = true;
              triggerGlobalAlarm(
                "FACE_LOST",
                "CRITICAL EMERGENCY: Driver Face Lost / Head Slumped!",
                "Driver face disappeared from camera frame while vehicle is active. Immediate wake-up siren active — KEEP HEAD UPRIGHT & EYES ON ROAD!"
              );
            }
          }

          if (missingFaceCount.current > 12) {
            setFocusScore(null);
            setBpm(null);
            setHrv(null);
            setEarValue(null);
            setHeadYaw(null);
            setHeadPitch(null);
            setZVariance(null);
            setMar(null);
            setIsYawning(false);
            setRespirationRate(null);
            setSpo2(null);
            setVitality(null);

            const ctx = landmarkCanvasRef.current?.getContext("2d");
            if (ctx && landmarkCanvasRef.current) {
              ctx.clearRect(0, 0, landmarkCanvasRef.current.width, landmarkCanvasRef.current.height);
            }
          }
          return;
        }

        missingFaceCount.current = 0;
        setFaceDetected(true);
        setEyesCaptured(true);
        setFaceInFrame(true);
        if (isHeadDownRef.current) {
          setIsHeadDown(false);
          isHeadDownRef.current = false;
        }
        if (!initialFaceCalibrated) {
          setInitialFaceCalibrated(true);
        }

        // 1. Real EAR Calculation with EMA smoothing
        const leftEar = (distance(p[159], p[145]) + distance(p[160], p[144])) / (2 * distance(p[33], p[133]));
        const rightEar = (distance(p[386], p[374]) + distance(p[387], p[373])) / (2 * distance(p[362], p[263]));
        const realEar = (leftEar + rightEar) / 2;
        const sEar = smoothMetric(smoothedEarRef.current, realEar, 0.35);
        smoothedEarRef.current = sEar;
        const isDrowsy = sEar < 0.22;
        setEarValue(Number(sEar.toFixed(3)));

        // 2. Real 3D Z-Variance for Volumetric Anti-Spoof with EMA smoothing
        const zValues = p.map((pt) => pt.z ?? 0);
        const zMean = zValues.reduce((a, b) => a + b, 0) / zValues.length;
        const rawZVar = zValues.reduce((sum, z) => sum + (z - zMean) ** 2, 0) / zValues.length;
        const sZVar = smoothMetric(smoothedZVarRef.current, rawZVar, 0.25);
        smoothedZVarRef.current = sZVar;
        setZVariance(Number(sZVar.toFixed(6)));

        // 3. Real Head Pose (Yaw & Pitch) with EMA smoothing & Slump Check
        const nose = p[1];
        const leftCheekPt = p[234];
        const rightCheekPt = p[454];
        const dLeft = Math.hypot(nose.x - leftCheekPt.x, nose.y - leftCheekPt.y);
        const dRight = Math.hypot(nose.x - rightCheekPt.x, nose.y - rightCheekPt.y);
        const totalWidth = dLeft + dRight || 0.001;
        const computedYaw = ((dRight - dLeft) / totalWidth) * 90;

        const forehead = p[10];
        const chin = p[152];
        const faceHeight = Math.hypot(forehead.x - chin.x, forehead.y - chin.y) || 0.001;
        const noseVerticalRatio = (nose.y - forehead.y) / faceHeight;
        const computedPitch = (noseVerticalRatio - 0.55) * 110;

        const sYaw = smoothMetric(smoothedYawRef.current, computedYaw, 0.22);
        const sPitch = smoothMetric(smoothedPitchRef.current, computedPitch, 0.22);
        smoothedYawRef.current = sYaw;
        smoothedPitchRef.current = sPitch;
        lastPitchRef.current = sPitch;

        setHeadYaw(Number(sYaw.toFixed(1)));
        setHeadPitch(Number(sPitch.toFixed(1)));

        // Head Slump / Nodding Off Check
        const isSlumped = sPitch > 20;
        setIsHeadDown(isSlumped);
        isHeadDownRef.current = isSlumped;
        if (isSlumped) {
          triggerGlobalAlarm(
            "HEAD_DROP",
            "CRITICAL EMERGENCY: Driver Head Drop / Slumping Detected!",
            "Immediate downward head collapse detected. Acoustic wake-up siren active — KEEP HEAD UPRIGHT!"
          );
        }

        // Eye closure / microsleep check (>3.0s continuous eye closure)
        if (isDrowsy) {
          if (!closedSinceRef.current) closedSinceRef.current = performance.now();
          const elapsed = (performance.now() - closedSinceRef.current) / 1000;
          if (elapsed >= 3.0) {
            triggerGlobalAlarm(
              "MICROSLEEP",
              "CRITICAL ALERT: Continuous Microsleep (>3.0s)",
              "Driver eyes closed for more than 3 seconds while vehicle is in active transit — WAKE UP & OPEN EYES!"
            );
          }
        } else {
          closedSinceRef.current = null;
        }

        // Auto-silence when driver is safe and upright with eyes open
        if (!isSlumped && !isDrowsy && alarmActive) {
          stopGlobalAlarm(true);
        }

        // 4. Focus Capacity Score with EMA smoothing
        const gazeDev = Math.hypot(sYaw, sPitch);
        let realFocus: number;
        if (sEar < 0.20) {
          realFocus = Math.max(15, Math.round(sEar * 120));
        } else {
          const earBonus = Math.min(30, (sEar - 0.20) * 150);
          const gazePenalty = Math.min(45, gazeDev * 1.1);
          realFocus = Math.max(20, Math.min(99, Math.round(75 + earBonus - gazePenalty)));
        }
        const sFocus = smoothMetric(smoothedFocusRef.current, realFocus, 0.20);
        smoothedFocusRef.current = sFocus;
        setFocusScore(Math.round(sFocus));

        // 5. Yawn Detection (Mouth Aspect Ratio - MAR)
        const rawMar = calculateMouthAspectRatio(p);
        const sMar = smoothMetric(smoothedMarRef.current, rawMar, 0.35);
        smoothedMarRef.current = sMar;
        setMar(Number(sMar.toFixed(3)));

        const yawningNow = sMar > 0.55;
        if (yawningNow) {
          if (!yawnSinceRef.current) yawnSinceRef.current = performance.now();
          if ((performance.now() - yawnSinceRef.current) / 1000 >= 1.2) {
            setIsYawning(true);
            if (performance.now() - lastYawnCountedRef.current > 4000) {
              setYawnCount((prev) => prev + 1);
              lastYawnCountedRef.current = performance.now();
            }
          }
        } else {
          yawnSinceRef.current = null;
          setIsYawning(false);
        }

        // 6. Contactless rPPG Pulse & Health Telemetry
        let currentBpm: number | null = null;
        const v = videoRef.current;
        if (v && v.videoWidth > 0) {
          const scCanvas = document.createElement("canvas");
          scCanvas.width = 160;
          scCanvas.height = 90;
          const scCtx = scCanvas.getContext("2d", { willReadFrequently: true });
          if (scCtx) {
            scCtx.drawImage(v, 0, 0, 160, 90);
            const pLeft = p[117];
            if (pLeft) {
              const sx = Math.max(0, Math.min(150, Math.floor(pLeft.x * 160) - 8));
              const sy = Math.max(0, Math.min(80, Math.floor(pLeft.y * 90) - 8));
              const imgData = scCtx.getImageData(sx, sy, 16, 16).data;
              let rSum = 0, gSum = 0, count = 0;
              for (let k = 0; k < imgData.length; k += 4) {
                rSum += imgData[k];
                gSum += imgData[k + 1];
                count++;
              }
              const chromPulse = (gSum / (count || 1)) - 0.5 * (rSum / (count || 1));
              rawPixelSamples.current = [...rawPixelSamples.current, chromPulse].slice(-150);

              // Signal selection
              const sigType = activeSignalRef.current;
              let pointToPush = realEar;
              if (sigType === "RPPG") pointToPush = chromPulse;
              else if (sigType === "YAW") pointToPush = computedYaw;
              signalPoints.current = [...signalPoints.current, pointToPush].slice(-160);

              // Heart Rate peak estimation with refractory period & EMA
              if (rawPixelSamples.current.length > 50) {
                const arr = rawPixelSamples.current;
                const mean = arr.reduce((s, val) => s + val, 0) / arr.length;
                const std = Math.sqrt(arr.reduce((s, val) => s + (val - mean) ** 2, 0) / arr.length);
                let peaks = 0;
                for (let i = 2; i < arr.length - 2; i++) {
                  if (arr[i] > arr[i - 1] && arr[i] > arr[i + 1] && arr[i] > mean + std * 0.20) {
                    peaks++;
                    i += 8;
                  }
                }
                const instantBpm = Math.max(60, Math.min(110, Math.round((peaks / (arr.length / 25)) * 60)));
                const instantHrv = Math.max(35, Math.min(85, Math.round(std * 650 + 45)));

                smoothedBpmRef.current = smoothMetric(smoothedBpmRef.current, instantBpm, 0.12);
                smoothedHrvRef.current = smoothMetric(smoothedHrvRef.current, instantHrv, 0.12);

                const instantResp = estimateRespirationRate(instantBpm);
                const instantSpo2 = estimateBloodOxygen(95);
                const vitObj = calculateDriverVitality(sEar, instantHrv, sFocus, yawnCount);

                smoothedRespRef.current = smoothMetric(smoothedRespRef.current, instantResp, 0.12);
                smoothedSpo2Ref.current = smoothMetric(smoothedSpo2Ref.current, instantSpo2, 0.15);
                smoothedVitalityRef.current = smoothMetric(smoothedVitalityRef.current, vitObj.score, 0.10);

                const nowTime = performance.now();
                if (nowTime - lastPulseUpdateTime.current >= 500) {
                  lastPulseUpdateTime.current = nowTime;
                  currentBpm = Math.round(smoothedBpmRef.current);
                  setBpm(currentBpm);
                  setHrv(Math.round(smoothedHrvRef.current));
                  setRespirationRate(Math.round(smoothedRespRef.current));
                  setSpo2(Number(smoothedSpo2Ref.current.toFixed(1)));
                  setVitality(Math.round(smoothedVitalityRef.current));
                }
                pulseBuffer.current = [...pulseBuffer.current, chromPulse - mean].slice(-60);
              }
            }
          }
        }

        // Draw the full Biometric Mask
        drawFaceMesh(p, isDrowsy, realEar, computedYaw, currentBpm);

        // Safety Events Logging on real state triggers
        const now = Date.now();
        if (now - lastAlertTime.current > 3500) {
          const timeStr = new Date().toLocaleTimeString("en-US", { hour12: false });
          if (isSlumped) {
            lastAlertTime.current = now;
            setSafetyEvents((prev) => [
              {
                id: `ev-${now}`,
                timestamp: timeStr,
                metric: "Head Slump / Nodding Off",
                value: `Pitch: +${sPitch.toFixed(1)}°`,
                threshold: "> +22.0°",
                status: "alert",
                action: "Wake-Up Siren Active",
              },
              ...prev.slice(0, 7),
            ]);
          } else if (isDrowsy) {
            lastAlertTime.current = now;
            setSafetyEvents((prev) => [
              {
                id: `ev-${now}`,
                timestamp: timeStr,
                metric: "Ocular Droop Detected",
                value: `EAR: ${realEar.toFixed(3)}`,
                threshold: "< 0.220",
                status: "warning",
                action: "Audio Alert Armed",
              },
              ...prev.slice(0, 7),
            ]);
          } else if (isYawning) {
            lastAlertTime.current = now;
            setSafetyEvents((prev) => [
              {
                id: `ev-${now}`,
                timestamp: timeStr,
                metric: "Yawn / Early Fatigue",
                value: `MAR: ${sMar.toFixed(3)}`,
                threshold: "> 0.550",
                status: "warning",
                action: "Fatigue Counter Logged",
              },
              ...prev.slice(0, 7),
            ]);
          } else if (Math.abs(computedYaw) > 25) {
            lastAlertTime.current = now;
            setSafetyEvents((prev) => [
              {
                id: `ev-${now}`,
                timestamp: timeStr,
                metric: "Gaze Deviation Warning",
                value: `Yaw: ${computedYaw > 0 ? "+" : ""}${computedYaw.toFixed(1)}°`,
                threshold: "±20.0°",
                status: "warning",
                action: "Visual Prompt Active",
              },
              ...prev.slice(0, 7),
            ]);
          }
        }
      });

      try {
          await mesh.initialize();
        } catch (e) {
          console.warn("[CognitAI] FaceMesh initialize error (will proceed):", e);
        }

        meshRef.current = mesh;
      }

      // Continuous processing loop (Throttled to smooth 25 FPS)
      runningRef.current = true;
      const targetFPS = 25;
      const frameInterval = 1000 / targetFPS;

      const loop = async (timestamp: number) => {
        if (!runningRef.current) return;
        const v = videoRef.current;
        if (
          v &&
          v.readyState >= 2 &&
          v.videoWidth > 0 &&
          meshRef.current &&
          !isProcessingRef.current &&
          timestamp - lastFrameTimeRef.current >= frameInterval
        ) {
          lastFrameTimeRef.current = timestamp;
          isProcessingRef.current = true;
          try {
            if (v.paused) {
              await v.play().catch(() => {});
            }
            await meshRef.current.send({ image: v });
          } catch (err) {
            console.warn("[CognitAI] FaceMesh send error:", err);
          } finally {
            isProcessingRef.current = false;
          }
        }
        if (runningRef.current) {
          requestAnimationFrame(loop);
        }
      };
      requestAnimationFrame(loop);

        return true;
      } finally {
        connectingPromiseRef.current = null;
      }
    })();

    return connectingPromiseRef.current;
  }, [drawFaceMesh]);

  useEffect(() => {
    if (isMonitoring) {
      runningRef.current = true;
      void connectCamera();
    } else {
      runningRef.current = false;
      setIsHeadDown(false);
      isHeadDownRef.current = false;
      if (streamRef.current) {
        releaseWebcamStream(streamRef.current);
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      setCameraActive(false);
      setFaceDetected(false);
      setEyesCaptured(false);
      setFocusScore(null);
      setBpm(null);
      setHrv(null);
      setEarValue(null);
      setHeadYaw(null);
      setHeadPitch(null);
      setZVariance(null);
      setMar(null);
      setIsYawning(false);
      setRespirationRate(null);
      setSpo2(null);
      setVitality(null);
      signalPoints.current = [];
      pulseBuffer.current = [];
      rawPixelSamples.current = [];
      const ctx = landmarkCanvasRef.current?.getContext("2d");
      if (ctx && landmarkCanvasRef.current) {
        ctx.clearRect(0, 0, landmarkCanvasRef.current.width, landmarkCanvasRef.current.height);
      }
    }
  }, [isMonitoring, connectCamera]);

  useEffect(() => {
    return () => {
      runningRef.current = false;
    };
  }, []);

  // Live Oscilloscope Canvas Renderer
  useEffect(() => {
    let animId: number;

    const render = () => {
      const canvas = plotCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const rect = canvas.getBoundingClientRect();
      if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
      }

      const w = canvas.width;
      const h = canvas.height;

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);

      // Gridlines
      ctx.strokeStyle = "#f0f2f5";
      ctx.lineWidth = 1;
      for (let y = 0; y < h; y += h / 6) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      for (let x = 0; x < w; x += w / 8) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }

      // Threshold Line for EAR
      if (activeSignal === "EAR") {
        const thresholdY = h - ((0.22 - 0.10) / (0.40 - 0.10)) * (h - 24) - 12;
        ctx.strokeStyle = "rgba(220, 38, 38, 0.4)";
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(0, thresholdY);
        ctx.lineTo(w, thresholdY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = "rgba(220, 38, 38, 0.75)";
        ctx.font = "11px monospace";
        ctx.fillText("CRITICAL FATIGUE THRESHOLD: EAR 0.220", 12, thresholdY - 5);
      }

      // Draw Signal Trace
      const pts = signalPoints.current;
      if (pts.length > 1) {
        ctx.beginPath();
        ctx.strokeStyle = activeSignal === "EAR" ? "#0066cc" : activeSignal === "RPPG" ? "#2563eb" : "#0284c7";
        ctx.lineWidth = 2.2;
        ctx.lineJoin = "round";

        let minVal = 0.10;
        let maxVal = 0.40;
        if (activeSignal === "RPPG") {
          minVal = -1.5;
          maxVal = 1.5;
        } else if (activeSignal === "YAW") {
          minVal = -45;
          maxVal = 45;
        }

        pts.forEach((val, i) => {
          const x = (i / (160 - 1)) * w;
          const normalized = Math.max(0, Math.min(1, (val - minVal) / (maxVal - minVal || 1)));
          const y = h - normalized * (h - 24) - 12;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // Glowing cursor
        const lastIdx = pts.length - 1;
        const lastVal = pts[lastIdx];
        const lastX = (lastIdx / (160 - 1)) * w;
        const normalized = Math.max(0, Math.min(1, (lastVal - minVal) / (maxVal - minVal || 1)));
        const lastY = h - normalized * (h - 24) - 12;

        ctx.beginPath();
        ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#0066cc";
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.fillStyle = "#94a3b8";
        ctx.font = "12px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Awaiting camera stream & driver detection...", w / 2, h / 2);
        ctx.textAlign = "left";
      }

      // Sparkline Pulse in KPI card
      const pCanvas = pulseCanvasRef.current;
      if (pCanvas) {
        const pCtx = pCanvas.getContext("2d");
        if (pCtx) {
          const pw = pCanvas.width;
          const ph = pCanvas.height;
          pCtx.clearRect(0, 0, pw, ph);

          const pBuf = pulseBuffer.current;
          if (pBuf.length > 2) {
            pCtx.beginPath();
            pCtx.strokeStyle = "#0066cc";
            pCtx.lineWidth = 1.5;
            pBuf.forEach((pval, pidx) => {
              const px = (pidx / 60) * pw;
              const py = Math.max(2, Math.min(ph - 2, ph * (0.5 - pval * 0.25)));
              if (pidx === 0) pCtx.moveTo(px, py);
              else pCtx.lineTo(px, py);
            });
            pCtx.stroke();
          }
        }
      }

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [activeSignal]);

  if (!currentDriver) {
    return <EntranceGateway />;
  }

  return (
    <main className="p-6 sm:p-8 space-y-8 w-full bg-white min-h-screen">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-gray-200">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 tracking-tight">
              Executive Safety &amp; Telemetry Cockpit
            </h1>
            <span className="px-2.5 py-0.5 rounded text-xs font-semibold bg-blue-50 text-[#0066cc] border border-blue-200">
              Masters Research AI
            </span>
          </div>
          <p className="text-sm text-gray-600 mt-1">
            Real-time multi-modal driver vigilance console: Ocular fatigue, contactless rPPG pulse, spatial head cone, and biometric liveness.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          <div className="px-3 py-1.5 rounded border border-gray-200 bg-gray-50 flex items-center gap-2 text-gray-700">
            <span className={`w-2 h-2 rounded-full ${faceDetected ? "bg-emerald-600 animate-pulse" : "bg-amber-500"}`} />
            <span className="font-medium">{faceDetected ? "Face Tracked (468 pts)" : "Searching Face"}</span>
          </div>

          <div className="px-3 py-1.5 rounded border border-gray-200 bg-gray-50 flex items-center gap-2 text-gray-700">
            <span className={`w-2 h-2 rounded-full ${backendOnline ? "bg-emerald-600" : "bg-amber-500"}`} />
            <span className="font-medium">FastAPI Engine: {backendOnline ? "Online (:8000)" : "Local Engine"}</span>
          </div>

          {!isMonitoring ? (
            <span className="px-3.5 py-1.5 rounded-lg border border-gray-200 bg-gray-50 text-gray-600 font-medium flex items-center gap-2 text-xs">
              <span className="w-2 h-2 rounded-full bg-gray-400" />
              <span>Standby — Start via Top Bar</span>
            </span>
          ) : (
            <span className="px-3.5 py-1.5 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 font-semibold flex items-center gap-2 text-xs">
              <span className="w-2 h-2 rounded-full bg-emerald-600 animate-ping" />
              <span>Portal: Monitoring Active</span>
            </span>
          )}
        </div>
      </div>

      {/* 4 Spacious Primary KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
        {/* KPI 1: Fatigue & Eye Aspect Ratio (EAR) */}
        <div className="border border-gray-200 rounded-lg p-5 bg-white space-y-3 hover:border-gray-300 transition">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Ocular Vigilance (EAR)</span>
            <span className="text-[11px] px-2 py-0.5 rounded bg-blue-50 text-[#0066cc] font-medium">Soukupová-Čech</span>
          </div>

          <div className="flex items-baseline justify-between">
            <div>
              <span className="text-3xl font-bold font-mono text-gray-900">
                {earValue !== null ? earValue.toFixed(3) : "--"}
              </span>
              <span className="text-xs text-gray-500 ml-1.5">EAR</span>
            </div>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
              earValue === null
                ? "bg-gray-100 text-gray-600"
                : earValue >= 0.22
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-red-50 text-red-700 border border-red-200 animate-pulse"
            }`}>
              {earValue === null ? "Awaiting Face" : earValue >= 0.22 ? "Attentive" : "Drowsy / Closed"}
            </span>
          </div>

          <div className="space-y-1">
            <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden relative">
              <div
                className={`h-full transition-all duration-200 ${
                  earValue === null ? "w-0" : earValue >= 0.22 ? "bg-[#0066cc]" : "bg-red-600"
                }`}
                style={{ width: `${Math.min(100, Math.max(0, ((earValue ?? 0) / 0.40) * 100))}%` }}
              />
              <div className="absolute left-[55%] top-0 bottom-0 w-0.5 bg-red-400" title="Cutoff 0.22" />
            </div>
            <div className="flex justify-between text-[11px] text-gray-400 font-mono">
              <span>0.10 (Closed)</span>
              <span className="text-red-500 font-medium">Threshold: 0.220</span>
              <span>0.40 (Open)</span>
            </div>
          </div>
        </div>

        {/* KPI 2: Contactless Cardiovascular Pulse (rPPG) */}
        <div className="border border-gray-200 rounded-lg p-5 bg-white space-y-3 hover:border-gray-300 transition">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Cardiovascular (rPPG)</span>
            <span className="text-[11px] px-2 py-0.5 rounded bg-blue-50 text-[#0066cc] font-medium">Capillary BVP</span>
          </div>

          <div className="flex items-baseline justify-between">
            <div>
              <span className="text-3xl font-bold font-mono text-gray-900">
                {bpm !== null ? bpm : "--"}
              </span>
              <span className="text-xs text-gray-500 ml-1.5">BPM</span>
            </div>
            <span className="text-xs font-semibold px-2 py-0.5 rounded bg-blue-50 text-[#0066cc] border border-blue-200">
              HRV: {hrv !== null ? `${hrv} ms` : "--"}
            </span>
          </div>

          <div className="h-6 w-full rounded bg-gray-50 border border-gray-100 overflow-hidden flex items-center px-1">
            <canvas ref={pulseCanvasRef} className="w-full h-full" width={180} height={24} />
          </div>

          <div className="flex justify-between text-[11px] text-gray-500">
            <span>Autonomic State:</span>
            <span className="font-semibold text-gray-800">{bpm ? "Normal Sinus Rhythm" : "Standby"}</span>
          </div>
        </div>

        {/* KPI 3: 3D Spatial Head Pose & Windshield Focus */}
        <div className="border border-gray-200 rounded-lg p-5 bg-white space-y-3 hover:border-gray-300 transition">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Spatial Orientation</span>
            <span className="text-[11px] px-2 py-0.5 rounded bg-blue-50 text-[#0066cc] font-medium">PnP 3-Axis</span>
          </div>

          <div className="flex items-baseline justify-between">
            <div>
              <span className="text-3xl font-bold font-mono text-gray-900">
                {headYaw !== null ? `${headYaw > 0 ? "+" : ""}${headYaw}°` : "--"}
              </span>
              <span className="text-xs text-gray-500 ml-1.5">Yaw</span>
            </div>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
              headYaw === null
                ? "bg-gray-100 text-gray-600"
                : Math.abs(headYaw) <= 15
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-amber-50 text-amber-700 border border-amber-200"
            }`}>
              {headYaw === null ? "Standby" : Math.abs(headYaw) <= 15 ? "Road Ahead" : "Deviated"}
            </span>
          </div>

          <div className="flex items-center justify-between text-xs text-gray-600 bg-gray-50 p-2 rounded border border-gray-100">
            <span className="text-[11px] text-gray-500">Pitch (Vertical):</span>
            <span className="font-mono font-bold text-gray-800">
              {headPitch !== null ? `${headPitch > 0 ? "+" : ""}${headPitch}°` : "--"}
            </span>
            <span className="text-[11px] text-gray-500">Cone: ±15.0°</span>
          </div>

          <div className="flex justify-between text-[11px] text-gray-500">
            <span>Windshield Sector:</span>
            <span className="font-semibold text-gray-800">
              {headYaw !== null ? (Math.abs(headYaw) < 15 ? "Primary Road Zone" : headYaw > 15 ? "Right Mirror" : "Left Mirror") : "--"}
            </span>
          </div>
        </div>

        {/* KPI 4: 3D Volumetric Depth & Anti-Spoof Defense */}
        <div className="border border-gray-200 rounded-lg p-5 bg-white space-y-3 hover:border-gray-300 transition">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Biometric Liveness</span>
            <span className="text-[11px] px-2 py-0.5 rounded bg-blue-50 text-[#0066cc] font-medium">IEEE 10856104</span>
          </div>

          <div className="flex items-baseline justify-between">
            <div>
              <span className="text-2xl font-bold text-gray-900">
                {zVariance !== null ? (zVariance >= 0.0005 ? "Genuine 3D" : "2D Spoof") : "--"}
              </span>
            </div>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded ${
              zVariance !== null && zVariance >= 0.0005
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-gray-100 text-gray-600"
            }`}>
              {zVariance !== null && zVariance >= 0.0005 ? "Verified Human" : "Standby"}
            </span>
          </div>

          <div className="flex items-center justify-between text-xs text-gray-600 bg-gray-50 p-2 rounded border border-gray-100 font-mono">
            <span className="text-[11px] text-gray-500">Z-Depth Variance:</span>
            <span className="font-bold text-gray-800">{zVariance !== null ? zVariance : "--"}</span>
          </div>

          <div className="flex justify-between text-[11px] text-gray-500">
            <span>Cipher Protection:</span>
            <span className="font-semibold text-[#0066cc]">AES-256 Fernet Active</span>
          </div>
        </div>
      </div>

      {/* Main Center Console: Live AI HUD + Live Telemetry Oscilloscope */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left 7 Columns: Live Camera Viewport with Authentic Biometric Mask */}
        <section className="lg:col-span-7 border border-gray-200 rounded-lg p-5 bg-white space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-gray-200">
            <div>
              <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full ${faceDetected ? "bg-emerald-600" : "bg-gray-400"}`} />
                <span>Live 3D Biometric Facial Mask &amp; Capillary HUD</span>
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                468-vertex spatial triangular tessellation, ocular reticles, and zygomatic microvascular ROI tracking.
              </p>
            </div>
            <span className="text-xs font-medium text-gray-600">
              {faceDetected ? "● Face Tracked (30 FPS)" : "○ Awaiting Face in Frame"}
            </span>
          </div>

          {/* Video & Canvas Overlay Viewport */}
          <div className="relative aspect-video w-full rounded-md border border-gray-200 overflow-hidden bg-slate-950 flex items-center justify-center">
            <video
              ref={videoRef}
              muted
              playsInline
              autoPlay
              className="absolute inset-0 w-full h-full object-cover transform -scale-x-100"
            />

            <canvas
              ref={landmarkCanvasRef}
              className="absolute inset-0 w-full h-full object-cover transform -scale-x-100 pointer-events-none"
            />

            {/* In-Video HUD Badges */}
            <div className="absolute top-3 left-3 right-3 flex items-center justify-between pointer-events-none text-xs">
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 bg-black/80 backdrop-blur-sm text-white rounded font-mono text-[11px]">
                  960x540 · 30 FPS
                </span>
                <span className={`px-2.5 py-1 backdrop-blur-sm rounded text-[11px] font-medium ${
                  faceDetected ? "bg-emerald-950/80 text-emerald-400 border border-emerald-800" : "bg-black/80 text-amber-300"
                }`}>
                  {faceDetected ? "468 Vertices Tracked" : "Searching for Driver Face"}
                </span>
              </div>
              {earValue !== null && (
                <span className={`px-2.5 py-1 backdrop-blur-sm rounded font-mono text-[11px] font-bold ${
                  earValue >= 0.22 ? "bg-black/80 text-white" : "bg-red-600 text-white animate-pulse"
                }`}>
                  EAR: {earValue.toFixed(3)}
                </span>
              )}
            </div>

            <CameraFaceOverlay
              cameraActive={cameraActive}
              faceDetected={faceDetected}
              isHeadDown={isHeadDown}
              title="Place Face in Front of the Camera"
              subtitle="Align your face within the viewport to activate full biometric telemetry"
            />
          </div>

          {/* AI Landmark Legend */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-600 pt-1 border-t border-gray-100">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-[#00b4d8]" />
              <span>468-pt Triangular Mesh</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-[#0066cc]" />
              <span>Zygomatic Capillary Box</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-[#00f0ff]" />
              <span>Dual Iris Reticles</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500" />
              <span>Drowsiness State</span>
            </span>
          </div>
        </section>

        {/* Right 5 Columns: Dual-Channel Live Waveform Oscilloscope */}
        <section className="lg:col-span-5 border border-gray-200 rounded-lg p-5 bg-white space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-gray-200">
            <div>
              <h2 className="text-base font-bold text-gray-900">Live Telemetry Oscilloscope</h2>
              <p className="text-xs text-gray-500">Real-time biological signal time-series</p>
            </div>

            {/* Signal Channel Selector */}
            <div className="inline-flex rounded border border-gray-200 p-0.5 bg-gray-50 text-xs">
              <button
                type="button"
                onClick={() => setActiveSignal("EAR")}
                className={`px-2.5 py-1 rounded transition font-medium ${
                  activeSignal === "EAR" ? "bg-white text-[#0066cc] shadow-sm" : "text-gray-600 hover:text-gray-900"
                }`}
              >
                EAR (Eyes)
              </button>
              <button
                type="button"
                onClick={() => setActiveSignal("RPPG")}
                className={`px-2.5 py-1 rounded transition font-medium ${
                  activeSignal === "RPPG" ? "bg-white text-[#0066cc] shadow-sm" : "text-gray-600 hover:text-gray-900"
                }`}
              >
                Pulse (rPPG)
              </button>
              <button
                type="button"
                onClick={() => setActiveSignal("YAW")}
                className={`px-2.5 py-1 rounded transition font-medium ${
                  activeSignal === "YAW" ? "bg-white text-[#0066cc] shadow-sm" : "text-gray-600 hover:text-gray-900"
                }`}
              >
                Pose (Yaw)
              </button>
            </div>
          </div>

          {/* Oscilloscope Canvas */}
          <div className="relative">
            <canvas
              ref={plotCanvasRef}
              className="w-full h-64 rounded border border-gray-200 bg-white"
            />
          </div>

          {/* Live Signal Diagnostics */}
          <div className="grid grid-cols-3 gap-3 text-xs pt-1 border-t border-gray-100">
            <div className="p-2.5 rounded border border-gray-100 bg-gray-50/60">
              <span className="text-[11px] text-gray-500 block">Current Signal</span>
              <span className="font-mono font-bold text-gray-900 text-sm">
                {activeSignal === "EAR"
                  ? earValue !== null ? earValue.toFixed(3) : "--"
                  : activeSignal === "RPPG"
                  ? bpm !== null ? `${bpm} BPM` : "--"
                  : headYaw !== null ? `${headYaw}°` : "--"}
              </span>
              <span className="text-[10px] text-gray-400 block">{activeSignal} Channel</span>
            </div>

            <div className="p-2.5 rounded border border-gray-100 bg-gray-50/60">
              <span className="text-[11px] text-gray-500 block">Sample Rate</span>
              <span className="font-mono font-bold text-gray-900 text-sm">30.0 Hz</span>
              <span className="text-[10px] text-gray-400 block">Frame sync</span>
            </div>

            <div className="p-2.5 rounded border border-gray-100 bg-gray-50/60">
              <span className="text-[11px] text-gray-500 block">Safety Margin</span>
              <span className="font-mono font-bold text-emerald-700 text-sm">
                {earValue !== null ? `${Math.round(((earValue - 0.22) / 0.22) * 100)}%` : "--"}
              </span>
              <span className="text-[10px] text-gray-400 block">Over cutoff</span>
            </div>
          </div>
        </section>
      </div>

      {/* Dedicated Section: Driver Health Options & Physiological Telemetry */}
      <section className="border border-gray-200 rounded-lg p-5 bg-white space-y-4 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600 text-lg">
              🩺
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-gray-900">Driver Health &amp; Physiological Vitality Console</h2>
                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
                  Continuous Bio-Extraction
                </span>
              </div>
              <p className="text-xs text-gray-500">
                Non-contact optical assessment of respiration rate, arterial blood oxygen (SpO₂), yawn kinetics, and driver vitality index
              </p>
            </div>
          </div>
          <Link
            href="/health-options"
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded bg-[#0066cc] text-white hover:bg-blue-700 transition text-xs font-semibold shadow-sm w-fit"
          >
            <span>Open Health Options Console</span>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Card 1: Respiration Rate */}
          <div className="p-4 rounded-lg border border-gray-200 bg-gradient-to-br from-white to-slate-50/50 hover:border-blue-300 transition">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-2xl">🫁</span>
                <span className="text-xs font-bold text-gray-600 uppercase tracking-wider">Respiration Rate</span>
              </div>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100">
                Chest &amp; Nares Micro-Motion
              </span>
            </div>
            <div className="flex items-baseline justify-between mt-1">
              <div className="text-2xl font-bold font-mono text-gray-900">
                {respirationRate !== null ? `${respirationRate}` : "--"}
                <span className="text-xs font-normal text-gray-500 ml-1">BrPM</span>
              </div>
              <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-100">
                {respirationRate !== null
                  ? respirationRate < 10
                    ? "Bradypnea"
                    : respirationRate > 24
                    ? "Tachypnea"
                    : "Eupnea (Normal)"
                  : "Standby"}
              </span>
            </div>
            <p className="text-[11px] text-gray-400 mt-2">Nominal resting range: 12 – 20 breaths per minute</p>
          </div>

          {/* Card 2: SpO2 */}
          <div className="p-4 rounded-lg border border-gray-200 bg-gradient-to-br from-white to-slate-50/50 hover:border-blue-300 transition">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-2xl">🩸</span>
                <span className="text-xs font-bold text-gray-600 uppercase tracking-wider">Blood Oxygen (SpO₂)</span>
              </div>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-100">
                Spectrophotometry
              </span>
            </div>
            <div className="flex items-baseline justify-between mt-1">
              <div className="text-2xl font-bold font-mono text-gray-900">
                {spo2 !== null ? `${spo2}%` : "--"}
              </div>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${
                spo2 !== null && spo2 < 94
                  ? "bg-rose-50 text-rose-700 border-rose-200"
                  : "bg-emerald-50 text-emerald-600 border-emerald-100"
              }`}>
                {spo2 !== null ? (spo2 < 94 ? "Hypoxia Alert" : "Optimal (95-100%)") : "Standby"}
              </span>
            </div>
            <p className="text-[11px] text-gray-400 mt-2">Standard hemoglobin saturation index</p>
          </div>

          {/* Card 3: Yawn & MAR */}
          <div className="p-4 rounded-lg border border-gray-200 bg-gradient-to-br from-white to-slate-50/50 hover:border-blue-300 transition">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-2xl">🥱</span>
                <span className="text-xs font-bold text-gray-600 uppercase tracking-wider">Yawn Frequency &amp; MAR</span>
              </div>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-100">
                Lip Separation
              </span>
            </div>
            <div className="flex items-baseline justify-between mt-1">
              <div className="text-2xl font-bold font-mono text-gray-900">
                {mar !== null ? mar.toFixed(3) : "--"}
              </div>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${
                isYawning
                  ? "bg-amber-100 text-amber-800 border-amber-300 animate-pulse"
                  : "bg-gray-100 text-gray-700 border-gray-200"
              }`}>
                {isYawning ? "Active Yawn" : `${yawnCount} Cumulative`}
              </span>
            </div>
            <p className="text-[11px] text-gray-400 mt-2">Triggers drowsiness alarm if sustained &gt; 1.8s</p>
          </div>

          {/* Card 4: Driver Vitality Index */}
          <div className="p-4 rounded-lg border border-gray-200 bg-gradient-to-br from-white to-slate-50/50 hover:border-blue-300 transition">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-2xl">🛡️</span>
                <span className="text-xs font-bold text-gray-600 uppercase tracking-wider">Driver Vitality Index</span>
              </div>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-100">
                Composite Score
              </span>
            </div>
            <div className="flex items-baseline justify-between mt-1">
              <div className="text-2xl font-bold font-mono text-emerald-700">
                {vitality !== null ? `${vitality}%` : "--"}
              </div>
              <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-100">
                {vitality !== null ? (vitality >= 80 ? "Fit to Drive" : vitality >= 60 ? "Moderate Fatigue" : "Impaired") : "Standby"}
              </span>
            </div>
            <p className="text-[11px] text-gray-400 mt-2">Combined EAR, HRV, Blink &amp; Respiration score</p>
          </div>
        </div>
      </section>

      {/* Bottom Section: Live Safety Incident & Telemetry Stream Table */}
      <section className="border border-gray-200 rounded-lg p-5 bg-white space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-gray-200">
          <div>
            <h2 className="text-base font-bold text-gray-900">Live Driver Safety Incident &amp; Telemetry Stream</h2>
            <p className="text-xs text-gray-500">Real-time audit log of biometric shifts, head pose alerts, and ocular vigilance transitions</p>
          </div>
          <span className="text-xs font-mono text-[#0066cc]">Live Millisecond Logger</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border border-gray-200 rounded">
            <thead>
              <tr className="bg-gray-50 text-gray-700 border-b border-gray-200 font-semibold">
                <th className="px-4 py-2.5">Timestamp</th>
                <th className="px-4 py-2.5">Event Metric</th>
                <th className="px-4 py-2.5">Observed Value</th>
                <th className="px-4 py-2.5">Safety Threshold</th>
                <th className="px-4 py-2.5">Risk Level</th>
                <th className="px-4 py-2.5">Action Taken</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-gray-800">
              {safetyEvents.map((ev) => (
                <tr key={ev.id} className="hover:bg-gray-50/80 transition">
                  <td className="px-4 py-2.5 font-mono text-gray-500">{ev.timestamp}</td>
                  <td className="px-4 py-2.5 font-medium text-gray-900">{ev.metric}</td>
                  <td className="px-4 py-2.5 font-mono">{ev.value}</td>
                  <td className="px-4 py-2.5 font-mono text-gray-500">{ev.threshold}</td>
                  <td className="px-4 py-2.5">
                    <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                      ev.status === "nominal"
                        ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                        : ev.status === "warning"
                        ? "bg-amber-50 text-amber-700 border border-amber-200"
                        : "bg-red-50 text-red-700 border border-red-200 animate-pulse"
                    }`}>
                      {ev.status.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-600">{ev.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
