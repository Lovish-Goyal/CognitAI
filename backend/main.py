"""Secure Facial Attendance System & Multi-Layer Biometric Verification Core."""
from __future__ import annotations
import base64
import hashlib
import hmac
import json
import os
import random
import smtplib
import sqlite3
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

# Ensure backend directory is in sys.path regardless of working directory
BACKEND_DIR = str(Path(__file__).resolve().parent)
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import cv2
import numpy as np
import torch
from cryptography.fernet import Fernet
from dotenv import load_dotenv
from email.mime.text import MIMEText
from facenet_pytorch import InceptionResnetV1, MTCNN
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from scipy.signal import butter, sosfiltfilt

import database
from mongodb_client import (
    count_mongo_drivers,
    find_mongo_driver,
    get_client,
    get_mongo_audit_history,
    get_mongodb_status,
    init_mongo,
    log_audit_event,
    log_mongo_incident,
    search_mongo_drivers,
    upsert_mongo_driver,
)

load_dotenv()

# --- System Configuration & Biometric Thresholds ---
DEVICE = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")

# Configurable, calibrated confidence thresholds (provisional benchmark for Inception-ResNet-v1 VGGFace2)
CONFIDENCE_VERIFIED_THRESHOLD = float(os.getenv("FACE_VERIFIED_THRESHOLD", "0.68"))
CONFIDENCE_RETRY_THRESHOLD = float(os.getenv("FACE_RETRY_THRESHOLD", "0.55"))
THRESHOLD = CONFIDENCE_VERIFIED_THRESHOLD  # Harmonized threshold for legacy references

# Neural Network Models
detector = MTCNN(image_size=160, margin=20, thresholds=[0.5, 0.6, 0.6], keep_all=False, device=DEVICE)
embedder = InceptionResnetV1(pretrained="vggface2").eval().to(DEVICE)
cv2_data = getattr(cv2, "data", None)
haar_cascade_path = (getattr(cv2_data, "haarcascades", "") or "") + "haarcascade_frontalface_default.xml"
face_cascade = cv2.CascadeClassifier(haar_cascade_path) if haar_cascade_path and os.path.exists(haar_cascade_path) else None

# Active Liveness Challenge Engine
CHALLENGE_STORE: dict[str, dict[str, Any]] = {}
CHALLENGE_LOCK = threading.Lock()
CHALLENGE_TTL_SECONDS = 12.0

depth_history: dict[str, list[float]] = {}
driver_embeddings_cache: dict[str, tuple[int, np.ndarray, dict[str, Any]]] = {}

# --- Pydantic Request Models ---

class AttendanceMarkRequest(BaseModel):
    photo_base64: str = Field(min_length=100)
    challenge_id: str = Field(min_length=4, max_length=50)
    challenge_token: str = Field(min_length=10, max_length=128)
    challenge_evidence: str = Field(default="[]")  # JSON-encoded array of kinematic frames
    claimed_student_code: Optional[str] = None      # Optional for 1:1 verification, omitted for 1:N
    landmark_matrix: Optional[str] = None          # Optional 468-point 3D landmark matrix

class StudentRegisterRequest(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    student_code: str = Field(min_length=2, max_length=40)
    department: str = Field(default="Computer Science", max_length=100)
    photo_base64: str = Field(min_length=100)

class DriverVerifyRequest(BaseModel):
    display_name: Optional[str] = None
    driver_id: Optional[str] = None
    photo_base64: Optional[str] = None
    facial_features: Optional[dict] = None

class DriverLoginRequest(BaseModel):
    face_photo_base64: Optional[str] = None
    photo_base64: Optional[str] = None
    driver_id: Optional[str] = None
    display_name: Optional[str] = None

class DriverRegisterRequest(BaseModel):
    display_name: str = Field(min_length=2, max_length=100)
    driver_id: Optional[str] = Field(default=None, max_length=40)
    license_class: Optional[str] = Field(default="Commercial Class A", max_length=80)
    photo_base64: Optional[str] = None
    facial_features: Optional[dict] = None

class AuditLogRequest(BaseModel):
    event_type: str = Field(min_length=2, max_length=50)
    driver_id: str = Field(min_length=1, max_length=50)
    driver_name: str = Field(min_length=1, max_length=100)
    reason: str = Field(min_length=1, max_length=500)
    severity: str = Field(default="INFO", max_length=20)
    duration_seconds: float = 0.0
    metadata: Optional[dict] = None

class EmergencyDispatchRequest(BaseModel):
    driver_id: str = Field(min_length=2, max_length=40)
    structural_failure_code: str = Field(min_length=3, max_length=100)
    client_timestamp_ms: float = Field(ge=0)

class ReportIncidentRequest(BaseModel):
    driver_id: str = Field(min_length=2, max_length=50)
    reason: str = Field(min_length=3, max_length=150)
    duration_seconds: float = Field(default=0.0, ge=0)

# --- Persistence Helpers ---

def now() -> str:
    return database.utc_now()

def fernet() -> Fernet:
    return database.get_fernet()

@contextmanager
def connection() -> Iterator[sqlite3.Connection]:
    with database.connection() as conn:
        yield conn

def initialise() -> None:
    """Initializes unified database schemas and initial default profiles if empty."""
    database.initialize_database()
    f = fernet()
    with connection() as conn:
        cur = conn.execute("SELECT COUNT(*) FROM encrypted_driver_profiles")
        if cur.fetchone()[0] == 0:
            mock_emb1 = np.random.randn(512).astype(np.float32)
            mock_emb1 = (mock_emb1 / np.linalg.norm(mock_emb1)).tobytes()
            mock_emb2 = np.random.randn(512).astype(np.float32)
            mock_emb2 = (mock_emb2 / np.linalg.norm(mock_emb2)).tobytes()
            conn.execute(
                "INSERT INTO encrypted_driver_profiles (driver_id, display_name, encrypted_embedding, created_at, photo_base64, license_class) VALUES (?, ?, ?, ?, ?, ?)",
                ("DRIVER-001", "Alex Mercer (Fleet Logistics Lead)", f.encrypt(mock_emb1).decode(), now(), "", "Commercial Class A"),
            )
            conn.execute(
                "INSERT INTO encrypted_driver_profiles (driver_id, display_name, encrypted_embedding, created_at, photo_base64, license_class) VALUES (?, ?, ?, ?, ?, ?)",
                ("DRIVER-002", "Sarah Chen (Hazardous Cargo Transport)", f.encrypt(mock_emb2).decode(), now(), "", "Commercial Class A"),
            )
            # Also seed students table
            conn.execute(
                "INSERT OR IGNORE INTO students (student_code, name, department, encrypted_embeddings, created_at) VALUES (?, ?, ?, ?, ?)",
                ("DRIVER-001", "Alex Mercer", "Fleet Logistics", f.encrypt(mock_emb1).decode(), now()),
            )
            conn.execute(
                "INSERT OR IGNORE INTO students (student_code, name, department, encrypted_embeddings, created_at) VALUES (?, ?, ?, ?, ?)",
                ("DRIVER-002", "Sarah Chen", "Hazardous Cargo", f.encrypt(mock_emb2).decode(), now()),
            )

        cur2 = conn.execute("SELECT COUNT(*) FROM system_breach_indicators")
        if cur2.fetchone()[0] == 0:
            conn.execute("INSERT INTO system_breach_indicators (driver_id, breach_code, delivery_state, created_at) VALUES (?, ?, ?, ?)", ("DRIVER-001", "PLANAR_PRESENTATION_ATTACK_BLOCKED [10856104.pdf]", "Z-VAR: 0.0000008 (FLAT_2D_SURFACE)", now()))
            conn.execute("INSERT INTO system_breach_indicators (driver_id, breach_code, delivery_state, created_at) VALUES (?, ?, ?, ?)", ("DRIVER-002", "LAPLACIAN_TEXTURE_ANOMALY", "TEXTURE_VAR: 44.2 (LOW_TEXTURE_REPLAY)", now()))

# --- Computer Vision & Biometric Embeddings ---

async def decode(image: UploadFile) -> np.ndarray:
    raw = await image.read(5 * 1024 * 1024 + 1)
    if not raw or len(raw) > 5 * 1024 * 1024:
        raise HTTPException(400, "Invalid image payload or payload exceeds 5MB")
    frame = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise HTTPException(400, "Image cannot be decoded")
    return frame

@torch.inference_mode()
def embedding(frame: np.ndarray) -> np.ndarray:
    face = detector(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    if face is None:
        raise HTTPException(422, "A clear human face is required")
    vector = embedder(face.unsqueeze(0).to(DEVICE)).cpu().numpy()[0].astype(np.float32)
    norm = np.linalg.norm(vector)
    return vector / norm if norm > 0 else vector

def cosine(a: np.ndarray, b: np.ndarray) -> float:
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))

