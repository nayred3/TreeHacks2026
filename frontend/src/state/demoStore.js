import { useState } from "react";

export function useDemoStore() {
  const [isRunning, setIsRunning] = useState(false);

  const [debug, setDebug] = useState({
    showLabels: true,
    showAssignments: true,
    showDetections: false,
  });

  function startDemo() {
    setIsRunning(true);
  }

  function resetDemo() {
    setIsRunning(false);
  }

  function toggle(key) {
    setDebug((d) => ({ ...d, [key]: !d[key] }));
  }

  return { isRunning, debug, startDemo, resetDemo, toggle };
}
