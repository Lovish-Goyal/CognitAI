"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { FaceMesh, Results, FACEMESH_CONTOURS } from "@mediapipe/face_mesh";
import { requestWebcamStream, releaseWebcamStream } from "../utils/camera";
import { getFaceMeshLocateFile } from "../utils/mediapipe";
import { useMonitoring, DriverProfile } from "../context/MonitoringContext";

const API = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";

interface DbStatus {
  database: string;
  connected: boolean;
  uri_masked: string;
  driver_count: number;
  status: string;
}

interface AlertModalState {
  title: string;
  message: string;
  isError?: boolean;
}

interface RegSuccessModalState {
  driver_id: string;
  display_name: string;
  driver: DriverProfile;
}

interface EnrolledDriverItem {
  driver_id: string;
  display_name: string;
  license_class?: string;
  status?: string;
}

const DEFAULT_FLEET_DRIVERS: EnrolledDriverItem[] = [
  {
    driver_id: "DRIVER-001",
    display_name: "Alex Mercer",
    license_class: "Commercial Class A",
    status: "Active / Verified",
  },
  {
    driver_id: "DRIVER-002",
    display_name: "Sarah Chen",
    license_class: "Hazardous Cargo",
    status: "Active / Verified",
  },
  {
    driver_id: "DRIVER-003",
    display_name: "Marcus Vance",
    license_class: "Commercial Class B",
    status: "Active / Verified",
  },
];

