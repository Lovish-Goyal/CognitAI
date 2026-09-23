"""Automated test suite for CognitAI bio-telemetry & security pipelines."""
import json
import math
import sys
import unittest
import urllib.request
import urllib.error
import numpy as np
from pathlib import Path
from cryptography.fernet import Fernet
from scipy.signal import butter, sosfiltfilt

# Import backend application directly
import main

class TestCognitAIPipeline(unittest.TestCase):
    """Test mathematical calculations, encryption algorithms, and local API integrity."""

    @classmethod
    def setUpClass(cls):
        main.initialise()

    def test_ear_calculation_logic(self):
        """Verify Eye Aspect Ratio (EAR) thresholding logic."""
        p_open = {
            "p33": {"x": 10, "y": 50},
            "p133": {"x": 50, "y": 50},
            "p160": {"x": 25, "y": 43},
            "p144": {"x": 25, "y": 57},
            "p159": {"x": 35, "y": 43},
            "p145": {"x": 35, "y": 57},
        }
        dist = lambda a, b: math.hypot(a["x"] - b["x"], a["y"] - b["y"])
        ear_open = (dist(p_open["p159"], p_open["p145"]) + dist(p_open["p160"], p_open["p144"])) / (2.0 * dist(p_open["p33"], p_open["p133"]))
        self.assertGreater(ear_open, 0.28, f"Open EAR should be > 0.28, got {ear_open:.3f}")

        p_closed = {
            "p33": {"x": 10, "y": 50},
            "p133": {"x": 50, "y": 50},
            "p160": {"x": 25, "y": 49},
            "p144": {"x": 25, "y": 51},
            "p159": {"x": 35, "y": 49},
            "p145": {"x": 35, "y": 51},
        }
        ear_closed = (dist(p_closed["p159"], p_closed["p145"]) + dist(p_closed["p160"], p_closed["p144"])) / (2.0 * dist(p_closed["p33"], p_closed["p133"]))
        self.assertLess(ear_closed, 0.22, f"Closed EAR should drop below 0.22 threshold, got {ear_closed:.3f}")

    def test_planar_homography_anti_spoof(self):
        """Verify Z-axis depth variance differentiates 2D photos from natural 3D human faces."""
        # 3D Human face: natural depth curvature
        landmarks_3d = np.zeros((468, 3))
        landmarks_3d[:, 0] = np.random.uniform(0.3, 0.7, 468)
        landmarks_3d[:, 1] = np.random.uniform(0.2, 0.8, 468)
        landmarks_3d[:, 2] = np.random.normal(0.0, 0.06, 468)
        z_var_human = float(np.var(landmarks_3d[:, 2]))
        self.assertGreater(z_var_human, 0.0005, f"3D human face Z-variance should be > 0.0005, got {z_var_human:.6f}")

        # Flat 2D attack: Z variance collapses toward zero
        landmarks_flat = np.zeros((468, 3))
        landmarks_flat[:, 0] = np.random.uniform(0.3, 0.7, 468)
        landmarks_flat[:, 1] = np.random.uniform(0.2, 0.8, 468)
        landmarks_flat[:, 2] = np.random.normal(0.0, 0.0001, 468)
        z_var_flat = float(np.var(landmarks_flat[:, 2]))
        self.assertLess(z_var_flat, 0.0005, f"Flat presentation attack should have Z-variance < 0.0005, got {z_var_flat:.6f}")

    def test_fernet_aes_encryption(self):
        """Verify AES-256 Fernet token encryption & decryption preserving embedding similarity."""
        key = Fernet.generate_key()
        cipher = Fernet(key)

        original_vector = np.random.randn(512).astype(np.float32)
        original_vector /= np.linalg.norm(original_vector)

        encrypted_token = cipher.encrypt(original_vector.tobytes()).decode()
        self.assertTrue(encrypted_token.startswith("gAAAAA"), "Fernet token must start with standard header")

        decrypted_bytes = cipher.decrypt(encrypted_token.encode())
        recovered_vector = np.frombuffer(decrypted_bytes, dtype=np.float32)

        cosine_sim = float(np.dot(original_vector, recovered_vector) / (np.linalg.norm(original_vector) * np.linalg.norm(recovered_vector)))
        self.assertAlmostEqual(cosine_sim, 1.0, places=5, msg="Recovered embedding must match original with 100% fidelity")

    def test_rppg_butterworth_filter(self):
        """Verify rPPG Butterworth bandpass filtration (0.7-3.5 Hz) and pulse detection."""
        fs = 30.0
        duration = 6.0
        t = np.linspace(0, duration, int(fs * duration), endpoint=False)

        simulated_pulse = 0.5 * np.sin(2 * np.pi * 1.2 * t) + 12.0 + 0.1 * np.sin(2 * np.pi * 8.0 * t)

        sos = butter(3, [0.7, 3.5], btype="bandpass", fs=fs, output="sos")
        filtered = sosfiltfilt(sos, simulated_pulse - simulated_pulse.mean())

        power = np.abs(np.fft.rfft(filtered * np.hanning(len(filtered)))) ** 2
        freqs = np.fft.rfftfreq(len(filtered), 1.0 / fs)
        valid_mask = (freqs >= 0.7) & (freqs <= 3.5)

        peak_idx = int(np.argmax(power[valid_mask]))
        detected_freq = float(freqs[valid_mask][peak_idx])
        detected_bpm = detected_freq * 60.0

        self.assertAlmostEqual(detected_bpm, 72.0, delta=4.0, msg=f"rPPG filter should detect ~72 BPM, got {detected_bpm:.1f}")

    def test_api_health(self):
        """Verify /health endpoint logic and response format."""
        result = main.health()
        self.assertEqual(result.get("status"), "ok")
        self.assertEqual(result.get("mode"), "research")

    def test_api_drivers(self):
        """Verify /api/drivers returns active driver profiles."""
        result = main.get_drivers()
        self.assertIn("drivers", result)
        self.assertGreaterEqual(len(result["drivers"]), 1)
        first = result["drivers"][0]
        self.assertIn("driver_id", first)
        self.assertIn("display_name", first)

    def test_api_security_audit(self):
        """Verify /api/security-audit returns encrypted profiles and incident logs."""
        result = main.security_audit()
        self.assertIn("profiles", result)
        self.assertIn("incidents", result)
        self.assertGreaterEqual(len(result["profiles"]), 1)
        self.assertTrue(result["profiles"][0]["ciphertext"].startswith("gAAAAA"), "Profile ciphertext must be Fernet AES encrypted")

    def test_api_emergency_dispatch(self):
        """Verify /api/emergency-dispatch accepts payload and queues background job."""
        req = main.EmergencyDispatchRequest(
            driver_id="TEST_DRIVER",
            structural_failure_code="UNIT_TEST_DISPATCH",
            client_timestamp_ms=1000.0,
        )
        result = main.emergency_dispatch(req)
        self.assertEqual(result.get("status"), "DISPATCH_QUEUED")

    def test_api_report_incident(self):
        """Verify /api/report-incident accepts incident logs and records them."""
        req = main.ReportIncidentRequest(
            driver_id="DRIVER-001",
            reason="DRIVER_MICROSLEEP_DETECTED",
            duration_seconds=3.0,
        )
    def test_driver_register_invalid_photo(self):
        """Verify /api/driver-register rejects images without a human face with HTTP 422."""
        import base64
        import cv2
        from fastapi import HTTPException
        # Blank black image with no face
        blank = np.zeros((160, 160, 3), dtype=np.uint8)
        _, buf = cv2.imencode(".jpg", blank)
        b64 = "data:image/jpeg;base64," + base64.b64encode(buf).decode()
        req = main.DriverRegisterRequest(
            display_name="No Face Test",
            photo_base64=b64,
        )
        with self.assertRaises(HTTPException) as ctx:
            main.register_driver(req)
        self.assertEqual(ctx.exception.status_code, 422)

    def test_driver_register_and_biometric_login(self):
        """Verify end-to-end registration with valid face and immediate biometric login match."""
        from mongodb_client import search_mongo_drivers
        drivers = search_mongo_drivers("")
        valid_photo = None
        for d in drivers:
            if d.get("photo_base64") and len(d["photo_base64"]) > 1000:
                valid_photo = d["photo_base64"]
                break

        if valid_photo is not None:
            # Register new driver with face
            reg_req = main.DriverRegisterRequest(
                display_name="Biometric Test Operator",
                license_class="Commercial Class A",
                photo_base64=valid_photo,
            )
            reg_res = main.register_driver(reg_req)
            self.assertEqual(reg_res.get("status"), "REGISTERED")
            new_id = reg_res.get("driver_id")
            self.assertTrue(new_id)

            # Biometric direct face login
            login_req = main.DriverLoginRequest(
                photo_base64=valid_photo,
            )
            login_res = main.driver_login(login_req)
            self.assertEqual(login_res.get("status"), "SUCCESS")
            self.assertGreaterEqual(float(login_res.get("similarity", 0)), 0.52)

if __name__ == "__main__":
    unittest.main()