def extract_face_embedding_from_b64(b64_str: str) -> Optional[np.ndarray]:
    """Extracts a normalized 512-D FaceNet InceptionResnetV1 embedding from a base64 encoded frame."""
    if not b64_str or len(b64_str) < 50:
        return None
    try:
        raw = base64.b64decode(b64_str.split(",")[-1])
        img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            return None

        h, w = img.shape[:2]
        max_dim = 480
        if max(h, w) > max_dim:
            scale = max_dim / float(max(h, w))
            img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)

        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        face_tensor = None

        with torch.inference_mode():
            try:
                face_tensor = detector(rgb)
            except Exception as e:
                print(f"[MTCNN Notice] {e}")

            if face_tensor is None and face_cascade is not None:
                gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
                faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(60, 60))
                if len(faces) > 0:
                    x, y, w_box, h_box = max(faces, key=lambda b: b[2] * b[3])
                    margin_x = int(w_box * 0.15)
                    margin_y = int(h_box * 0.15)
                    x1 = max(0, x - margin_x)
                    y1 = max(0, y - margin_y)
                    x2 = min(rgb.shape[1], x + w_box + margin_x)
                    y2 = min(rgb.shape[0], y + h_box + margin_y)
                    crop = rgb[y1:y2, x1:x2]
                    crop_resized = cv2.resize(crop, (160, 160))
                    tensor_np = np.transpose(crop_resized, (2, 0, 1)).astype(np.float32)
                    tensor_np = (tensor_np - 127.5) / 128.0
                    face_tensor = torch.from_numpy(tensor_np)

            if face_tensor is None:
                return None

            vec = embedder(face_tensor.unsqueeze(0).to(DEVICE)).cpu().numpy()[0].astype(np.float32)
            norm = np.linalg.norm(vec)
            if norm > 0:
                vec = vec / norm
            return vec
    except Exception as ex:
        print(f"[FaceNet Embedding Error] {ex}")
        return None

def preload_all_driver_embeddings() -> None:
    """Preloads and caches all enrolled student and driver embeddings in memory."""
    global driver_embeddings_cache
    f = fernet()
    candidates: list[dict[str, Any]] = []

    try:
        with connection() as conn:
            # 1. Load from students table
            s_rows = conn.execute("SELECT student_code, name, department, encrypted_embeddings, created_at FROM students").fetchall()
            for r in s_rows:
                candidates.append({
                    "driver_id": r["student_code"],
                    "display_name": r["name"],
                    "license_class": r["department"],
                    "photo_base64": "",
                    "encrypted_embedding": r["encrypted_embeddings"],
                    "created_at": r["created_at"],
                })

            # 2. Load from driver profiles table
            d_rows = conn.execute("SELECT driver_id, display_name, created_at, photo_base64, license_class, encrypted_embedding FROM encrypted_driver_profiles ORDER BY created_at DESC").fetchall()
            seen_ids = {c["driver_id"] for c in candidates}
            for r in d_rows:
                if r["driver_id"] not in seen_ids:
                    candidates.append({
                        "driver_id": r["driver_id"],
                        "display_name": r["display_name"],
                        "photo_base64": r["photo_base64"] if "photo_base64" in r.keys() else "",
                        "license_class": r["license_class"] if "license_class" in r.keys() else "Commercial Class A",
                        "encrypted_embedding": r["encrypted_embedding"] if "encrypted_embedding" in r.keys() else "",
                        "created_at": r["created_at"],
                    })
    except Exception as ex:
        print(f"[Preload SQLite Warning] {ex}")

    count_loaded = 0
    for cand in candidates:
        cand_id = cand.get("driver_id", "")
        if not cand_id:
            continue
        cand_encrypted = cand.get("encrypted_embedding") or ""
        cand_vec = None

        if cand_encrypted and cand_encrypted != "REVOKED_DELETED_BIOMETRIC_TOKEN":
            try:
                raw_bytes = f.decrypt(cand_encrypted.encode())
                vec = np.frombuffer(raw_bytes, dtype=np.float32)
                norm = np.linalg.norm(vec)
                if norm > 0:
                    cand_vec = vec / norm
            except Exception:
                pass

        if cand_vec is not None:
            driver_embeddings_cache[cand_id] = (0, cand_vec, cand)
            count_loaded += 1

    print(f"[Biometric Cache] Preloaded {count_loaded} student/driver templates into high-speed memory cache.")

