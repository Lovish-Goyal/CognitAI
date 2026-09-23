"use client";

import { FaceMesh, Results, FACEMESH_TESSELATION, FACEMESH_CONTOURS } from "@mediapipe/face_mesh";
import { useEffect, useRef, useState, useCallback } from "react";
import { requestWebcamStream, releaseWebcamStream } from "../utils/camera";
import { getFaceMeshLocateFile } from "../utils/mediapipe";
import { selectPrimaryDriverFace, smoothMetric, calculateMouthAspectRatio, calculateHeadPose } from "../utils/faceProcessing";
import { CameraFaceOverlay } from "../components/CameraFaceOverlay";

const API = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

// Eye Landmark Contours
const LEFT_EYE = [33, 160, 158, 133, 153, 144, 33];
const RIGHT_EYE = [362, 385, 387, 263, 373, 380, 362];

import { useMonitoring } from "../context/MonitoringContext";

export default function FatigueMonitor() {
  const {
    isMonitoring,
    initialFaceCalibrated,
    setInitialFaceCalibrated,
    triggerGlobalAlarm,
    stopGlobalAlarm,
    alarmActive: globalAlarmActive,
    setFaceInFrame,
  } = useMonitoring();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const plotCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const meshRef = useRef<FaceMesh | null>(null);
  const runningRef = useRef(false);
  const connectingPromiseRef = useRef<Promise<boolean> | null>(null);
  const isProcessingRef = useRef(false);
  const lastFrameTimeRef = useRef(0);
  const smoothedEarRef = useRef<number | null>(null);
  const smoothedMarRef = useRef<number | null>(null);
  const smoothedPitchRef = useRef<number | null>(null);

  // Buffer & Timers
  const earBuffer = useRef<number[]>([]);
  const closureWindow = useRef<boolean[]>([]);
  const lowSince = useRef<number | null>(null);
  const outSince = useRef<number | null>(null);
  const headDownSinceRef = useRef<number | null>(null);
  const yawnSinceRef = useRef<number | null>(null);
  const lastYawnCountedRef = useRef<number>(0);
  const lastPitchRef = useRef<number>(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sirenInterval = useRef<number | null>(null);
  const alarmActive = useRef(false);

  // States
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [eyesOpenTime, setEyesOpenTime] = useState<number>(0);

  useEffect(() => {
    if (!isMonitoring) {
      setFaceInFrame?.(true);
    }
  }, [isMonitoring, setFaceInFrame]);

  const [leftEar, setLeftEar] = useState<number | null>(null);
  const [rightEar, setRightEar] = useState<number | null>(null);
  const [meanEar, setMeanEar] = useState<number | null>(null);
  const [perclos, setPerclos] = useState<number>(0);
  const [closedSeconds, setClosedSeconds] = useState<number>(0);

  // Yawning & Head Slump States
  const [mar, setMar] = useState<number | null>(null);
  const [yawnCount, setYawnCount] = useState<number>(0);
  const [isYawning, setIsYawning] = useState<boolean>(false);
  const [headPitch, setHeadPitch] = useState<number | null>(null);
  const [isHeadDown, setIsHeadDown] = useState<boolean>(false);
  // Monitoring Control States
  const [autoRecovered, setAutoRecovered] = useState(false);

  const [alarm, setAlarm] = useState(false);
  const [alarmReason, setAlarmReason] = useState<"MICROSLEEP" | "OUT_OF_FRAME" | "HEAD_DROP">("MICROSLEEP");

  // Demonstrations
  const [simulatedSleep, setSimulatedSleep] = useState(false);
  const [simulatedOut, setSimulatedOut] = useState(false);
  const [simulatedYawn, setSimulatedYawn] = useState(false);
  const [simulatedHeadDown, setSimulatedHeadDown] = useState(false);

  const simulatedSleepRef = useRef(simulatedSleep);
  const simulatedOutRef = useRef(simulatedOut);
  const simulatedYawnRef = useRef(simulatedYawn);
  const simulatedHeadDownRef = useRef(simulatedHeadDown);

  useEffect(() => {
    simulatedSleepRef.current = simulatedSleep;
    if (!simulatedSleep && alarmActive.current && alarmReason === "MICROSLEEP") {
      stopAlarm();
      setAutoRecovered(true);
      setTimeout(() => setAutoRecovered(false), 3500);
    }
  }, [simulatedSleep, alarmReason]);
  useEffect(() => {
    simulatedOutRef.current = simulatedOut;
    if (!simulatedOut && alarmActive.current && alarmReason === "OUT_OF_FRAME") {
      stopAlarm();
      setAutoRecovered(true);
      setTimeout(() => setAutoRecovered(false), 3500);
    }
  }, [simulatedOut, alarmReason]);
  useEffect(() => {
    simulatedYawnRef.current = simulatedYawn;
  }, [simulatedYawn]);
  useEffect(() => {
    simulatedHeadDownRef.current = simulatedHeadDown;
    if (!simulatedHeadDown && alarmActive.current && alarmReason === "HEAD_DROP") {
      stopAlarm();
      setAutoRecovered(true);
      setTimeout(() => setAutoRecovered(false), 3500);
    }
  }, [simulatedHeadDown, alarmReason]);



  const triggerAlarm = (reason: "MICROSLEEP" | "OUT_OF_FRAME" | "HEAD_DROP") => {
    alarmActive.current = true;
    setAlarm(true);
    setAlarmReason(reason);

    const alarmCode = reason === "OUT_OF_FRAME" ? "FACE_LOST" : reason;
    triggerGlobalAlarm(alarmCode);
  };

  const stopAlarm = () => {
    alarmActive.current = false;
    setAlarm(false);
    setSimulatedSleep(false);
    setSimulatedOut(false);
    setSimulatedYawn(false);
    setSimulatedHeadDown(false);
    lowSince.current = null;
    outSince.current = null;
    headDownSinceRef.current = null;
    yawnSinceRef.current = null;
    setIsHeadDown(false);
    setIsYawning(false);
    setClosedSeconds(0);

    stopGlobalAlarm(true);
  };

  // Draw full facial wireframe mask + focused eye reticles
  const drawEyeHUD = (landmarks: Array<{ x: number; y: number; z?: number }>, isDrowsy: boolean) => {
    const canvas = canvasRef.current;
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

    // 1. Full Facial Tessellation Mask
    ctx.strokeStyle = isDrowsy ? "rgba(239, 68, 68, 0.35)" : "rgba(0, 180, 255, 0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < FACEMESH_TESSELATION.length; i++) {
      const [sIdx, eIdx] = FACEMESH_TESSELATION[i];
      const p1 = landmarks[sIdx];
      const p2 = landmarks[eIdx];
      if (p1 && p2) {
        ctx.moveTo(p1.x * w, p1.y * h);
        ctx.lineTo(p2.x * w, p2.y * h);
      }
    }
    ctx.stroke();

    // 2. Bold Eyelid Contours
    const eyeColor = isDrowsy ? "#ef4444" : "#0066cc";
    const drawContour = (indices: number[]) => {
      ctx.beginPath();
      ctx.strokeStyle = eyeColor;
      ctx.lineWidth = 2.4;
      for (let i = 0; i < indices.length; i++) {
        const pt = landmarks[indices[i]];
        if (!pt) continue;
        if (i === 0) ctx.moveTo(pt.x * w, pt.y * h);
        else ctx.lineTo(pt.x * w, pt.y * h);
      }
      ctx.stroke();
    };

    drawContour(LEFT_EYE);
    drawContour(RIGHT_EYE);

    // 3. Iris Centers with Targeting Reticles
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
      ctx.arc(ix, iy, 10, 0, Math.PI * 2);
      ctx.strokeStyle = isDrowsy ? "rgba(239, 68, 68, 0.8)" : "rgba(0, 240, 255, 0.8)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // 4. Eye Bounding Brackets
    [LEFT_EYE, RIGHT_EYE].forEach((eyeIndices) => {
      const xs = eyeIndices.map((i) => (landmarks[i]?.x ?? 0) * w);
      const ys = eyeIndices.map((i) => (landmarks[i]?.y ?? 0) * h);
      const minX = Math.min(...xs) - 8;
      const maxX = Math.max(...xs) + 8;
      const minY = Math.min(...ys) - 8;
      const maxY = Math.max(...ys) + 8;

      ctx.strokeStyle = isDrowsy ? "rgba(239, 68, 68, 0.6)" : "rgba(0, 102, 204, 0.5)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
    });
  };

  // Connect Camera & Setup MediaPipe FaceMesh
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
          v.onloadedmetadata = () => {
            void v.play().catch(() => {});
            if (canvasRef.current) {
              canvasRef.current.width = v.videoWidth || 960;
              canvasRef.current.height = v.videoHeight || 540;
            }
          };
          v.srcObject = stream;
          try {
            await v.play();
          } catch (e) {
            console.warn("Webcam direct play error:", e);
          }
          if (canvasRef.current && v.videoWidth > 0) {
            canvasRef.current.width = v.videoWidth;
            canvasRef.current.height = v.videoHeight;
          }
        }

        setCameraActive(true);
        setCameraError(null);

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

            if (!p || p.length === 0 || simulatedOutRef.current) {
              setFaceInFrame(false);
              setLeftEar(null);
              setRightEar(null);
              setMeanEar(null);
              setMar(null);
              lowSince.current = null;
              setClosedSeconds(0);

              const ctx = canvasRef.current?.getContext("2d");
              if (ctx && canvasRef.current) {
                ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
              }

              // CRITICAL: Check if loss of face was caused by driver nodding off / head slumping downward!
              if (simulatedHeadDownRef.current || lastPitchRef.current > 16 || headDownSinceRef.current !== null) {
                setIsHeadDown(true);
                if (!headDownSinceRef.current) headDownSinceRef.current = performance.now();
                const elapsedHeadDown = (performance.now() - headDownSinceRef.current) / 1000;
                if (elapsedHeadDown >= 0.8) {
                  triggerAlarm("HEAD_DROP");
                }
                return;
              }

              setIsHeadDown(false);
              headDownSinceRef.current = null;

              if (!outSince.current) outSince.current = performance.now();
              const elapsed = (performance.now() - outSince.current) / 1000;
              // If monitoring was started and face calibrated, missing face triggers alarm in >= 0.8s
              if (initialFaceCalibrated && (elapsed >= 0.8 || simulatedOutRef.current)) {
                triggerAlarm("OUT_OF_FRAME");
              }
              return;
            }

            outSince.current = null;
            setFaceInFrame(true);
            if (!initialFaceCalibrated) {
              setInitialFaceCalibrated(true);
            }

            // 1. Head Pose & Slump / Nodding Off Check
            const pose = calculateHeadPose(p);
            const currentPitch = simulatedHeadDownRef.current ? 34 : pose.pitch;
            const sPitch = smoothMetric(smoothedPitchRef.current, currentPitch, 0.35);
            smoothedPitchRef.current = sPitch;
            lastPitchRef.current = sPitch;
            setHeadPitch(Number(sPitch.toFixed(1)));

            const isSlumped = sPitch > 22 || simulatedHeadDownRef.current;
            if (isSlumped) {
              setIsHeadDown(true);
              if (!headDownSinceRef.current) headDownSinceRef.current = performance.now();
              const duration = (performance.now() - headDownSinceRef.current) / 1000;
              if (duration >= 1.2) {
                triggerAlarm("HEAD_DROP");
              }
            } else {
              setIsHeadDown(false);
              headDownSinceRef.current = null;
              if (alarmActive.current && alarmReason === "HEAD_DROP") {
                stopAlarm();
              }
            }

            // 2. Mouth Aspect Ratio (MAR) & Yawning Detection
            const rawMar = simulatedYawnRef.current ? 0.68 : calculateMouthAspectRatio(p);
            const sMar = smoothMetric(smoothedMarRef.current, rawMar, 0.35);
            smoothedMarRef.current = sMar;
            setMar(Number(sMar.toFixed(3)));

            const yawningNow = sMar > 0.55 || simulatedYawnRef.current;
            if (yawningNow) {
              if (!yawnSinceRef.current) yawnSinceRef.current = performance.now();
              const yawnDuration = (performance.now() - yawnSinceRef.current) / 1000;
              if (yawnDuration >= 1.2) {
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

            // 3. Eye Aspect Ratio (EAR) & Microsleep Detection
            let lVal: number;
            let rVal: number;

            if (simulatedSleepRef.current) {
              lVal = 0.12;
              rVal = 0.12;
            } else {
              lVal = (distance(p[159], p[145]) + distance(p[160], p[144])) / (2 * distance(p[33], p[133]));
              rVal = (distance(p[386], p[374]) + distance(p[387], p[373])) / (2 * distance(p[362], p[263]));
            }

            const mean = (lVal + rVal) / 2;
            const sMean = smoothMetric(smoothedEarRef.current, mean, 0.35);
            smoothedEarRef.current = sMean;

            setLeftEar(Number(lVal.toFixed(3)));
            setRightEar(Number(rVal.toFixed(3)));
            setMeanEar(Number(sMean.toFixed(3)));

            const isLow = sMean < 0.22;
            drawEyeHUD(p, isLow);

            // Buffer
            earBuffer.current = [...earBuffer.current, mean].slice(-160);

            // PERCLOS (Rolling 30s ~ 900 frames)
            closureWindow.current = [...closureWindow.current, isLow].slice(-900);
            const perclosVal = (closureWindow.current.filter(Boolean).length / closureWindow.current.length) * 100;
            setPerclos(Number(perclosVal.toFixed(1)));

            // Microsleep check (> 3000ms continuous closure)
            if (isLow) {
              if (!lowSince.current) lowSince.current = performance.now();
              const duration = (performance.now() - lowSince.current) / 1000;
              setClosedSeconds(Number(duration.toFixed(1)));
              if (duration >= 3.0) {
                triggerAlarm("MICROSLEEP");
              }
            } else {
              lowSince.current = null;
              setClosedSeconds(0);

              // AUTOMATIC ALARM DISMISSAL:
              // "alaram jb samne aa jaye face fir bnd ho jayega automatic"
              // When the driver wakes up, opens eyes, and looks forward, alarm is automatically silenced!
              if (
                alarmActive.current &&
                !isSlumped &&
                !simulatedSleepRef.current &&
                !simulatedHeadDownRef.current &&
                !simulatedOutRef.current
              ) {
                stopAlarm();
                setAutoRecovered(true);
                setTimeout(() => setAutoRecovered(false), 3500);
              }
            }
          });

          try {
            await mesh.initialize();
          } catch (e) {
            console.warn("FaceMesh initialize error (will proceed):", e);
          }

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
            } catch (err) {
              console.warn("[FatigueMonitor] FaceMesh send error:", err);
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
  }, []);

  useEffect(() => {
    if (isMonitoring) {
      runningRef.current = true;
      void connectCamera();
    } else {
      runningRef.current = false;
      stopAlarm();
      if (streamRef.current) {
        releaseWebcamStream(streamRef.current);
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      setCameraActive(false);
      setLeftEar(null);
      setRightEar(null);
      setMeanEar(null);
      setMar(null);
      setHeadPitch(null);
      setIsHeadDown(false);
      setIsYawning(false);
      setClosedSeconds(0);
      const ctx = canvasRef.current?.getContext("2d");
      if (ctx && canvasRef.current) {
        ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
    }
  }, [isMonitoring, connectCamera]);

  useEffect(() => {
    return () => {
      runningRef.current = false;
      stopAlarm();
    };
  }, []);

  // Live High-Resolution EAR Waveform Canvas
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

      // Grid
      ctx.strokeStyle = "#f1f5f9";
      ctx.lineWidth = 1;
      for (let y = 0; y < h; y += h / 5) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Cutoff threshold line (0.22)
      const thresholdY = h - ((0.22 - 0.10) / (0.40 - 0.10)) * (h - 24) - 12;
      ctx.strokeStyle = "rgba(220, 38, 38, 0.4)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, thresholdY);
      ctx.lineTo(w, thresholdY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "rgba(220, 38, 38, 0.8)";
      ctx.font = "11px monospace";
      ctx.fillText("CRITICAL FATIGUE CUTOFF (EAR 0.220)", 10, thresholdY - 5);

      // Trace
      const pts = earBuffer.current;
      if (pts.length > 1) {
        ctx.beginPath();
        ctx.strokeStyle = "#0066cc";
        ctx.lineWidth = 2.2;
        ctx.lineJoin = "round";

        pts.forEach((val, i) => {
          const x = (i / (160 - 1)) * w;
          const normalized = Math.max(0, Math.min(1, (val - 0.10) / 0.30));
          const y = h - normalized * (h - 24) - 12;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // Cursor
        const lastVal = pts[pts.length - 1];
        const lastX = w;
        const normalized = Math.max(0, Math.min(1, (lastVal - 0.10) / 0.30));
        const lastY = h - normalized * (h - 24) - 12;

        ctx.beginPath();
        ctx.arc(lastX - 2, lastY, 4, 0, Math.PI * 2);
        ctx.fillStyle = lastVal < 0.22 ? "#dc2626" : "#0066cc";
        ctx.fill();
      }

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, []);

  return (
    <main className="p-6 sm:p-8 space-y-8 w-full bg-white min-h-screen">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-gray-200">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 tracking-tight">
              Neuro-Ophthalmic Fatigue Monitor
            </h1>
            <span className="px-2.5 py-0.5 rounded text-xs font-semibold bg-blue-50 text-[#0066cc] border border-blue-200">
              Soukupová-Čech (2016)
            </span>
          </div>
          <p className="text-sm text-gray-600 mt-1">
            Millisecond ocular biomechanics: Eye Aspect Ratio (EAR), PERCLOS integration, and two-stage emergency alert logic.
          </p>
        </div>

        {/* Action & Simulation Bar */}
        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          <span className="px-3 py-1.5 rounded border border-gray-200 bg-gray-50 text-gray-700 flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isMonitoring ? "bg-emerald-600 animate-pulse" : "bg-gray-400"}`} />
            <span className="font-medium">Portal: {isMonitoring ? "Monitoring Active" : "Standby"}</span>
          </span>

          <button
            type="button"
            disabled={!isMonitoring}
            onClick={() => {
              if (simulatedSleep) stopAlarm();
              else {
                setSimulatedOut(false);
                setSimulatedYawn(false);
                setSimulatedHeadDown(false);
                setSimulatedSleep(true);
              }
            }}
            className={`px-3.5 py-1.5 rounded font-medium border transition disabled:opacity-40 disabled:cursor-not-allowed ${
              simulatedSleep
                ? "bg-red-600 text-white border-red-600 shadow-sm"
                : "bg-white text-gray-800 border-gray-300 hover:bg-gray-50"
            }`}
          >
            {simulatedSleep ? "Stop Microsleep Sim" : "Simulate Microsleep (>3s)"}
          </button>

          <button
            type="button"
            disabled={!isMonitoring}
            onClick={() => {
              if (simulatedHeadDown) stopAlarm();
              else {
                setSimulatedSleep(false);
                setSimulatedOut(false);
                setSimulatedYawn(false);
                setSimulatedHeadDown(true);
              }
            }}
            className={`px-3.5 py-1.5 rounded font-medium border transition disabled:opacity-40 disabled:cursor-not-allowed ${
              simulatedHeadDown
                ? "bg-rose-700 text-white border-rose-700 shadow-sm"
                : "bg-white text-rose-800 border-rose-300 hover:bg-rose-50"
            }`}
          >
            {simulatedHeadDown ? "Stop Head Slump Sim" : "Simulate Head Slump / Drop"}
          </button>

          <button
            type="button"
            disabled={!isMonitoring}
            onClick={() => {
              if (simulatedYawn) setSimulatedYawn(false);
              else {
                setSimulatedSleep(false);
                setSimulatedOut(false);
                setSimulatedHeadDown(false);
                setSimulatedYawn(true);
              }
            }}
            className={`px-3.5 py-1.5 rounded font-medium border transition disabled:opacity-40 disabled:cursor-not-allowed ${
              simulatedYawn
                ? "bg-amber-600 text-white border-amber-600 shadow-sm"
                : "bg-white text-amber-800 border-amber-300 hover:bg-amber-50"
            }`}
          >
            {simulatedYawn ? "Stop Yawn Sim" : "Simulate Yawn (>1.5s)"}
          </button>

          <button
            type="button"
            disabled={!isMonitoring}
            onClick={() => {
              if (simulatedOut) stopAlarm();
              else {
                setSimulatedSleep(false);
                setSimulatedYawn(false);
                setSimulatedHeadDown(false);
                setSimulatedOut(true);
              }
            }}
            className={`px-3.5 py-1.5 rounded font-medium border transition disabled:opacity-40 disabled:cursor-not-allowed ${
              simulatedOut
                ? "bg-slate-700 text-white border-slate-700 shadow-sm"
                : "bg-white text-gray-800 border-gray-300 hover:bg-gray-50"
            }`}
          >
            {simulatedOut ? "Stop Out-of-Frame Sim" : "Simulate Out-of-Frame"}
          </button>
        </div>
      </div>

      {/* 5 High-Definition Telemetry KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {/* Card 1: Mean EAR */}
        <div className="border border-gray-200 rounded-lg p-4 bg-white space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Eye Aspect Ratio</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-[#0066cc] font-semibold">Bilateral</span>
          </div>

          <div className="flex items-baseline justify-between">
            <div>
              <span className="text-2xl font-bold font-mono text-gray-900">
                {meanEar !== null ? meanEar.toFixed(3) : "--"}
              </span>
              <span className="text-xs text-gray-500 ml-1">EAR</span>
            </div>
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${
              meanEar === null
                ? "bg-gray-100 text-gray-600"
                : meanEar >= 0.22
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-red-50 text-red-700 border border-red-200"
            }`}>
              {meanEar === null ? "Standby" : meanEar >= 0.22 ? "Eyes Open" : "Drooping"}
            </span>
          </div>

          <div className="space-y-1">
            <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
              <div
                className={`h-full transition-all duration-150 ${
                  meanEar === null ? "w-0" : meanEar >= 0.22 ? "bg-[#0066cc]" : "bg-red-600"
                }`}
                style={{ width: `${Math.min(100, Math.max(0, ((meanEar ?? 0) / 0.40) * 100))}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-gray-400 font-mono">
              <span>0.10</span>
              <span className="text-red-500 font-bold">Cutoff 0.22</span>
              <span>0.40</span>
            </div>
          </div>
        </div>

        {/* Card 2: PERCLOS */}
        <div className="border border-gray-200 rounded-lg p-4 bg-white space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">PERCLOS Ratio</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-[#0066cc] font-semibold">30s Window</span>
          </div>

          <div className="flex items-baseline justify-between">
            <div>
              <span className="text-2xl font-bold font-mono text-gray-900">
                {perclos.toFixed(1)}%
              </span>
              <span className="text-xs text-gray-500 ml-1">Closure</span>
            </div>
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${
              perclos < 8.0
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : perclos < 15.0
                ? "bg-amber-50 text-amber-700 border border-amber-200"
                : "bg-red-50 text-red-700 border border-red-200"
            }`}>
              {perclos < 8.0 ? "Alert" : perclos < 15.0 ? "Moderate" : "Severe"}
            </span>
          </div>

          <div className="space-y-1">
            <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${
                  perclos < 8.0 ? "bg-[#0066cc]" : perclos < 15.0 ? "bg-amber-500" : "bg-red-600"
                }`}
                style={{ width: `${Math.min(100, (perclos / 25) * 100)}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-gray-400 font-mono">
              <span>0%</span>
              <span className="text-red-500 font-bold">&gt;15% Hazard</span>
              <span>25%</span>
            </div>
          </div>
        </div>

        {/* Card 3: Microsleep Counter */}
        <div className="border border-gray-200 rounded-lg p-4 bg-white space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Closure Duration</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-[#0066cc] font-semibold">Limit 3.0s</span>
          </div>

          <div className="flex items-baseline justify-between">
            <div>
              <span className={`text-2xl font-bold font-mono ${
                closedSeconds >= 2.0 ? "text-red-600 animate-pulse" : "text-gray-900"
              }`}>
                {closedSeconds.toFixed(1)}s
              </span>
              <span className="text-xs text-gray-500 ml-1">Elapsed</span>
            </div>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-blue-50 text-[#0066cc] border border-blue-200">
              Alarm @ 3s
            </span>
          </div>

          <div className="space-y-1">
            <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
              <div
                className={`h-full transition-all duration-100 ${
                  closedSeconds >= 2.0 ? "bg-red-600" : "bg-[#0066cc]"
                }`}
                style={{ width: `${Math.min(100, (closedSeconds / 3.0) * 100)}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-gray-400 font-mono">
              <span>0.0s</span>
              <span className="text-red-500 font-bold">Alarm: 3.0s</span>
              <span>3.0s</span>
            </div>
          </div>
        </div>

        {/* Card 4: Mouth Aspect Ratio (MAR) & Yawn Detection */}
        <div className="border border-gray-200 rounded-lg p-4 bg-white space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Mouth (MAR) / Yawn</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 font-semibold">6 Lip Pts</span>
          </div>

          <div className="flex items-baseline justify-between">
            <div>
              <span className={`text-2xl font-bold font-mono ${isYawning ? "text-amber-600 animate-bounce" : "text-gray-900"}`}>
                {mar !== null ? mar.toFixed(3) : "--"}
              </span>
              <span className="text-xs text-gray-500 ml-1">MAR</span>
            </div>
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${
              isYawning
                ? "bg-amber-500 text-white animate-pulse"
                : yawnCount > 0
                ? "bg-amber-50 text-amber-700 border border-amber-200"
                : "bg-emerald-50 text-emerald-700 border border-emerald-200"
            }`}>
              {isYawning ? "Yawning Active" : yawnCount > 0 ? `${yawnCount} Yawns` : "Normal"}
            </span>
          </div>

          <div className="space-y-1">
            <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
              <div
                className={`h-full transition-all duration-150 ${
                  isYawning ? "bg-amber-500" : (mar ?? 0) > 0.45 ? "bg-amber-400" : "bg-[#0066cc]"
                }`}
                style={{ width: `${Math.min(100, Math.max(0, (((mar ?? 0) - 0.1) / 0.7) * 100))}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-gray-400 font-mono">
              <span>0.15</span>
              <span className="text-amber-600 font-bold">Yawn &gt;0.55</span>
              <span>0.80</span>
            </div>
          </div>
        </div>

        {/* Card 5: Head Pitch & Slump Risk */}
        <div className="border border-gray-200 rounded-lg p-4 bg-white space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Head Pitch (Slump)</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 font-semibold">3D Kinematics</span>
          </div>

          <div className="flex items-baseline justify-between">
            <div>
              <span className={`text-2xl font-bold font-mono ${isHeadDown ? "text-rose-600 animate-pulse" : "text-gray-900"}`}>
                {headPitch !== null ? `${headPitch > 0 ? "+" : ""}${headPitch.toFixed(1)}°` : "--"}
              </span>
              <span className="text-xs text-gray-500 ml-1">Pitch</span>
            </div>
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${
              isHeadDown
                ? "bg-rose-600 text-white animate-pulse"
                : (headPitch ?? 0) > 15
                ? "bg-amber-50 text-amber-700 border border-amber-200"
                : "bg-emerald-50 text-emerald-700 border border-emerald-200"
            }`}>
              {isHeadDown ? "Head Slumped" : (headPitch ?? 0) > 15 ? "Tilting Down" : "Upright Posture"}
            </span>
          </div>

          <div className="space-y-1">
            <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
              <div
                className={`h-full transition-all duration-150 ${
                  isHeadDown ? "bg-rose-600" : (headPitch ?? 0) > 15 ? "bg-amber-500" : "bg-emerald-600"
                }`}
                style={{ width: `${Math.min(100, Math.max(0, (((headPitch ?? 0) + 15) / 50) * 100))}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-gray-400 font-mono">
              <span>-10° (Up)</span>
              <span className="text-rose-600 font-bold">Slump &gt;22°</span>
              <span>+35°</span>
            </div>
          </div>
        </div>
      </div>

      {/* Main Workspace: Ocular Camera Feed & Dual-Eye Analysis */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left 6 Columns: Camera View with Eye Contours */}
        <section className="lg:col-span-6 border border-gray-200 rounded-lg p-5 bg-white space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-gray-200">
            <div>
              <h2 className="text-base font-bold text-gray-900">Focused Ocular Landmark Tracking</h2>
              <p className="text-xs text-gray-500">468-pt wireframe with upper/lower eyelid Euclidean distance calculation</p>
            </div>
            <span className="text-xs font-medium text-gray-600">
              {meanEar !== null ? "● Ocular Feed Locked" : "○ Searching"}
            </span>
          </div>

          <div className="relative aspect-video w-full rounded-md border border-gray-200 overflow-hidden bg-slate-950 flex items-center justify-center">
            <video
              ref={videoRef}
              muted
              playsInline
              autoPlay
              className="absolute inset-0 w-full h-full object-cover transform -scale-x-100"
            />
            <canvas
              ref={canvasRef}
              className="absolute inset-0 w-full h-full object-cover transform -scale-x-100 pointer-events-none"
            />

            <CameraFaceOverlay
              cameraActive={cameraActive}
              faceDetected={meanEar !== null}
              isHeadDown={isHeadDown}
              title="Place Face in Front of the Camera"
              subtitle="Align your face to calibrate ocular eyelid contours and microsleep detection"
            />
          </div>

          <div className="flex justify-between items-center text-xs text-gray-500 pt-1">
            <span>Points: Left #33,#160,#158,#133,#153,#144</span>
            <span>Right #362,#385,#387,#263,#373,#380</span>
          </div>
        </section>

        {/* Right 6 Columns: Left vs Right EAR & Live Oscilloscope */}
        <section className="lg:col-span-6 border border-gray-200 rounded-lg p-5 bg-white space-y-5">
          <div className="border-b border-gray-200 pb-3">
            <h2 className="text-base font-bold text-gray-900">Bilateral Ocular Symmetry &amp; Waveform</h2>
            <p className="text-xs text-gray-500">Left vs right eye fatigue differential &amp; blink velocity trace</p>
          </div>

          {/* Left vs Right Comparison Meters */}
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 rounded-lg border border-gray-200 bg-gray-50/50 space-y-2">
              <div className="flex justify-between text-xs">
                <span className="font-bold text-gray-700">Left Eye (OS)</span>
                <span className="font-mono font-bold text-gray-900">{leftEar !== null ? leftEar.toFixed(3) : "--"}</span>
              </div>
              <div className="h-2 w-full rounded-full bg-gray-200 overflow-hidden">
                <div
                  className="h-full bg-[#0066cc] transition-all duration-100"
                  style={{ width: `${Math.min(100, ((leftEar ?? 0) / 0.40) * 100)}%` }}
                />
              </div>
              <span className="text-[11px] text-gray-500 block">Cutoff: 0.220</span>
            </div>

            <div className="p-4 rounded-lg border border-gray-200 bg-gray-50/50 space-y-2">
              <div className="flex justify-between text-xs">
                <span className="font-bold text-gray-700">Right Eye (OD)</span>
                <span className="font-mono font-bold text-gray-900">{rightEar !== null ? rightEar.toFixed(3) : "--"}</span>
              </div>
              <div className="h-2 w-full rounded-full bg-gray-200 overflow-hidden">
                <div
                  className="h-full bg-[#0066cc] transition-all duration-100"
                  style={{ width: `${Math.min(100, ((rightEar ?? 0) / 0.40) * 100)}%` }}
                />
              </div>
              <span className="text-[11px] text-gray-500 block">Cutoff: 0.220</span>
            </div>
          </div>

          {/* Live Waveform */}
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-gray-600">
              <span className="font-bold">Real-time Blink &amp; Closure Waveform</span>
              <span className="font-mono text-gray-500">160 Frames Window</span>
            </div>
            <canvas ref={plotCanvasRef} className="w-full h-44 rounded border border-gray-200 bg-white" />
          </div>
        </section>
      </div>
    </main>
  );
}
