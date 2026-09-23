# CognitAI — Autonomous Driver Attentiveness & Bio-Telemetry Console

Local-first, high-precision edge AI telemetry system for autonomous vehicles, commercial logistics, and driver safety monitoring. Powered by **FastAPI**, **PyTorch (FaceNet/MTCNN)**, **MediaPipe 468-point 3D Face Mesh**, **AES-256 Fernet encryption**, and **Next.js 14**.

---

## 🚀 Key Features

| Module | Technology | Functionality |
| :--- | :--- | :--- |
| **Fatigue Monitor** | MediaPipe 468-point Mesh | Real-time Eye Aspect Ratio (EAR) tracking with instant microsleep alarms when EAR drops below threshold (`< 0.20`). |
| **Stress & Bio-Analytics** | Optical rPPG + FFT Filtering | Contactless Remote Photoplethysmography analyzing green/red wavelength variance to compute Heart Rate (BPM), HRV, and Spectral SNR. |
| **Gaze Deviation** | 3D Head Pose Estimation | Real-time Yaw & Pitch orientation tracking to distinguish active road focus from distracted gaze drift (`> 35°`). |
| **Spoof Interceptor** | 3D Homography & Laplacian | Dual-layer presentation attack defense analyzing Z-axis landmark depth variance and high-frequency texture anomalies to block 2D photo/screen replay attacks. |
| **Identity Vault** | InceptionResnetV1 + Fernet | 512-dimensional facial embeddings encrypted at rest with AES-256 Fernet keys in SQLite. |
| **Emergency Dispatch** | Automated Background Worker | Immediate audio alarms and automated SMTP emergency dispatch notifications when an operator is unresponsive. |

---

## 🛠️ Quick Start

### 1. Start the Backend (Port 8000)

Using the automated batch script:
```powershell
.\start_backend.bat
```

Or manually:
```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

> **Note:** The backend generates an encrypted database at `backend/cognitive_data/cognitive.db` and an encryption key at `backend/cognitive_data/profile.key`. Keep this key secure.

### 2. Start the Frontend (Port 3000)

```powershell
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the live telemetry dashboard.

---

## 🧪 Automated Testing

Run the single-command master test runner verifying mathematical calculations, signal filters, anti-spoof homography, and encryption:

```powershell
.\test_all.bat
# or directly:
python run_all_tests.py
```

---

## 📁 System Architecture

```text
CognitAI/
├── backend/
│   ├── cognitive_data/          # SQLite database and AES-256 encryption keys
│   ├── database.py              # Persistence layer
│   ├── main.py                  # FastAPI server & cognitive pipeline
│   ├── requirements.txt         # PyTorch, OpenCV, SciPy, FastAPI dependencies
│   ├── start_backend.bat        # 1-Click backend launcher
│   └── test_suite.py            # Unit & pipeline test cases
├── frontend/
│   ├── app/
│   │   ├── components/          # DriverNav, MediaPipeGuard, Telemetry HUDs
│   │   ├── fatigue-monitor/     # Real-time EAR microsleep detection
│   │   ├── stress-analytics/    # rPPG cardiovascular telemetry
│   │   ├── gaze-deviation/      # 3D Head pose & windshield gaze
│   │   ├── spoof-interceptor/   # 3D Depth & texture anti-spoofing
│   │   ├── page.tsx             # Main Telemetry Console
│   │   └── layout.tsx           # Global Wikipedia-style clean layout
│   └── package.json
├── run_all_tests.py             # Master test executor
├── start_backend.bat            # Root launcher for backend
├── test_all.bat                 # Root launcher for tests
└── README.md
```

---

## 🛡️ Security & Privacy

All facial recognition templates are transformed into high-dimensional vector embeddings and immediately encrypted using AES-256 (Fernet) prior to database persistence. Raw video feeds are processed locally on-device and are never stored or transmitted over public networks.

