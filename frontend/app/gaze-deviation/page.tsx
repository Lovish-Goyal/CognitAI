"use client";

import { FaceMesh, Results } from "@mediapipe/face_mesh";
import { useEffect, useRef, useState, useCallback } from "react";
import { requestWebcamStream, releaseWebcamStream } from "../utils/camera";
import { getFaceMeshLocateFile } from "../utils/mediapipe";
import { selectPrimaryDriverFace, smoothMetric } from "../utils/faceProcessing";
import { CameraFaceOverlay } from "../components/CameraFaceOverlay";

import { useMonitoring } from "../context/MonitoringContext";

export default function GazeDeviation() {
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
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const targetCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const meshRef = useRef<FaceMesh | null>(null);
  const runningRef = useRef(false);
  const connectingPromiseRef = useRef<Promise<boolean> | null>(null);
  const isProcessingRef = useRef(false);
  const lastFrameTimeRef = useRef(0);
  const missingFaceCount = useRef(0);
  const smoothedYawRef = useRef<number | null>(null);
  const smoothedPitchRef = useRef<number | null>(null);
  const smoothedRollRef = useRef<number | null>(null);
  const smoothedScoreRef = useRef<number | null>(null);

  const awayTimer = useRef<number | null>(null);

  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [eyesCaptured, setEyesCaptured] = useState(false);

  const [yaw, setYaw] = useState<number | null>(null);
  const [pitch, setPitch] = useState<number | null>(null);
  const [roll, setRoll] = useState<number | null>(null);
  const [distracted, setDistracted] = useState(false);

  useEffect(() => {
    if (!isMonitoring) {
      setFaceInFrame?.(true);
    }
  }, [isMonitoring, setFaceInFrame]);
  const [secondsAway, setSecondsAway] = useState(0);
  const [roadFocusScore, setRoadFocusScore] = useState<number | null>(null);
  const [autoRecovered, setAutoRecovered] = useState(false);
  const [isHeadDown, setIsHeadDown] = useState(false);
  const isHeadDownRef = useRef(false);
  const lastPitchRef = useRef(0);
  const distractedRef = useRef(distracted);
  useEffect(() => {
    distractedRef.current = distracted;
  }, [distracted]);
  useEffect(() => {
    isHeadDownRef.current = isHeadDown;
  }, [isHeadDown]);



  // Connect webcam & run MediaPipe FaceMesh for 3D Head Pose
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
        v.onloadedmetadata = () => {
          void v.play().catch(() => {});
          if (overlayCanvasRef.current) {
            overlayCanvasRef.current.width = v.videoWidth || 960;
            overlayCanvasRef.current.height = v.videoHeight || 540;
          }
        };
        try {
          await v.play();
        } catch {
          // Fallback
        }
        if (overlayCanvasRef.current && v.videoWidth > 0) {
          overlayCanvasRef.current.width = v.videoWidth;
          overlayCanvasRef.current.height = v.videoHeight;
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
          const canvas = overlayCanvasRef.current;
          const v = videoRef.current;
          if (!canvas || !v) return;

          if (canvas.width !== v.videoWidth || canvas.height !== v.videoHeight) {
            canvas.width = v.videoWidth;
            canvas.height = v.videoHeight;
          }

          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          if (!p || p.length < 400) {
            setEyesCaptured(false);
            missingFaceCount.current += 1;

            if (missingFaceCount.current >= 4) {
              setFaceInFrame?.(false);
            }

            // If monitoring has started and face was calibrated, missing face is an immediate alarm
            if (initialFaceCalibrated && missingFaceCount.current >= 10) {
              triggerGlobalAlarm(
                "FACE_LOST",
                "CRITICAL EMERGENCY: Driver Face Lost / Head Slumped!",
                "Driver face disappeared from camera frame while vehicle is active. Immediate wake-up siren active — KEEP HEAD UPRIGHT & EYES ON ROAD!"
              );
            }

            // CRITICAL: Check if loss of face was due to nodding off / head dropping down
            if (lastPitchRef.current > 16 || isHeadDownRef.current) {
              setIsHeadDown(true);
              isHeadDownRef.current = true;
              if (!awayTimer.current) awayTimer.current = performance.now();
              const elapsed = (performance.now() - awayTimer.current) / 1000;
              setSecondsAway(Number(elapsed.toFixed(1)));
              if (elapsed >= 1.0) {
                if (!distractedRef.current) {
                  distractedRef.current = true;
                  setDistracted(true);
                  triggerGlobalAlarm(
                    "HEAD_DROP",
                    "CRITICAL EMERGENCY: Driver Head Slump Detected!",
                    "Immediate downward head collapse detected. Acoustic wake-up siren active — KEEP HEAD UPRIGHT!"
                  );
                }
              }
              return;
            }

            if (missingFaceCount.current > 12) {
              setYaw(null);
              setPitch(null);
              setRoll(null);
              setRoadFocusScore(null);
              setDistracted(false);
              setSecondsAway(0);
              awayTimer.current = null;
              setIsHeadDown(false);
              isHeadDownRef.current = false;
            }
            return;
          }

          missingFaceCount.current = 0;
          setEyesCaptured(true);
          setFaceInFrame?.(true);
          if (!initialFaceCalibrated) {
            setInitialFaceCalibrated(true);
          }
          const w = canvas.width;
          const h = canvas.height;

          // 1. Calculate Yaw (Horizontal Rotation)
          const nose = p[1];
          const leftCheek = p[234];
          const rightCheek = p[454];
          const dLeft = Math.hypot(nose.x - leftCheek.x, nose.y - leftCheek.y);
          const dRight = Math.hypot(nose.x - rightCheek.x, nose.y - rightCheek.y);
          const totalWidth = dLeft + dRight || 0.001;
          const computedYaw = ((dRight - dLeft) / totalWidth) * 90;

          // 2. Calculate Pitch (Vertical Tilt)
          const forehead = p[10];
          const chin = p[152];
          const faceHeight = Math.hypot(forehead.x - chin.x, forehead.y - chin.y) || 0.001;
          const noseVerticalRatio = (nose.y - forehead.y) / faceHeight;
          const computedPitch = (noseVerticalRatio - 0.55) * 110;

          // 3. Calculate Roll (Lateral Tilt)
          const leftEyeCorner = p[33];
          const rightEyeCorner = p[263];
          const eyeDeltaY = rightEyeCorner.y - leftEyeCorner.y;
          const eyeDeltaX = rightEyeCorner.x - leftEyeCorner.x;
          const computedRoll = (Math.atan2(eyeDeltaY, eyeDeltaX) * 180) / Math.PI;

          // Apply low-pass exponential smoothing to eliminate micro-fluctuations
          const sYaw = smoothMetric(smoothedYawRef.current, computedYaw, 0.22);
          const sPitch = smoothMetric(smoothedPitchRef.current, computedPitch, 0.22);
          const sRoll = smoothMetric(smoothedRollRef.current, computedRoll, 0.22);
          smoothedYawRef.current = sYaw;
          smoothedPitchRef.current = sPitch;
          smoothedRollRef.current = sRoll;
          lastPitchRef.current = sPitch;

          setYaw(Number(sYaw.toFixed(1)));
          setPitch(Number(sPitch.toFixed(1)));
          setRoll(Number(sRoll.toFixed(1)));

          // Head Slump Check
          const isSlumped = sPitch > 22;
          if (isSlumped) {
            setIsHeadDown(true);
            isHeadDownRef.current = true;
          } else {
            setIsHeadDown(false);
            isHeadDownRef.current = false;
          }

          // Draw 3D Pose Projection Axes from Nose Tip
          const nx = nose.x * w;
          const ny = nose.y * h;
          const axisLen = Math.min(w, h) * 0.18;

          // X Axis (Pitch - Red)
          ctx.beginPath();
          ctx.strokeStyle = isSlumped ? "#e11d48" : "#dc2626";
          ctx.lineWidth = isSlumped ? 3.5 : 2.5;
          ctx.moveTo(nx, ny);
          ctx.lineTo(nx, ny + (sPitch / 45) * axisLen);
          ctx.stroke();

          // Y Axis (Yaw - Green)
          ctx.beginPath();
          ctx.strokeStyle = "#16a34a";
          ctx.lineWidth = 2.5;
          ctx.moveTo(nx, ny);
          ctx.lineTo(nx + (sYaw / 45) * axisLen, ny);
          ctx.stroke();

          // Z Axis (Roll - Blue Center Dot)
          ctx.beginPath();
          ctx.arc(nx, ny, 4, 0, Math.PI * 2);
          ctx.fillStyle = "#0066cc";
          ctx.fill();

          // Road Focus Index with EMA smoothing
          const dev = Math.hypot(sYaw, sPitch);
          const rawScore = Math.max(10, Math.min(99, Math.round(98 - dev * 1.6)));
          const sScore = smoothMetric(smoothedScoreRef.current, rawScore, 0.20);
          smoothedScoreRef.current = sScore;
          setRoadFocusScore(Math.round(sScore));

          // Distraction Timer (> 20° deviation or Head Slump)
          const isOffRoad = Math.abs(sYaw) > 20 || Math.abs(sPitch) > 15 || isSlumped;
          if (isOffRoad) {
            if (!awayTimer.current) awayTimer.current = performance.now();
            const elapsed = (performance.now() - awayTimer.current) / 1000;
            setSecondsAway(Number(elapsed.toFixed(1)));
            const limit = isSlumped ? 1.2 : 2.5;
            if (elapsed >= limit) {
              if (!distractedRef.current) {
                distractedRef.current = true;
                setDistracted(true);
                const reason = isSlumped ? "HEAD_DROP" : "GAZE_DISTRACTION";
                triggerGlobalAlarm(
                  reason,
                  reason === "HEAD_DROP"
                    ? "CRITICAL EMERGENCY: Driver Head Slump Detected!"
                    : "CRITICAL WARNING: Gaze Diverted From Windshield!",
                  reason === "HEAD_DROP"
                    ? "Sudden downward head collapse detected. Acoustic wake-up siren active — KEEP HEAD UPRIGHT!"
                    : "Driver head pose deviated outside windshield safety cone for > 2.5 seconds. REFOCUS EYES FORWARD!"
                );
              }
            }
          } else {
            awayTimer.current = null;
            setSecondsAway(0);
            // AUTOMATIC ALARM DISMISSAL:
            // When face returns upright and looks ahead into road cone, immediately cancel alert!
            if (distractedRef.current || isHeadDownRef.current || globalAlarmActive) {
              distractedRef.current = false;
              setDistracted(false);
              setIsHeadDown(false);
              isHeadDownRef.current = false;
              stopGlobalAlarm(true);
            }
          }
        });

        try {
          await mesh.initialize();
        } catch (e) {
          console.warn("[GazeDeviation] FaceMesh initialize error (will proceed):", e);
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
            console.warn("[GazeDeviation] FaceMesh send error:", err);
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
      setDistracted(false);
      distractedRef.current = false;
      setIsHeadDown(false);
      isHeadDownRef.current = false;
      awayTimer.current = null;
      setSecondsAway(0);
      if (streamRef.current) {
        releaseWebcamStream(streamRef.current);
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      setCameraActive(false);
      setEyesCaptured(false);
      setYaw(null);
      setPitch(null);
      setRoll(null);
      setRoadFocusScore(null);
      const ctx = overlayCanvasRef.current?.getContext("2d");
      if (ctx && overlayCanvasRef.current) {
        ctx.clearRect(0, 0, overlayCanvasRef.current.width, overlayCanvasRef.current.height);
      }
    }
  }, [isMonitoring, connectCamera]);

  useEffect(() => {
    return () => {
      runningRef.current = false;
    };
  }, []);

  // Windshield Focal Cone Radar Widget Renderer (Eliminates getBoundingClientRect forced reflow)
  useEffect(() => {
    const canvas = targetCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = 640;
    const h = 256;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const cx = w / 2;
    const cy = h / 2;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    // Windshield Perspective Outline
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(w * 0.12, h * 0.12);
    ctx.lineTo(w * 0.88, h * 0.12);
    ctx.lineTo(w * 0.94, h * 0.88);
    ctx.lineTo(w * 0.06, h * 0.88);
    ctx.closePath();
    ctx.stroke();

    // Horizon line
    ctx.strokeStyle = "#e2e8f0";
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(w, cy);
    ctx.stroke();

    // Road Ahead Safe Ellipse
    const rx = w * 0.22;
    const ry = h * 0.25;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = distracted ? "rgba(220, 38, 38, 0.06)" : "rgba(0, 102, 204, 0.05)";
    ctx.fill();
    ctx.strokeStyle = distracted ? "#dc2626" : "#0066cc";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Crosshairs
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 15, cy);
    ctx.lineTo(cx + 15, cy);
    ctx.moveTo(cx, cy - 15);
    ctx.lineTo(cx, cy + 15);
    ctx.stroke();

    // Sector Labels
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#64748b";
    ctx.textAlign = "center";
    ctx.fillText("Road Ahead (Safe Cone)", cx, cy - ry - 8);
    ctx.fillText("Console / Cluster", cx, h - 14);
    ctx.fillText("◀ Left Mirror", w * 0.18, cy - 6);
    ctx.fillText("Right Mirror ▶", w * 0.82, cy - 6);

    if (eyesCaptured && yaw !== null && pitch !== null) {
      const scale = Math.min(w, h) * 0.012;
      const gazeX = cx + yaw * scale;
      const gazeY = cy + pitch * scale;

      // Laser vector line
      ctx.beginPath();
      ctx.strokeStyle = distracted ? "#dc2626" : "#0066cc";
      ctx.lineWidth = 2;
      ctx.moveTo(cx, cy);
      ctx.lineTo(gazeX, gazeY);
      ctx.stroke();

      // Blip
      ctx.beginPath();
      ctx.arc(gazeX, gazeY, 6, 0, Math.PI * 2);
      ctx.fillStyle = distracted ? "#dc2626" : "#0066cc";
      ctx.fill();

      // Outer ring
      ctx.beginPath();
      ctx.arc(gazeX, gazeY, 14, 0, Math.PI * 2);
      ctx.strokeStyle = distracted ? "rgba(220, 38, 38, 0.3)" : "rgba(0, 102, 204, 0.3)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      ctx.fillStyle = "#94a3b8";
      ctx.fillText("Awaiting driver face detection — radar standby", cx, cy + 25);
    }
  }, [yaw, pitch, distracted, eyesCaptured]);

  return (
    <main className="p-6 sm:p-8 space-y-8 w-full bg-white min-h-screen">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-gray-200">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 tracking-tight">
              3D Spatial Gaze &amp; Windshield Cone
            </h1>
            <span className="px-2.5 py-0.5 rounded text-xs font-semibold bg-blue-50 text-[#0066cc] border border-blue-200">
              Perspective-n-Point 3D
            </span>
          </div>
          <p className="text-sm text-gray-600 mt-1">
            Real-time head pose kinematics (Yaw, Pitch, Roll) and windshield focal cone departure tracking.
          </p>
        </div>

        <div className="flex items-center gap-2.5 text-xs">
          <span className="px-3 py-1.5 rounded border border-gray-200 bg-gray-50 text-gray-700 flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${eyesCaptured ? "bg-emerald-600 animate-pulse" : "bg-gray-400"}`} />
            <span className="font-medium">3D Pose: {eyesCaptured ? "Calibrated (30 FPS)" : "Standby"}</span>
          </span>

          <span className="px-3 py-1.5 rounded border border-gray-200 bg-gray-50 text-gray-700 flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isMonitoring ? "bg-emerald-600 animate-pulse" : "bg-gray-400"}`} />
            <span className="font-medium">Portal: {isMonitoring ? "Monitoring Active" : "Standby"}</span>
          </span>
        </div>
      </div>

      {/* 4 Spacious Specialized KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
        {/* Card 1: Yaw (Horizontal) */}
        <div className="border border-gray-200 rounded-lg p-5 bg-white space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Head Yaw (Horizontal)</span>
            <span className="text-[11px] px-2 py-0.5 rounded bg-blue-50 text-[#0066cc] font-medium">Y-Axis</span>
          </div>

          <div className="flex items-baseline justify-between">
            <div>
              <span className="text-3xl font-bold font-mono text-gray-900">
                {yaw !== null ? `${yaw > 0 ? "+" : ""}${yaw}°` : "--"}
              </span>
              <span className="text-xs text-gray-500 ml-1.5">Rotation</span>
            </div>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded ${
              yaw === null
                ? "bg-gray-100 text-gray-600"
                : Math.abs(yaw) <= 15
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-amber-50 text-amber-700 border border-amber-200"
            }`}>
              {yaw === null ? "Standby" : Math.abs(yaw) <= 15 ? "Windshield Center" : yaw > 15 ? "Right Deviation" : "Left Deviation"}
            </span>
          </div>

          <div className="text-[11px] text-gray-500 border-t border-gray-100 pt-1 flex justify-between">
            <span>Safe Driving Limit:</span>
            <span className="font-mono text-gray-800">±15.0° Degrees</span>
          </div>
        </div>

        {/* Card 2: Pitch (Vertical) */}
        <div className="border border-gray-200 rounded-lg p-5 bg-white space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Head Pitch (Vertical)</span>
            <span className="text-[11px] px-2 py-0.5 rounded bg-blue-50 text-[#0066cc] font-medium">X-Axis</span>
          </div>

          <div className="flex items-baseline justify-between">
            <div>
              <span className="text-3xl font-bold font-mono text-gray-900">
                {pitch !== null ? `${pitch > 0 ? "+" : ""}${pitch}°` : "--"}
              </span>
              <span className="text-xs text-gray-500 ml-1.5">Elevation</span>
            </div>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded ${
              pitch === null
                ? "bg-gray-100 text-gray-600"
                : Math.abs(pitch) <= 12
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-amber-50 text-amber-700 border border-amber-200"
            }`}>
              {pitch === null ? "Standby" : Math.abs(pitch) <= 12 ? "Road Horizon" : pitch > 12 ? "Looking Down" : "Looking Up"}
            </span>
          </div>

          <div className="text-[11px] text-gray-500 border-t border-gray-100 pt-1 flex justify-between">
            <span>Cluster / Phone Limit:</span>
            <span className="font-mono text-gray-800">&gt; +15.0° Down</span>
          </div>
        </div>

        {/* Card 3: Road Focus Score */}
        <div className="border border-gray-200 rounded-lg p-5 bg-white space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Spatial Road Focus</span>
            <span className="text-[11px] px-2 py-0.5 rounded bg-blue-50 text-[#0066cc] font-medium">Cone Score</span>
          </div>

          <div className="flex items-baseline justify-between">
            <div>
              <span className="text-3xl font-bold font-mono text-gray-900">
                {roadFocusScore !== null ? `${roadFocusScore}%` : "--"}
              </span>
              <span className="text-xs text-gray-500 ml-1.5">Capacity</span>
            </div>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded ${
              roadFocusScore === null
                ? "bg-gray-100 text-gray-600"
                : roadFocusScore >= 80
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-amber-50 text-amber-700 border border-amber-200"
            }`}>
              {roadFocusScore === null ? "Standby" : roadFocusScore >= 80 ? "Optimal Focus" : "Diverted"}
            </span>
          </div>

          <div className="text-[11px] text-gray-500 border-t border-gray-100 pt-1 flex justify-between">
            <span>Benchmark Target:</span>
            <span className="font-mono text-emerald-700 font-semibold">&gt; 85% On-Road</span>
          </div>
        </div>

        {/* Card 4: Off-Road Duration */}
        <div className="border border-gray-200 rounded-lg p-5 bg-white space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Off-Road Gaze Timer</span>
            <span className="text-[11px] px-2 py-0.5 rounded bg-blue-50 text-[#0066cc] font-medium">Cutoff 2.5s</span>
          </div>

          <div className="flex items-baseline justify-between">
            <div>
              <span className={`text-3xl font-bold font-mono ${
                secondsAway >= 1.5 ? "text-red-600" : "text-gray-900"
              }`}>
                {secondsAway.toFixed(1)}s
              </span>
              <span className="text-xs text-gray-500 ml-1.5">Elapsed</span>
            </div>
            <span className="text-xs font-semibold px-2.5 py-1 rounded bg-blue-50 text-[#0066cc] border border-blue-200">
              Limit: 2.5s
            </span>
          </div>

          <div className="text-[11px] text-gray-500 border-t border-gray-100 pt-1 flex justify-between">
            <span>Alert State:</span>
            <span className="font-mono text-gray-800">{distracted ? "Audio Triggered" : "Nominal"}</span>
          </div>
        </div>
      </div>

      {/* Main Workspace: 3D Projection Axes Video & Windshield Radar Canvas */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left 6 Columns: Camera Viewport with 3D Head Pose Axes */}
        <section className="lg:col-span-6 border border-gray-200 rounded-lg p-5 bg-white space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-gray-200">
            <div>
              <h2 className="text-base font-bold text-gray-900">3D Head Pose Vector Projection</h2>
              <p className="text-xs text-gray-500">Orthogonal coordinate axes projected from driver nasal bridge</p>
            </div>
            <span className="text-xs font-medium text-gray-600">
              {eyesCaptured ? "● Vector Locked" : "○ Searching"}
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
              ref={overlayCanvasRef}
              className="absolute inset-0 w-full h-full object-cover transform -scale-x-100 pointer-events-none"
            />

            <CameraFaceOverlay
              cameraActive={cameraActive}
              faceDetected={eyesCaptured}
              isHeadDown={isHeadDown}
              title="Place Face in Front of the Camera"
              subtitle="Align your face to track 3D head pose and windshield safety cone deviation"
            />
          </div>

          <div className="flex items-center justify-between text-xs text-gray-500 pt-1">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-red-600" />
              <span>Red: Pitch (Vertical X)</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-600" />
              <span>Green: Yaw (Horizontal Y)</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#0066cc]" />
              <span>Blue: Roll (Lateral Z)</span>
            </span>
          </div>
        </section>

        {/* Right 6 Columns: Windshield Focal Cone Radar Widget */}
        <section className="lg:col-span-6 border border-gray-200 rounded-lg p-5 bg-white space-y-4">
          <div className="border-b border-gray-200 pb-3">
            <h2 className="text-base font-bold text-gray-900">Windshield Focal Cone Radar Target</h2>
            <p className="text-xs text-gray-500">Interactive cockpit visual radar tracking driver gaze position in real time</p>
          </div>

          <div className="relative">
            <canvas ref={targetCanvasRef} width={640} height={256} className="w-full h-64 rounded border border-gray-200 bg-white" />
          </div>

          <div className="grid grid-cols-3 gap-3 text-xs pt-1 border-t border-gray-100">
            <div className="p-2.5 rounded border border-gray-100 bg-gray-50/60">
              <span className="text-[11px] text-gray-500 block">Current Quadrant</span>
              <span className="font-bold text-gray-900 text-sm">
                {yaw !== null ? (Math.abs(yaw) <= 15 ? "Windshield Center" : yaw > 15 ? "Right Sector" : "Left Sector") : "--"}
              </span>
            </div>
            <div className="p-2.5 rounded border border-gray-100 bg-gray-50/60">
              <span className="text-[11px] text-gray-500 block">Roll Deviation</span>
              <span className="font-mono font-bold text-gray-900 text-sm">
                {roll !== null ? `${roll}°` : "--"}
              </span>
            </div>
            <div className="p-2.5 rounded border border-gray-100 bg-gray-50/60">
              <span className="text-[11px] text-gray-500 block">Cone Departure</span>
              <span className={`font-bold text-sm ${distracted ? "text-red-600" : "text-emerald-700"}`}>
                {distracted ? "Diverted" : "Within Boundary"}
              </span>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
