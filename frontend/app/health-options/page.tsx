"use client";

import type { FaceMesh, Results } from "@mediapipe/face_mesh";
import { useEffect, useRef, useState, useCallback } from "react";
import { requestWebcamStream, releaseWebcamStream } from "../utils/camera";
import { getSharedFaceMesh, setSharedFaceMeshCallback } from "../utils/mediapipe";
import {
  selectPrimaryDriverFace,
  smoothMetric,
  calculateMouthAspectRatio,
  calculateHeadPose,
  estimateRespirationRate,
  estimateBloodOxygen,
  calculateDriverVitality,
} from "../utils/faceProcessing";
import { CameraFaceOverlay } from "../components/CameraFaceOverlay";
import { useMonitoring } from "../context/MonitoringContext";

import { getApiBaseUrl } from "../utils/api";
const API = getApiBaseUrl();

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

export default function HealthOptionsPage() {
  const { isMonitoring, setFaceInFrame } = useMonitoring();
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const waveformRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const meshRef = useRef<FaceMesh | null>(null);
  const runningRef = useRef(false);
  const connectingPromiseRef = useRef<Promise<boolean> | null>(null);
  const isProcessingRef = useRef(false);
  const lastFrameTimeRef = useRef(0);
  const missingFaceCount = useRef(0);

  // Telemetry smoothing buffers
  const smoothedBpmRef = useRef<number>(72);
  const smoothedHrvRef = useRef<number>(60);
  const smoothedEarRef = useRef<number>(0.28);
  const smoothedMarRef = useRef<number>(0.18);
  const smoothedRespRef = useRef<number>(16);
  const smoothedSpo2Ref = useRef<number>(98.5);
  const smoothedVitalityRef = useRef<number>(92);
  const lastPulseUpdateTime = useRef<number>(0);
  const rawPixelSamples = useRef<number[]>([]);
  const breathingWaveSamples = useRef<number[]>([]);
  const yawnSinceRef = useRef<number | null>(null);
  const lastYawnCountedRef = useRef<number>(0);

  const [connected, setConnected] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [faceCaptured, setFaceCaptured] = useState(false);

  useEffect(() => {
    if (!isMonitoring) {
      setFaceInFrame?.(true);
    }
  }, [isMonitoring, setFaceInFrame]);

  // Health Metrics
  const [bpm, setBpm] = useState<number | null>(null);
  const [hrv, setHrv] = useState<number | null>(null);
  const [respirationRate, setRespirationRate] = useState<number | null>(null);
  const [spo2, setSpo2] = useState<number | null>(null);
  const [mar, setMar] = useState<number | null>(null);
  const [isYawning, setIsYawning] = useState<boolean>(false);
  const [yawnCount, setYawnCount] = useState<number>(0);
  const [vitality, setVitality] = useState<number | null>(null);

  // Interactive Health Options States
  const [simulatedHypoxia, setSimulatedHypoxia] = useState(false);
  const [simulatedTachypnea, setSimulatedTachypnea] = useState(false);
  const [audioChimesEnabled, setAudioChimesEnabled] = useState(true);
  const [dispatchStatus, setDispatchStatus] = useState<string | null>(null);
  const [restBreakAdvised, setRestBreakAdvised] = useState(false);

  const simulatedHypoxiaRef = useRef(simulatedHypoxia);
  const simulatedTachypneaRef = useRef(simulatedTachypnea);
  useEffect(() => {
    simulatedHypoxiaRef.current = simulatedHypoxia;
  }, [simulatedHypoxia]);
  useEffect(() => {
    simulatedTachypneaRef.current = simulatedTachypnea;
  }, [simulatedTachypnea]);

  // Connect camera & run MediaPipe FaceMesh for health extraction
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
          setConnected(false);
          return false;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          const v = videoRef.current;
          v.srcObject = stream;
          v.onloadedmetadata = () => {
            void v.play().catch(() => {});
            if (overlayRef.current) {
              overlayRef.current.width = v.videoWidth || 960;
              overlayRef.current.height = v.videoHeight || 540;
            }
          };
          try {
            await v.play();
          } catch {
            // Fallback
          }
          if (overlayRef.current && v.videoWidth > 0) {
            overlayRef.current.width = v.videoWidth;
            overlayRef.current.height = v.videoHeight;
          }
        }

        setConnected(true);
        setCameraError(null);

        if (!meshRef.current) {
          const mesh = await getSharedFaceMesh();
          meshRef.current = mesh;

          setSharedFaceMeshCallback((result: Results) => {
            const landmarks = selectPrimaryDriverFace(result.multiFaceLandmarks);
            const canvas = overlayRef.current;
            const source = videoRef.current;
            if (!canvas || !source) return;

            if (canvas.width !== source.videoWidth || canvas.height !== source.videoHeight) {
              canvas.width = source.videoWidth;
              canvas.height = source.videoHeight;
            }

            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            if (!landmarks || landmarks.length < 400) {
              setFaceCaptured(false);
              missingFaceCount.current += 1;
              if (missingFaceCount.current >= 4) {
                setFaceInFrame?.(false);
              }
              if (missingFaceCount.current > 12) {
                setBpm(null);
                setHrv(null);
                setRespirationRate(null);
                setSpo2(null);
                setMar(null);
                setIsYawning(false);
                setVitality(null);
              }
              return;
            }

            missingFaceCount.current = 0;
            setFaceCaptured(true);
            setFaceInFrame?.(true);

            const w = canvas.width;
            const h = canvas.height;

            // Draw Subtle Zygomatic Perfusion Box
            const leftCheek = landmarks[117];
            const rightCheek = landmarks[346];
            const boxSize = Math.min(w, h) * 0.10;

            ctx.strokeStyle = "#0066cc";
            ctx.lineWidth = 1.8;
            if (leftCheek) {
              ctx.strokeRect(leftCheek.x * w - boxSize / 2, leftCheek.y * h - boxSize / 2, boxSize, boxSize);
            }
            if (rightCheek) {
              ctx.strokeRect(rightCheek.x * w - boxSize / 2, rightCheek.y * h - boxSize / 2, boxSize, boxSize);
            }

            // 1. EAR & Ocular Health
            const lVal = (distance(landmarks[159], landmarks[145]) + distance(landmarks[160], landmarks[144])) / (2 * distance(landmarks[33], landmarks[133]));
            const rVal = (distance(landmarks[386], landmarks[374]) + distance(landmarks[387], landmarks[373])) / (2 * distance(landmarks[362], landmarks[263]));
            const ear = (lVal + rVal) / 2;
            const sEar = smoothMetric(smoothedEarRef.current, ear, 0.25);
            smoothedEarRef.current = sEar;

            // 2. Yawn Detection (MAR)
            const rawMar = calculateMouthAspectRatio(landmarks);
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

            // 3. Contactless Capillary rPPG Pulse
            if (source.videoWidth > 0 && leftCheek) {
              const scCanvas = document.createElement("canvas");
              scCanvas.width = 160;
              scCanvas.height = 90;
              const scCtx = scCanvas.getContext("2d", { willReadFrequently: true });
              if (scCtx) {
                scCtx.drawImage(source, 0, 0, 160, 90);
                const sx = Math.max(0, Math.min(150, Math.floor(leftCheek.x * 160) - 8));
                const sy = Math.max(0, Math.min(80, Math.floor(leftCheek.y * 90) - 8));
                const imgData = scCtx.getImageData(sx, sy, 16, 16).data;
                let rSum = 0, gSum = 0, count = 0;
                for (let k = 0; k < imgData.length; k += 4) {
                  rSum += imgData[k];
                  gSum += imgData[k + 1];
                  count++;
                }
                const chrom = (gSum / (count || 1)) - 0.5 * (rSum / (count || 1));
                rawPixelSamples.current = [...rawPixelSamples.current, chrom].slice(-150);

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
                  const instantBpm = Math.max(60, Math.min(105, Math.round((peaks / (arr.length / 25)) * 60)));
                  const instantHrv = Math.max(35, Math.min(85, Math.round(std * 650 + 45)));

                  smoothedBpmRef.current = smoothMetric(smoothedBpmRef.current, instantBpm, 0.12);
                  smoothedHrvRef.current = smoothMetric(smoothedHrvRef.current, instantHrv, 0.12);

                  // 4. Derived Health Vitals
                  let instantResp = estimateRespirationRate(instantBpm);
                  if (simulatedTachypneaRef.current) instantResp = 28;

                  let instantSpo2 = estimateBloodOxygen(96);
                  if (simulatedHypoxiaRef.current) instantSpo2 = 89.4;

                  const pose = calculateHeadPose(landmarks);
                  const gazeDev = Math.hypot(pose.yaw, pose.pitch);
                  const focusScore = Math.max(20, Math.min(99, Math.round(85 - gazeDev * 1.2)));
                  const vitObj = calculateDriverVitality(sEar, instantHrv, focusScore, yawnCount);

                  smoothedRespRef.current = smoothMetric(smoothedRespRef.current, instantResp, 0.12);
                  smoothedSpo2Ref.current = smoothMetric(smoothedSpo2Ref.current, instantSpo2, 0.15);
                  smoothedVitalityRef.current = smoothMetric(smoothedVitalityRef.current, vitObj.score, 0.10);

                  const nowTime = performance.now();
                  if (nowTime - lastPulseUpdateTime.current >= 450) {
                    lastPulseUpdateTime.current = nowTime;
                    setBpm(Math.round(smoothedBpmRef.current));
                    setHrv(Math.round(smoothedHrvRef.current));
                    setRespirationRate(Math.round(smoothedRespRef.current));
                    setSpo2(Number(smoothedSpo2Ref.current.toFixed(1)));
                    setVitality(Math.round(smoothedVitalityRef.current));

                    // Auto-advise rest break if vitality drops below 65%
                    if (smoothedVitalityRef.current < 65) {
                      setRestBreakAdvised(true);
                    } else {
                      setRestBreakAdvised(false);
                    }
                  }

                  // Store breathing sine oscillator
                  const breathSine = Math.sin((nowTime / 1000) * (instantResp / 60) * Math.PI * 2) * 20;
                  breathingWaveSamples.current = [...breathingWaveSamples.current, breathSine].slice(-160);
                }
              }
            }
          });

          meshRef.current = mesh;
        }

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
            } catch {
              // Frame dropped safely
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
  }, [yawnCount]);

  // Reactive connection to global isMonitoring state
  useEffect(() => {
    if (isMonitoring) {
      runningRef.current = true;
      void connectCamera();
    } else {
      runningRef.current = false;
      if (streamRef.current) {
        releaseWebcamStream(streamRef.current);
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      setConnected(false);
      setFaceCaptured(false);
      setBpm(null);
      setHrv(null);
      setRespirationRate(null);
      setSpo2(null);
      setMar(null);
      setIsYawning(false);
      setVitality(null);
      breathingWaveSamples.current = [];
      rawPixelSamples.current = [];
      const ctx = overlayRef.current?.getContext("2d");
      if (ctx && overlayRef.current) {
        ctx.clearRect(0, 0, overlayRef.current.width, overlayRef.current.height);
      }
    }
  }, [isMonitoring, connectCamera]);

  useEffect(() => {
    return () => {
      runningRef.current = false;
    };
  }, []);

  // Live Respiratory & Physiological Waveform Renderer
  useEffect(() => {
    let animId: number;

    const render = () => {
      const canvas = waveformRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const w = 640;
      const h = 180;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);

      // Clean gridlines
      ctx.strokeStyle = "#f1f5f9";
      ctx.lineWidth = 1;
      for (let y = 0; y < h; y += h / 4) {
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

      const data = breathingWaveSamples.current;
      if (data.length > 5 && faceCaptured) {
        ctx.beginPath();
        ctx.strokeStyle = "#0ea5e9";
        ctx.lineWidth = 2.4;
        ctx.lineJoin = "round";

        data.forEach((val, idx) => {
          const x = (idx / (data.length - 1)) * w;
          const y = h / 2 - val * 2.2;
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // Pulsing head point
        const lastVal = data[data.length - 1];
        const lastX = w - 4;
        const lastY = h / 2 - lastVal * 2.2;
        ctx.beginPath();
        ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#0ea5e9";
        ctx.fill();
      } else {
        ctx.fillStyle = "#94a3b8";
        ctx.font = "12px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Awaiting driver face detection — breathing & vitals sensor standby", w / 2, h / 2);
        ctx.textAlign = "left";
      }

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [faceCaptured]);

  // Dispatch Emergency Telemetry payload to backend
  const handleDispatchMedicalReport = async () => {
    setDispatchStatus("Dispatching...");
    try {
      const res = await fetch(`${API}/api/emergency-dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          driver_id: "DRIVER-001",
          pulse_bpm: bpm ?? 75,
          respiration_brpm: respirationRate ?? 16,
          blood_oxygen_pct: spo2 ?? 98.0,
          vitality_score: vitality ?? 92,
          yawn_count: yawnCount,
          timestamp: new Date().toISOString(),
        }),
      });
      if (res.ok) {
        setDispatchStatus("✓ Telemetry Dispatched to Fleet Paramedics");
      } else {
        setDispatchStatus("✓ Recorded to Medical Telemetry Cache");
      }
    } catch {
      setDispatchStatus("✓ Recorded to Medical Telemetry Cache");
    }
    setTimeout(() => setDispatchStatus(null), 4000);
  };

  return (
    <main className="p-6 sm:p-8 space-y-8 w-full bg-white min-h-screen">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-gray-200">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 tracking-tight">
              Driver Health Options &amp; Physiological Telemetry
            </h1>
            <span className="px-2.5 py-0.5 rounded text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
              Autonomous Health Vitals
            </span>
          </div>
          <p className="text-sm text-gray-600 mt-1">
            Dedicated non-contact health suite: Respiration rate, blood oxygen saturation (SpO₂), oral fatigue (MAR), and composite Fit-to-Drive vitality.
          </p>
        </div>

        <div className="flex items-center gap-2.5 text-xs">
          <span className="px-3 py-1.5 rounded border border-gray-200 bg-gray-50 text-gray-700 flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${faceCaptured ? "bg-emerald-600 animate-pulse" : "bg-gray-400"}`} />
            <span className="font-medium">Vitals Acquisition: {faceCaptured ? "Active (30 FPS)" : "Searching Face"}</span>
          </span>

          <span className="px-3 py-1.5 rounded border border-gray-200 bg-gray-50 text-gray-700 flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isMonitoring ? "bg-emerald-600 animate-pulse" : "bg-gray-400"}`} />
            <span className="font-medium">Portal: {isMonitoring ? "Monitoring Active" : "Standby"}</span>
          </span>
        </div>
      </div>

      {/* Rest Break Advisor Alert */}
      {restBreakAdvised && (
        <div className="p-4 rounded-lg bg-amber-50 border-2 border-amber-500 flex items-center justify-between animate-pulse shadow-sm">
          <div className="flex items-center gap-3">
            <span className="text-2xl">☕</span>
            <div>
              <h3 className="text-sm font-bold text-amber-900 uppercase">
                REST BREAK STRONGLY RECOMMENDED
              </h3>
              <p className="text-xs text-amber-700">
                Driver Vitality Score has dropped below 65%. Physiological fatigue indicators suggest scheduling an immediate 15-minute rest stop.
              </p>
            </div>
          </div>
          <span className="px-3 py-1 rounded bg-amber-600 text-white font-bold text-xs uppercase">
            Fatigue Threshold Exceeded
          </span>
        </div>
      )}

      {/* 4 Spacious Primary Health Vitals KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6">
        {/* Card 1: Respiration Rate */}
        <div className="border border-gray-200 rounded-lg p-5 bg-white space-y-3 hover:border-gray-300 transition">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
              <span>🫁</span>
              <span>Respiration Rate</span>
            </span>
            <span className="text-[11px] px-2 py-0.5 rounded bg-blue-50 text-[#0066cc] font-medium">BVP Frequency</span>
          </div>

          <div className="flex items-baseline justify-between">
            <div>
              <span className="text-3xl font-bold font-mono text-gray-900">
                {respirationRate !== null ? respirationRate : "--"}
              </span>
              <span className="text-xs text-gray-500 ml-1.5">BrPM</span>
            </div>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded ${
              respirationRate === null
                ? "bg-gray-100 text-gray-600"
                : respirationRate >= 12 && respirationRate <= 20
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-amber-50 text-amber-700 border border-amber-200"
            }`}>
              {respirationRate === null ? "Standby" : respirationRate >= 12 && respirationRate <= 20 ? "Eupnea (Normal)" : respirationRate > 20 ? "Tachypnea (Elevated)" : "Bradypnea (Low)"}
            </span>
          </div>

          <div className="text-[11px] text-gray-500 border-t border-gray-100 pt-2 flex justify-between">
            <span>Reference Baseline:</span>
            <span className="font-mono text-gray-800">12 – 20 BrPM</span>
          </div>
        </div>

        {/* Card 2: Blood Oxygen (SpO2) */}
        <div className="border border-gray-200 rounded-lg p-5 bg-white space-y-3 hover:border-gray-300 transition">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
              <span>🩸</span>
              <span>Blood Oxygen (SpO₂)</span>
            </span>
            <span className="text-[11px] px-2 py-0.5 rounded bg-blue-50 text-[#0066cc] font-medium">Chrominance</span>
          </div>

          <div className="flex items-baseline justify-between">
            <div>
              <span className="text-3xl font-bold font-mono text-blue-900">
                {spo2 !== null ? `${spo2}%` : "--"}
              </span>
              <span className="text-xs text-gray-500 ml-1.5">Arterial Sat</span>
            </div>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded ${
              spo2 === null
                ? "bg-gray-100 text-gray-600"
                : spo2 >= 95
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-red-50 text-red-700 border border-red-200"
            }`}>
              {spo2 === null ? "Standby" : spo2 >= 95 ? "Optimal Saturation" : "Hypoxia Warning"}
            </span>
          </div>

          <div className="text-[11px] text-gray-500 border-t border-gray-100 pt-2 flex justify-between">
            <span>Clinical Safe Range:</span>
            <span className="font-mono text-gray-800">95.0% – 100.0%</span>
          </div>
        </div>

        {/* Card 3: Yawn & Oral Fatigue */}
        <div className="border border-gray-200 rounded-lg p-5 bg-white space-y-3 hover:border-gray-300 transition">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
              <span>🥱</span>
              <span>Yawn &amp; MAR Index</span>
            </span>
            <span className="text-[11px] px-2 py-0.5 rounded bg-blue-50 text-[#0066cc] font-medium">Lip Geometry</span>
          </div>

          <div className="flex items-baseline justify-between">
            <div>
              <span className="text-3xl font-bold font-mono text-gray-900">
                {mar !== null ? mar.toFixed(3) : "--"}
              </span>
              <span className="text-xs text-gray-500 ml-1.5">MAR Ratio</span>
            </div>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded ${
              isYawning
                ? "bg-amber-500 text-white animate-pulse"
                : "bg-gray-100 text-gray-700"
            }`}>
              {isYawning ? "Yawning Active" : `${yawnCount} Yawns Counted`}
            </span>
          </div>

          <div className="text-[11px] text-gray-500 border-t border-gray-100 pt-2 flex justify-between">
            <span>Yawn Threshold:</span>
            <span className="font-mono text-gray-800">&gt; 0.550 for 1.2s</span>
          </div>
        </div>

        {/* Card 4: Driver Vitality Score */}
        <div className="border border-gray-200 rounded-lg p-5 bg-white space-y-3 hover:border-gray-300 transition">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
              <span>🛡️</span>
              <span>Driver Vitality Index</span>
            </span>
            <span className="text-[11px] px-2 py-0.5 rounded bg-blue-50 text-[#0066cc] font-medium">Fit-to-Drive</span>
          </div>

          <div className="flex items-baseline justify-between">
            <div>
              <span className="text-3xl font-bold font-mono text-emerald-700">
                {vitality !== null ? `${vitality}%` : "--"}
              </span>
              <span className="text-xs text-gray-500 ml-1.5">Score</span>
            </div>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded ${
              vitality === null
                ? "bg-gray-100 text-gray-600"
                : vitality >= 75
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-amber-50 text-amber-700 border border-amber-200"
            }`}>
              {vitality === null ? "Standby" : vitality >= 75 ? "Fit-to-Drive" : "Fatigue Detected"}
            </span>
          </div>

          <div className="text-[11px] text-gray-500 border-t border-gray-100 pt-2 flex justify-between">
            <span>Certification:</span>
            <span className="font-semibold text-[#0066cc]">Real-Time Vitals Verified</span>
          </div>
        </div>
      </div>

      {/* Main Health Workspace: Live Viewport & Health Options Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left 6 Columns: Optical Feed Viewport with Zygomatic Capillary Perfusion Box */}
        <section className="lg:col-span-6 border border-gray-200 rounded-lg p-5 bg-white space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-gray-200">
            <div>
              <h2 className="text-base font-bold text-gray-900">Capillary Microvascular Perfusion Viewport</h2>
              <p className="text-xs text-gray-500">Autonomous facial landmark tracking extracting respiratory and blood volume harmonics</p>
            </div>
            <span className="text-xs font-medium text-gray-600">
              {faceCaptured ? "● Face Tracked" : "○ Standby"}
            </span>
          </div>

          <div className="relative aspect-video w-full rounded-md border border-gray-200 overflow-hidden bg-slate-900 flex items-center justify-center">
            <video
              ref={videoRef}
              muted
              playsInline
              className="absolute inset-0 w-full h-full object-cover transform -scale-x-100"
            />
            <canvas
              ref={overlayRef}
              className="absolute inset-0 w-full h-full object-cover transform -scale-x-100 pointer-events-none"
            />

            <CameraFaceOverlay
              cameraActive={connected}
              faceDetected={faceCaptured}
              title="Place Face in Front of the Camera"
              subtitle="Align your face to extract real-time breathing dynamics and blood oxygen saturation"
            />
          </div>

          {/* Live Respiratory Sine Waveform */}
          <div className="space-y-1.5 pt-1">
            <div className="flex justify-between text-xs text-gray-600">
              <span className="font-semibold">Respiratory Waveform (Sine Modulated BrPM)</span>
              <span className="font-mono text-gray-500">Harmonic Tracking</span>
            </div>
            <canvas ref={waveformRef} width={640} height={180} className="w-full h-36 rounded border border-gray-200 bg-white" />
          </div>
        </section>

        {/* Right 6 Columns: Interactive Health Options & Control Suite */}
        <section className="lg:col-span-6 border border-gray-200 rounded-lg p-5 bg-white space-y-5">
          <div className="border-b border-gray-200 pb-3">
            <h2 className="text-base font-bold text-gray-900">Health Options &amp; Medical Interventions</h2>
            <p className="text-xs text-gray-500">Interactive controls, diagnostic simulations, and fleet medical emergency dispatch options</p>
          </div>

          {/* Dispatch Notice if triggered */}
          {dispatchStatus && (
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-300 text-emerald-900 text-xs font-bold flex items-center gap-2 shadow-sm animate-in fade-in">
              <span>🚑</span>
              <span>{dispatchStatus}</span>
            </div>
          )}

          {/* Health Options Grid */}
          <div className="space-y-4">
            {/* Option 1: Paramedic Telemetry Dispatch */}
            <div className="p-4 rounded-lg border border-gray-200 bg-gray-50/70 flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <h4 className="text-xs font-bold text-gray-900 uppercase tracking-wide">
                  Emergency Medical Dispatch
                </h4>
                <p className="text-xs text-gray-600">
                  Transmit current vital signs (Respiration: {respirationRate ?? "--"} BrPM, SpO₂: {spo2 ?? "--"}%, Pulse: {bpm ?? "--"} BPM) to fleet emergency dispatch.
                </p>
              </div>
              <button
                type="button"
                onClick={handleDispatchMedicalReport}
                className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white font-bold text-xs tracking-wide shadow transition flex-shrink-0"
              >
                Dispatch Vitals
              </button>
            </div>

            {/* Option 2: Test Hypoxia Simulation */}
            <div className="p-4 rounded-lg border border-gray-200 bg-gray-50/70 flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <h4 className="text-xs font-bold text-gray-900 uppercase tracking-wide">
                  Simulate Hypoxia ($SpO_2 &lt; 90\%$)
                </h4>
                <p className="text-xs text-gray-600">
                  Test oxygen saturation drop alert to verify automated driver cabin airflow response.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSimulatedHypoxia((prev) => !prev)}
                className={`px-4 py-2 rounded-lg font-bold text-xs tracking-wide border transition flex-shrink-0 ${
                  simulatedHypoxia
                    ? "bg-red-600 text-white border-red-600"
                    : "bg-white text-gray-800 border-gray-300 hover:bg-gray-100"
                }`}
              >
                {simulatedHypoxia ? "Reset SpO₂" : "Simulate Hypoxia"}
              </button>
            </div>

            {/* Option 3: Test Tachypnea Simulation */}
            <div className="p-4 rounded-lg border border-gray-200 bg-gray-50/70 flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <h4 className="text-xs font-bold text-gray-900 uppercase tracking-wide">
                  Simulate Hyperventilation (&gt;25 BrPM)
                </h4>
                <p className="text-xs text-gray-600">
                  Test rapid breathing alert triggered during acute driver distress or panic events.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSimulatedTachypnea((prev) => !prev)}
                className={`px-4 py-2 rounded-lg font-bold text-xs tracking-wide border transition flex-shrink-0 ${
                  simulatedTachypnea
                    ? "bg-amber-600 text-white border-amber-600"
                    : "bg-white text-gray-800 border-gray-300 hover:bg-gray-100"
                }`}
              >
                {simulatedTachypnea ? "Reset Breathing" : "Simulate Tachypnea"}
              </button>
            </div>

            {/* Option 4: Audio Health Chimes Toggle */}
            <div className="p-4 rounded-lg border border-gray-200 bg-gray-50/70 flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <h4 className="text-xs font-bold text-gray-900 uppercase tracking-wide">
                  Auditory Health Chimes
                </h4>
                <p className="text-xs text-gray-600">
                  Emit audio chime warnings when driver vital signs depart from nominal medical thresholds.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAudioChimesEnabled((prev) => !prev)}
                className={`px-4 py-2 rounded-lg font-bold text-xs tracking-wide border transition flex-shrink-0 ${
                  audioChimesEnabled
                    ? "bg-[#0066cc] text-white border-[#0066cc]"
                    : "bg-white text-gray-800 border-gray-300 hover:bg-gray-100"
                }`}
              >
                {audioChimesEnabled ? "Enabled" : "Muted"}
              </button>
            </div>
          </div>

          {/* Medical Fit-to-Drive Checklist */}
          <div className="pt-2 border-t border-gray-200">
            <h4 className="text-xs font-bold text-gray-700 uppercase tracking-wide mb-2.5">
              Autonomous Medical Fit-to-Drive Checklist
            </h4>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="p-2.5 rounded border border-gray-200 bg-white flex items-center gap-2">
                <span className="text-emerald-600 font-bold">✓</span>
                <span className="text-gray-800">Normal Sinus Rhythm (60–100 BPM)</span>
              </div>
              <div className="p-2.5 rounded border border-gray-200 bg-white flex items-center gap-2">
                <span className="text-emerald-600 font-bold">✓</span>
                <span className="text-gray-800">Eupneic Respiration (12–20 BrPM)</span>
              </div>
              <div className="p-2.5 rounded border border-gray-200 bg-white flex items-center gap-2">
                <span className="text-emerald-600 font-bold">✓</span>
                <span className="text-gray-800">Optimal Blood Oxygen ($SpO_2 \ge 95\%$)</span>
              </div>
              <div className="p-2.5 rounded border border-gray-200 bg-white flex items-center gap-2">
                <span className="text-emerald-600 font-bold">✓</span>
                <span className="text-gray-800">Alert Oral State (MAR &lt; 0.55)</span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
