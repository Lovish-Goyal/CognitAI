"""MongoDB integration client for driver profiles, biometrics, and audit logging."""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from dotenv import load_dotenv

load_dotenv()

try:
    import pymongo
    from pymongo import MongoClient
    from pymongo.errors import ConnectionFailure, PyMongoError
    PYMONGO_AVAILABLE = True
except ImportError:
    pymongo = None
    MongoClient = None
    ConnectionFailure = Exception
    PyMongoError = Exception
    PYMONGO_AVAILABLE = False

DEFAULT_URI = "mongodb://localhost:27017/cognitai"

def get_mongo_uri() -> str:
    return os.getenv("MONGODB_URI", DEFAULT_URI).strip()

def mask_uri(uri: str) -> str:
    """Mask credentials in MongoDB URI for safe API exposure."""
    try:
        return re.sub(r"://([^:]+):([^@]+)@", r"://\1:****@", uri)
    except Exception:
        return "mongodb://****"

_client: Optional[MongoClient] = None
_db_connected: bool = False

def get_client() -> Optional[MongoClient]:
    global _client, _db_connected
    if not PYMONGO_AVAILABLE or MongoClient is None:
        _db_connected = False
        return None
    uri = get_mongo_uri()
    try:
        if _client is None:
            _client = MongoClient(uri, serverSelectionTimeoutMS=5000, connectTimeoutMS=5000)
            _client.admin.command("ping")
            _db_connected = True
        return _client
    except (ConnectionFailure, PyMongoError, Exception) as e:
        print(f"[MongoDB Client Error] {e}")
        _client = None
        _db_connected = False
        return None

def get_db() -> Optional[Any]:
    client = get_client()
    if client is None:
        return None
    # Parse DB name from URI or default to 'cognitai'
    uri = get_mongo_uri()
    db_name = "cognitai"
    try:
        parsed_path = uri.split("/")[-1].split("?")[0]
        if parsed_path:
            db_name = parsed_path
    except Exception:
        pass
    return client[db_name]

def init_mongo() -> bool:
    """Initializes MongoDB collections, indexes, and initial seed drivers if empty."""
    db = get_db()
    if db is None:
        return False

    try:
        drivers_col = db["drivers"]
        drivers_col.create_index("driver_id", unique=True)
        drivers_col.create_index("display_name")

        # Seed initial drivers if empty
        if drivers_col.count_documents({}) == 0:
            now_iso = datetime.now(timezone.utc).isoformat()
            drivers_col.insert_many([
                {
                    "driver_id": "DRIVER-001",
                    "display_name": "Alex Mercer (Fleet Logistics Lead)",
                    "photo_base64": "",
                    "license_class": "Commercial A (Heavy Freight)",
                    "status": "Active / Verified",
                    "created_at": now_iso,
                },
                {
                    "driver_id": "DRIVER-002",
                    "display_name": "Sarah Chen (Hazardous Cargo Transport)",
                    "photo_base64": "",
                    "license_class": "Commercial HAZMAT",
                    "status": "Active / Verified",
                    "created_at": now_iso,
                },
                {
                    "driver_id": "DRIVER-003",
                    "display_name": "Marcus Vance (Overnight Express Transit)",
                    "photo_base64": "",
                    "license_class": "Commercial Class B",
                    "status": "Active / Verified",
                    "created_at": now_iso,
                },
                {
                    "driver_id": "DRIVER-004",
                    "display_name": "Elena Rostova (Autonomous Escort Pilot)",
                    "photo_base64": "",
                    "license_class": "Commercial Class A",
                    "status": "Active / Verified",
                    "created_at": now_iso,
                },
            ])

        # Audit History Indexing & SQLite bootstrap sync
        audit_col = db["audit_history"]
        audit_col.create_index([("timestamp", -1)])
        audit_col.create_index("driver_id")
        audit_col.create_index("event_type")

        if audit_col.count_documents({}) == 0:
            import sqlite3
            import json
            from pathlib import Path
            sqlite_db = Path(__file__).resolve().parent / "cognitive_data" / "cognitive.db"
            if sqlite_db.exists():
                try:
                    conn = sqlite3.connect(sqlite_db)
                    conn.row_factory = sqlite3.Row
                    rows = conn.execute(
                        "SELECT event_type, driver_id, driver_name, reason, severity, duration_seconds, metadata_json, created_at FROM audit_history ORDER BY id ASC"
                    ).fetchall()
                    conn.close()
                    if rows:
                        docs = []
                        for r in rows:
                            meta = {}
                            try:
                                if r["metadata_json"]:
                                    meta = json.loads(r["metadata_json"])
                            except Exception:
                                pass
                            docs.append({
                                "event_type": r["event_type"],
                                "driver_id": r["driver_id"],
                                "driver_name": r["driver_name"],
                                "reason": r["reason"],
                                "severity": r["severity"],
                                "duration_seconds": r["duration_seconds"],
                                "metadata": meta,
                                "timestamp": r["created_at"],
                            })
                        if docs:
                            audit_col.insert_many(docs)
                except Exception as ex:
                    print(f"[MongoDB] SQLite sync note: {ex}")

        return True
    except Exception as e:
        print(f"[MongoDB] Init warning: {e}")
        return False

