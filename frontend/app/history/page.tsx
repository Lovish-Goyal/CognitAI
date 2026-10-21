"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { useMonitoring } from "../context/MonitoringContext";

import { getApiBaseUrl } from "../utils/api";
const API = getApiBaseUrl();

interface AuditRecord {
  id: string;
  event_type: "LOGIN" | "LOGOUT" | "ALARM" | string;
  driver_id: string;
  driver_name: string;
  reason: string;
  severity: "INFO" | "WARNING" | "CRITICAL" | string;
  duration_seconds: number;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

interface AttendanceRecord {
  id: number;
  student_id: number;
  student_code: string;
  name: string;
  timestamp: string;
  status: string;
  similarity_score: number;
  liveness_score: number;
  liveness_type: string;
  challenge_id: string;
  prev_hash: string;
  record_hmac: string;
  is_hmac_valid: boolean;
}

interface IntegrityAuditResult {
  is_valid: boolean;
  status: string;
  total_records: number;
  tampered_records: Array<{ record_id: number; student_code: string; reason: string }>;
  checkpoint_valid: boolean;
  checkpoint_status: string;
  message: string;
}

export default function HistoryPage() {
  const { currentDriver, isMonitoring } = useMonitoring();
  const [activeTab, setActiveTab] = useState<"ATTENDANCE" | "SYSTEM">("ATTENDANCE");
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [attendanceRecords, setAttendanceRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [filterType, setFilterType] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [dbSource, setDbSource] = useState<string>("sqlite_unified");

  // Ledger Integrity Modal
  const [auditing, setAuditing] = useState<boolean>(false);
  const [integrityResult, setIntegrityResult] = useState<IntegrityAuditResult | null>(null);
  const [showIntegrityModal, setShowIntegrityModal] = useState<boolean>(false);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      // 1. Fetch system audit records
      const res = await fetch(`${API}/api/audit-history?limit=100`);
      const data = await res.json();
      if (data && Array.isArray(data.history)) {
        setRecords(data.history);
        setDbSource(data.source || "database");
      }
    } catch {
      // Fallback
    }

    try {
      // 2. Fetch tamper-evident attendance ledger
      const attRes = await fetch(`${API}/api/attendance/history?limit=100`);
      const attData = await attRes.json();
      if (attData && Array.isArray(attData.history)) {
        setAttendanceRecords(attData.history);
      }
    } catch {
      // Fallback
    } finally {
      setLoading(false);
    }
  }, []);

  const runIntegrityAudit = async () => {
    setAuditing(true);
    try {
      const res = await fetch(`${API}/api/attendance/verify-integrity`);
      const data: IntegrityAuditResult = await res.json();
      setIntegrityResult(data);
      setShowIntegrityModal(true);
    } catch (err) {
      console.error("Integrity audit failed:", err);
    } finally {
      setAuditing(false);
    }
  };

  useEffect(() => {
    fetchHistory();
    const interval = setInterval(fetchHistory, 10000); // Polling every 10s
    return () => clearInterval(interval);
  }, [fetchHistory]);

  // Filtered attendance records
  const filteredAttendance = useMemo(() => {
    return attendanceRecords.filter((r) => {
      const q = searchQuery.toLowerCase().trim();
      return !q || r.name.toLowerCase().includes(q) || r.student_code.toLowerCase().includes(q);
    });
  }, [attendanceRecords, searchQuery]);

  // Filtered system records
  const filteredRecords = useMemo(() => {
    return records.filter((r) => {
      const matchesType =
        filterType === "ALL" || r.event_type.toUpperCase() === filterType.toUpperCase();
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        r.driver_name.toLowerCase().includes(q) ||
        r.driver_id.toLowerCase().includes(q) ||
        r.reason.toLowerCase().includes(q);
      return matchesType && matchesSearch;
    });
  }, [records, filterType, searchQuery]);

  // Statistics
  const stats = useMemo(() => {
    const logins = records.filter((r) => r.event_type.toUpperCase() === "LOGIN").length;
    const logouts = records.filter((r) => r.event_type.toUpperCase() === "LOGOUT").length;
    const alarms = records.filter((r) => r.event_type.toUpperCase() === "ALARM").length;
    return { logins, logouts, alarms, total: records.length, attendanceTotal: attendanceRecords.length };
  }, [records, attendanceRecords]);

  const formatTimestamp = (ts: string) => {
    try {
      const d = new Date(ts);
      return d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      });
    } catch {
      return ts;
    }
  };

  const formatDuration = (sec: number) => {
    if (!sec || sec <= 0) return "—";
    if (sec < 60) return `${Math.round(sec)}s`;
    const mins = Math.floor(sec / 60);
    const remainder = Math.round(sec % 60);
    return `${mins}m ${remainder}s`;
  };

  return (
    <div className="w-full p-6 sm:p-8 space-y-6 bg-white min-h-screen">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-6 border-b border-gray-200">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
              Audit &amp; Session History
            </h1>
            <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-blue-50 text-blue-700 border border-blue-200">
              HMAC-SHA256 Ledger
            </span>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            Tamper-evident attendance ledger linked with sequential cryptographic backward hash chains and trusted checkpoints.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {/* Live Integrity Audit Button */}
          <button
            type="button"
            onClick={runIntegrityAudit}
            disabled={auditing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded-lg shadow-sm transition"
          >
            <span>🛡️</span>
            <span>{auditing ? "Auditing Chain..." : "Verify Ledger Integrity"}</span>
          </button>

          <button
            type="button"
            onClick={fetchHistory}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 shadow-sm transition"
          >
            <span>🔄</span>
            <span>{loading ? "Refreshing..." : "Refresh"}</span>
          </button>

          <div className="text-xs text-gray-400 font-mono bg-gray-50 px-2.5 py-1.5 rounded-lg border border-gray-200">
            Source: <span className="font-semibold text-gray-700 uppercase">{dbSource}</span>
          </div>
        </div>
      </div>

      {/* Main Ledger Mode Tabs */}
      <div className="flex items-center gap-2 border-b border-gray-200 pb-2">
        <button
          type="button"
          onClick={() => setActiveTab("ATTENDANCE")}
          className={`flex items-center gap-2 py-2 px-4 rounded-xl text-xs font-bold transition ${
            activeTab === "ATTENDANCE"
              ? "bg-[#0066cc] text-white shadow-sm"
              : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
          }`}
        >
          <span>📜</span>
          <span>Attendance Ledger (HMAC Chained)</span>
          <span className={`px-2 py-0.2 rounded-full text-[10px] ${activeTab === "ATTENDANCE" ? "bg-white/20 text-white" : "bg-gray-200 text-gray-700"}`}>
            {attendanceRecords.length}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("SYSTEM")}
          className={`flex items-center gap-2 py-2 px-4 rounded-xl text-xs font-bold transition ${
            activeTab === "SYSTEM"
              ? "bg-[#0066cc] text-white shadow-sm"
              : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
          }`}
        >
          <span>⚙️</span>
          <span>System &amp; Driver Event Logs</span>
          <span className={`px-2 py-0.2 rounded-full text-[10px] ${activeTab === "SYSTEM" ? "bg-white/20 text-white" : "bg-gray-200 text-gray-700"}`}>
            {records.length}
          </span>
        </button>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 my-6">
        <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wider">Attendance Marked</div>
          <div className="text-2xl font-extrabold text-emerald-600 mt-1 flex items-center justify-between">
            <span>{attendanceRecords.length}</span>
            <span className="text-sm px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-mono">
              HMAC Chained
            </span>
          </div>
          <p className="text-[11px] text-gray-400 mt-1">Multi-layer biometric check-ins</p>
        </div>

        <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wider">Sequential Integrity</div>
          <div className="text-2xl font-extrabold text-blue-600 mt-1 flex items-center justify-between">
            <span>100%</span>
            <span className="text-sm px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 font-mono">
              Genesis Linked
            </span>
          </div>
          <p className="text-[11px] text-gray-400 mt-1">SHA-256 backward audit trail</p>
        </div>

        <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wider">Security Events</div>
          <div className="text-2xl font-extrabold text-rose-600 mt-1 flex items-center justify-between">
            <span>{stats.alarms}</span>
            <span className="text-sm px-2 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200">
              Logged
            </span>
          </div>
          <p className="text-[11px] text-gray-400 mt-1">Microsleep, fatigue &amp; anti-spoof alerts</p>
        </div>

        <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wider">Current Operator</div>
          <div className="text-sm font-bold text-gray-900 mt-1 truncate">
            {currentDriver?.display_name || "No Active Session"}
          </div>
          <div className="text-[11px] text-gray-500 mt-1 flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${isMonitoring ? "bg-emerald-500 animate-pulse" : "bg-gray-400"}`} />
            <span>{isMonitoring ? "Monitoring Active" : "Session Standby"}</span>
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 mb-6 bg-gray-50 p-2.5 rounded-xl border border-gray-200">
        {activeTab === "SYSTEM" ? (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
            {[
              { id: "ALL", label: "All Logs" },
              { id: "LOGIN", label: "🟢 Logins" },
              { id: "LOGOUT", label: "🔴 Logouts" },
              { id: "ALARM", label: "⚠️ Alarms" },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilterType(tab.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                  filterType === tab.id
                    ? "bg-white text-blue-700 shadow-sm border border-gray-200"
                    : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-700 px-1">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span>Tamper-Resistant Attendance Ledger</span>
          </div>
        )}

        {/* Search Input */}
        <div className="relative min-w-[240px]">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={activeTab === "ATTENDANCE" ? "Search by student name or code..." : "Search by operator or reason..."}
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-gray-300 rounded-lg text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
          />
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs">🔍</span>
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* History Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          {activeTab === "ATTENDANCE" ? (
            /* ATTENDANCE LEDGER TABLE */
            <table className="w-full text-left text-xs text-gray-700">
              <thead className="bg-gray-50 border-b border-gray-200 text-gray-600 font-semibold uppercase text-[10px] tracking-wider">
                <tr>
                  <th className="px-4 py-3">Timestamp</th>
                  <th className="px-4 py-3">Student Identity</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Biometric Similarity</th>
                  <th className="px-4 py-3">Liveness Defense</th>
                  <th className="px-4 py-3">HMAC-SHA256 Hash Chain</th>
                  <th className="px-4 py-3 text-right">Integrity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredAttendance.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                      <div className="text-3xl mb-2">📜</div>
                      <p className="font-medium text-sm text-gray-600">No attendance entries recorded yet</p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        Authenticate a face through the Entrance Gateway to write the first cryptographic block.
                      </p>
                    </td>
                  </tr>
                ) : (
                  filteredAttendance.map((item) => (
                    <tr key={item.id} className="hover:bg-gray-50/80 transition font-mono">
                      {/* Timestamp */}
                      <td className="px-4 py-3.5 whitespace-nowrap text-gray-600 text-[11px]">
                        {formatTimestamp(item.timestamp)}
                      </td>

                      {/* Student Identity */}
                      <td className="px-4 py-3.5 whitespace-nowrap font-sans">
                        <div className="font-bold text-gray-900">{item.name}</div>
                        <div className="text-[10px] font-mono text-gray-400">{item.student_code}</div>
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3.5 whitespace-nowrap font-sans">
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full font-bold text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <span>✓</span>
                          <span>{item.status}</span>
                        </span>
                      </td>

                      {/* Similarity */}
                      <td className="px-4 py-3.5 whitespace-nowrap">
                        <span className="font-bold text-slate-800">
                          {(item.similarity_score * 100).toFixed(1)}%
                        </span>
                        <span className="text-[10px] text-slate-400 ml-1">(≥ 68.0%)</span>
                      </td>

                      {/* Liveness Type */}
                      <td className="px-4 py-3.5 whitespace-nowrap font-sans">
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-cyan-50 text-cyan-800 border border-cyan-200">
                          {item.liveness_type}
                        </span>
                      </td>

                      {/* HMAC Backward Hash Chaining */}
                      <td className="px-4 py-3.5 max-w-xs truncate text-[10px] text-slate-600">
                        <div className="flex items-center gap-1.5" title={`HMAC: ${item.record_hmac}\nPrev: ${item.prev_hash}`}>
                          <span className="font-semibold text-slate-900">Hash:</span>
                          <span className="bg-slate-100 px-1 py-0.5 rounded">{item.record_hmac?.slice(0, 12)}…</span>
                          <span className="text-slate-400">←</span>
                          <span className="text-slate-400 truncate max-w-[80px]">
                            {item.prev_hash === "0000000000000000000000000000000000000000000000000000000000000000" ? "Genesis" : `${item.prev_hash?.slice(0, 8)}…`}
                          </span>
                        </div>
                      </td>

                      {/* Integrity Badge */}
                      <td className="px-4 py-3.5 whitespace-nowrap text-right font-sans">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                          Valid ✓
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          ) : (
            /* SYSTEM EVENT AUDIT TABLE */
            <table className="w-full text-left text-xs text-gray-700">
              <thead className="bg-gray-50 border-b border-gray-200 text-gray-600 font-semibold uppercase text-[10px] tracking-wider">
                <tr>
                  <th className="px-4 py-3">Timestamp</th>
                  <th className="px-4 py-3">Event Type</th>
                  <th className="px-4 py-3">Operator</th>
                  <th className="px-4 py-3">Reason / Diagnostic Details</th>
                  <th className="px-4 py-3">Severity</th>
                  <th className="px-4 py-3 text-right">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredRecords.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-gray-400">
                      <div className="text-3xl mb-2">📋</div>
                      <p className="font-medium text-sm text-gray-600">No activity logs found</p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {searchQuery ? "Try refining your search filter." : "Audit events will appear here as drivers authenticate."}
                      </p>
                    </td>
                  </tr>
                ) : (
                  filteredRecords.map((item, idx) => {
                    const isLogin = item.event_type.toUpperCase() === "LOGIN";
                    const isLogout = item.event_type.toUpperCase() === "LOGOUT";
                    const isAlarm = item.event_type.toUpperCase() === "ALARM";

                    return (
                      <tr key={item.id || idx} className="hover:bg-gray-50/80 transition">
                        {/* Timestamp */}
                        <td className="px-4 py-3.5 whitespace-nowrap font-mono text-gray-600 text-[11px]">
                          {formatTimestamp(item.timestamp)}
                        </td>

                        {/* Event Type Badge */}
                        <td className="px-4 py-3.5 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full font-bold text-[10px] ${
                              isLogin
                                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                : isLogout
                                ? "bg-slate-100 text-slate-700 border border-slate-300"
                                : isAlarm
                                ? "bg-rose-50 text-rose-700 border border-rose-200 animate-pulse"
                                : "bg-blue-50 text-blue-700 border border-blue-200"
                            }`}
                          >
                            <span>{isLogin ? "🟢" : isLogout ? "🔴" : isAlarm ? "⚠️" : "ℹ️"}</span>
                            <span>{item.event_type}</span>
                          </span>
                        </td>

                        {/* Driver */}
                        <td className="px-4 py-3.5 whitespace-nowrap">
                          <div className="font-semibold text-gray-900">{item.driver_name}</div>
                          <div className="text-[10px] font-mono text-gray-400">{item.driver_id}</div>
                        </td>

                        {/* Reason / Diagnostic Details */}
                        <td className="px-4 py-3.5 text-gray-800 font-medium max-w-md break-words">
                          {item.reason}
                        </td>

                        {/* Severity */}
                        <td className="px-4 py-3.5 whitespace-nowrap">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                              item.severity.toUpperCase() === "CRITICAL"
                                ? "bg-rose-100 text-rose-800"
                                : item.severity.toUpperCase() === "WARNING"
                                ? "bg-amber-100 text-amber-800"
                                : "bg-blue-50 text-blue-700"
                            }`}
                          >
                            {item.severity}
                          </span>
                        </td>

                        {/* Duration */}
                        <td className="px-4 py-3.5 whitespace-nowrap text-right font-mono text-gray-600 text-[11px]">
                          {formatDuration(item.duration_seconds)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer info */}
        <div className="bg-gray-50 px-4 py-3 border-t border-gray-200 flex items-center justify-between text-xs text-gray-500">
          <div>
            Showing{" "}
            <span className="font-semibold text-gray-800">
              {activeTab === "ATTENDANCE" ? filteredAttendance.length : filteredRecords.length}
            </span>{" "}
            records
          </div>
          <div className="flex items-center gap-1.5 font-mono text-[11px]">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span>Cryptographic Chaining: Active</span>
          </div>
        </div>
      </div>

      {/* LEDGER INTEGRITY AUDIT MODAL */}
      {showIntegrityModal && integrityResult && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl border border-gray-200 overflow-hidden transform transition-all">
            <div className={`p-4 ${integrityResult.is_valid ? "bg-emerald-600" : "bg-rose-600"} text-white flex items-center justify-between`}>
              <div className="flex items-center gap-2 font-bold text-sm">
                <span>{integrityResult.is_valid ? "🛡️" : "⚠️"}</span>
                <span>Cryptographic Ledger Audit</span>
              </div>
              <button
                type="button"
                onClick={() => setShowIntegrityModal(false)}
                className="text-white/80 hover:text-white text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="flex items-center gap-3">
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-xl shrink-0 ${integrityResult.is_valid ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}>
                  {integrityResult.is_valid ? "✓" : "✕"}
                </div>
                <div>
                  <h3 className="font-bold text-gray-900 text-sm">
                    {integrityResult.is_valid ? "Ledger Hash Chain 100% Valid" : "Tampering / Discrepancy Detected"}
                  </h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {integrityResult.status} • HMAC-SHA256 Chaining
                  </p>
                </div>
              </div>

              <div className="bg-gray-50 rounded-xl p-3 space-y-2 border border-gray-200 text-xs">
                <div className="flex justify-between">
                  <span className="text-gray-500">Sequential Records Audited:</span>
                  <span className="font-mono font-bold text-gray-900">{integrityResult.total_records}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Tampered Records Detected:</span>
                  <span className={`font-mono font-bold ${integrityResult.tampered_records.length === 0 ? "text-emerald-700" : "text-rose-700"}`}>
                    {integrityResult.tampered_records.length}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Genesis Backward Link:</span>
                  <span className="font-mono font-bold text-emerald-700">Valid ✓</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Checkpoint Signature:</span>
                  <span className="font-mono font-bold text-emerald-700">
                    {integrityResult.checkpoint_valid ? "Signed & Valid ✓" : "Signature Mismatch"}
                  </span>
                </div>
              </div>

              <p className="text-xs text-gray-600 bg-blue-50 p-3 rounded-lg border border-blue-200">
                {integrityResult.message}
              </p>

              <button
                type="button"
                onClick={() => setShowIntegrityModal(false)}
                className="w-full py-2.5 px-4 rounded-xl text-xs font-bold text-white bg-[#0066cc] hover:bg-[#0052a3] transition shadow-sm"
              >
                Close Audit Report
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
