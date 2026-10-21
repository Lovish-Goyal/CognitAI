"use client";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

export type CameraHandle = { capture: () => Promise<Blob>; sampleRgb: () => { red: number; green: number; blue: number }; retry: () => void };
type Props = { className?: string; onReady?: () => void };

const Camera = forwardRef<CameraHandle, Props>(function Camera({ className = "", onReady }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const capture = useCallback(() => new Promise<Blob>((resolve, reject) => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return reject(new Error("Camera is not ready"));
    const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Image capture failed")), "image/jpeg", 0.92);
  }), []);
  const sampleRgb = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) throw new Error("Camera is not ready");
    const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Pixel sampler unavailable");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    // Forehead/cheek-friendly central upper facial ROI; no frame is retained after aggregation.
    const x = Math.floor(canvas.width * 0.32), y = Math.floor(canvas.height * 0.18), width = Math.floor(canvas.width * 0.36), height = Math.floor(canvas.height * 0.28);
    const pixels = context.getImageData(x, y, width, height).data; let red = 0, green = 0, blue = 0, total = 0;
    for (let index = 0; index < pixels.length; index += 16) { red += pixels[index]; green += pixels[index + 1]; blue += pixels[index + 2]; total += 1; }
    return { red: red / total, green: green / total, blue: blue / total };
  }, []);
  useImperativeHandle(ref, () => ({ capture, sampleRgb, retry: () => setRetryNonce((value) => value + 1) }), [capture, sampleRgb]);
  useEffect(() => {
    let stream: MediaStream | undefined;
    let disposed = false;
    setError(null);
    const start = async () => {
      try {
        const constraints: MediaStreamConstraints = { video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (disposed || !videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
        if (!disposed) onReady?.();
      } catch (reason) {
        if (disposed) return;
        const code = reason instanceof DOMException ? reason.name : "UnknownError";
        const message = code === "NotAllowedError" ? "Permission blocked: click the camera icon beside the address bar and choose Allow."
          : code === "NotReadableError" ? "Camera is busy in another app. Close Windows Camera, Teams, Zoom, or another browser tab, then retry."
          : code === "OverconstrainedError" ? "Your default camera is unavailable. Disconnect and reconnect it, then retry."
          : `Camera could not start (${code}). Check Windows Settings › Privacy & security › Camera.`;
        setError(message);
      }
    };
    void start();
    return () => { disposed = true; stream?.getTracks().forEach((track) => track.stop()); };
  }, [onReady, retryNonce]);
  return <div className={`relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 shadow-sm ${className}`}><video ref={videoRef} muted playsInline className="aspect-video w-full object-cover" />{error && <div className="absolute inset-0 grid place-items-center gap-3 bg-white/90 p-6 text-center text-slate-700"><p className="max-w-sm font-medium">{error}</p><button type="button" onClick={() => setRetryNonce((value) => value + 1)} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">Retry camera</button></div>}</div>;
});
export default Camera;