def search_mongo_drivers(query: str = "", limit: int = 20, skip: int = 0) -> List[Dict[str, Any]]:
    """Letter-by-letter regex search across driver name and driver ID with pagination."""
    db = get_db()
    if db is None:
        return []

    try:
        col = db["drivers"]
        filter_dict: Dict[str, Any] = {}
        if query and query.strip():
            pattern = re.compile(re.escape(query.strip()), re.IGNORECASE)
            filter_dict = {
                "$or": [
                    {"display_name": pattern},
                    {"driver_id": pattern},
                    {"license_class": pattern},
                ]
            }

        cursor = (
            col.find(filter_dict, {"_id": 0})
            .sort("created_at", (pymongo.DESCENDING if pymongo else -1))
            .skip(max(0, skip))
            .limit(min(100, max(1, limit)))
        )
        return list(cursor)
    except Exception as e:
        print(f"[MongoDB] Search error: {e}")
        return []

def count_mongo_drivers(query: str = "") -> int:
    db = get_db()
    if db is None:
        return 0
    try:
        filter_dict = {}
        if query and query.strip():
            pattern = re.compile(re.escape(query.strip()), re.IGNORECASE)
            filter_dict = {
                "$or": [
                    {"display_name": pattern},
                    {"driver_id": pattern},
                ]
            }
        return db["drivers"].count_documents(filter_dict)
    except Exception:
        return 0

def upsert_mongo_driver(
    driver_id: str,
    display_name: str,
    photo_base64: str = "",
    encrypted_embedding: str = "",
    license_class: str = "Commercial A",
) -> bool:
    """Inserts or updates driver profile in MongoDB."""
    db = get_db()
    if db is None:
        return False

    try:
        now_iso = datetime.now(timezone.utc).isoformat()
        db["drivers"].update_one(
            {"driver_id": driver_id.upper().strip()},
            {
                "$set": {
                    "driver_id": driver_id.upper().strip(),
                    "display_name": display_name.strip(),
                    "photo_base64": photo_base64,
                    "encrypted_embedding": encrypted_embedding,
                    "license_class": license_class.strip(),
                    "status": "Active / Verified",
                    "updated_at": now_iso,
                },
                "$setOnInsert": {
                    "created_at": now_iso,
                },
            },
            upsert=True,
        )
        return True
    except Exception as e:
        print(f"[MongoDB] Upsert error: {e}")
        return False