# --- Liveness Challenge-Response & Presentation Attack Defense ---

def get_challenge_hmac_secret() -> bytes:
    return database.get_audit_hmac_key()

def validate_liveness_challenge(
    challenge_id: str,
    token: str,
    evidence_json: str,
) -> tuple[bool, str, float]:
    """Validates challenge token authenticity, expiration, and algorithmic kinematic motion evidence."""
    now_ms = time.time() * 1000.0
    with CHALLENGE_LOCK:
        chal = CHALLENGE_STORE.pop(challenge_id, None)

    if chal is None:
        return False, "Challenge not found, already consumed, or expired.", 0.0

    if now_ms > chal["expires_ms"]:
        return False, "Liveness challenge expired. Please retry with a new challenge.", 0.0

    # Verify cryptographic HMAC signature on token
    expected_payload = f"{challenge_id}:{chal['type']}:{chal['expires_ms']:.0f}".encode("utf-8")
    expected_token = hmac.new(get_challenge_hmac_secret(), expected_payload, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected_token, token):
        return False, "Forged or tampered challenge token.", 0.0

    # Parse temporal kinematic evidence
    try:
        evidence = json.loads(evidence_json) if isinstance(evidence_json, str) else evidence_json
        if not isinstance(evidence, list) or len(evidence) < 3:
            return False, "Insufficient temporal kinematic evidence. At least 3 frame samples required.", 0.0
    except Exception:
        return False, "Malformed challenge evidence payload.", 0.0

    chal_type = chal["type"]
    liveness_score = 0.0

    if chal_type == "HEAD_TURN_LEFT":
        yaws = [float(f.get("yaw", 0.0)) for f in evidence if isinstance(f, dict)]
        min_yaw = min(yaws)
        final_yaw = yaws[-1]
        if min_yaw <= chal["threshold"] and final_yaw >= -15.0:
            liveness_score = min(1.0, abs(min_yaw) / 20.0)
            return True, f"Verified head turn left (min yaw: {min_yaw:.1f}°)", liveness_score
        return False, f"Head turn left threshold ({chal['threshold']}°) not reached. (Min yaw: {min_yaw:.1f}°)", 0.0

    elif chal_type == "HEAD_TURN_RIGHT":
        yaws = [float(f.get("yaw", 0.0)) for f in evidence if isinstance(f, dict)]
        max_yaw = max(yaws)
        final_yaw = yaws[-1]
        if max_yaw >= chal["threshold"] and final_yaw <= 15.0:
            liveness_score = min(1.0, max_yaw / 20.0)
            return True, f"Verified head turn right (max yaw: {max_yaw:.1f}°)", liveness_score
        return False, f"Head turn right threshold ({chal['threshold']}°) not reached. (Max yaw: {max_yaw:.1f}°)", 0.0

    elif chal_type == "BLINK":
        ears = [float(f.get("ear", 0.30)) for f in evidence if isinstance(f, dict)]
        min_ear = min(ears)
        max_ear = max(ears)
        if min_ear <= chal["threshold"] or (max_ear - min_ear) >= 0.035:
            liveness_score = min(1.0, max(0.5, (max_ear - min_ear) / 0.12))
            return True, f"Verified dynamic eye blink (min EAR: {min_ear:.2f}, max EAR: {max_ear:.2f})", liveness_score
        return False, f"Blink closure threshold (< {chal['threshold']}) was not detected in evidence stream. (Min EAR: {min_ear:.2f})", 0.0

    return False, f"Unknown challenge type: {chal_type}", 0.0

