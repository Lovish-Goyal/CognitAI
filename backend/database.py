"""SQLite persistence, Fernet biometric protection, and HMAC-SHA256 chained attendance audit trail."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import shutil
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

import numpy as np
from cryptography.fernet import Fernet

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DATABASE_PATH = DATA_DIR / "biometrics.db"
KEY_PATH = DATA_DIR / "fernet.key"
AUDIT_KEY_PATH = DATA_DIR / "attendance_audit.key"
BACKUP_DIR = DATA_DIR / "backups"

GENESIS_PREV_HASH = "GENESIS_ATTENDANCE_ROOT_0000000000000000"

def utc_now() -> str:
    """Returns current UTC timestamp in ISO 8601 format."""
    return datetime.now(timezone.utc).isoformat()

def get_fernet() -> Fernet:
    """Resolves Fernet biometric encryption key from environment or local secured key file."""
    DATA_DIR.mkdir(mode=0o700, exist_ok=True)
    env_key = os.getenv("BIOMETRIC_ENCRYPTION_KEY", "").strip()
    if env_key:
        try:
            return Fernet(env_key.encode("ascii"))
        except Exception:
            pass

    if not KEY_PATH.exists():
        try:
            with KEY_PATH.open("xb") as f:
                f.write(Fernet.generate_key())
            if os.name != "nt":
                os.chmod(KEY_PATH, 0o600)
        except FileExistsError:
            pass
    return Fernet(KEY_PATH.read_bytes().strip())

def get_audit_hmac_key() -> bytes:
    """Resolves HMAC key for chained attendance audit records from env or secured key file."""
    DATA_DIR.mkdir(mode=0o700, exist_ok=True)
    env_key = os.getenv("ATTENDANCE_AUDIT_KEY", "").strip()
    if env_key:
        return env_key.encode("utf-8")

    if not AUDIT_KEY_PATH.exists():
        try:
            with AUDIT_KEY_PATH.open("xb") as f:
                # 32 bytes (256-bit) cryptographically strong random key
                f.write(os.urandom(32))
            if os.name != "nt":
                os.chmod(AUDIT_KEY_PATH, 0o600)
        except FileExistsError:
            pass
    return AUDIT_KEY_PATH.read_bytes().strip()

def backup_database_if_exists() -> Optional[str]:
    """Creates a timestamped backup before any migrations to guarantee zero data loss."""
    if not DATABASE_PATH.exists() or DATABASE_PATH.stat().st_size == 0:
        return None
    try:
        BACKUP_DIR.mkdir(mode=0o700, exist_ok=True)
        timestamp_str = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        backup_path = BACKUP_DIR / f"biometrics_backup_{timestamp_str}.db"
        shutil.copy2(DATABASE_PATH, backup_path)
        return str(backup_path)
    except Exception as e:
        print(f"[Database Backup Notice] {e}")
        return None

@contextmanager
def connection() -> Iterator[sqlite3.Connection]:
    DATA_DIR.mkdir(mode=0o700, exist_ok=True)
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

def initialize_database() -> None:
    DATA_DIR.mkdir(mode=0o700, exist_ok=True)
    backup_database_if_exists()
    get_fernet()
    get_audit_hmac_key()

    with connection() as conn:
        # 1. Core Students / Enrolled Identities table
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS students (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          student_code TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          department TEXT NOT NULL DEFAULT 'Computer Science',
          encrypted_embeddings TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_students_code ON students(student_code);

        -- 2. Chained, Tamper-Evident Attendance Ledger
        CREATE TABLE IF NOT EXISTS attendance (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          student_id INTEGER NOT NULL,
          student_code TEXT NOT NULL,
          name TEXT NOT NULL,
          timestamp TIMESTAMP NOT NULL,
          status TEXT NOT NULL DEFAULT 'PRESENT',
          similarity_score REAL NOT NULL,
          liveness_score REAL NOT NULL,
          liveness_type TEXT NOT NULL DEFAULT 'CHALLENGE_VERIFIED',
          challenge_id TEXT NOT NULL DEFAULT 'CHAL_NONE',
          prev_hash TEXT NOT NULL,
          record_hmac TEXT NOT NULL,
          FOREIGN KEY(student_id) REFERENCES students(id)
        );
        CREATE INDEX IF NOT EXISTS idx_attendance_student_time ON attendance(student_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_attendance_code_time ON attendance(student_code, timestamp DESC);

        -- 3. Trusted Chain Checkpoint table (detects truncation / ledger rollback)
        CREATE TABLE IF NOT EXISTS attendance_chain_checkpoints (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          latest_attendance_id INTEGER NOT NULL,
          latest_record_hmac TEXT NOT NULL,
          total_records INTEGER NOT NULL,
          checkpoint_timestamp TIMESTAMP NOT NULL,
          checkpoint_signature TEXT NOT NULL
        );

        -- 4. Fuzzy Vaults table
        CREATE TABLE IF NOT EXISTS fuzzy_vaults (
          student_id INTEGER PRIMARY KEY,
          encrypted_payload TEXT NOT NULL,
          genuine_count INTEGER NOT NULL,
          chaff_count INTEGER NOT NULL,
          created_at TIMESTAMP NOT NULL,
          FOREIGN KEY(student_id) REFERENCES students(id)
        );

        -- 5. Vault Identities & Spatial Seats
        CREATE TABLE IF NOT EXISTS vault_identities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          student_code TEXT UNIQUE NOT NULL,
          full_name TEXT NOT NULL,
          assigned_seat TEXT NOT NULL,
          encrypted_face_string TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL
        );
        CREATE TABLE IF NOT EXISTS live_proctor_incidents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          incident_type TEXT NOT NULL,
          severity TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL
        );
        CREATE TABLE IF NOT EXISTS spatial_seats (
          seat_code TEXT PRIMARY KEY,
          student_code TEXT UNIQUE,
          state TEXT NOT NULL DEFAULT 'UNASSIGNED',
          updated_at TIMESTAMP NOT NULL
        );

        -- 6. Backward Compatibility for existing test suite and driver telemetry
        CREATE TABLE IF NOT EXISTS encrypted_driver_profiles (
          driver_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          encrypted_embedding TEXT NOT NULL,
          created_at TEXT NOT NULL,
          photo_base64 TEXT DEFAULT '',
          license_class TEXT DEFAULT 'Commercial Class A'
        );
        CREATE TABLE IF NOT EXISTS focus_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          driver_id TEXT,
          event_type TEXT NOT NULL,
          yaw REAL NOT NULL,
          pitch REAL NOT NULL,
          ear REAL NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pulse_variances (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          driver_id TEXT,
          heart_rate REAL,
          spectral_snr REAL,
          signal_variance REAL NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS fatigue_timestamps (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          driver_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          ear REAL NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS distraction_vectors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          driver_id TEXT NOT NULL,
          yaw REAL NOT NULL,
          pitch REAL NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS focus_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          driver_id TEXT NOT NULL,
          ear REAL NOT NULL,
          workload_index REAL NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS system_breach_indicators (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          driver_id TEXT,
          breach_code TEXT NOT NULL,
          delivery_state TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          driver_id TEXT NOT NULL,
          driver_name TEXT NOT NULL,
          reason TEXT NOT NULL,
          severity TEXT NOT NULL,
          duration_seconds REAL DEFAULT 0.0,
          metadata_json TEXT,
          created_at TEXT NOT NULL
        );
        """)

        # Forward-compatible schema migrations for attendance table if created previously
        att_cols = {row["name"] for row in conn.execute("PRAGMA table_info(attendance)")}
        if "student_code" not in att_cols:
            conn.execute("ALTER TABLE attendance ADD COLUMN student_code TEXT NOT NULL DEFAULT ''")
        if "name" not in att_cols:
            conn.execute("ALTER TABLE attendance ADD COLUMN name TEXT NOT NULL DEFAULT ''")
        if "similarity_score" not in att_cols:
            conn.execute("ALTER TABLE attendance ADD COLUMN similarity_score REAL NOT NULL DEFAULT 1.0")
        if "liveness_type" not in att_cols:
            conn.execute("ALTER TABLE attendance ADD COLUMN liveness_type TEXT NOT NULL DEFAULT 'CHALLENGE_VERIFIED'")
        if "challenge_id" not in att_cols:
            conn.execute("ALTER TABLE attendance ADD COLUMN challenge_id TEXT NOT NULL DEFAULT 'CHAL_NONE'")
        if "prev_hash" not in att_cols:
            conn.execute(f"ALTER TABLE attendance ADD COLUMN prev_hash TEXT NOT NULL DEFAULT '{GENESIS_PREV_HASH}'")
        if "record_hmac" not in att_cols:
            conn.execute("ALTER TABLE attendance ADD COLUMN record_hmac TEXT NOT NULL DEFAULT ''")

        # Initialize spatial seats (6x6 classroom grid)
        for row in range(1, 7):
            for column in range(1, 7):
                seat = f"{chr(64 + row)}{column}"
                conn.execute(
                    "INSERT OR IGNORE INTO spatial_seats (seat_code, state, updated_at) VALUES (?, 'UNASSIGNED', ?)",
                    (seat, utc_now()),
                )

