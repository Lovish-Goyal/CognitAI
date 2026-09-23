"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import EntranceGateway from "../components/EntranceGateway";
import { useMonitoring } from "../context/MonitoringContext";

export default function EntrancePage() {
  const router = useRouter();
  const { currentDriver } = useMonitoring();

  useEffect(() => {
    if (currentDriver) {
      router.push("/");
    }
  }, [currentDriver, router]);

  return <EntranceGateway />;
}
