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

export default function HistoryPage() {
  const { currentDriver, isMonitoring } = useMonitoring();
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [filterType, setFilterType] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [dbSource, setDbSource] = useState<string>("mongodb");

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/audit-history?limit=100`);
      const data = await res.json();
      if (data && Array.isArray(data.history)) {
        setRecords(data.history);
        setDbSource(data.source || "database");
      }
    } catch {
      // In case of error keep existing
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
    const interval = setInterval(fetchHistory, 10000); // Polling every 10s
    return () => clearInterval(interval);
  }, [fetchHistory]);

  // Filtered records
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
    return { logins, logouts, alarms, total: records.length };
  }, [records]);

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
              Biometric Trail
            </span>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            Tamper-evident logs of driver authentications, session terminations, and real-time safety alarm events.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={fetchHistory}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 shadow-sm transition"
          >
            <span>🔄</span>
            <span>{loading ? "Refreshing..." : "Refresh Logs"}</span>
          </button>
          <div className="text-xs text-gray-400 font-mono bg-gray-50 px-2.5 py-1.5 rounded-lg border border-gray-200">
            Source: <span className="font-semibold text-gray-700 uppercase">{dbSource}</span>
          </div>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 my-6">
        <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wider">Total Logins</div>
          <div className="text-2xl font-extrabold text-emerald-600 mt-1 flex items-center justify-between">
            <span>{stats.logins}</span>
            <span className="text-sm px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
              Verified
            </span>
          </div>
          <p className="text-[11px] text-gray-400 mt-1">Biometric face scans &amp; logins</p>
        </div>

        <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wider">Total Logouts</div>
          <div className="text-2xl font-extrabold text-slate-700 mt-1 flex items-center justify-between">
            <span>{stats.logouts}</span>
            <span className="text-sm px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
              Terminated
            </span>
          </div>
          <p className="text-[11px] text-gray-400 mt-1">Manual stops &amp; sign-outs</p>
        </div>

        <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wider">Alarms Triggered</div>
          <div className="text-2xl font-extrabold text-rose-600 mt-1 flex items-center justify-between">
            <span>{stats.alarms}</span>
            <span className="text-sm px-2 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200">
              Critical
            </span>
          </div>
          <p className="text-[11px] text-gray-400 mt-1">Microsleep, head drop &amp; distraction</p>
        </div>

        <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wider">Current Operator</div>
          <div className="text-sm font-bold text-gray-900 mt-1 truncate">
            {currentDriver?.display_name || "No Active Session"}
          </div>
          <div className="text-[11px] text-gray-500 mt-1 flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${isMonitoring ? "bg-emerald-500 animate-pulse" : "bg-gray-400"}`} />
            <span>{isMonitoring ? "Monitoring Active" : "Session Paused"}</span>
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 mb-6 bg-gray-50 p-2.5 rounded-xl border border-gray-200">
        {/* Filter Pills */}
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

        {/* Search Input */}
        <div className="relative min-w-[240px]">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by driver, ID, or reason..."
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
        </div>

        {/* Footer info */}
        <div className="bg-gray-50 px-4 py-3 border-t border-gray-200 flex items-center justify-between text-xs text-gray-500">
          <div>
            Showing <span className="font-semibold text-gray-800">{filteredRecords.length}</span> of{" "}
            <span className="font-semibold text-gray-800">{records.length}</span> recorded events
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span>Audit Trail Sync</span>
          </div>
        </div>
      </div>
    </div>
  );
}