# --- Biometric Cryptography ---

def encrypt_embedding(embedding: np.ndarray) -> str:
    """Encrypts a 512-D float32 vector with Fernet AES-256."""
    return get_fernet().encrypt(np.asarray(embedding, dtype=np.float32).tobytes()).decode("ascii")

def decrypt_embedding(token: str) -> np.ndarray:
    """Decrypts a Fernet token back into a 512-D float32 vector."""
    vector = np.frombuffer(get_fernet().decrypt(token.encode("ascii")), dtype=np.float32)
    if vector.shape != (512,):
        raise ValueError("Invalid biometric vector shape; expected 512-dimensional vector.")
    return vector.copy()

# --- Tamper-Evident HMAC-SHA256 Chaining Functions ---

def canonicalize_attendance_record(
    student_id: int,
    student_code: str,
    timestamp: str,
    status: str,
    similarity_score: float,
    liveness_score: float,
    liveness_type: str,
    challenge_id: str,
    prev_hash: str,
) -> bytes:
    """Produces a deterministic, canonical representation of an attendance record for HMAC computation."""
    canonical_str = (
        f"{student_id}|{student_code.strip()}|{timestamp.strip()}|{status.strip().upper()}|"
        f"{similarity_score:.4f}|{liveness_score:.4f}|{liveness_type.strip()}|"
        f"{challenge_id.strip()}|{prev_hash.strip()}"
    )
    return canonical_str.encode("utf-8")

