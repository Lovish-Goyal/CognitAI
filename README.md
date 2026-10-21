# CognitAI — Edge Biometric Verification & Operator Bio-Telemetry System

CognitAI is a local-first, high-precision edge artificial intelligence system providing multi-layer biometric authentication, presentation attack defense, and real-time operator vigilance telemetry. Engineered with **FastAPI**, **PyTorch (Inception-ResNet-v1 / MTCNN)**, **MediaPipe 468-point 3D Face Mesh**, **AES-256 Fernet encryption at rest**, and **Next.js 14**.

---

## 🚀 System Capabilities

| Module | Core Technology | Operational Capability |
| :--- | :--- | :--- |
| **Entrance Verification** | Inception-ResNet-v1 (512-D) | High-accuracy facial biometric identification with three-tier confidence boundaries (`VERIFIED`, `RETRY`, `REJECTED`). |
| **Presentation Attack Defense** | 3D Homography & Spatial Laplacian | Dual-layer passive anti-spoofing analyzing volumetric $Z$-axis curvature and high-frequency texture gradient to intercept 2D photo printouts and digital screen replays. |
| **Active Liveness Engine** | Kinematic Motion Tracking | Cryptographically signed, randomized micro-challenges (head yaw rotation, dynamic eye blinks) with single-use tokens and 12-second TTL. |
| **Ocular Fatigue Monitor** | MediaPipe 468-point Mesh | Real-time Eye Aspect Ratio (EAR) tracking with sub-200ms detection of prolonged eye closures and microsleep episodes. |
| **Cardiovascular rPPG** | Contactless Optical Telemetry | Remote Photoplethysmography extracting pulse wave variations across hemoglobin-sensitive color channels filtered through a 2nd-order Butterworth bandpass (0.7–3.5 Hz). |
| **Spatial Gaze Deviation** | 3D Head Pose Orientation | Real-time 6-DoF yaw, pitch, and roll monitoring to ensure eyes stay focused forward and proactively flag cognitive distractions. |
| **Biometric Vault** | Fernet AES-256 Encryption | 512-dimensional facial embeddings encrypted at rest with Fernet keys in SQLite. Raw webcam frames are processed transiently in memory and discarded. |
| **Tamper-Evident Ledger** | Sequential HMAC-SHA256 Chain | Backward hash-chained transaction ledger linking each verification event with cryptographic integrity verification. |

---

## 🛠️ Quick Start

### Option 1: 1-Click Launch (Recommended for Windows)

Double-click the root batch script:
```powershell
.\start_project.bat
```
This launcher automatically initializes the FastAPI backend on port 8000, starts the Next.js frontend on port 3000, and opens your default browser.

---

### Option 2: Manual Initialization

#### 1. Backend Service (Port 8000)
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```
* API Documentation: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)
* Health Status: [http://127.0.0.1:8000/health](http://127.0.0.1:8000/health)

#### 2. Frontend Interface (Port 3000)
```powershell
cd frontend
npm install
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) to access the operator control console.

---

## 🧪 Automated Verification & Testing

Execute the comprehensive automated test suite verifying mathematical calculations, signal filtration, anti-spoof homography, and cryptographic ledgers:

```powershell
.\test_all.bat
# or directly:
python run_all_tests.py
```

To run the dedicated secure attendance unit suite:
```powershell
& .\backend\.venv\Scripts\python.exe backend\test_secure_attendance.py
```

---

## 📁 System Architecture

```text
CognitAI/
├── backend/
│   ├── data/                    # Active encrypted SQLite database & Fernet keys (.gitignored)
│   ├── database.py              # Persistence layer, Fernet AES-256 encryption & HMAC chain
│   ├── main.py                  # FastAPI service, Inception-ResNet-v1 & MTCNN pipelines
│   ├── mongodb_client.py        # Optional cloud telemetry synchronization client
│   ├── requirements.txt         # Core Python dependencies
│   ├── test_secure_attendance.py# Unit tests for biometric security & anti-spoofing
│   └── test_suite.py            # Master telemetry and signal processing test suite
├── frontend/
│   ├── app/
│   │   ├── components/          # EntranceGateway, MediaPipeGuard, Telemetry HUDs
│   │   ├── fatigue-monitor/     # Real-time EAR microsleep detection interface
│   │   ├── stress-analytics/    # rPPG cardiovascular telemetry interface
│   │   ├── gaze-deviation/      # 3D Head pose & windscreen gaze interface
│   │   ├── spoof-interceptor/   # 3D Depth & texture anti-spoofing monitor
│   │   ├── history/             # Cryptographic ledger audit verification portal
│   │   ├── page.tsx             # Primary Operator Telemetry Console
│   │   └── layout.tsx           # Global application layout
│   ├── public/mediapipe/        # Local offline MediaPipe WASM and binary assets
│   └── package.json             # Next.js dependencies and build scripts
├── start_project.bat            # 1-Click launcher for full stack
├── start_backend.bat            # Root launcher for backend
├── test_all.bat                 # Root launcher for test suite
├── run_all_tests.py             # Automated test runner
└── README.md                    # Primary repository documentation
```

---

## 🛡️ Security, Privacy & Compliance

1. **Zero Raw Image Persistence:** Camera base64 images are processed in-memory solely for neural feature extraction. Once 512-dimensional vector embeddings are generated, raw frames are discarded and never written to disk.
2. **Cryptographic Protection at Rest:** Biometric embeddings are encrypted with AES-256 (Fernet) prior to database persistence. Symmetric encryption keys are strictly excluded from version control.
3. **Tamper Detection:** All attendance events are sequentially hashed using HMAC-SHA256 backward chaining. Any post-hoc database tampering or record modification is flagged by ledger audit checkpoints.
4. **Offline Isolation:** Neural vision inference executes entirely on-device using local MediaPipe WASM binaries and PyTorch models without transmitting video feeds over public networks.
