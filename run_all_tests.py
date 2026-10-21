#!/usr/bin/env python3
"""
CognitAI Master Automated Test Runner
Single-command test executor verifying all mathematical algorithms, security defenses, and API endpoints.

Usage:
    python run_all_tests.py
"""

import subprocess
import sys
import time
import unittest
from pathlib import Path

# Ensure UTF-8 output and ANSI color support on Windows console
if sys.platform == "win32":
    try:
        subprocess.run(["cmd", "/c", "color"], check=False)
    except Exception:
        pass
    try:
        reconfigure = getattr(sys.stdout, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Auto-switch to virtual environment python if available and not already running in it
BASE_DIR = Path(__file__).resolve().parent
BACKEND_DIR = BASE_DIR / "backend"
VENV_PYTHON = BACKEND_DIR / ".venv" / ("Scripts" if sys.platform == "win32" else "bin") / ("python.exe" if sys.platform == "win32" else "python")
if VENV_PYTHON.exists() and Path(sys.executable).resolve() != VENV_PYTHON.resolve():
    result = subprocess.run([str(VENV_PYTHON), *sys.argv])
    sys.exit(result.returncode)

# Add backend directory to sys.path
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"

def print_banner():
    print(f"\n{BOLD}{CYAN}============================================================{RESET}")
    print(f"{BOLD}{CYAN}      COGNITAI COMPREHENSIVE AUTOMATED TEST SUITE          {RESET}")
    print(f"{CYAN} Autonomous Bio-Telemetry & Attentiveness Control Console  {RESET}")
    print(f"{BOLD}{CYAN}============================================================{RESET}\n")

def iter_test_cases(suite):
    """Recursively yield individual TestCase instances from a TestSuite."""
    if isinstance(suite, unittest.TestSuite):
        for item in suite:
            yield from iter_test_cases(item)
    elif isinstance(suite, unittest.TestCase):
        yield suite


def run_tests():
    print_banner()

    try:
        from backend import test_suite
    except ImportError:
        try:
            import test_suite  # pyrefly: ignore[missing-import]  # type: ignore
        except ImportError as err:
            print(f"{RED}Error importing test_suite: {err}{RESET}")
            print("Please ensure the virtual environment packages are installed.")
            return 1

    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(test_suite)

    total_tests = suite.countTestCases()
    print(f"Discovered {BOLD}{total_tests} test cases{RESET} in test_suite.py...\n")

    passed = 0
    failed = 0
    skipped = 0
    start_time = time.time()

    for test in iter_test_cases(suite):
        test_name = getattr(test, "_testMethodName", str(test))
        test_doc = getattr(test, "_testMethodDoc", None) or test_name
        test_doc_clean = test_doc.split("\n")[0].strip()

        t0 = time.time()
        result = unittest.TestResult()
        test.run(result)
        duration = (time.time() - t0) * 1000

        if result.wasSuccessful():
            if len(result.skipped) > 0:
                skipped += 1
                reason = result.skipped[0][1]
                print(f" {YELLOW}[SKIP]{RESET} {test_doc_clean} ({duration:.1f}ms)")
                print(f"        -> {YELLOW}{reason}{RESET}")
            else:
                passed += 1
                print(f" {GREEN}[PASS]{RESET} {test_doc_clean} ({duration:.1f}ms)")
        else:
            failed += 1
            error_msg = result.failures[0][1] if result.failures else result.errors[0][1]
            first_line = error_msg.split("\n")[-2] if "\n" in error_msg else error_msg
            print(f" {RED}[FAIL]{RESET} {test_doc_clean} ({duration:.1f}ms)")
            print(f"        -> {RED}{first_line}{RESET}")

    total_duration = time.time() - start_time
    print(f"\n{BOLD}{CYAN}------------------------------------------------------------{RESET}")
    print(f"Total Tests : {total_tests}")
    print(f"Passed      : {GREEN}{passed}{RESET}")
    print(f"Skipped     : {YELLOW}{skipped}{RESET}")
    print(f"Failed      : {RED if failed else GREEN}{failed}{RESET}")
    print(f"Duration    : {total_duration:.2f} seconds")
    print(f"{BOLD}{CYAN}------------------------------------------------------------{RESET}")

    if failed == 0:
        print(f"{BOLD}{GREEN}ALL SYSTEMS OPERATIONAL: {passed}/{total_tests - skipped} ACTIVE TESTS PASSED{RESET}\n")
        return 0
    else:
        print(f"{BOLD}{RED}ATTENTION: {failed} test(s) failed. Check details above.{RESET}\n")
        return 1

if __name__ == "__main__":
    sys.exit(run_tests())