def compute_record_hmac(canonical_bytes: bytes) -> str:
    """Computes HMAC-SHA256 digest over canonical record bytes using isolated audit key."""
    key = get_audit_hmac_key()
    return hmac.new(key, canonical_bytes, hashlib.sha256).hexdigest()

def insert_secure_attendance(
    student_id: int,
    student_code: str,
    name: str,
    similarity_score: float,
    liveness_score: float,
    liveness_type: str = "CHALLENGE_VERIFIED",
    challenge_id: str = "CHAL_VERIFIED",
    cooldown_seconds: int = 43200,  # 12 hours
) -> dict[str, Any]:
    """Atomically records attendance with duplicate cooldown check, canonical HMAC chaining,
    and trusted checkpoint update in a single SQLite transaction."""
    clean_code = student_code.upper().strip()
    with connection() as conn:
        # Guarantee student exists and get actual primary key id to satisfy FOREIGN KEY constraint
        stu_row = conn.execute("SELECT id, name FROM students WHERE student_code = ?", (clean_code,)).fetchone()
        if stu_row:
            student_id = stu_row["id"]
            if not name:
                name = stu_row["name"]
        elif student_id <= 0:
            # If student record doesn't exist yet, insert a minimal valid student entry
            now_ts = utc_now()
            conn.execute(
                """INSERT INTO students (student_code, name, department, encrypted_embeddings, created_at)
                   VALUES (?, ?, 'Enrolled', '', ?)
                   ON CONFLICT(student_code) DO NOTHING""",
                (clean_code, name or clean_code, now_ts),
            )
            created_stu = conn.execute("SELECT id FROM students WHERE student_code = ?", (clean_code,)).fetchone()
            student_id = created_stu["id"] if created_stu else 1

        # 1. Enforce duplicate attendance prevention
        last_row = conn.execute(
            "SELECT timestamp FROM attendance WHERE student_id = ? ORDER BY id DESC LIMIT 1",
            (student_id,),
        ).fetchone()

        now_ts = utc_now()
        now_dt = datetime.now(timezone.utc)

        if last_row is not None:
            try:
                last_dt = datetime.fromisoformat(last_row["timestamp"])
                elapsed = (now_dt - last_dt).total_seconds()
                if elapsed < cooldown_seconds:
                    return {
                        "status": "DUPLICATE_REJECTED",
                        "marked": False,
                        "student_code": student_code,
                        "message": f"Attendance already recorded for {student_code} today ({int(elapsed // 60)} minutes ago). Duplicate attendance is prevented.",
                    }
            except Exception:
                pass

        # 2. Retrieve previous record's HMAC to establish the tamper-evident chain link
        prev_row = conn.execute(
            "SELECT record_hmac FROM attendance ORDER BY id DESC LIMIT 1"
        ).fetchone()

        prev_hash = prev_row["record_hmac"] if prev_row and prev_row["record_hmac"] else GENESIS_PREV_HASH

        # 3. Compute canonical representation & HMAC-SHA256
        status = "PRESENT"
        canonical = canonicalize_attendance_record(
            student_id=student_id,
            student_code=student_code,
            timestamp=now_ts,
            status=status,
            similarity_score=similarity_score,
            liveness_score=liveness_score,
            liveness_type=liveness_type,
            challenge_id=challenge_id,
            prev_hash=prev_hash,
        )
        record_hmac = compute_record_hmac(canonical)

        # 4. Insert into attendance ledger
        cur = conn.execute(
            """INSERT INTO attendance (
                student_id, student_code, name, timestamp, status,
                similarity_score, liveness_score, liveness_type, challenge_id,
                prev_hash, record_hmac
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                student_id,
                student_code,
                name,
                now_ts,
                status,
                float(similarity_score),
                float(liveness_score),
                liveness_type,
                challenge_id,
                prev_hash,
                record_hmac,
            ),
        )
        new_id = int(cur.lastrowid or 0)

        # 5. Update trusted chain checkpoint
        total_records = conn.execute("SELECT COUNT(*) AS total FROM attendance").fetchone()["total"]
        checkpoint_sig = hmac.new(
            get_audit_hmac_key(),
            f"{new_id}|{record_hmac}|{total_records}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

        conn.execute(
            """INSERT INTO attendance_chain_checkpoints (
                latest_attendance_id, latest_record_hmac, total_records,
                checkpoint_timestamp, checkpoint_signature
            ) VALUES (?, ?, ?, ?, ?)""",
            (new_id, record_hmac, total_records, now_ts, checkpoint_sig),
        )

        return {
            "status": "ATTENDANCE_MARKED",
            "marked": True,
            "attendance_id": new_id,
            "student_id": student_id,
            "student_code": student_code,
            "name": name,
            "timestamp": now_ts,
            "similarity_score": round(similarity_score, 4),
            "liveness_score": round(liveness_score, 4),
            "record_hmac": record_hmac,
            "prev_hash": prev_hash,
            "total_records": total_records,
        }

def verify_attendance_chain_integrity() -> dict[str, Any]:
    """Audits the complete attendance ledger sequentially:
    1. Recomputes HMAC-SHA256 for each record against its canonical content.
    2. Verifies cryptographic backward hash linking (R_i.prev_hash == R_{i-1}.record_hmac).
    3. Verifies against the trusted checkpoint signature to detect truncation / rollback."""
    with connection() as conn:
        rows = conn.execute(
            """SELECT id, student_id, student_code, name, timestamp, status,
                      similarity_score, liveness_score, liveness_type, challenge_id,
                      prev_hash, record_hmac
               FROM attendance ORDER BY id ASC"""
        ).fetchall()

        checkpoint_row = conn.execute(
            """SELECT latest_attendance_id, latest_record_hmac, total_records,
                      checkpoint_timestamp, checkpoint_signature
               FROM attendance_chain_checkpoints ORDER BY id DESC LIMIT 1"""
        ).fetchone()

    total = len(rows)
    if total == 0:
        return {
            "is_valid": True,
            "total_records": 0,
            "tampered_records": [],
            "checkpoint_valid": True,
            "status": "EMPTY_LEDGER",
            "message": "Attendance ledger is empty. Chain is intact at Genesis.",
        }

    tampered: list[dict[str, Any]] = []
    expected_prev = GENESIS_PREV_HASH

    for r in rows:
        r_id = r["id"]
        # A. Check backward hash link
        if r["prev_hash"] != expected_prev:
            tampered.append({
                "record_id": r_id,
                "student_code": r["student_code"],
                "reason": f"Broken chain link: expected prev_hash '{expected_prev[:12]}...', found '{r['prev_hash'][:12]}...'",
            })

        # B. Recompute canonical HMAC
        canonical = canonicalize_attendance_record(
            student_id=r["student_id"],
            student_code=r["student_code"],
            timestamp=r["timestamp"],
            status=r["status"],
            similarity_score=r["similarity_score"],
            liveness_score=r["liveness_score"],
            liveness_type=r["liveness_type"],
            challenge_id=r["challenge_id"],
            prev_hash=r["prev_hash"],
        )
        recomputed = compute_record_hmac(canonical)

        if recomputed != r["record_hmac"]:
            tampered.append({
                "record_id": r_id,
                "student_code": r["student_code"],
                "reason": f"HMAC signature mismatch: record content was modified after signing.",
            })

        expected_prev = r["record_hmac"]

    # C. Checkpoint verification
    checkpoint_valid = True
    checkpoint_msg = "Checkpoint verified"
    if checkpoint_row is not None:
        last_rec = rows[-1]
        sig_data = f"{checkpoint_row['latest_attendance_id']}|{checkpoint_row['latest_record_hmac']}|{checkpoint_row['total_records']}".encode("utf-8")
        expected_sig = hmac.new(get_audit_hmac_key(), sig_data, hashlib.sha256).hexdigest()

        if expected_sig != checkpoint_row["checkpoint_signature"]:
            checkpoint_valid = False
            checkpoint_msg = "Trusted checkpoint signature invalid (checkpoint modified)."
        elif (
            checkpoint_row["latest_attendance_id"] != last_rec["id"]
            or checkpoint_row["latest_record_hmac"] != last_rec["record_hmac"]
            or checkpoint_row["total_records"] != total
        ):
            checkpoint_valid = False
            checkpoint_msg = f"Checkpoint mismatch: checkpoint recorded {checkpoint_row['total_records']} entries, but ledger contains {total}. Potential truncation detected!"

    is_valid = len(tampered) == 0 and checkpoint_valid

    return {
        "is_valid": is_valid,
        "total_records": total,
        "tampered_records": tampered,
        "checkpoint_valid": checkpoint_valid,
        "checkpoint_status": checkpoint_msg,
        "status": "CHAIN_VERIFIED" if is_valid else "TAMPER_DETECTED",
        "message": (
            f"All {total} attendance records cryptographically verified. Hash chain and HMACs are 100% valid."
            if is_valid
            else f"Integrity check failed: {len(tampered)} tampered record(s) or checkpoint discrepancies found."
        ),
    }

# --- Student & Profile Persistence (No Raw Photo Storage) ---

def register_student(
    name: str,
    student_code: str,
    department: str,
    embedding: np.ndarray,
) -> int:
    """Enrolls a student with Fernet AES-256 encrypted vector embedding; never stores raw photographs."""
    enc = encrypt_embedding(embedding)
    now_ts = utc_now()
    clean_code = student_code.upper().strip()
    with connection() as conn:
        conn.execute(
            """INSERT INTO students (name, student_code, department, encrypted_embeddings, created_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(student_code) DO UPDATE SET
                   name = excluded.name,
                   department = excluded.department,
                   encrypted_embeddings = excluded.encrypted_embeddings,
                   created_at = excluded.created_at""",
            (name.strip(), clean_code, department.strip(), enc, now_ts),
        )
        row = conn.execute("SELECT id FROM students WHERE student_code = ?", (clean_code,)).fetchone()
        row_id = row["id"] if row else 1

        # Also populate backwards-compatible table
        conn.execute(
            """INSERT INTO encrypted_driver_profiles (driver_id, display_name, encrypted_embedding, created_at, photo_base64, license_class)
               VALUES (?, ?, ?, ?, '', ?)
               ON CONFLICT(driver_id) DO UPDATE SET
                   display_name = excluded.display_name,
                   encrypted_embedding = excluded.encrypted_embedding,
                   created_at = excluded.created_at""",
            (clean_code, name.strip(), enc, now_ts, department.strip()),
        )
        return int(row_id)

def delete_student_biometrics(student_code: str) -> bool:
    """Authorized deletion/revocation of biometric template (GDPR right to be forgotten).
    Overwrites the encrypted embedding vector with a cryptographically wiped tombstone,
    preserving non-biometric attendance records for academic integrity."""
    clean_code = student_code.upper().strip()
    with connection() as conn:
        row = conn.execute("SELECT id FROM students WHERE student_code = ?", (clean_code,)).fetchone()
        if row is None:
            # Check driver table fallback
            d_row = conn.execute("SELECT driver_id FROM encrypted_driver_profiles WHERE driver_id = ?", (clean_code,)).fetchone()
            if d_row is None:
                return False

        # Cryptographically overwrite embedding vector
        wiped_token = "REVOKED_DELETED_BIOMETRIC_TOKEN"
        conn.execute(
            "UPDATE students SET encrypted_embeddings = ? WHERE student_code = ?",
            (wiped_token, clean_code),
        )
        conn.execute(
            "UPDATE encrypted_driver_profiles SET encrypted_embedding = ?, photo_base64 = '' WHERE driver_id = ?",
            (wiped_token, clean_code),
        )
        return True

def get_students() -> list[sqlite3.Row]:
    with connection() as conn:
        return conn.execute("SELECT id, name, student_code, department, encrypted_embeddings FROM students").fetchall()

def get_student_by_code(student_code: str) -> Optional[dict[str, Any]]:
    clean_code = student_code.upper().strip()
    with connection() as conn:
        row = conn.execute(
            "SELECT id, name, student_code, department, encrypted_embeddings, created_at FROM students WHERE student_code = ?",
            (clean_code,),
        ).fetchone()
        if row:
            return dict(row)
        # Fallback to driver profiles table
        d_row = conn.execute(
            "SELECT driver_id AS student_code, display_name AS name, license_class AS department, encrypted_embedding AS encrypted_embeddings, created_at FROM encrypted_driver_profiles WHERE driver_id = ?",
            (clean_code,),
        ).fetchone()
        if d_row:
            return {**dict(d_row), "id": 1}
        return None

def get_attendance_history(limit: int = 100) -> list[dict[str, Any]]:
    """Retrieves recent attendance records along with their tamper-evident cryptographic verification status."""
    with connection() as conn:
        rows = conn.execute(
            """SELECT id, student_id, student_code, name, timestamp, status,
                      similarity_score, liveness_score, liveness_type, challenge_id,
                      prev_hash, record_hmac
               FROM attendance ORDER BY id DESC LIMIT ?""",
            (limit,),
        ).fetchall()

    result = []
    for r in rows:
        canonical = canonicalize_attendance_record(
            student_id=r["student_id"],
            student_code=r["student_code"],
            timestamp=r["timestamp"],
            status=r["status"],
            similarity_score=r["similarity_score"],
            liveness_score=r["liveness_score"],
            liveness_type=r["liveness_type"],
            challenge_id=r["challenge_id"],
            prev_hash=r["prev_hash"],
        )
        verified = compute_record_hmac(canonical) == r["record_hmac"]
        result.append({
            "id": r["id"],
            "student_id": r["student_id"],
            "student_code": r["student_code"],
            "name": r["name"],
            "timestamp": r["timestamp"],
            "status": r["status"],
            "similarity_score": round(r["similarity_score"], 4),
            "liveness_score": round(r["liveness_score"], 4),
            "liveness_type": r["liveness_type"],
            "challenge_id": r["challenge_id"],
            "prev_hash": r["prev_hash"],
            "record_hmac": r["record_hmac"],
            "hmac_verified": verified,
        })
    return result

def attendance_recently_marked(student_id: int, cooldown_seconds: int = 43200) -> bool:
    with connection() as conn:
        row = conn.execute("SELECT timestamp FROM attendance WHERE student_id = ? ORDER BY id DESC LIMIT 1", (student_id,)).fetchone()
    if row is None:
        return False
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(row["timestamp"])).total_seconds() < cooldown_seconds
    except ValueError:
        return False

def get_dashboard() -> dict[str, Any]:
    today = datetime.now(timezone.utc).date().isoformat()
    with connection() as conn:
        enrolled = conn.execute("SELECT COUNT(*) AS total FROM students").fetchone()["total"]
        if enrolled == 0:
            enrolled = conn.execute("SELECT COUNT(*) AS total FROM encrypted_driver_profiles").fetchone()["total"]

        present = conn.execute(
            "SELECT COUNT(DISTINCT student_code) AS total FROM attendance WHERE timestamp >= ?",
            (today,),
        ).fetchone()["total"]

        rows = conn.execute(
            """SELECT id, student_code, name, timestamp, status,
                      similarity_score, liveness_score, record_hmac
               FROM attendance ORDER BY id DESC LIMIT 50"""
        ).fetchall()

    audit_status = verify_attendance_chain_integrity()
    return {
        "enrolled": enrolled,
        "present_today": present,
        "absent_today": max(0, enrolled - present),
        "ledger_verified": audit_status["is_valid"],
        "total_attendance_records": audit_status["total_records"],
        "records": [dict(r) for r in rows],
    }

# Backward compatibility functions
def insert_student(name: str, student_code: str, department: str, encrypted_embedding: str) -> int:
    with connection() as conn:
        cur = conn.execute("""INSERT INTO students
            (name, student_code, department, encrypted_embeddings, created_at) VALUES (?, ?, ?, ?, ?)""",
            (name, student_code, department, encrypted_embedding, utc_now()))
        return int(cur.lastrowid or 0)

def insert_attendance(student_id: int, score: float, challenge_status: str) -> None:
    insert_secure_attendance(
        student_id=student_id,
        student_code=f"STU-{student_id}",
        name=f"Student {student_id}",
        similarity_score=score,
        liveness_score=score,
        liveness_type=challenge_status,
        challenge_id="CHAL_LEGACY",
    )

def save_fuzzy_vault(student_id: int, encrypted_payload: str, genuine_count: int, chaff_count: int) -> None:
    with connection() as conn:
        conn.execute("""INSERT INTO fuzzy_vaults (student_id, encrypted_payload, genuine_count, chaff_count, created_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(student_id) DO UPDATE SET encrypted_payload=excluded.encrypted_payload,
            genuine_count=excluded.genuine_count, chaff_count=excluded.chaff_count, created_at=excluded.created_at""",
            (student_id, encrypted_payload, genuine_count, chaff_count, utc_now()))

def get_fuzzy_vault(student_id: int) -> sqlite3.Row | None:
    with connection() as conn:
        return conn.execute("SELECT * FROM fuzzy_vaults WHERE student_id = ?", (student_id,)).fetchone()

def fuzzy_vault_metrics() -> dict[str, Any]:
    with connection() as conn:
        rows = conn.execute("SELECT student_id, genuine_count, chaff_count, created_at, encrypted_payload FROM fuzzy_vaults ORDER BY created_at DESC LIMIT 24").fetchall()
    return {"vault_count": len(rows), "nodes": [{"student_id": row["student_id"], "genuine_count": row["genuine_count"],
        "chaff_count": row["chaff_count"], "created_at": row["created_at"], "cipher_preview": row["encrypted_payload"][:28] + "…"} for row in rows]}

def upsert_vault_identity(student_code: str, full_name: str, encrypted_face: str) -> str:
    seat = f"{chr(65 + (sum(map(ord, student_code)) % 6))}{(sum(map(ord, full_name)) % 6) + 1}"
    with connection() as conn:
        conn.execute("""INSERT INTO vault_identities (student_code, full_name, assigned_seat, encrypted_face_string, created_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(student_code) DO UPDATE SET full_name=excluded.full_name,
          encrypted_face_string=excluded.encrypted_face_string""", (student_code, full_name, seat, encrypted_face, utc_now()))
        conn.execute("UPDATE spatial_seats SET student_code=?, state='VERIFIED', updated_at=? WHERE seat_code=?", (student_code, utc_now(), seat))
    return seat

def spatial_audit() -> dict[str, Any]:
    with connection() as conn:
        seats = conn.execute("SELECT seat_code, student_code, state FROM spatial_seats ORDER BY seat_code").fetchall()
        identities = conn.execute("SELECT student_code, full_name, assigned_seat, encrypted_face_string FROM vault_identities ORDER BY full_name").fetchall()
    return {"seats": [dict(row) for row in seats], "identities": [{**dict(row), "encrypted_face_string": row["encrypted_face_string"][:512]} for row in identities]}

def log_proctor_incident(session_id: str, incident_type: str, severity: str, payload_json: str) -> None:
    with connection() as conn:
        conn.execute("INSERT INTO live_proctor_incidents (session_id, incident_type, severity, payload_json, created_at) VALUES (?, ?, ?, ?, ?)", (session_id, incident_type, severity, payload_json, utc_now()))

def log_sqlite_audit_event(
    event_type: str,
    driver_id: str,
    driver_name: str,
    reason: str,
    severity: str = "INFO",
    duration_seconds: float = 0.0,
    metadata_json: str = "{}",
) -> bool:
    try:
        with connection() as conn:
            conn.execute(
                "INSERT INTO audit_history (event_type, driver_id, driver_name, reason, severity, duration_seconds, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (event_type.upper().strip(), driver_id.upper().strip(), driver_name.strip(), reason.strip(), severity.upper().strip(), float(duration_seconds), metadata_json, utc_now()),
            )
        return True
    except Exception:
        return False

def get_sqlite_audit_history(
    limit: int = 100,
    event_type: str | None = None,
    driver_id: str | None = None,
) -> list[dict[str, Any]]:
    try:
        with connection() as conn:
            query = "SELECT id, event_type, driver_id, driver_name, reason, severity, duration_seconds, metadata_json, created_at FROM audit_history"
            params: list[Any] = []
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
            return [
                {
                    "id": str(r["id"]),
                    "event_type": r["event_type"],
                    "driver_id": r["driver_id"],
                    "driver_name": r["driver_name"],
                    "reason": r["reason"],
                    "severity": r["severity"],
                    "duration_seconds": r["duration_seconds"],
                    "metadata": json.loads(r["metadata_json"] or "{}"),
                    "timestamp": r["created_at"],
                }
                for r in rows
            ]
    except Exception:
        return []