def find_mongo_driver(query: str) -> Optional[Dict[str, Any]]:
    """Finds a driver in MongoDB by driver ID or display name (exact or substring)."""
    db = get_db()
    if db is None or not query or not query.strip():
        return None
    try:
        col = db["drivers"]
        q = query.strip()
        # 1. Exact driver_id match
        exact_id = col.find_one({"driver_id": q.upper()}, {"_id": 0})
        if exact_id:
            return exact_id

        # 2. Case-insensitive exact name match
        name_exact_pattern = re.compile(f"^{re.escape(q)}$", re.IGNORECASE)
        exact_name = col.find_one({"display_name": name_exact_pattern}, {"_id": 0})
        if exact_name:
            return exact_name

        # 3. Case-insensitive substring name or ID match
        loose_pattern = re.compile(re.escape(q), re.IGNORECASE)
        loose_match = col.find_one({
            "$or": [
                {"display_name": loose_pattern},
                {"driver_id": loose_pattern},
            ]
        }, {"_id": 0})
        return loose_match
    except Exception as e:
        print(f"[MongoDB] Find error: {e}")
        return None

def get_mongo_driver_by_id(driver_id: str) -> Optional[Dict[str, Any]]:
    return find_mongo_driver(driver_id)

def log_mongo_incident(driver_id: str, reason: str, duration_seconds: float = 0.0) -> bool:
    db = get_db()
    if db is None:
        return False
    try:
        db["incidents"].insert_one({
            "driver_id": driver_id.upper().strip(),
            "reason": reason,
            "duration_seconds": duration_seconds,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        return True
    except Exception:
        return False

def log_audit_event(
    event_type: str,
    driver_id: str,
    driver_name: str,
    reason: str,
    severity: str = "INFO",
    duration_seconds: float = 0.0,
    metadata: Optional[Dict[str, Any]] = None,
) -> bool:
    db = get_db()
    if db is None:
        return False
    try:
        doc = {
            "event_type": event_type.upper().strip(),
            "driver_id": driver_id.upper().strip(),
            "driver_name": driver_name.strip(),
            "reason": reason.strip(),
            "severity": severity.upper().strip(),
            "duration_seconds": round(float(duration_seconds), 1),
            "metadata": metadata or {},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        db["audit_history"].insert_one(doc)
        return True
    except Exception:
        return False

def get_mongo_audit_history(
    limit: int = 100,
    event_type: Optional[str] = None,
    driver_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    db = get_db()
    if db is None:
        return []
    try:
        filter_query: Dict[str, Any] = {}
        if event_type and event_type.strip() and event_type.upper() != "ALL":
            filter_query["event_type"] = event_type.upper().strip()
        if driver_id and driver_id.strip():
            filter_query["$or"] = [
                {"driver_id": {"$regex": driver_id.strip(), "$options": "i"}},
                {"driver_name": {"$regex": driver_id.strip(), "$options": "i"}},
            ]

        cursor = db["audit_history"].find(filter_query).sort("timestamp", -1).limit(limit)
        results = []
        for doc in cursor:
            results.append({
                "id": str(doc.get("_id", "")),
                "event_type": doc.get("event_type", "INFO"),
                "driver_id": doc.get("driver_id", "UNKNOWN"),
                "driver_name": doc.get("driver_name", "Unknown Operator"),
                "reason": doc.get("reason", "Standard operational event"),
                "severity": doc.get("severity", "INFO"),
                "duration_seconds": doc.get("duration_seconds", 0.0),
                "metadata": doc.get("metadata", {}),
                "timestamp": doc.get("timestamp", datetime.now(timezone.utc).isoformat()),
            })
        return results
    except Exception as e:
        print(f"[MongoDB get_mongo_audit_history Exception] {type(e).__name__}: {e}")
        return []

def get_mongodb_status() -> Dict[str, Any]:
    uri = get_mongo_uri()
    client = get_client()
    connected = client is not None
    driver_count = 0
    if connected:
        try:
            db = get_db()
            if db is not None:
                driver_count = db["drivers"].count_documents({})
        except Exception:
            pass

    return {
        "database": "mongodb" if connected else "sqlite_fallback",
        "connected": connected,
        "uri_masked": mask_uri(uri),
        "driver_count": driver_count,
        "status": "ONLINE (Connected to MongoDB)" if connected else "OFFLINE (Fallback to SQLite Storage)",
    }

