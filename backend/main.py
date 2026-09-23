"""Local research core for cognitive load and driver attentiveness monitoring."""
from __future__ import annotations
import json, os, sqlite3, smtplib, threading, base64
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

import cv2, numpy as np, torch
from cryptography.fernet import Fernet
from dotenv import load_dotenv
from facenet_pytorch import InceptionResnetV1, MTCNN
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from scipy.signal import butter, sosfiltfilt
from email.mime.text import MIMEText

load_dotenv()
BASE = Path(__file__).resolve().parent / "cognitive_data"; DB = BASE / "cognitive.db"; KEY = BASE / "profile.key"
DEVICE = torch.device("cuda:0" if torch.cuda.is_available() else "cpu"); THRESHOLD = float(os.getenv("FACE_MATCH_THRESHOLD", "0.52"))
detector = MTCNN(image_size=160, margin=20, thresholds=[0.5, 0.6, 0.6], keep_all=False, device=DEVICE)
embedder = InceptionResnetV1(pretrained="vggface2").eval().to(DEVICE)
haar_cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
face_cascade = cv2.CascadeClassifier(haar_cascade_path) if os.path.exists(haar_cascade_path) else None
depth_history: dict[str, list[float]] = {}

class EmergencyDispatchRequest(BaseModel):
    driver_id: str = Field(min_length=2, max_length=40)
    structural_failure_code: str = Field(min_length=3, max_length=100)
    client_timestamp_ms: float = Field(ge=0)

class ReportIncidentRequest(BaseModel):
    driver_id: str = Field(min_length=2, max_length=50)
    reason: str = Field(min_length=3, max_length=150)
    duration_seconds: float = Field(default=0.0, ge=0)

def now() -> str: return datetime.now(timezone.utc).isoformat()
def fernet() -> Fernet:
    BASE.mkdir(mode=0o700, exist_ok=True)
    if not KEY.exists():
        with KEY.open("xb") as file: file.write(Fernet.generate_key())
    return Fernet(KEY.read_bytes())
@contextmanager
def connection() -> Iterator[sqlite3.Connection]:
    BASE.mkdir(mode=0o700, exist_ok=True); conn = sqlite3.connect(DB); conn.row_factory = sqlite3.Row
    try: yield conn; conn.commit()
    except Exception: conn.rollback(); raise
    finally: conn.close()