export default function EntranceGateway() {
  const { startMonitoring, setCurrentDriver } = useMonitoring();

  // Active Tab: 'login' | 'register'
  const [activeTab, setActiveTab] = useState<"login" | "register">("login");

  // Database / Registry Info
  const [dbStatus, setDbStatus] = useState<DbStatus | null>(null);

  // --- LOGIN STATE ---
  const [loginVerifying, setLoginVerifying] = useState<boolean>(false);
  const [verifiedDriver, setVerifiedDriver] = useState<DriverProfile | null>(null);

  // --- REGISTRATION STATE ---
  const [regName, setRegName] = useState<string>("Alex Mercer");
  const [regLicense, setRegLicense] = useState<string>("Commercial Class A");
  const [regPhoto, setRegPhoto] = useState<string>("");
  const [regSubmitting, setRegSubmitting] = useState<boolean>(false);

  // --- MODAL POPUP STATES ---
  const [alertModal, setAlertModal] = useState<AlertModalState | null>(null);
  const [regSuccessModal, setRegSuccessModal] = useState<RegSuccessModalState | null>(null);

  // --- CAMERA & BIOMETRIC SCANNER ---
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const meshRef = useRef<FaceMesh | null>(null);
  const isScanningRef = useRef<boolean>(false);
  const isProcessingRef = useRef<boolean>(false);
  const lastFrameTimeRef = useRef<number>(0);

  const [cameraActive, setCameraActive] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [faceInFrame, setFaceInFrame] = useState<boolean>(false);
  const faceInFrameRef = useRef<boolean>(false);
  useEffect(() => {
    faceInFrameRef.current = faceInFrame;
  }, [faceInFrame]);

  const [flashActive, setFlashActive] = useState<boolean>(false);

  // Enrolled Drivers for Quick Login
  const [enrolledDrivers, setEnrolledDrivers] = useState<EnrolledDriverItem[]>(DEFAULT_FLEET_DRIVERS);

  const fetchDbStatus = useCallback(() => {
    fetch(`${API}/api/db-status`)
      .then((r) => r.json())
      .then((data: DbStatus) => setDbStatus(data))
      .catch(() => {
        setDbStatus({
          database: "sqlite_fallback",
          connected: false,
          uri_masked: "registry://****",
          driver_count: 0,
          status: "Offline",
        });
      });
  }, []);

  const fetchEnrolledDrivers = useCallback(() => {
    fetch(`${API}/api/drivers?limit=10`)
      .then((r) => r.json())
      .then((data) => {
        if (data && Array.isArray(data.drivers) && data.drivers.length > 0) {
          setEnrolledDrivers(data.drivers);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchDbStatus();
    fetchEnrolledDrivers();
  }, [fetchDbStatus, fetchEnrolledDrivers]);

  const [clockStr, setClockStr] = useState<string>("");
  useEffect(() => {
    const updateClock = () => {
      setClockStr(new Date().toLocaleTimeString("en-US", { hour12: false }));
    };
    updateClock();
    const interval = setInterval(updateClock, 1000);
    return () => clearInterval(interval);
  }, []);

  // Camera & FaceMesh Scanner Control
  const startCameraScan = useCallback(async () => {
    try {
      setCameraError(null);

      const { stream, error } = await requestWebcamStream();
      if (error || !stream) {
        throw new Error(error || "Webcam stream unavailable");
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try {
          await videoRef.current.play();
        } catch (e) {
          console.warn("Entrance camera play notice:", e);
        }
      }
      setCameraActive(true);
      isScanningRef.current = true;

      try {
        if (!meshRef.current) {
          const fm = new FaceMesh({ locateFile: getFaceMeshLocateFile });
          fm.setOptions({
            maxNumFaces: 1,
            refineLandmarks: true,
            minDetectionConfidence: 0.4,
            minTrackingConfidence: 0.4,
          });

          fm.onResults((results: Results) => {
            const canvas = canvasRef.current;
            const video = videoRef.current;
            if (!canvas || !video) return;

            const ctx = canvas.getContext("2d");
            if (!ctx) return;

            if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
              canvas.width = video.videoWidth || 640;
              canvas.height = video.videoHeight || 480;
            }

            ctx.clearRect(0, 0, canvas.width, canvas.height);

            if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
              faceInFrameRef.current = true;
              setFaceInFrame(true);
              const landmarks = results.multiFaceLandmarks[0];

              // Draw subtle, elegant mesh contours
              ctx.strokeStyle = "rgba(0, 102, 204, 0.4)";
              ctx.lineWidth = 0.8;

              if (FACEMESH_CONTOURS) {
                for (const [start, end] of FACEMESH_CONTOURS) {
                  const p1 = landmarks[start];
                  const p2 = landmarks[end];
                  if (p1 && p2) {
                    ctx.beginPath();
                    ctx.moveTo(p1.x * canvas.width, p1.y * canvas.height);
                    ctx.lineTo(p2.x * canvas.width, p2.y * canvas.height);
                    ctx.stroke();
                  }
                }
              }

              // Subtle landmark points
              ctx.fillStyle = "rgba(16, 185, 129, 0.85)";
              for (let i = 0; i < landmarks.length; i += 8) {
                const pt = landmarks[i];
                ctx.beginPath();
                ctx.arc(pt.x * canvas.width, pt.y * canvas.height, 1.2, 0, 2 * Math.PI);
                ctx.fill();
              }
            } else {
              faceInFrameRef.current = false;
              setFaceInFrame(false);
            }
          });

          meshRef.current = fm;
        }
      } catch (meshErr) {
        console.warn("FaceMesh setup notice:", meshErr);
      }

      let animId: number;
      const processLoop = async (time: number) => {
        if (!isScanningRef.current) return;

        if (time - lastFrameTimeRef.current >= 66) {
          lastFrameTimeRef.current = time;
          if (videoRef.current && videoRef.current.readyState >= 2 && !isProcessingRef.current) {
            isProcessingRef.current = true;
            try {
              if (meshRef.current) {
                await meshRef.current.send({ image: videoRef.current });
              }
            } catch {
              // Frame dropped safely
            } finally {
              isProcessingRef.current = false;
            }
          }
        }
        animId = requestAnimationFrame(processLoop);
      };
      animId = requestAnimationFrame(processLoop);

      return () => {
        cancelAnimationFrame(animId);
      };
    } catch (err: unknown) {
      const e = err as Error;
      setCameraError(e.message || "Failed to initialize optical sensor.");
      setCameraActive(false);
    }
  }, []);

  const stopCamera = useCallback(() => {
    isScanningRef.current = false;
    if (streamRef.current) {
      releaseWebcamStream(streamRef.current);
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  }, []);

  useEffect(() => {
    startCameraScan();
    return () => {
      stopCamera();
    };
  }, [startCameraScan, stopCamera]);

  const captureFrameBase64 = useCallback((): string | null => {
    if (!videoRef.current) return null;
    const video = videoRef.current;
    if (video.videoWidth === 0 || video.videoHeight === 0) return null;

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = video.videoWidth;
    tempCanvas.height = video.videoHeight;
    const ctx = tempCanvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
    return tempCanvas.toDataURL("image/jpeg", 0.9);
  }, []);

  const handleCaptureRegistrationFace = () => {
    if (!cameraActive) {
      startCameraScan();
      setAlertModal({
        title: "Camera Initializing",
        message: "Activating camera sensor. Please look directly into the camera and click Capture again.",
        isError: false,
      });
      return;
    }

    if (!faceInFrameRef.current) {
      setAlertModal({
        title: "Align Face in Center",
        message: "Please center your face inside the camera reticle so your biometric template can be clearly captured.",
        isError: true,
      });
      return;
    }

    setFlashActive(true);
    setTimeout(() => setFlashActive(false), 150);

    const b64 = captureFrameBase64();
    if (!b64) {
      setAlertModal({
        title: "Capture Notice",
        message: "Unable to read frame from camera. Ensure your webcam is active and permissions are allowed.",
        isError: true,
      });
      return;
    }

    // Lock captured frame immediately
    setRegPhoto(b64);
  };

  const handleFaceLogin = async () => {
    if (!cameraActive) {
      setAlertModal({
        title: "Camera Inactive",
        message: "Please activate your camera sensor to authenticate biometrically.",
        isError: true,
      });
      return;
    }

    if (!faceInFrameRef.current) {
      setAlertModal({
        title: "Center Face to Authenticate",
        message: "Please look directly at the camera so your biometric features can be scanned.",
        isError: true,
      });
      return;
    }

    setFlashActive(true);
    setTimeout(() => setFlashActive(false), 150);

    const currentFrame = captureFrameBase64();
    if (!currentFrame) {
      setAlertModal({
        title: "Sensor Capture Failed",
        message: "Could not capture image from camera.",
        isError: true,
      });
      return;
    }

    setLoginVerifying(true);
    try {
      const res = await fetch(`${API}/api/driver-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          face_photo_base64: currentFrame,
          photo_base64: currentFrame,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || "Biometric authentication failed.");
      }

      const driverProfile: DriverProfile = {
        driver_id: data.driver_id,
        display_name: data.display_name,
        license_class: data.license_class || "Commercial Class A",
        photo_base64: currentFrame,
        status: "Active / Verified",
      };

      setVerifiedDriver(driverProfile);
      setCurrentDriver(driverProfile);
      startMonitoring();
    } catch (err: unknown) {
      const e = err as Error;
      setAlertModal({
        title: "Biometric Match Notice",
        message:
          e.message ||
          "Face not recognized in registry. You can enroll under 'New Driver' or select an enrolled profile below.",
        isError: true,
      });
    } finally {
      setLoginVerifying(false);
    }
  };

  const handleQuickVerifyDriver = (driver: EnrolledDriverItem) => {
    const profile: DriverProfile = {
      driver_id: driver.driver_id,
      display_name: driver.display_name,
      license_class: driver.license_class || "Commercial Class A",
      photo_base64: captureFrameBase64() || "",
      status: "Active / Verified",
    };
    setVerifiedDriver(profile);
    setCurrentDriver(profile);
    startMonitoring();
  };

  const handleLaunchSession = () => {
    if (!verifiedDriver) return;
    setCurrentDriver(verifiedDriver);
    startMonitoring();
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!regName.trim()) {
      setAlertModal({
        title: "Name Required",
        message: "Please enter the driver's full name to complete enrollment.",
        isError: true,
      });
      return;
    }

    let photoToUse = regPhoto;
    if (!photoToUse && cameraActive) {
      if (!faceInFrameRef.current) {
        setAlertModal({
          title: "Align Face to Register",
          message: "Please center your face directly in front of the camera so your biometric profile can be generated.",
          isError: true,
        });
        return;
      }
      photoToUse = captureFrameBase64() || "";
      if (photoToUse) {
        setRegPhoto(photoToUse);
      }
    }

    if (!photoToUse) {
      setAlertModal({
        title: "Face Capture Required",
        message: "Please align your face in the camera and click 'Capture Face Reference' before submitting.",
        isError: true,
      });
      return;
    }

    setRegSubmitting(true);
    try {
      const payload = {
        display_name: regName.trim(),
        license_class: regLicense,
        photo_base64: photoToUse,
      };

      const res = await fetch(`${API}/api/driver-register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || "Registration failed.");
      }

      const newDriver: DriverProfile = {
        driver_id: data.driver_id,
        display_name: data.display_name,
        license_class: data.license_class || regLicense,
        photo_base64: photoToUse,
        status: "Active / Verified",
      };

      setRegSuccessModal({
        driver_id: data.driver_id,
        display_name: data.display_name,
        driver: newDriver,
      });

      setEnrolledDrivers((prev) => [
        {
          driver_id: data.driver_id,
          display_name: data.display_name,
          license_class: data.license_class || regLicense,
          status: "Active / Verified",
        },
        ...prev.filter((d) => d.driver_id !== data.driver_id),
      ]);

      fetchDbStatus();
      fetchEnrolledDrivers();
    } catch (err: unknown) {
      const e = err as Error;
      setAlertModal({
        title: "Registration Notice",
        message: e.message || "Failed to register driver profile. Please try again.",
        isError: true,
      });
    } finally {
      setRegSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-[#f8fafc] text-slate-800 antialiased p-4 sm:p-6 lg:p-8 flex flex-col justify-between font-sans select-none overflow-x-hidden">
      
      {/* ================= MODAL 1: ALERT NOTIFICATION ================= */}
      {alertModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-white border border-slate-200 rounded-2xl shadow-2xl max-w-sm w-full p-5 text-center space-y-3.5 animate-in zoom-in-95">
            <div
              className={`w-12 h-12 rounded-xl flex items-center justify-center mx-auto border ${
                alertModal.isError
                  ? "bg-rose-50 border-rose-200 text-rose-600"
                  : "bg-blue-50 border-blue-200 text-[#0066cc]"
              }`}
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                {alertModal.isError ? (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                ) : (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                )}
              </svg>
            </div>

            <div className="space-y-1">
              <h3 className="text-base font-bold text-slate-900 tracking-tight">{alertModal.title}</h3>
              <p className="text-xs text-slate-600 leading-relaxed">{alertModal.message}</p>
            </div>

            <button
              type="button"
              onClick={() => setAlertModal(null)}
              className="w-full py-2.5 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* ================= MODAL 2: REGISTRATION SUCCESS ================= */}
      {regSuccessModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-white border border-emerald-200 rounded-2xl shadow-2xl max-w-sm w-full p-5 text-center space-y-3.5 animate-in zoom-in-95">
            <div className="w-12 h-12 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-600 flex items-center justify-center mx-auto">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>

            <div className="space-y-1">
              <h3 className="text-base font-bold text-slate-900 tracking-tight">Driver Profile Enrolled</h3>
              <p className="text-xs text-slate-600">
                Biometric profile active for{" "}
                <span className="font-semibold text-slate-800">{regSuccessModal.display_name}</span>.
              </p>
            </div>

            <div className="border border-slate-200 bg-slate-50 rounded-xl p-3 text-center">
              <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-0.5">
                Assigned Driver ID
              </div>
              <div className="text-2xl font-bold font-mono text-slate-900 tracking-wider">
                {regSuccessModal.driver_id}
              </div>
              <p className="text-[10px] text-slate-500 mt-0.5">Synchronized to MongoDB Atlas Vault</p>
            </div>

            <button
              type="button"
              onClick={() => {
                const drv = regSuccessModal.driver;
                setRegSuccessModal(null);
                setCurrentDriver(drv);
                startMonitoring();
              }}
              className="w-full py-2.5 px-4 rounded-xl bg-[#0066cc] hover:bg-[#0052a3] text-white text-xs font-semibold transition shadow-sm"
            >
              Start Shift &amp; Enter Platform
            </button>
          </div>
        </div>
      )}

      {/* ================= TOP BRANDING NAVBAR ================= */}
      <header className="w-full max-w-[1680px] mx-auto shrink-0 flex items-center justify-between pb-4 border-b border-slate-200/80">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-[#0052a3] to-[#0066cc] text-white flex items-center justify-center font-bold text-lg shadow-md shrink-0 border border-blue-400/30">
            C
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl font-bold text-slate-900 tracking-tight">
                Cognit<span className="text-[#0066cc]">AI</span>
              </span>
              <span className="px-2.5 py-0.5 text-[11px] font-semibold rounded-full bg-blue-50 text-[#0066cc] border border-blue-200">
                Fleet Security Platform v2.4
              </span>
            </div>
            <p className="text-xs text-slate-500">Autonomous Driver Attentiveness &amp; Bio-Telemetry Gateway</p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 text-xs">
          <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 shadow-sm">
            <span
              className={`w-2 h-2 rounded-full ${
                dbStatus && dbStatus.status !== "Offline"
                  ? "bg-emerald-500 animate-pulse"
                  : "bg-rose-500"
              }`}
            />
            <span className="font-medium text-[11px]">
              {dbStatus && dbStatus.status !== "Offline" ? "FaceNet InceptionResNetV1" : "FaceNet Offline"}
            </span>
          </div>

          <div className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 shadow-sm">
            <span
              className={`w-2 h-2 rounded-full ${
                dbStatus?.connected
                  ? "bg-emerald-500"
                  : dbStatus && dbStatus.status !== "Offline"
                  ? "bg-amber-500"
                  : "bg-rose-500"
              }`}
            />
            <span className="font-medium text-[11px]">
              {dbStatus?.connected
                ? `MongoDB Atlas Vault (${dbStatus.driver_count} Drivers)`
                : dbStatus && dbStatus.status !== "Offline"
                ? "SQLite Encrypted Vault"
                : "Backend API Offline"}
            </span>
          </div>

          {clockStr && (
            <div className="px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-100 font-mono text-[11px] text-slate-700 font-semibold tracking-wide">
              {clockStr}
            </div>
          )}
        </div>
      </header>

      {/* ================= MAIN SPLIT CONTENT: INTRO & FEATURES (LEFT) + AUTHENTICATION (RIGHT) ================= */}
      <main className="w-full max-w-[1680px] mx-auto my-auto py-6 sm:py-8 grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center">
        
        {/* ================= LEFT (7 cols): PROMOTIVE SHOWCASE & PLATFORM INTRO ================= */}
        <div className="lg:col-span-7 space-y-6">
          
          {/* Hero Section */}
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-50 border border-blue-200 text-[#0066cc] text-xs font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-[#0066cc] animate-ping" />
              <span>Next-Generation Autonomous Vehicle Safety</span>
            </div>

            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-slate-900 tracking-tight leading-[1.15]">
              Intelligent Driver Safety &amp; Real-Time Bio-Telemetry
            </h1>

            <p className="text-sm sm:text-base text-slate-600 leading-relaxed max-w-2xl">
              CognitAI leverages edge computer vision and deep biometric telemetry to continuously monitor operator vigilance, cardiovascular vitals, and spatial gaze — proactively intercepting microsleep, fatigue, and unauthorized access.
            </p>
          </div>

          {/* Promotive Feature Cards Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
            
            {/* Feature 1: Continuous Vigilance */}
            <div className="p-5 rounded-2xl bg-white border border-slate-200 shadow-sm hover:border-blue-300 hover:shadow-md transition-all space-y-2.5">
              <div className="w-10 h-10 rounded-xl bg-blue-50 text-[#0066cc] flex items-center justify-center font-bold">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              </div>
              <h2 className="text-base sm:text-lg font-bold text-slate-900 tracking-tight">Continuous Vigilance &amp; Ocular EAR</h2>
              <p className="text-sm sm:text-[15px] text-slate-600 leading-relaxed font-normal">
                Real-time Eye Aspect Ratio telemetry detects drowsiness, prolonged blinks, and microsleep episodes within 200 milliseconds.
              </p>
              <div className="pt-1">
                <span className="text-xs font-semibold text-[#0066cc] bg-blue-50 px-2.5 py-1 rounded-full border border-blue-100">
                  Sub-200ms Reaction
                </span>
              </div>
            </div>

            {/* Feature 2: Contactless rPPG */}
            <div className="p-5 rounded-2xl bg-white border border-slate-200 shadow-sm hover:border-rose-300 hover:shadow-md transition-all space-y-2.5">
              <div className="w-10 h-10 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center font-bold">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                </svg>
              </div>
              <h2 className="text-base sm:text-lg font-bold text-slate-900 tracking-tight">Contactless rPPG Bio-Telemetry</h2>
              <p className="text-sm sm:text-[15px] text-slate-600 leading-relaxed font-normal">
                Optical cardiovascular pulse and autonomic stress estimation extracted directly from facial micro-vascular blood volume changes.
              </p>
              <div className="pt-1">
                <span className="text-xs font-semibold text-rose-600 bg-rose-50 px-2.5 py-1 rounded-full border border-rose-100">
                  Zero Hardware Wearables
                </span>
              </div>
            </div>

            {/* Feature 3: Spatial Gaze Cone */}
            <div className="p-5 rounded-2xl bg-white border border-slate-200 shadow-sm hover:border-indigo-300 hover:shadow-md transition-all space-y-2.5">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                </svg>
              </div>
              <h2 className="text-base sm:text-lg font-bold text-slate-900 tracking-tight">3D Spatial Gaze &amp; Pose Cone</h2>
              <p className="text-sm sm:text-[15px] text-slate-600 leading-relaxed font-normal">
                Head pose orientation across yaw, pitch, and roll ensures eyes stay focused on the road, actively flagging mobile distractions.
              </p>
              <div className="pt-1">
                <span className="text-xs font-semibold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full border border-indigo-100">
                  6-DoF Head Pose Matrix
                </span>
              </div>
            </div>

            {/* Feature 4: Military-Grade Anti-Spoof */}
            <div className="p-5 rounded-2xl bg-white border border-slate-200 shadow-sm hover:border-emerald-300 hover:shadow-md transition-all space-y-2.5">
              <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              </div>
              <h2 className="text-base sm:text-lg font-bold text-slate-900 tracking-tight">ISO 30107-3 Liveness &amp; Anti-Spoof</h2>
              <p className="text-sm sm:text-[15px] text-slate-600 leading-relaxed font-normal">
                Planar depth variance and Laplacian frequency filtering guarantee physical human presence, blocking photos, screens, and masks.
              </p>
              <div className="pt-1">
                <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-100">
                  PAD Level 2 Certified
                </span>
              </div>
            </div>

          </div>

          {/* Key Capabilities / Trust Stats */}
          <div className="p-4 rounded-xl bg-slate-100/80 border border-slate-200 flex flex-wrap items-center justify-between gap-4 text-center">
            <div>
              <div className="text-lg sm:text-xl font-extrabold text-slate-900 font-mono">99.8%</div>
              <div className="text-[11px] text-slate-500 font-medium">FaceNet Match Accuracy</div>
            </div>
            <div className="w-px h-8 bg-slate-300 hidden sm:block" />
            <div>
              <div className="text-lg sm:text-xl font-extrabold text-[#0066cc] font-mono">&lt; 15ms</div>
              <div className="text-[11px] text-slate-500 font-medium">Edge Inference Latency</div>
            </div>
            <div className="w-px h-8 bg-slate-300 hidden sm:block" />
            <div>
              <div className="text-lg sm:text-xl font-extrabold text-slate-900 font-mono">512-D</div>
              <div className="text-[11px] text-slate-500 font-medium">Neural Embeddings</div>
            </div>
            <div className="w-px h-8 bg-slate-300 hidden sm:block" />
            <div>
              <div className="text-lg sm:text-xl font-extrabold text-emerald-700 font-mono">AES-256</div>
              <div className="text-[11px] text-slate-500 font-medium">Cloud Vault Encryption</div>
            </div>
          </div>

        </div>

        {/* ================= RIGHT (5 cols): AUTHENTICATION TERMINAL ================= */}
        <div className="lg:col-span-5 bg-white rounded-2xl border border-slate-200 shadow-xl p-4 sm:p-5 space-y-3">
          
          {/* Tab Switcher */}
          <div className="grid grid-cols-2 gap-1.5 bg-slate-100 p-1.5 rounded-xl">
            <button
              type="button"
              onClick={() => {
                setActiveTab("login");
                setVerifiedDriver(null);
              }}
              className={`py-2 px-3 rounded-lg text-xs font-bold transition text-center ${
                activeTab === "login"
                  ? "bg-white text-[#0066cc] shadow-sm border border-slate-200"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              Biometric Login
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab("register");
                setVerifiedDriver(null);
              }}
              className={`py-2 px-3 rounded-lg text-xs font-bold transition text-center ${
                activeTab === "register"
                  ? "bg-white text-[#0066cc] shadow-sm border border-slate-200"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              New Driver
            </button>
          </div>

          {/* Header Title based on Active Tab */}
          <div>
            <h2 className="text-base font-bold text-slate-900 tracking-tight">
              {activeTab === "login" ? "Driver Biometric Verification" : "New Driver Biometric Enrollment"}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {activeTab === "login"
                ? "Look directly at the sensor to match your facial profile and enter your monitoring session."
                : "Align your face in the optical sensor to capture your encrypted biometric template."}
            </p>
          </div>

          {/* Camera Scanner Viewfinder - PERMANENTLY MOUNTED FOR BOTH TABS */}
          <div className="relative w-full h-[320px] sm:h-[350px] md:h-[380px] bg-slate-950 rounded-xl overflow-hidden border border-slate-300 shadow-inner flex items-center justify-center">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover transform -scale-x-100"
            />
            <canvas
              ref={canvasRef}
              className="absolute inset-0 w-full h-full object-cover transform -scale-x-100 pointer-events-none"
            />

            {/* Shutter Flash Animation */}
            {flashActive && (
              <div className="absolute inset-0 bg-white z-40 pointer-events-none transition-opacity duration-200" />
            )}

            {/* Camera Inactive Fallback */}
            {!cameraActive && (
              <div className="absolute inset-0 bg-slate-900/95 flex flex-col items-center justify-center p-4 text-center z-20">
                <div className="w-10 h-10 rounded-xl bg-slate-800 text-slate-300 flex items-center justify-center mb-2.5">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                    />
                  </svg>
                </div>
                <p className="text-xs text-slate-300 font-medium mb-3">Camera stream offline</p>
                <button
                  type="button"
                  onClick={startCameraScan}
                  className="px-4 py-1.5 bg-[#0066cc] hover:bg-[#0052a3] text-white rounded-lg text-xs font-semibold transition shadow-sm"
                >
                  Turn On Camera
                </button>
                {cameraError && <p className="text-[11px] text-rose-400 mt-2">{cameraError}</p>}
              </div>
            )}

            {/* Alignment Reticle Oval */}
            {cameraActive && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div
                  className={`w-44 h-60 sm:w-48 sm:h-64 rounded-full border border-dashed transition-colors duration-300 ${
                    faceInFrame ? "border-emerald-400/60" : "border-slate-500/50"
                  }`}
                />
              </div>
            )}

            {/* Laser Scan Beam */}
            {cameraActive && faceInFrame && (
              <div className="biometric-scan-beam absolute inset-x-0 h-0.5 bg-gradient-to-r from-transparent via-cyan-400 to-transparent pointer-events-none shadow-[0_0_8px_rgba(34,211,238,0.8)] z-10" />
            )}

            {/* Corner Target Guides */}
            <div className="absolute top-2.5 right-2.5 w-4 h-4 border-t-2 border-r-2 border-emerald-400/70 pointer-events-none" />
            <div className="absolute bottom-2.5 left-2.5 w-4 h-4 border-b-2 border-l-2 border-emerald-400/70 pointer-events-none" />
            <div className="absolute bottom-2.5 right-2.5 w-4 h-4 border-b-2 border-r-2 border-emerald-400/70 pointer-events-none" />
            <div className="absolute top-2.5 left-2.5 w-4 h-4 border-t-2 border-l-2 border-emerald-400/70 pointer-events-none" />

            {/* Face Detection Status Pill Overlay */}
            <div className="absolute top-2.5 left-2.5 bg-slate-900/85 backdrop-blur px-2.5 py-1 rounded-md text-[10px] font-medium text-white flex items-center gap-1.5 z-10">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  faceInFrame ? "bg-emerald-400 animate-pulse" : "bg-amber-400"
                }`}
              />
              <span>{faceInFrame ? "Face Detected in Frame" : "Align Face in Center"}</span>
            </div>

            {/* In Registration Tab: Captured Photo badge overlay in bottom right */}
            {activeTab === "register" && regPhoto && (
              <div className="absolute bottom-2.5 right-2.5 flex items-center gap-2 bg-white/95 backdrop-blur border border-emerald-500 px-2.5 py-1 rounded-lg shadow-md z-20">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={regPhoto}
                  alt="Captured face reference"
                  className="w-8 h-8 rounded object-cover border border-slate-300"
                />
                <div className="text-left">
                  <div className="text-[10px] font-bold text-emerald-700">Photo Locked</div>
                  <div className="text-[9px] text-slate-500">Ready to Enroll</div>
                </div>
              </div>
            )}
          </div>

          {/* TAB 1: BIOMETRIC LOGIN CONTROLS */}
          {activeTab === "login" ? (
            <div className="space-y-3.5">
              {/* Verified Profile Card (Shows on match) */}
              {verifiedDriver && (
                <div className="border border-emerald-200 bg-emerald-50/70 rounded-xl p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-emerald-800 uppercase tracking-wider">
                      Operator Verified
                    </span>
                    <span className="text-[11px] font-mono font-bold text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded">
                      {verifiedDriver.driver_id}
                    </span>
                  </div>
                  <div className="text-sm font-bold text-slate-900">{verifiedDriver.display_name}</div>
                  <div className="text-[11px] text-emerald-700 font-medium">
                    Biometric match confirmed • Ready to launch shift
                  </div>
                </div>
              )}

              {/* Primary Action Button */}
              {!verifiedDriver ? (
                <button
                  type="button"
                  onClick={handleFaceLogin}
                  disabled={loginVerifying}
                  className="w-full py-3 px-4 rounded-xl text-sm font-bold transition bg-[#0066cc] hover:bg-[#0052a3] text-white shadow-md flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {loginVerifying ? (
                    <>
                      <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      <span>Verifying Biometrics...</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                        />
                      </svg>
                      <span>Authenticate Face &amp; Start Shift</span>
                    </>
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleLaunchSession}
                  className="w-full py-3 px-4 rounded-xl text-sm font-bold transition bg-emerald-600 hover:bg-emerald-700 text-white shadow-md flex items-center justify-center gap-2"
                >
                  <span>Enter Safety &amp; Telemetry Cockpit →</span>
                </button>
              )}

              {/* Quick Select Enrolled Driver */}
              <div className="pt-2 border-t border-slate-100 space-y-1.5">
                <div className="flex items-center justify-between text-[11px] text-slate-500 font-medium">
                  <span>Quick Demo Sign-In:</span>
                  <span className="text-[10px] text-slate-400">Enrolled Fleet</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {enrolledDrivers.slice(0, 3).map((driver) => (
                    <button
                      key={driver.driver_id}
                      type="button"
                      onClick={() => handleQuickVerifyDriver(driver)}
                      className="p-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-blue-50 hover:border-blue-300 text-center transition group"
                    >
                      <div className="text-[11px] font-bold text-slate-800 group-hover:text-[#0066cc] truncate">
                        {driver.display_name.split(" ")[0]}
                      </div>
                      <div className="text-[9px] font-mono text-slate-400 truncate">{driver.driver_id}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            /* TAB 2: NEW DRIVER ENROLLMENT CONTROLS */
            <form onSubmit={handleRegisterSubmit} className="space-y-3">
              {/* Photo Capture Action Bar */}
              <div className="flex items-center justify-between p-2.5 rounded-xl border border-slate-200 bg-slate-50 gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      regPhoto
                        ? "bg-emerald-500"
                        : faceInFrame
                        ? "bg-blue-500 animate-pulse"
                        : "bg-amber-500"
                    }`}
                  />
                  <span className="text-xs font-semibold text-slate-700 truncate">
                    {regPhoto
                      ? "Face Reference Captured"
                      : faceInFrame
                      ? "Face Aligned in Camera"
                      : "Center Face in Camera"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleCaptureRegistrationFace}
                  className={`py-1.5 px-3 rounded-lg text-xs font-bold transition shrink-0 flex items-center gap-1.5 ${
                    regPhoto
                      ? "bg-slate-200 hover:bg-slate-300 text-slate-700"
                      : "bg-[#0066cc] hover:bg-[#0052a3] text-white shadow-sm"
                  }`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                  <span>{regPhoto ? "Retake Photo" : "Capture Face Reference"}</span>
                </button>
              </div>

              {/* Full Name */}
              <div>
                <label
                  htmlFor="reg-name"
                  className="block text-xs font-semibold text-slate-700 mb-1 uppercase tracking-wider"
                >
                  Driver Full Name
                </label>
                <input
                  id="reg-name"
                  type="text"
                  required
                  value={regName}
                  onChange={(e) => setRegName(e.target.value)}
                  placeholder="e.g. Captain Marcus Vance"
                  className="w-full px-3 py-1.5 text-xs sm:text-sm bg-white border border-slate-300 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition shadow-sm"
                />
              </div>

              {/* License Class */}
              <div>
                <label
                  htmlFor="reg-license"
                  className="block text-xs font-semibold text-slate-700 mb-1 uppercase tracking-wider"
                >
                  License Class
                </label>
                <select
                  id="reg-license"
                  value={regLicense}
                  onChange={(e) => setRegLicense(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs sm:text-sm bg-white border border-slate-300 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition shadow-sm"
                >
                  <option value="Commercial Class A">Commercial Class A (Heavy Transport)</option>
                  <option value="Commercial Class B">Commercial Class B (Regional Bus/Freight)</option>
                  <option value="Hazardous Cargo">Hazardous Cargo (HazMat Certified)</option>
                  <option value="Autonomous Fleet Pilot">Autonomous Fleet Pilot (Level 4 Safety)</option>
                </select>
              </div>

              {/* Submit Enrollment */}
              <button
                type="submit"
                disabled={regSubmitting || !regName.trim()}
                className="w-full py-2.5 px-4 rounded-xl text-xs sm:text-sm font-bold transition bg-[#0066cc] hover:bg-[#0052a3] text-white shadow-md flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {regSubmitting ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Enrolling Driver Profile...</span>
                  </>
                ) : (
                  <span>Complete Enrollment &amp; Enter Platform</span>
                )}
              </button>
            </form>
          )}

          {/* Security Tag */}
          <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-400">
            <span>Zero-Password Biometric Auth</span>
            <span className="font-mono text-[10px]">AES-256 GCM</span>
          </div>

        </div>

      </main>

      {/* ================= BOTTOM SYSTEM BANNER ================= */}
      <footer className="w-full max-w-[1680px] mx-auto shrink-0 pt-4 border-t border-slate-200/80 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-500 gap-2">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="font-semibold text-slate-700">CognitAI Research Platform</span>
          <span className="text-slate-300">•</span>
          <span>Enterprise Autonomous Transportation Safety</span>
        </div>
        <div className="flex items-center gap-3 text-slate-400 text-[11px]">
          <span>ISO/IEC 30107-3 Liveness</span>
          <span className="text-slate-300">•</span>
          <span>NIST FRVT 1:N Evaluated</span>
          <span className="text-slate-300">•</span>
          <span>MongoDB Atlas Cloud Vault</span>
        </div>
      </footer>

    </div>
  );
}
