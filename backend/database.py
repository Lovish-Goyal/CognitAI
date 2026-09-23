"""SQLite persistence and Fernet protection for biometric templates."""
from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

import numpy as np
from cryptography.fernet import Fernet

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DATABASE_PATH = DATA_DIR / "biometrics.db"
KEY_PATH = DATA_DIR / "fernet.key"

def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()

def get_fernet() -> Fernet:
    DATA_DIR.mkdir(mode=0o700, exist_ok=True)
    if not KEY_PATH.exists():
        try:
            with KEY_PATH.open("xb") as f:
                f.write(Fernet.generate_key())
            if os.name != "nt": os.chmod(KEY_PATH, 0o600)
        except FileExistsError:
            pass
    return Fernet(KEY_PATH.read_bytes().strip())

@contextmanager
def connection() -> Iterator[sqlite3.Connection]:
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
    get_fernet()
    with connection() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS students (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL,
          encrypted_embeddings TEXT NOT NULL, created_at TIMESTAMP NOT NULL
        );
        CREATE TABLE IF NOT EXISTS attendance (
          id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL,
          timestamp TIMESTAMP NOT NULL, status TEXT NOT NULL, liveness_score REAL NOT NULL,
          FOREIGN KEY(student_id) REFERENCES students(id)
        );
        CREATE INDEX IF NOT EXISTS idx_attendance_student_time ON attendance(student_id, timestamp DESC);
        """)
        # Forward-compatible migrations for databases created by earlier versions.
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(students)")}
        if "student_code" not in existing:
            conn.execute("ALTER TABLE students ADD COLUMN student_code TEXT")
        if "department" not in existing:
            conn.execute("ALTER TABLE students ADD COLUMN department TEXT NOT NULL DEFAULT 'General'")
        attendance_columns = {row["name"] for row in conn.execute("PRAGMA table_info(attendance)")}
        if "active_challenge_status" not in attendance_columns:
            conn.execute("ALTER TABLE attendance ADD COLUMN active_challenge_status TEXT NOT NULL DEFAULT 'NOT_APPLICABLE'")
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS fuzzy_vaults (
          student_id INTEGER PRIMARY KEY,
          encrypted_payload TEXT NOT NULL,
          genuine_count INTEGER NOT NULL,
          chaff_count INTEGER NOT NULL,
          created_at TIMESTAMP NOT NULL,
          FOREIGN KEY(student_id) REFERENCES students(id)
        );
        """)
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS vault_identities (
          id INTEGER PRIMARY KEY, student_code TEXT UNIQUE NOT NULL, full_name TEXT NOT NULL,
          assigned_seat TEXT NOT NULL, encrypted_face_string TEXT NOT NULL, created_at TIMESTAMP NOT NULL
        );
        CREATE TABLE IF NOT EXISTS live_proctor_incidents (
          id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, incident_type TEXT NOT NULL,
          severity TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TIMESTAMP NOT NULL
        );
        CREATE TABLE IF NOT EXISTS spatial_seats (
          seat_code TEXT PRIMARY KEY, student_code TEXT UNIQUE, state TEXT NOT NULL DEFAULT 'UNASSIGNED', updated_at TIMESTAMP NOT NULL
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
        for row in range(1, 7):
            for column in range(1, 7):
                seat = f"{chr(64 + row)}{column}"
                conn.execute("INSERT OR IGNORE INTO spatial_seats (seat_code, state, updated_at) VALUES (?, 'UNASSIGNED', ?)", (seat, utc_now()))
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_students_code ON students(student_code) WHERE student_code IS NOT NULL")

def encrypt_embedding(embedding: np.ndarray) -> str:
    return get_fernet().encrypt(np.asarray(embedding, dtype=np.float32).tobytes()).decode("ascii")

def decrypt_embedding(token: str) -> np.ndarray:
    vector = np.frombuffer(get_fernet().decrypt(token.encode("ascii")), dtype=np.float32)
    if vector.shape != (512,): raise ValueError("Invalid biometric vector")
    return vector.copy()

def insert_student(name: str, student_code: str, department: str, encrypted_embedding: str) -> int:
    with connection() as conn:
        return int(conn.execute("""INSERT INTO students
            (name, student_code, department, encrypted_embeddings, created_at) VALUES (?, ?, ?, ?, ?)""",
            (name, student_code, department, encrypted_embedding, utc_now())).lastrowid)

def get_students() -> list[sqlite3.Row]:
    with connection() as conn:
        return conn.execute("SELECT id, name, student_code, department, encrypted_embeddings FROM students").fetchall()

def get_dashboard() -> dict[str, object]:
    """Daily operational summary and most recent, non-sensitive attendance audit records."""
    today = datetime.now(timezone.utc).date().isoformat()
    with connection() as conn:
        enrolled = conn.execute("SELECT COUNT(*) AS total FROM students").fetchone()["total"]
        present = conn.execute("SELECT COUNT(DISTINCT student_id) AS total FROM attendance WHERE timestamp >= ?", (today,)).fetchone()["total"]
        rows = conn.execute("""SELECT a.id, a.timestamp, a.status, a.liveness_score, a.active_challenge_status,
            s.name, s.student_code, s.department FROM attendance a
            JOIN students s ON s.id = a.student_id ORDER BY a.id DESC LIMIT 50""").fetchall()
    return {"enrolled": enrolled, "present_today": present, "absent_today": max(0, enrolled - present),
            "records": [dict(row) for row in rows]}

def attendance_recently_marked(student_id: int, cooldown_seconds: int) -> bool:
    with connection() as conn:
        row = conn.execute("SELECT timestamp FROM attendance WHERE student_id = ? ORDER BY id DESC LIMIT 1", (student_id,)).fetchone()
    if row is None: return False
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(row["timestamp"])).total_seconds() < cooldown_seconds
    except ValueError:
        return False

def insert_attendance(student_id: int, score: float, challenge_status: str) -> None:
    with connection() as conn:
        conn.execute("""INSERT INTO attendance
            (student_id, timestamp, status, liveness_score, active_challenge_status) VALUES (?, ?, ?, ?, ?)""",
            (student_id, utc_now(), "Present", score, challenge_status))

def save_fuzzy_vault(student_id: int, encrypted_payload: str, genuine_count: int, chaff_count: int) -> None:
    with connection() as conn:
        conn.execute("""INSERT INTO fuzzy_vaults (student_id, encrypted_payload, genuine_count, chaff_count, created_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(student_id) DO UPDATE SET encrypted_payload=excluded.encrypted_payload,
            genuine_count=excluded.genuine_count, chaff_count=excluded.chaff_count, created_at=excluded.created_at""",
            (student_id, encrypted_payload, genuine_count, chaff_count, utc_now()))

def get_fuzzy_vault(student_id: int) -> sqlite3.Row | None:
    with connection() as conn:
        return conn.execute("SELECT * FROM fuzzy_vaults WHERE student_id = ?", (student_id,)).fetchone()

def fuzzy_vault_metrics() -> dict[str, object]:
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

def spatial_audit() -> dict[str, object]:
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
) -> list[dict[str, object]]:
    try:
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
