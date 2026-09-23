"""Explicit database initializer; the API also calls this on startup."""
from database import DATABASE_PATH, KEY_PATH, initialize_database

if __name__ == "__main__":
    initialize_database()
    print(f"Database ready: {DATABASE_PATH}")
    print(f"Fernet key ready: {KEY_PATH}")