def evaluate_presentation_attack(
    frame: np.ndarray,
    landmark_matrix: Optional[str] = None,
) -> tuple[bool, str, float]:
    """Analyzes high-frequency texture gradient (Laplacian blur) and Z-curvature depth to intercept 2D photo/screen replays."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    texture_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())

    # 1. Evaluate 3D Z-axis curvature if 468 landmark coordinates provided
    # Forgiving threshold (0.00007) allows standard webcams and slight angles while blocking flat photos (< 0.00005)
    if landmark_matrix and len(landmark_matrix) > 20:
        try:
            lm = np.asarray(json.loads(landmark_matrix), dtype=np.float64)
            if lm.ndim == 2 and lm.shape[0] >= 100 and lm.shape[1] >= 3:
                z_var = float(np.var(lm[:, 2]))
                if z_var < 0.00007:
                    return False, f"PLANAR_2D_SPOOF_DETECTED: Flat volumetric depth variance ({z_var:.6f} < 0.00007)", texture_var
        except Exception:
            pass

    # 2. Low texture variance indicates a blurry photo, low-resolution paper, or out-of-focus replay
    # Relaxed to 20.0 to prevent false rejections in dim indoor webcam lighting
    if texture_var < 20.0:
        return False, f"TEXTURE_BLUR_PHOTO_SPOOF: Low spatial Laplacian variance ({texture_var:.1f} < 20.0)", texture_var

    # 3. Excessive texture variance indicates digital moiré frequency artifacts from screen replays
    if texture_var > 6500.0:
        return False, f"HIGH_FREQUENCY_SCREEN_MOIRE: Abnormal frequency variance ({texture_var:.1f} > 6500.0)", texture_var

    return True, "PASSED_TEXTURE_AND_DEPTH_ANALYSIS", texture_var

# --- FastAPI Application ---

app = FastAPI(title="Secure Facial Attendance & Multi-Layer Biometric Verification Core", version="3.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
def startup() -> None:
    initialise()
    try:
        init_mongo()
    except Exception as e:
        print(f"[MongoDB Startup Notice] {e}")
    threading.Thread(target=preload_all_driver_embeddings, daemon=True).start()

@app.get("/")
@app.head("/")
def root() -> dict[str, str]:
    return {"status": "ok", "app": "Secure Facial Attendance System", "version": "3.0"}

@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "mode": "research", "system": "secure_facial_attendance"}

# --- ATTENDANCE & LIVENESS ENDPOINTS ---

@app.post("/api/attendance/challenge")
def create_attendance_challenge() -> dict[str, Any]:
    """Issues a randomized, cryptographically-signed, time-limited liveness challenge."""
    challenge_id = f"CHAL_{uuid.uuid4().hex[:12].upper()}"
    challenge_options = [
        {
            "type": "HEAD_TURN_LEFT",
            "prompt": "Liveness Check: Turn your head slightly LEFT, then look forward",
            "metric": "yaw",
            "threshold": -10.0,
        },
        {
            "type": "HEAD_TURN_RIGHT",
            "prompt": "Liveness Check: Turn your head slightly RIGHT, then look forward",
            "metric": "yaw",
            "threshold": 10.0,
        },
        {
            "type": "BLINK",
            "prompt": "Liveness Check: Blink your eyes naturally, then look forward",
            "metric": "ear",
            "threshold": 0.22,
        },
    ]
    choice = random.choice(challenge_options)
    now_ms = time.time() * 1000.0
    expires_ms = now_ms + (CHALLENGE_TTL_SECONDS * 1000.0)

    token_payload = f"{challenge_id}:{choice['type']}:{expires_ms:.0f}".encode("utf-8")
    token = hmac.new(get_challenge_hmac_secret(), token_payload, hashlib.sha256).hexdigest()

    with CHALLENGE_LOCK:
        # Purge expired challenges
        expired_keys = [k for k, v in CHALLENGE_STORE.items() if (time.time() * 1000.0) > v["expires_ms"]]
        for k in expired_keys:
            CHALLENGE_STORE.pop(k, None)

        CHALLENGE_STORE[challenge_id] = {
            "type": choice["type"],
            "metric": choice["metric"],
            "threshold": choice["threshold"],
            "expires_ms": expires_ms,
            "token": token,
            "created_at_ms": now_ms,
        }

    return {
        "challenge_id": challenge_id,
        "challenge_type": choice["type"],
        "prompt": choice["prompt"],
        "target_metric": choice["metric"],
        "threshold": choice["threshold"],
        "expires_at_ms": expires_ms,
        "ttl_seconds": CHALLENGE_TTL_SECONDS,
        "token": token,
    }

@app.post("/api/attendance/mark")
def mark_attendance(req: AttendanceMarkRequest) -> dict[str, Any]:
    """Secure Attendance Marking Endpoint:
    1. Validates time-limited challenge-response liveness.
    2. Intercepts photo and video presentation spoof attacks.
    3. Extracts 512-D FaceNet embedding from live camera frame.
    4. Evaluates three-tier confidence (VERIFIED, RETRY, REJECTED).
    5. Records attendance with duplicate prevention and HMAC-SHA256 chaining."""
    if not req.photo_base64 or len(req.photo_base64) < 100:
        raise HTTPException(400, "A live camera face capture is required for attendance.")

    try:
        raw = base64.b64decode(req.photo_base64.split(",")[-1])
        frame = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise HTTPException(400, "Unable to decode live camera frame.")
    except Exception:
        raise HTTPException(400, "Malformed base64 camera frame payload.")

    # 1. Validate Active Liveness Challenge
    is_live, live_msg, live_score = validate_liveness_challenge(
        challenge_id=req.challenge_id,
        token=req.challenge_token,
        evidence_json=req.challenge_evidence,
    )
    if not is_live:
        raise HTTPException(
            status_code=403,
            detail={
                "status": "LIVENESS_FAILED",
                "marked": False,
                "message": live_msg,
                "liveness_score": live_score,
            },
        )

    # 2. Evaluate Presentation Attack (Texture + Depth)
    is_genuine, spoof_msg, tex_score = evaluate_presentation_attack(
        frame=frame,
        landmark_matrix=req.landmark_matrix,
    )
    if not is_genuine:
        raise HTTPException(
            status_code=403,
            detail={
                "status": "SPOOF_REJECTED",
                "marked": False,
                "message": spoof_msg,
                "texture_score": round(tex_score, 2),
            },
        )

    # 3. Extract 512-D Normalized Embedding
    query_vec = extract_face_embedding_from_b64(req.photo_base64)
    if query_vec is None:
        raise HTTPException(
            status_code=422,
            detail={
                "status": "NO_FACE_DETECTED",
                "marked": False,
                "message": "No clear human face recognized in camera frame. Center your face directly in front of the optical sensor.",
            },
        )

    # 4. Biometric Template Matching (1:1 or 1:N)
    if not driver_embeddings_cache:
        preload_all_driver_embeddings()

    best_score = -1.0
    best_match: Optional[dict[str, Any]] = None

    if req.claimed_student_code and req.claimed_student_code.strip():
        # 1:1 Verification against claimed student code
        claim_code = req.claimed_student_code.upper().strip()
        cached = driver_embeddings_cache.get(claim_code)
        if cached:
            _, cand_vec, cand_meta = cached
            best_score = float(np.dot(query_vec, cand_vec))
            best_match = cand_meta
    else:
        # 1:N Identification against all enrolled templates
        for cand_id, item in list(driver_embeddings_cache.items()):
            _, cand_vec, cand_meta = item
            sim = float(np.dot(query_vec, cand_vec))
            if sim > best_score:
                best_score = sim
                best_match = cand_meta

    # 5. Confidence-Based Decision Evaluation (Three Outcomes)
    if best_match is None or best_score < CONFIDENCE_RETRY_THRESHOLD:
        score_pct = (best_score * 100) if best_score > 0 else 0.0
        raise HTTPException(
            status_code=401,
            detail={
                "status": "REJECTED",
                "marked": False,
                "similarity": round(best_score, 4) if best_score > -1 else 0.0,
                "threshold_verified": CONFIDENCE_VERIFIED_THRESHOLD,
                "threshold_retry": CONFIDENCE_RETRY_THRESHOLD,
                "message": f"Biometric identification failed (similarity: {score_pct:.1f}%). Unrecognized face — your profile is not enrolled in the database. Please enroll in 'New Driver' tab first.",
            },
        )

    if CONFIDENCE_RETRY_THRESHOLD <= best_score < CONFIDENCE_VERIFIED_THRESHOLD:
        raise HTTPException(
            status_code=409,
            detail={
                "status": "RETRY",
                "marked": False,
                "similarity": round(best_score, 4),
                "threshold_verified": CONFIDENCE_VERIFIED_THRESHOLD,
                "threshold_retry": CONFIDENCE_RETRY_THRESHOLD,
                "message": f"Biometric similarity ({best_score:.3f}) is ambiguous. Please ensure adequate lighting and face camera forward to retry.",
            },
        )

    # 6. VERIFIED: Atomically Mark Attendance with Duplicate Prevention & HMAC Chaining
    student_code = best_match["driver_id"]
    student_name = best_match["display_name"]

    # Resolve student_id integer from students table
    with connection() as conn:
        s_row = conn.execute("SELECT id FROM students WHERE student_code = ?", (student_code,)).fetchone()
        student_id = int(s_row["id"]) if s_row else 1

    res = database.insert_secure_attendance(
        student_id=student_id,
        student_code=student_code,
        name=student_name,
        similarity_score=best_score,
        liveness_score=live_score,
        liveness_type="CHALLENGE_VERIFIED",
        challenge_id=req.challenge_id,
    )

    if res["status"] == "DUPLICATE_REJECTED":
        return {
            "status": "DUPLICATE_REJECTED",
            "marked": False,
            "student_code": student_code,
            "display_name": student_name,
            "message": res["message"],
            "similarity": round(best_score, 4),
        }

    return {
        "status": "VERIFIED",
        "marked": True,
        "student_code": student_code,
        "display_name": student_name,
        "similarity": round(best_score, 4),
        "liveness_verified": True,
        "attendance": res,
        "message": f"Biometric identity verified and attendance marked for {student_name} ({student_code}).",
    }

@app.get("/api/attendance/verify-integrity")
def verify_ledger_integrity() -> dict[str, Any]:
    """Audits the HMAC-SHA256 hash chain and trusted checkpoint to detect any record modification or deletion."""
    return database.verify_attendance_chain_integrity()

@app.get("/api/attendance/history")
def get_attendance_history_endpoint(limit: int = 100) -> dict[str, Any]:
    """Returns chronological attendance records with cryptographic verification tags."""
    records = database.get_attendance_history(limit=limit)
    audit = database.verify_attendance_chain_integrity()
    return {
        "records": records,
        "total": len(records),
        "chain_valid": audit["is_valid"],
        "checkpoint_status": audit["checkpoint_status"],
    }

@app.get("/api/attendance/dashboard")
def get_attendance_dashboard_endpoint() -> dict[str, Any]:
    return database.get_dashboard()

@app.post("/api/students/register")
def register_student_endpoint(req: StudentRegisterRequest) -> dict[str, Any]:
    """Registers a student template with Fernet AES-256 encryption; permanently avoids storing raw photos."""
    vec = extract_face_embedding_from_b64(req.photo_base64)
    if vec is None:
        raise HTTPException(
            status_code=422,
            detail="No clear human face recognized in enrollment photo. Please align your face upright in good lighting.",
        )

    clean_code = req.student_code.upper().strip()
    clean_name = req.name.strip()
    clean_dept = req.department.strip()

    row_id = database.register_student(
        name=clean_name,
        student_code=clean_code,
        department=clean_dept,
        embedding=vec,
    )

    # Update in-memory cache
    driver_embeddings_cache[clean_code] = (0, vec, {
        "driver_id": clean_code,
        "display_name": clean_name,
        "license_class": clean_dept,
        "photo_base64": "",  # Raw photo explicitly NOT stored!
        "status": "Active / Verified",
        "created_at": database.utc_now(),
    })

    return {
        "status": "REGISTERED",
        "student_id": row_id,
        "student_code": clean_code,
        "name": clean_name,
        "department": clean_dept,
        "message": f"Student {clean_name} ({clean_code}) successfully enrolled with encrypted 512-D template. Raw photograph was discarded.",
    }

@app.delete("/api/students/{student_code}/template")
def delete_student_template_endpoint(student_code: str) -> dict[str, Any]:
    """Authorized biometric template deletion/revocation (GDPR compliance)."""
    clean_code = student_code.upper().strip()
    deleted = database.delete_student_biometrics(clean_code)
    if not deleted:
        raise HTTPException(404, f"Student code '{clean_code}' not found in registry.")

    driver_embeddings_cache.pop(clean_code, None)
    return {
        "status": "REVOKED",
        "student_code": clean_code,
        "message": f"Biometric template for {clean_code} permanently wiped and revoked from database and memory.",
    }

# --- Driver & User Management Endpoints (Backward Compatible) ---

@app.get("/api/db-status")
def db_status() -> dict[str, object]:
    return get_mongodb_status()

@app.get("/api/drivers")
def get_drivers(search: str = "", limit: int = 20, skip: int = 0) -> dict[str, object]:
    client = get_client()
    if client is not None:
        mongo_drivers = search_mongo_drivers(query=search, limit=limit, skip=skip)
        return {
            "drivers": mongo_drivers,
            "source": "mongodb",
            "total": count_mongo_drivers(search),
            "search": search,
        }

    with connection() as conn:
        if search.strip():
            term = f"%{search.strip()}%"
            rows = conn.execute(
                "SELECT driver_id, display_name, created_at, photo_base64, license_class FROM encrypted_driver_profiles WHERE display_name LIKE ? OR driver_id LIKE ? ORDER BY driver_id ASC LIMIT ? OFFSET ?",
                (term, term, limit, skip),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT driver_id, display_name, created_at, photo_base64, license_class FROM encrypted_driver_profiles ORDER BY created_at DESC, driver_id ASC LIMIT ? OFFSET ?",
                (limit, skip),
            ).fetchall()

    drivers = [
        {
            "driver_id": r["driver_id"],
            "display_name": r["display_name"],
            "created_at": r["created_at"],
            "license_class": r["license_class"] if "license_class" in r.keys() else "Commercial Class A",
            "status": "Active / Verified",
            "photo_base64": r["photo_base64"] if "photo_base64" in r.keys() else "",
        }
        for r in rows
    ]
    return {
        "drivers": drivers,
        "source": "sqlite_fallback",
        "total": len(drivers),
        "search": search,
    }

@app.post("/api/driver-verify")
def verify_driver(req: DriverVerifyRequest) -> dict[str, object]:
    """Verifies whether a driver/student exists by facial biometric matching using deep FaceNet embeddings.
    Always requires a live camera face photo — identity bypass without biometric match is prohibited."""
    if not req.photo_base64:
        raise HTTPException(
            status_code=400,
            detail="A live face camera scan is strictly required for biometric identity verification.",
        )

    query_vec = extract_face_embedding_from_b64(req.photo_base64)
    if query_vec is None:
        return {
            "status": "NOT_FOUND",
            "exists": False,
            "message": "No human face recognized in camera frame. Please center your face upright in front of the optical sensor.",
        }

    if not driver_embeddings_cache:
        preload_all_driver_embeddings()

    query = (req.driver_id or req.display_name or "").strip().upper()

    if query:
        # 1:1 Verification against claimed ID/name
        cand_item = driver_embeddings_cache.get(query)
        if not cand_item:
            # Search by name match
            for cid, item in driver_embeddings_cache.items():
                if query.lower() in item[2].get("display_name", "").lower():
                    cand_item = item
                    break

        if cand_item:
            _, cand_vec, cand_meta = cand_item
            sim = float(np.dot(query_vec, cand_vec))
            if sim >= CONFIDENCE_VERIFIED_THRESHOLD:
                return {
                    "status": "VERIFIED",
                    "exists": True,
                    "driver": cand_meta,
                    "similarity": round(sim, 4),
                    "source": "biometric_facenet_dnn",
                    "message": f"Biometric identity verified: {cand_meta['display_name']} ({cand_meta['driver_id']}) with similarity {sim:.3f}.",
                }
            return {
                "status": "REJECTED",
                "exists": False,
                "similarity": round(sim, 4),
                "message": f"Biometric mismatch: live face does not match enrolled profile '{query}' (similarity: {sim:.3f} < {CONFIDENCE_VERIFIED_THRESHOLD}).",
            }
        return {
            "status": "NOT_FOUND",
            "exists": False,
            "message": f"No profile matching '{query}' found in registry.",
        }

    # 1:N Identification
    best_score = -1.0
    best_match = None
    for cand_id, item in list(driver_embeddings_cache.items()):
        _, cand_vec, cand_meta = item
        sim = float(np.dot(query_vec, cand_vec))
        if sim > best_score:
            best_score = sim
            best_match = cand_meta

    if best_match and best_score >= CONFIDENCE_VERIFIED_THRESHOLD:
        return {
            "status": "VERIFIED",
            "exists": True,
            "driver": best_match,
            "similarity": round(best_score, 4),
            "source": "biometric_facenet_dnn",
            "message": f"Biometric identity verified: {best_match['display_name']} ({best_match['driver_id']}) with similarity {best_score:.3f}.",
        }

    return {
        "status": "NOT_FOUND",
        "exists": False,
        "similarity": round(best_score, 4) if best_score > -1 else 0.0,
        "message": "Unrecognized face. Operator not found in biometric registry.",
    }

@app.post("/api/driver-login")
def driver_login(req: DriverLoginRequest) -> dict[str, object]:
    photo = req.face_photo_base64 or req.photo_base64
    if not photo:
        raise HTTPException(status_code=400, detail="Camera face scan is required. Demonstration bypass without face scan is prohibited.")

    verify_req = DriverVerifyRequest(
        driver_id=req.driver_id,
        display_name=req.display_name,
        photo_base64=photo,
    )
    res = verify_driver(verify_req)
    if not res.get("exists") or res.get("status") != "VERIFIED":
        raise HTTPException(status_code=401, detail=res.get("message", "Biometric verification failed."))

    driver = res.get("driver")
    driver_dict: dict[str, Any] = driver if isinstance(driver, dict) else {}
    return {
        "status": "SUCCESS",
        "driver_id": driver_dict.get("driver_id", "DRV-UNKNOWN"),
        "display_name": driver_dict.get("display_name", "Authorized Operator"),
        "license_class": driver_dict.get("license_class", "Commercial Class A"),
        "similarity": res.get("similarity", 1.0),
        "message": res.get("message", "Biometric login successful."),
    }

@app.post("/api/driver-register")
def register_driver(req: DriverRegisterRequest) -> dict[str, object]:
    clean_name = req.display_name.strip()
    driver_id = req.driver_id.upper().strip() if req.driver_id and req.driver_id.strip() else f"DRV-{random.randint(1000, 9999)}"
    license_class = req.license_class.strip() if req.license_class and req.license_class.strip() else "Commercial Class A"
    photo = req.photo_base64 or ""

    if not photo:
        raise HTTPException(status_code=400, detail="A camera photo is required to register biometric template.")

    face_vec = extract_face_embedding_from_b64(photo)
    if face_vec is None:
        raise HTTPException(
            status_code=422,
            detail="No clear human face recognized in the captured photo. Please look straight at the camera and ensure good lighting before capturing.",
        )

    f = fernet()
    embedding_bytes = face_vec.tobytes()
    encrypted = f.encrypt(embedding_bytes).decode()

    # Pre-cache in memory (WITHOUT storing raw photo)
    driver_profile = {
        "driver_id": driver_id,
        "display_name": clean_name,
        "license_class": license_class,
        "photo_base64": "",  # Discard raw photo!
        "status": "Active / Verified",
        "created_at": now(),
    }
    driver_embeddings_cache[driver_id] = (0, face_vec, driver_profile)

    with connection() as conn:
        conn.execute(
            """INSERT INTO encrypted_driver_profiles (driver_id, display_name, encrypted_embedding, created_at, photo_base64, license_class)
            VALUES (?, ?, ?, ?, '', ?)
            ON CONFLICT(driver_id) DO UPDATE SET
                display_name=excluded.display_name,
                encrypted_embedding=excluded.encrypted_embedding,
                created_at=excluded.created_at,
                photo_base64='',
                license_class=excluded.license_class""",
            (driver_id, clean_name, encrypted, now(), license_class),
        )
        conn.execute(
            """INSERT INTO students (name, student_code, department, encrypted_embeddings, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(student_code) DO UPDATE SET
                name=excluded.name,
                department=excluded.department,
                encrypted_embeddings=excluded.encrypted_embeddings,
                created_at=excluded.created_at""",
            (clean_name, driver_id, license_class, encrypted, now()),
        )

    # Async MongoDB sync (without raw photo)
    def _async_mongo_sync():
        try:
            upsert_mongo_driver(
                driver_id=driver_id,
                display_name=clean_name,
                photo_base64="",
                encrypted_embedding=encrypted,
                license_class=license_class,
            )
        except Exception as e:
            print(f"[Async Mongo Sync Notice] {e}")

    threading.Thread(target=_async_mongo_sync, daemon=True).start()

    return {
        "status": "REGISTERED",
        "driver_id": driver_id,
        "display_name": clean_name,
        "license_class": license_class,
        "database": "sqlite_instant",
        "message": f"Biometric identity for {clean_name} ({driver_id}) enrolled with Fernet encrypted embedding. Raw photo discarded.",
    }

@app.post("/api/audit-log")
def create_audit_log(req: AuditLogRequest) -> dict[str, object]:
    meta_str = json.dumps(req.metadata or {})
    with connection() as conn:
        conn.execute(
            "INSERT INTO audit_history (event_type, driver_id, driver_name, reason, severity, duration_seconds, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (req.event_type.upper().strip(), req.driver_id.upper().strip(), req.driver_name.strip(), req.reason.strip(), req.severity.upper().strip(), float(req.duration_seconds), meta_str, now()),
        )
    mongo_saved = False
    try:
        mongo_saved = log_audit_event(
            event_type=req.event_type,
            driver_id=req.driver_id,
            driver_name=req.driver_name,
            reason=req.reason,
            severity=req.severity,
            duration_seconds=req.duration_seconds,
            metadata=req.metadata,
        )
    except Exception:
        pass

    return {
        "status": "AUDIT_RECORDED",
        "event_type": req.event_type.upper(),
        "driver_id": req.driver_id.upper(),
        "mongodb_logged": mongo_saved,
    }

@app.get("/api/audit-history")
def get_audit_history_endpoint(
    limit: int = 100,
    event_type: Optional[str] = None,
    driver_id: Optional[str] = None,
) -> dict[str, object]:
    client = get_client()
    if client is not None:
        try:
            mongo_logs = get_mongo_audit_history(limit=limit, event_type=event_type, driver_id=driver_id)
            return {
                "history": mongo_logs,
                "total": len(mongo_logs),
                "source": "mongodb",
            }
        except Exception as e:
            return {
                "history": [],
                "total": 0,
                "source": f"mongo_error: {type(e).__name__} - {e}",
            }

    with connection() as conn:
        query = "SELECT id, event_type, driver_id, driver_name, reason, severity, duration_seconds, metadata_json, created_at FROM audit_history"
        params: list[object] = []
        conditions: list[str] = []
        if event_type and event_type.strip() and event_type.upper() != "ALL":
            conditions.append("event_type = ?")
            params.append(event_type.upper().strip())
        if driver_id and driver_id.strip():
            conditions.append("(driver_id LIKE ? OR driver_name LIKE ?)")
            params.extend([f"%{driver_id.strip()}%", f"%{driver_id.strip()}%"])
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY id DESC LIMIT ?"
        params.append(limit)

        rows = conn.execute(query, tuple(params)).fetchall()
        results = [
            {
                "id": str(r["id"]),
                "event_type": r["event_type"],
                "driver_id": r["driver_id"],
                "driver_name": r["driver_name"],
                "reason": r["reason"],
                "severity": r["severity"],
                "duration_seconds": r["duration_seconds"],
                "metadata": json.loads(r["metadata_json"] or "{}") if r["metadata_json"] else {},
                "timestamp": r["created_at"],
            }
            for r in rows
        ]

    return {
        "history": results,
        "total": len(results),
        "source": "sqlite_fallback",
    }

@app.get("/api/security-audit")
def security_audit() -> dict[str, object]:
    with connection() as conn:
        profiles = conn.execute(
            """SELECT driver_id, display_name, encrypted_embedding, created_at
               FROM encrypted_driver_profiles
               ORDER BY (CASE WHEN encrypted_embedding LIKE 'gAAAAA%' THEN 0 ELSE 1 END), created_at DESC LIMIT 50"""
        ).fetchall()
        breaches = conn.execute("SELECT created_at, breach_code, delivery_state FROM system_breach_indicators ORDER BY id DESC LIMIT 50").fetchall()
    return {"profiles": [{"driver_id": row["driver_id"], "display_name": row["display_name"], "ciphertext": row["encrypted_embedding"][:512], "created_at": row["created_at"]} for row in profiles], "incidents": [{"timestamp": row["created_at"], "vector": row["breach_code"], "confidence": row["delivery_state"]} for row in breaches]}

def send_emergency_email(driver_id: str, driver_name: str, failure_code: str) -> None:
    host = os.getenv("SMTP_HOST")
    user = os.getenv("SMTP_USERNAME")
    password = os.getenv("SMTP_PASSWORD")
    contact = os.getenv("EMERGENCY_CONTACT_EMAIL")
    state = "SMTP_NOT_CONFIGURED"
    if host and user and password and contact:
        message = MIMEText(f"[EMERGENCY DISPATCH: OPERATOR UNRESPONSIVE]\n\nDriver: {driver_name} ({driver_id})\nFailure code: {failure_code}\nTime: {now()}\n\nAutomated notification.")
        message["Subject"] = "Critical Attentiveness Dispatch"
        message["From"] = user
        message["To"] = contact
        try:
            with smtplib.SMTP_SSL(host, int(os.getenv("SMTP_PORT", "465")), timeout=15) as server:
                server.login(user, password)
                server.sendmail(user, [contact], message.as_string())
            state = "EMAIL_SENT"
        except (smtplib.SMTPException, OSError):
            state = "EMAIL_FAILED"
    with connection() as conn:
        conn.execute("INSERT INTO system_breach_indicators (driver_id, breach_code, delivery_state, created_at) VALUES (?, ?, ?, ?)", (driver_id, failure_code, state, now()))

@app.post("/api/emergency-dispatch", status_code=202)
def emergency_dispatch(request: EmergencyDispatchRequest) -> dict[str, str]:
    with connection() as conn:
        profile = conn.execute("SELECT display_name FROM encrypted_driver_profiles WHERE driver_id=?", (request.driver_id.upper(),)).fetchone()
    name = profile["display_name"] if profile else "Unidentified driver"
    thread = threading.Thread(target=send_emergency_email, args=(request.driver_id.upper(), name, request.structural_failure_code), daemon=True)
    thread.start()
    with connection() as conn:
        conn.execute("INSERT INTO fatigue_timestamps (driver_id, event_type, ear, created_at) VALUES (?, ?, ?, ?)", (request.driver_id.upper(), "PASSIVE_ALARM_TIMEOUT", 0.0, now()))
    return {"status": "DISPATCH_QUEUED", "delivery": "background SMTP job started"}

@app.post("/api/report-incident")
def report_incident(request: ReportIncidentRequest) -> dict[str, str]:
    with connection() as conn:
        conn.execute(
            "INSERT INTO fatigue_timestamps (driver_id, event_type, ear, created_at) VALUES (?, ?, ?, ?)",
            (request.driver_id.upper(), request.reason, 0.0, now()),
        )
        conn.execute(
            "INSERT INTO system_breach_indicators (driver_id, breach_code, delivery_state, created_at) VALUES (?, ?, ?, ?)",
            (request.driver_id.upper(), request.reason, f"DURATION_{request.duration_seconds}s", now()),
        )
    try:
        log_mongo_incident(request.driver_id.upper(), request.reason, request.duration_seconds)
    except Exception:
        pass
    return {"status": "INCIDENT_LOGGED", "driver_id": request.driver_id.upper(), "reason": request.reason}

@app.post("/api/driver-profile")
async def create_profile(driver_id: str = Form(..., min_length=2, max_length=40), display_name: str = Form(..., min_length=1, max_length=100), image: UploadFile = File(...)):
    vector = embedding(await decode(image))
    encrypted = fernet().encrypt(vector.tobytes()).decode()
    with connection() as conn:
        conn.execute(
            """INSERT INTO encrypted_driver_profiles (driver_id, display_name, encrypted_embedding, created_at, photo_base64)
            VALUES (?, ?, ?, ?, '')
            ON CONFLICT(driver_id) DO UPDATE SET display_name=excluded.display_name, encrypted_embedding=excluded.encrypted_embedding, created_at=excluded.created_at, photo_base64=''""",
            (driver_id.upper(), display_name.strip(), encrypted, now()),
        )
    return {"status": "PROFILE_SECURED", "driver_id": driver_id.upper()}

@app.post("/api/cognitive-pipeline")
async def cognitive_pipeline(
    image: UploadFile = File(...),
    driver_id: str = Form(...),
    session_id: str = Form(...),
    landmark_matrix: str = Form(...),
    yaw: float = Form(...),
    pitch: float = Form(...),
    ear: float = Form(...),
    red_series: str = Form("[]"),
    green_series: str = Form("[]"),
):
    frame = await decode(image)
    texture = float(cv2.Laplacian(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())
    try:
        landmarks = np.asarray(json.loads(landmark_matrix), dtype=np.float64)
    except (json.JSONDecodeError, ValueError):
        raise HTTPException(422, "Invalid landmark matrix")

    if landmarks.ndim != 2 or landmarks.shape[0] == 0 or landmarks.shape[1] < 3:
        return {"status": "PIPELINE_FROZEN", "reason": "SUBJECT_BOUNDING_MATRIX_DISCONNECTED"}

    z_variance = float(np.var(landmarks[:, 2]))
    history = depth_history.setdefault(session_id, [])
    history.append(z_variance)
    depth_history[session_id] = history[-10:]
    temporal_depth = float(np.var(depth_history[session_id]))

    if texture < 75 or (len(history) >= 4 and z_variance < 0.000002 and temporal_depth < 0.0000005):
        return {"status": "SPOOF", "reason": "PLANAR_SURFACE_INJECTION", "texture_variance": round(texture, 2), "depth_variance": z_variance}

    try:
        red, green = np.asarray(json.loads(red_series), float), np.asarray(json.loads(green_series), float)
    except (json.JSONDecodeError, ValueError):
        red, green = np.array([]), np.array([])

    heart_rate, snr = None, None
    if len(red) >= 90 and len(red) == len(green):
        raw = green / (green.mean() + 1e-9) - 0.5 * red / (red.mean() + 1e-9)
        sos = butter(3, [0.7, 3.5], btype="bandpass", fs=30, output="sos")
        filtered = sosfiltfilt(sos, raw - raw.mean())
        power = np.abs(np.fft.rfft(filtered * np.hanning(len(filtered)))) ** 2
        freq = np.fft.rfftfreq(len(filtered), 1 / 30)
        mask = (freq >= 0.7) & (freq <= 3.5)
        peak = int(np.argmax(power[mask]))
        heart_rate = float(freq[mask][peak] * 60)
        snr = float(10 * np.log10(power[mask][peak] / (np.median(power[mask]) + 1e-9)))

    with connection() as conn:
        profile = conn.execute("SELECT * FROM encrypted_driver_profiles WHERE driver_id=?", (driver_id.upper(),)).fetchone()
    if profile is None:
        return {"status": "UNKNOWN_DRIVER"}

    score = cosine(embedding(frame), np.frombuffer(fernet().decrypt(profile["encrypted_embedding"].encode()), np.float32))
    if score < CONFIDENCE_VERIFIED_THRESHOLD:
        return {"status": "IDENTITY_MISMATCH", "similarity": round(score, 4)}

    event = "MICROSLEEP" if ear < 0.20 else "GAZE_DRIFT" if max(abs(yaw), abs(pitch)) > 35 else "FOCUS_NOMINAL"
    with connection() as conn:
        conn.execute("INSERT INTO focus_events (driver_id,event_type,yaw,pitch,ear,created_at) VALUES (?,?,?,?,?,?)", (driver_id.upper(), event, yaw, pitch, ear, now()))
        conn.execute("INSERT INTO pulse_variances (driver_id,heart_rate,spectral_snr,signal_variance,created_at) VALUES (?,?,?,?,?)", (driver_id.upper(), heart_rate, snr, float(np.var(green)) if len(green) else 0.0, now()))
        conn.execute("INSERT INTO distraction_vectors (driver_id, yaw, pitch, created_at) VALUES (?, ?, ?, ?)", (driver_id.upper(), yaw, pitch, now()))
        conn.execute("INSERT INTO focus_metrics (driver_id, ear, workload_index, created_at) VALUES (?, ?, ?, ?)", (driver_id.upper(), ear, min(100.0, max(0.0, 100.0 - max(abs(yaw), abs(pitch)) * 2)), now()))
        if ear < 0.22:
            conn.execute("INSERT INTO fatigue_timestamps (driver_id, event_type, ear, created_at) VALUES (?, ?, ?, ?)", (driver_id.upper(), "LOW_EAR", ear, now()))

    return {
        "status": "AUTHENTIC",
        "driver": profile["display_name"],
        "similarity": round(score, 4),
        "focus_event": event,
        "heart_rate": heart_rate,
        "spectral_snr": snr,
        "texture_variance": round(texture, 2),
        "depth_variance": z_variance,
    }
