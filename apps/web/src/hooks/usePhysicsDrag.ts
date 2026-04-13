// Physics-based drag hook — thread dangles from cursor with spring physics
// Creates a natural swinging/dangling effect when dragging threads between folders

import { useCallback, useRef, useState, useEffect } from "react";

interface PhysicsState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angularVelocity: number;
}

interface DragState {
  isDragging: boolean;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  physics: PhysicsState;
  draggedId: string | null;
}

const SPRING_STIFFNESS = 0.15;
const DAMPING = 0.85;
const GRAVITY = 0.3;
const PENDULUM_LENGTH = 24;
const ANGULAR_DAMPING = 0.92;

export function usePhysicsDrag(onDrop?: (itemId: string, targetId: string) => void) {
  const [dragState, setDragState] = useState<DragState>({
    isDragging: false,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    physics: { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angularVelocity: 0 },
    draggedId: null,
  });

  const rafRef = useRef<number>(0);
  const stateRef = useRef(dragState);
  stateRef.current = dragState;

  const prevMouseRef = useRef({ x: 0, y: 0 });
  const mouseVelocityRef = useRef({ x: 0, y: 0 });

  // Physics simulation loop
  const simulate = useCallback(() => {
    const s = stateRef.current;
    if (!s.isDragging) return;

    // Mouse velocity for pendulum swing
    const mx = s.currentX - prevMouseRef.current.x;
    const my = s.currentY - prevMouseRef.current.y;
    mouseVelocityRef.current = { x: mx, y: my };
    prevMouseRef.current = { x: s.currentX, y: s.currentY };

    // Pendulum physics — angle driven by horizontal mouse acceleration
    const horizontalForce = -mx * 0.02;
    const gravityForce = -Math.sin(s.physics.angle) * GRAVITY * 0.1;
    const newAngularVelocity = (s.physics.angularVelocity + horizontalForce + gravityForce) * ANGULAR_DAMPING;
    const newAngle = s.physics.angle + newAngularVelocity;

    // Clamp angle
    const clampedAngle = Math.max(-Math.PI / 4, Math.min(Math.PI / 4, newAngle));

    // Spring following cursor
    const targetX = s.currentX + Math.sin(clampedAngle) * PENDULUM_LENGTH;
    const targetY = s.currentY + Math.cos(clampedAngle) * PENDULUM_LENGTH;

    const dx = targetX - s.physics.x;
    const dy = targetY - s.physics.y;

    const newVx = (s.physics.vx + dx * SPRING_STIFFNESS) * DAMPING;
    const newVy = (s.physics.vy + dy * SPRING_STIFFNESS) * DAMPING;

    setDragState((prev) => ({
      ...prev,
      physics: {
        x: prev.physics.x + newVx,
        y: prev.physics.y + newVy,
        vx: newVx,
        vy: newVy,
        angle: clampedAngle,
        angularVelocity: newAngularVelocity,
      },
    }));

    rafRef.current = requestAnimationFrame(simulate);
  }, []);

  const startDrag = useCallback(
    (e: React.MouseEvent, itemId: string) => {
      e.preventDefault();
      setDragState({
        isDragging: true,
        startX: e.clientX,
        startY: e.clientY,
        currentX: e.clientX,
        currentY: e.clientY,
        physics: {
          x: e.clientX,
          y: e.clientY + PENDULUM_LENGTH,
          vx: 0,
          vy: 0,
          angle: 0,
          angularVelocity: 0,
        },
        draggedId: itemId,
      });
      prevMouseRef.current = { x: e.clientX, y: e.clientY };
      rafRef.current = requestAnimationFrame(simulate);
    },
    [simulate],
  );

  const updateDrag = useCallback((e: MouseEvent) => {
    setDragState((prev) => {
      if (!prev.isDragging) return prev;
      return { ...prev, currentX: e.clientX, currentY: e.clientY };
    });
  }, []);

  const endDrag = useCallback(
    (e: MouseEvent) => {
      cancelAnimationFrame(rafRef.current);

      const s = stateRef.current;
      if (!s.isDragging || !s.draggedId) {
        setDragState((prev) => ({ ...prev, isDragging: false, draggedId: null }));
        return;
      }

      // Find drop target
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const dropZone = target?.closest("[data-drop-zone]");
      const targetId = dropZone?.getAttribute("data-drop-zone");

      if (targetId && onDrop) {
        onDrop(s.draggedId, targetId);
      }

      setDragState((prev) => ({ ...prev, isDragging: false, draggedId: null }));
    },
    [onDrop],
  );

  useEffect(() => {
    if (dragState.isDragging) {
      window.addEventListener("mousemove", updateDrag);
      window.addEventListener("mouseup", endDrag);
      return () => {
        window.removeEventListener("mousemove", updateDrag);
        window.removeEventListener("mouseup", endDrag);
      };
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [dragState.isDragging, updateDrag, endDrag]);

  return {
    isDragging: dragState.isDragging,
    draggedId: dragState.draggedId,
    cursorX: dragState.currentX,
    cursorY: dragState.currentY,
    physicsX: dragState.physics.x,
    physicsY: dragState.physics.y,
    angle: dragState.physics.angle,
    startDrag,
  };
}

// ─── Drag Ghost Component ────────────────────────────────────────────────────

interface DragGhostProps {
  readonly visible: boolean;
  readonly cursorX: number;
  readonly cursorY: number;
  readonly physicsX: number;
  readonly physicsY: number;
  readonly angle: number;
  readonly label: string;
}

export function DragGhost({ visible, cursorX, cursorY, physicsX, physicsY, angle, label }: DragGhostProps) {
  if (!visible) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[9999]">
      {/* String from cursor to ghost */}
      <svg className="absolute inset-0 h-full w-full">
        <line
          x1={cursorX}
          y1={cursorY}
          x2={physicsX}
          y2={physicsY}
          stroke="currentColor"
          strokeWidth="1"
          className="text-primary/40"
        />
      </svg>

      {/* Dangling ghost card */}
      <div
        className="absolute -translate-x-1/2 rounded-md border border-primary/30 bg-card/90 px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur-sm"
        style={{
          left: physicsX,
          top: physicsY,
          transform: `translate(-50%, 0) rotate(${angle * (180 / Math.PI) * 0.5}deg)`,
          transformOrigin: "top center",
        }}
      >
        <span className="text-primary">{label}</span>
      </div>

      {/* Cursor attachment point */}
      <div
        className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/60"
        style={{ left: cursorX, top: cursorY }}
      />
    </div>
  );
}
