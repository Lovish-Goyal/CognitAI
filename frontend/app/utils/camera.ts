/**
 * Robust cross-browser webcam stream acquisition with singleton sharing
 * and smooth tab-switching handover without camera driver lockouts.
 */

let sharedStream: MediaStream | null = null;
let acquisitionPromise: Promise<{ stream: MediaStream | null; error: string | null }> | null = null;

export async function requestWebcamStream(): Promise<{ stream: MediaStream | null; error: string | null }> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return {
      stream: null,
      error: "Webcam access API (navigator.mediaDevices.getUserMedia) is not supported in this browser.",
    };
  }

  // Reuse existing live stream across navigation tabs for instant transition
  if (sharedStream) {
    const tracks = sharedStream.getVideoTracks();
    if (tracks.length > 0 && tracks[0].readyState === "live" && tracks[0].enabled) {
      return { stream: sharedStream, error: null };
    }
    sharedStream = null;
  }

  // Prevent concurrent getUserMedia calls from racing against each other
  if (acquisitionPromise) {
    return acquisitionPromise;
  }

  acquisitionPromise = (async () => {
    // Attempt 1: Standard 720p Resolution
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      sharedStream = stream;
      return { stream, error: null };
    } catch (err1) {
      // Attempt 2: Minimal Fallback without constraints
      try {
        const fallbackStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
        sharedStream = fallbackStream;
        return { stream: fallbackStream, error: null };
      } catch (err2: unknown) {
        const errorObj = err2 as { name?: string; message?: string };
        const errName = errorObj?.name || "";

        if (errName === "NotAllowedError" || errName === "PermissionDeniedError") {
          return {
            stream: null,
            error: "Camera access was not granted.",
          };
        }
        if (errName === "NotReadableError" || errName === "TrackStartError") {
          return {
            stream: null,
            error: "Camera is busy in another application.",
          };
        }
        if (errName === "NotFoundError" || errName === "DevicesNotFoundError") {
          return {
            stream: null,
            error: "No webcam detected.",
          };
        }

        return {
          stream: null,
          error: errorObj?.message || "Unable to start webcam stream.",
        };
      }
    } finally {
      acquisitionPromise = null;
    }
  })();

  return acquisitionPromise;
}

/**
 * Gracefully release or stop webcam stream.
 * Tracks remain active across navigation tabs and only stopped when force=true
 * or when the user closes the browser session.
 */
export function releaseWebcamStream(streamOrForce?: MediaStream | boolean | null, force: boolean = false): void {
  if (streamOrForce && typeof streamOrForce !== "boolean") {
    streamOrForce.getTracks().forEach((track) => track.stop());
    if (sharedStream === streamOrForce) {
      sharedStream = null;
    }
  } else if (typeof streamOrForce === "boolean" ? streamOrForce : force) {
    if (sharedStream) {
      sharedStream.getTracks().forEach((track) => track.stop());
      sharedStream = null;
    }
  }
}