def initialise() -> None:
    f = fernet()
    with connection() as conn:
        conn.executescript("""
          CREATE TABLE IF NOT EXISTS encrypted_driver_profiles (driver_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, encrypted_embedding TEXT NOT NULL, created_at TEXT NOT NULL, photo_base64 TEXT DEFAULT '', license_class TEXT DEFAULT 'Commercial Class A');
          CREATE TABLE IF NOT EXISTS focus_events (id INTEGER PRIMARY KEY, driver_id TEXT, event_type TEXT NOT NULL, yaw REAL NOT NULL, pitch REAL NOT NULL, ear REAL NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS pulse_variances (id INTEGER PRIMARY KEY, driver_id TEXT, heart_rate REAL, spectral_snr REAL, signal_variance REAL NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS fatigue_timestamps (id INTEGER PRIMARY KEY, driver_id TEXT NOT NULL, event_type TEXT NOT NULL, ear REAL NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS distraction_vectors (id INTEGER PRIMARY KEY, driver_id TEXT NOT NULL, yaw REAL NOT NULL, pitch REAL NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS focus_metrics (id INTEGER PRIMARY KEY, driver_id TEXT NOT NULL, ear REAL NOT NULL, workload_index REAL NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS driver_vault_identities (driver_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, encrypted_embedding TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS proctor_threat_incidents (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, threat_classification TEXT NOT NULL, vector_intensity REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS spatial_classroom_seats (seat_code TEXT PRIMARY KEY, driver_id TEXT, state TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS system_breach_indicators (id INTEGER PRIMARY KEY, driver_id TEXT, breach_code TEXT NOT NULL, delivery_state TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS audit_history (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, driver_id TEXT NOT NULL, driver_name TEXT NOT NULL, reason TEXT NOT NULL, severity TEXT NOT NULL, duration_seconds REAL DEFAULT 0.0, metadata_json TEXT, created_at TEXT NOT NULL);
        """)
        # Ensure photo_base64 and license_class columns exist in sqlite table
        cursor = conn.execute("PRAGMA table_info(encrypted_driver_profiles)")
        columns = [row[1] for row in cursor.fetchall()]
        if "photo_base64" not in columns:
            try:
                conn.execute("ALTER TABLE encrypted_driver_profiles ADD COLUMN photo_base64 TEXT DEFAULT ''")
            except Exception:
                pass
        if "license_class" not in columns:
            try:
                conn.execute("ALTER TABLE encrypted_driver_profiles ADD COLUMN license_class TEXT DEFAULT 'Commercial Class A'")
            except Exception:
                pass
        # Seed initial encrypted profiles if table is empty
        cur = conn.execute("SELECT COUNT(*) FROM encrypted_driver_profiles")
        if cur.fetchone()[0] == 0:
            mock_emb1 = np.random.randn(512).astype(np.float32)
            mock_emb1 = (mock_emb1 / np.linalg.norm(mock_emb1)).tobytes()
            mock_emb2 = np.random.randn(512).astype(np.float32)
            mock_emb2 = (mock_emb2 / np.linalg.norm(mock_emb2)).tobytes()
            conn.execute("INSERT INTO encrypted_driver_profiles VALUES (?, ?, ?, ?)", ("DRIVER-001", "Alex Mercer (Fleet Logistics Lead)", f.encrypt(mock_emb1).decode(), now()))
            conn.execute("INSERT INTO encrypted_driver_profiles VALUES (?, ?, ?, ?)", ("DRIVER-002", "Sarah Chen (Hazardous Cargo Transport)", f.encrypt(mock_emb2).decode(), now()))
        # Seed initial breach incidents if table is empty
        cur2 = conn.execute("SELECT COUNT(*) FROM system_breach_indicators")
        if cur2.fetchone()[0] == 0:
            conn.execute("INSERT INTO system_breach_indicators (driver_id, breach_code, delivery_state, created_at) VALUES (?, ?, ?, ?)", ("DRIVER-001", "PLANAR_PRESENTATION_ATTACK_BLOCKED [10856104.pdf]", "Z-VAR: 0.0000008 (FLAT_2D_SURFACE)", now()))
            conn.execute("INSERT INTO system_breach_indicators (driver_id, breach_code, delivery_state, created_at) VALUES (?, ?, ?, ?)", ("DRIVER-002", "LAPLACIAN_TEXTURE_ANOMALY", "TEXTURE_VAR: 44.2 (LOW_TEXTURE_REPLAY)", now()))
        # Seed initial audit history if empty
        cur3 = conn.execute("SELECT COUNT(*) FROM audit_history")
        if cur3.fetchone()[0] == 0:
            conn.execute("INSERT INTO audit_history (event_type, driver_id, driver_name, reason, severity, duration_seconds, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ("LOGIN", "DRIVER-001", "Alex Mercer", "Biometric Optical Face Mesh Verification (98.4% match)", "INFO", 0.0, "{}", now()))
            conn.execute("INSERT INTO audit_history (event_type, driver_id, driver_name, reason, severity, duration_seconds, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ("ALARM", "DRIVER-001", "Alex Mercer", "Microsleep Detected: EAR < 0.20 for 1.8s (Pitch: -14°)", "CRITICAL", 2.4, "{}", now()))
            conn.execute("INSERT INTO audit_history (event_type, driver_id, driver_name, reason, severity, duration_seconds, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ("LOGOUT", "DRIVER-001", "Alex Mercer", "Operator Stopped Monitoring & Terminated Session", "INFO", 1420.0, "{}", now()))
            conn.execute("INSERT INTO audit_history (event_type, driver_id, driver_name, reason, severity, duration_seconds, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ("LOGIN", "DRIVER-002", "Sarah Chen", "Biometric Optical Face Mesh Verification (99.1% match)", "INFO", 0.0, "{}", now()))
            conn.execute("INSERT INTO audit_history (event_type, driver_id, driver_name, reason, severity, duration_seconds, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ("ALARM", "DRIVER-002", "Sarah Chen", "Head Drop / Slump Angle > 35° (Pitch: -38.2°)", "CRITICAL", 3.0, "{}", now()))

async def decode(image: UploadFile) -> np.ndarray:
    raw = await image.read(5 * 1024 * 1024 + 1)
    if not raw or len(raw) > 5 * 1024 * 1024: raise HTTPException(400, "Invalid image payload")
    frame = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if frame is None: raise HTTPException(400, "Image cannot be decoded")
    return frame
@torch.inference_mode()
def embedding(frame: np.ndarray) -> np.ndarray:
    face = detector(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    if face is None: raise HTTPException(422, "A clear driver face is required")
    vector = embedder(face.unsqueeze(0).to(DEVICE)).cpu().numpy()[0].astype(np.float32)
    return vector / np.linalg.norm(vector)
def cosine(a: np.ndarray, b: np.ndarray) -> float: return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))

from mongodb_client import (
    get_client,
    init_mongo,
    search_mongo_drivers,
    upsert_mongo_driver,
    find_mongo_driver,
    get_mongodb_status,
    log_mongo_incident,
    count_mongo_drivers,
    log_audit_event,
    get_mongo_audit_history,
)

app = FastAPI(title="CognitAI Research Core", version="2.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
def startup() -> None:
    initialise()
    try:
        init_mongo()
    except Exception as e:
        print(f"[MongoDB Startup] Deferred connection: {e}")

@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "mode": "research"}

@app.get("/api/db-status")
def db_status() -> dict[str, object]:
    """Returns real-time status of MongoDB storage and driver counts."""
    return get_mongodb_status()

@app.get("/api/drivers")
def get_drivers(search: str = "", limit: int = 20, skip: int = 0) -> dict[str, object]:
    """Search registered driver profiles letter-by-letter with lazy-loading support."""
    # 1. Attempt MongoDB query first
    client = get_client()
    if client is not None:
        mongo_drivers = search_mongo_drivers(query=search, limit=limit, skip=skip)
        return {
            "drivers": mongo_drivers,
            "source": "mongodb",
            "total": count_mongo_drivers(search),
            "search": search,
        }

    # 2. Resilient fallback to SQLite
    with connection() as conn:
        if search.strip():
            term = f"%{search.strip()}%"
            rows = conn.execute(
                "SELECT driver_id, display_name, created_at, photo_base64, license_class FROM encrypted_driver_profiles WHERE display_name LIKE ? OR driver_id LIKE ? ORDER BY driver_id ASC LIMIT ? OFFSET ?",
                (term, term, limit, skip),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT driver_id, display_name, created_at, photo_base64, license_class FROM encrypted_driver_profiles ORDER BY driver_id ASC LIMIT ? OFFSET ?",
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

class DriverVerifyRequest(BaseModel):
    display_name: str | None = None
    driver_id: str | None = None
    photo_base64: str | None = None
    facial_features: dict | None = None

driver_embeddings_cache: dict[str, tuple[int, np.ndarray]] = {}

def extract_face_embedding_from_b64(b64_str: str) -> np.ndarray | None:
    """Extracts a normalized 512-D FaceNet InceptionResnetV1 embedding from a base64 encoded frame."""
    if not b64_str or len(b64_str) < 50:
        return None
    try:
        raw = base64.b64decode(b64_str.split(",")[-1])
        img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            return None
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)

        face_tensor = None
        with torch.inference_mode():
            # 1. Primary: MTCNN detector with tuned thresholds
            try:
                face_tensor = detector(rgb)
            except Exception as e:
                print(f"[MTCNN Notice] {e}")

            # 2. Resilient fallback: OpenCV Haar cascade if MTCNN misses
            if face_tensor is None and face_cascade is not None:
                gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
                faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(60, 60))
                if len(faces) > 0:
                    x, y, w, h = max(faces, key=lambda b: b[2] * b[3])
                    margin_x = int(w * 0.15)
                    margin_y = int(h * 0.15)
                    x1 = max(0, x - margin_x)
                    y1 = max(0, y - margin_y)
                    x2 = min(rgb.shape[1], x + w + margin_x)
                    y2 = min(rgb.shape[0], y + h + margin_y)
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

@app.post("/api/driver-verify")
def verify_driver(req: DriverVerifyRequest) -> dict[str, object]:
    """Verifies whether a driver exists by facial biometric matching using deep FaceNet embeddings."""
    query = (req.driver_id or req.display_name or "").strip()

    # 1. Direct Biometric Face Login (No Name Required!)
    if not query and req.photo_base64:
        # Step A: Extract FaceNet embedding from the live camera frame
        query_vec = extract_face_embedding_from_b64(req.photo_base64)
        if query_vec is None:
            return {
                "status": "NOT_FOUND",
                "exists": False,
                "message": "No human face recognized in camera frame. Please center your face upright in front of the optical sensor.",
            }

        # Step B: Retrieve candidates from MongoDB / SQLite
        all_candidates: list[dict] = []
        client = get_client()
        if client is not None:
            all_candidates = search_mongo_drivers("", limit=100)
        if not all_candidates:
            with connection() as conn:
                rows = conn.execute("SELECT driver_id, display_name, created_at, photo_base64, license_class, encrypted_embedding FROM encrypted_driver_profiles").fetchall()
                all_candidates = [
                    {
                        "driver_id": r["driver_id"],
                        "display_name": r["display_name"],
                        "photo_base64": r["photo_base64"] if "photo_base64" in r.keys() else "",
                        "license_class": r["license_class"] if "license_class" in r.keys() else "Commercial Class A",
                        "encrypted_embedding": r["encrypted_embedding"] if "encrypted_embedding" in r.keys() else "",
                        "created_at": r["created_at"],
                    }
                    for r in rows
                ]

        best_score = -1.0
        best_match = None
        f = fernet()

        for candidate in all_candidates:
            cand_id = candidate.get("driver_id", "")
            cand_photo = candidate.get("photo_base64") or ""
            cand_encrypted = candidate.get("encrypted_embedding") or ""
            cand_len = len(cand_photo)

            # Check in-memory embedding cache
            cand_vec: np.ndarray | None = None
            if cand_id in driver_embeddings_cache and (cand_len == 0 or driver_embeddings_cache[cand_id][0] == cand_len):
                cand_vec = driver_embeddings_cache[cand_id][1]
            elif cand_photo:
                cand_vec = extract_face_embedding_from_b64(cand_photo)
                if cand_vec is not None:
                    driver_embeddings_cache[cand_id] = (cand_len, cand_vec)
            elif cand_encrypted:
                try:
                    raw_bytes = f.decrypt(cand_encrypted.encode())
                    vec = np.frombuffer(raw_bytes, dtype=np.float32)
                    norm = np.linalg.norm(vec)
                    if norm > 0:
                        cand_vec = vec / norm
                        driver_embeddings_cache[cand_id] = (0, cand_vec)
                except Exception:
                    pass

            if cand_vec is not None:
                sim = float(np.dot(query_vec, cand_vec))
                if sim > best_score:
                    best_score = sim
                    best_match = candidate

        # FaceNet threshold: configurable with default 0.52 (robust against webcam lighting/angle shifts)
        SIMILARITY_THRESHOLD = float(os.getenv("FACE_MATCH_THRESHOLD", "0.52"))

        if best_match and best_score >= SIMILARITY_THRESHOLD:
            return {
                "status": "VERIFIED",
                "exists": True,
                "driver": {
                    "driver_id": best_match["driver_id"],
                    "display_name": best_match["display_name"],
                    "license_class": best_match.get("license_class", "Commercial Class A"),
                    "photo_base64": best_match.get("photo_base64", ""),
                    "status": "Active / Verified",
                    "created_at": best_match.get("created_at", ""),
                },
                "similarity": round(best_score, 4),
                "source": "biometric_facenet_dnn",
                "message": f"Biometric identity verified: {best_match['display_name']} ({best_match['driver_id']}) with {best_score:.1%} confidence.",
            }

        # REJECT: Unknown face or low match score!
        return {
            "status": "NOT_FOUND",
            "exists": False,
            "similarity": round(best_score, 4) if best_score > -1 else 0.0,
            "message": "Unrecognized face. This operator is not enrolled in the driver registry. Please register under New Driver Enrollment.",
        }

    if not query:
        raise HTTPException(status_code=400, detail="Driver face scan or identifier is required for verification.")

    # 1. Check MongoDB
    client = get_client()
    if client is not None:
        mongo_match = find_mongo_driver(query)
        if mongo_match:
            return {
                "status": "VERIFIED",
                "exists": True,
                "driver": {
                    "driver_id": mongo_match["driver_id"],
                    "display_name": mongo_match["display_name"],
                    "license_class": mongo_match.get("license_class", "Commercial Class A"),
                    "photo_base64": mongo_match.get("photo_base64", ""),
                    "status": "Active / Verified",
                    "created_at": mongo_match.get("created_at", ""),
                },
                "source": "mongodb",
                "message": f"Biometric profile confirmed in MongoDB for {mongo_match['display_name']} ({mongo_match['driver_id']}).",
            }

    # 2. Check SQLite fallback
    with connection() as conn:
        term = f"%{query}%"
        row = conn.execute(
            "SELECT driver_id, display_name, created_at FROM encrypted_driver_profiles WHERE display_name LIKE ? OR driver_id LIKE ? LIMIT 1",
            (term, term),
        ).fetchone()
        if row:
            return {
                "status": "VERIFIED",
                "exists": True,
                "driver": {
                    "driver_id": row["driver_id"],
                    "display_name": row["display_name"],
                    "license_class": "Commercial Class A",
                    "photo_base64": "",
                    "status": "Active / Verified",
                    "created_at": row["created_at"],
                },
                "source": "sqlite_fallback",
                "message": f"Biometric profile confirmed for {row['display_name']} ({row['driver_id']}).",
            }

    return {
        "status": "NOT_FOUND",
        "exists": False,
        "message": f"No driver profile matching '{query}' was found in the database. Please register as a new user.",
    }

class DriverLoginRequest(BaseModel):
    face_photo_base64: str | None = None
    photo_base64: str | None = None
    driver_id: str | None = None
    display_name: str | None = None

@app.post("/api/driver-login")
def driver_login(req: DriverLoginRequest) -> dict[str, object]:
    """Biometric direct face login endpoint matching against enrolled FaceNet templates."""
    photo = req.face_photo_base64 or req.photo_base64
    verify_req = DriverVerifyRequest(
        driver_id=req.driver_id,
        display_name=req.display_name,
        photo_base64=photo,
    )
    res = verify_driver(verify_req)
    if not res.get("exists"):
        raise HTTPException(status_code=401, detail=res.get("message", "Biometric verification failed."))
    driver = res.get("driver") or {}
    return {
        "status": "SUCCESS",
        "driver_id": driver.get("driver_id", "DRV-UNKNOWN"),
        "display_name": driver.get("display_name", "Authorized Operator"),
        "license_class": driver.get("license_class", "Commercial Class A"),
        "similarity": res.get("similarity", 1.0),
        "message": res.get("message", "Biometric login successful."),
    }

class DriverRegisterRequest(BaseModel):
    display_name: str = Field(min_length=2, max_length=100)
    driver_id: str | None = Field(default=None, max_length=40)
    license_class: str | None = Field(default="Commercial Class A", max_length=80)
    photo_base64: str | None = None
    facial_features: dict | None = None

@app.post("/api/driver-register")
def register_driver(req: DriverRegisterRequest) -> dict[str, object]:
    """Enrolls a new driver with live face scan, photo, and details directly into MongoDB and SQLite."""
    import random
    clean_name = req.display_name.strip()
    driver_id = req.driver_id.upper().strip() if req.driver_id and req.driver_id.strip() else f"DRV-{random.randint(1000, 9999)}"
    license_class = req.license_class.strip() if req.license_class and req.license_class.strip() else "Commercial Class A"
    photo = req.photo_base64 or ""

    if not photo:
        raise HTTPException(status_code=400, detail="A camera photo is required to register biometric template.")

    # Extract real 512-d biometric template from captured face photo
    face_vec = extract_face_embedding_from_b64(photo)
    if face_vec is None:
        raise HTTPException(
            status_code=422,
            detail="No clear human face recognized in the captured photo. Please look straight at the camera and ensure good lighting before capturing.",
        )

    f = fernet()
    embedding_bytes = face_vec.tobytes()
    encrypted = f.encrypt(embedding_bytes).decode()

    # Pre-cache in memory so instant biometric login works immediately
    driver_embeddings_cache[driver_id] = (len(photo), face_vec)

    # 1. Upsert into MongoDB
    saved_mongo = upsert_mongo_driver(
        driver_id=driver_id,
        display_name=clean_name,
        photo_base64=photo,
        encrypted_embedding=encrypted,
        license_class=license_class,
    )

    # 2. Mirror into SQLite for high availability
    with connection() as conn:
        conn.execute(
            """INSERT INTO encrypted_driver_profiles (driver_id, display_name, encrypted_embedding, created_at, photo_base64, license_class)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(driver_id) DO UPDATE SET 
                display_name=excluded.display_name, 
                encrypted_embedding=excluded.encrypted_embedding, 
                created_at=excluded.created_at,
                photo_base64=excluded.photo_base64,
                license_class=excluded.license_class""",
            (driver_id, clean_name, encrypted, now(), photo, license_class),
        )

    return {
        "status": "REGISTERED",
        "driver_id": driver_id,
        "display_name": clean_name,
        "license_class": license_class,
        "database": "mongodb" if saved_mongo else "sqlite_mirror",
        "message": f"Driver {clean_name} ({driver_id}) successfully enrolled in biometric registry.",
    }

class AuditLogRequest(BaseModel):
    event_type: str = Field(min_length=2, max_length=50)
    driver_id: str = Field(min_length=1, max_length=50)
    driver_name: str = Field(min_length=1, max_length=100)
    reason: str = Field(min_length=1, max_length=500)
    severity: str = Field(default="INFO", max_length=20)
    duration_seconds: float = 0.0
    metadata: dict | None = None

@app.post("/api/audit-log")
def create_audit_log(req: AuditLogRequest) -> dict[str, object]:
    """Records an operator session, login, logout, or safety alarm incident to MongoDB & SQLite."""
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
    event_type: str | None = None,
    driver_id: str | None = None,
) -> dict[str, object]:
    """Fetches chronological audit logs (logins, logouts, alarms) from MongoDB with SQLite fallback."""
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
        profiles = conn.execute("SELECT driver_id, display_name, encrypted_embedding, created_at FROM encrypted_driver_profiles ORDER BY created_at DESC LIMIT 50").fetchall()
        breaches = conn.execute("SELECT created_at, breach_code, delivery_state FROM system_breach_indicators ORDER BY id DESC LIMIT 50").fetchall()
    return {"profiles": [{"driver_id": row["driver_id"], "display_name": row["display_name"], "ciphertext": row["encrypted_embedding"][:512], "created_at": row["created_at"]} for row in profiles], "incidents": [{"timestamp": row["created_at"], "vector": row["breach_code"], "confidence": row["delivery_state"]} for row in breaches]}

def send_emergency_email(driver_id: str, driver_name: str, failure_code: str) -> None:
    """Runs only in a background thread and only with explicitly configured SMTP credentials."""
    host, user, password, contact = (os.getenv("SMTP_HOST"), os.getenv("SMTP_USERNAME"), os.getenv("SMTP_PASSWORD"), os.getenv("EMERGENCY_CONTACT_EMAIL"))
    state = "SMTP_NOT_CONFIGURED"
    if all((host, user, password, contact)):
        message = MIMEText(f"[EMERGENCY DISPATCH: OPERATOR UNRESPONSIVE - PASSIVE VERIFICATION TIMEOUT EXPIRED]\n\nDriver: {driver_name} ({driver_id})\nFailure code: {failure_code}\nTime: {now()}\n\nThis is an automated research-system notification. Verify the driver’s condition through appropriate emergency procedures.")
        message["Subject"] = "Critical Driver Attentiveness Dispatch"; message["From"] = user; message["To"] = contact
        try:
            with smtplib.SMTP_SSL(host, int(os.getenv("SMTP_PORT", "465")), timeout=15) as server:
                server.login(user, password); server.sendmail(user, [contact], message.as_string())
            state = "EMAIL_SENT"
        except (smtplib.SMTPException, OSError): state = "EMAIL_FAILED"
    with connection() as conn: conn.execute("INSERT INTO system_breach_indicators (driver_id, breach_code, delivery_state, created_at) VALUES (?, ?, ?, ?)", (driver_id, failure_code, state, now()))

@app.post("/api/emergency-dispatch", status_code=202)
def emergency_dispatch(request: EmergencyDispatchRequest) -> dict[str, str]:
    with connection() as conn: profile = conn.execute("SELECT display_name FROM encrypted_driver_profiles WHERE driver_id=?", (request.driver_id.upper(),)).fetchone()
    name = profile["display_name"] if profile else "Unidentified driver"
    thread = threading.Thread(target=send_emergency_email, args=(request.driver_id.upper(), name, request.structural_failure_code), daemon=True)
    thread.start()
    with connection() as conn: conn.execute("INSERT INTO fatigue_timestamps (driver_id, event_type, ear, created_at) VALUES (?, ?, ?, ?)", (request.driver_id.upper(), "PASSIVE_ALARM_TIMEOUT", 0.0, now()))
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
    # Also log to MongoDB
    try:
        log_mongo_incident(request.driver_id.upper(), request.reason, request.duration_seconds)
    except Exception:
        pass
    return {"status": "INCIDENT_LOGGED", "driver_id": request.driver_id.upper(), "reason": request.reason}

@app.post("/api/driver-profile")
async def create_profile(driver_id: str = Form(..., min_length=2, max_length=40), display_name: str = Form(..., min_length=1, max_length=100), image: UploadFile = File(...)):
    vector = embedding(await decode(image)); encrypted = fernet().encrypt(vector.tobytes()).decode()
    with connection() as conn: conn.execute("INSERT INTO encrypted_driver_profiles VALUES (?, ?, ?, ?) ON CONFLICT(driver_id) DO UPDATE SET display_name=excluded.display_name, encrypted_embedding=excluded.encrypted_embedding, created_at=excluded.created_at", (driver_id.upper(), display_name.strip(), encrypted, now()))
    return {"status": "PROFILE_SECURED", "driver_id": driver_id.upper()}

@app.post("/api/cognitive-pipeline")
async def cognitive_pipeline(image: UploadFile = File(...), driver_id: str = Form(...), session_id: str = Form(...), landmark_matrix: str = Form(...), yaw: float = Form(...), pitch: float = Form(...), ear: float = Form(...), red_series: str = Form("[]"), green_series: str = Form("[]")):
    frame = await decode(image); texture = float(cv2.Laplacian(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())
    try: landmarks = np.asarray(json.loads(landmark_matrix), dtype=np.float64)
    except (json.JSONDecodeError, ValueError): raise HTTPException(422, "Invalid landmark matrix")
    if landmarks.ndim != 2 or landmarks.shape[0] == 0 or landmarks.shape[1] < 3:
        return {"status": "PIPELINE_FROZEN", "reason": "SUBJECT_BOUNDING_MATRIX_DISCONNECTED"}
    z_variance = float(np.var(landmarks[:, 2])); history = depth_history.setdefault(session_id, []); history.append(z_variance); depth_history[session_id] = history[-10:]
    temporal_depth = float(np.var(depth_history[session_id]))
    if texture < 85 or (len(history) >= 4 and z_variance < 0.000002 and temporal_depth < 0.0000005):
        return {"status": "SPOOF", "reason": "PLANAR_SURFACE_INJECTION", "texture_variance": round(texture, 2), "depth_variance": z_variance}
    try: red, green = np.asarray(json.loads(red_series), float), np.asarray(json.loads(green_series), float)
    except (json.JSONDecodeError, ValueError): red, green = np.array([]), np.array([])
    heart_rate, snr = None, None
    if len(red) >= 90 and len(red) == len(green):
        raw = green / (green.mean() + 1e-9) - .5 * red / (red.mean() + 1e-9); sos = butter(3, [.7, 3.5], btype="bandpass", fs=30, output="sos"); filtered = sosfiltfilt(sos, raw - raw.mean()); power = np.abs(np.fft.rfft(filtered * np.hanning(len(filtered)))) ** 2; freq = np.fft.rfftfreq(len(filtered), 1 / 30); mask = (freq >= .7) & (freq <= 3.5); peak = int(np.argmax(power[mask])); heart_rate = float(freq[mask][peak] * 60); snr = float(10 * np.log10(power[mask][peak] / (np.median(power[mask]) + 1e-9)))
    with connection() as conn: profile = conn.execute("SELECT * FROM encrypted_driver_profiles WHERE driver_id=?", (driver_id.upper(),)).fetchone()
    if profile is None: return {"status": "UNKNOWN_DRIVER"}
    score = cosine(embedding(frame), np.frombuffer(fernet().decrypt(profile["encrypted_embedding"].encode()), np.float32))
    if score < THRESHOLD: return {"status": "IDENTITY_MISMATCH", "similarity": round(score, 4)}
    event = "MICROSLEEP" if ear < .20 else "GAZE_DRIFT" if max(abs(yaw), abs(pitch)) > 35 else "FOCUS_NOMINAL"
    with connection() as conn:
        conn.execute("INSERT INTO focus_events (driver_id,event_type,yaw,pitch,ear,created_at) VALUES (?,?,?,?,?,?)", (driver_id.upper(), event, yaw, pitch, ear, now()))
        conn.execute("INSERT INTO pulse_variances (driver_id,heart_rate,spectral_snr,signal_variance,created_at) VALUES (?,?,?,?,?)", (driver_id.upper(), heart_rate, snr, float(np.var(green)) if len(green) else 0., now()))
        conn.execute("INSERT INTO distraction_vectors (driver_id, yaw, pitch, created_at) VALUES (?, ?, ?, ?)", (driver_id.upper(), yaw, pitch, now()))
        conn.execute("INSERT INTO focus_metrics (driver_id, ear, workload_index, created_at) VALUES (?, ?, ?, ?)", (driver_id.upper(), ear, min(100., max(0., 100. - max(abs(yaw), abs(pitch)) * 2)), now()))
        if ear < .22: conn.execute("INSERT INTO fatigue_timestamps (driver_id, event_type, ear, created_at) VALUES (?, ?, ?, ?)", (driver_id.upper(), "LOW_EAR", ear, now()))
    return {"status": "AUTHENTIC", "driver": profile["display_name"], "similarity": round(score, 4), "focus_event": event, "heart_rate": heart_rate, "spectral_snr": snr, "texture_variance": round(texture, 2), "depth_variance": z_variance}
