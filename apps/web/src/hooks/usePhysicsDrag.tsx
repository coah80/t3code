import { useCallback, useEffect, useRef, useState } from "react";

interface PhysicsState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angularVelocity: number;
}

interface DragState {
  phase: "idle" | "pending" | "dragging";
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  physics: PhysicsState;
  draggedId: string | null;
  dropTargetId: string | null;
}

interface PointerMotionState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  time: number;
}

const INITIAL_PHYSICS_STATE: PhysicsState = {
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  angle: 0,
  angularVelocity: 0,
};

const INITIAL_DRAG_STATE: DragState = {
  phase: "idle",
  startX: 0,
  startY: 0,
  currentX: 0,
  currentY: 0,
  physics: INITIAL_PHYSICS_STATE,
  draggedId: null,
  dropTargetId: null,
};

const SPRING_STIFFNESS = 0.12;
const DAMPING = 0.9;
const GRAVITY = 0.36;
const BASE_PENDULUM_LENGTH = 34;
const MAX_PENDULUM_STRETCH = 24;
const ANGULAR_DAMPING = 0.97;
const ANGULAR_SWING_FORCE = 0.0032;
const VERTICAL_SWING_FORCE = 0.0011;
const MAX_SWING_ANGLE = Math.PI * 0.72;
const DRAG_ACTIVATION_DISTANCE = 6;

const INITIAL_POINTER_MOTION: PointerMotionState = {
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  speed: 0,
  time: 0,
};

function resolveDropTargetId(clientX: number, clientY: number) {
  const target = document.elementFromPoint(clientX, clientY);
  const dropZone = target?.closest("[data-drop-zone]");
  return dropZone?.getAttribute("data-drop-zone") ?? null;
}

export function usePhysicsDrag(onDrop?: (itemId: string, targetId: string) => void) {
  const [dragState, setDragState] = useState<DragState>(INITIAL_DRAG_STATE);
  const dragStateRef = useRef(dragState);
  dragStateRef.current = dragState;

  const rafRef = useRef<number>(0);
  const pointerMotionRef = useRef<PointerMotionState>(INITIAL_POINTER_MOTION);
  const suppressClickRef = useRef(false);

  const setDragStateWithRef = useCallback(
    (nextState: DragState | ((previousState: DragState) => DragState)) => {
      setDragState((previousState) => {
        const resolvedState =
          typeof nextState === "function" ? nextState(previousState) : nextState;
        dragStateRef.current = resolvedState;
        return resolvedState;
      });
    },
    [],
  );

  const stopSimulation = useCallback(() => {
    if (rafRef.current !== 0) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
  }, []);

  const simulate = useCallback(() => {
    const currentState = dragStateRef.current;
    if (currentState.phase !== "dragging") {
      return;
    }

    const motion = pointerMotionRef.current;
    const ropeLength = BASE_PENDULUM_LENGTH + Math.min(motion.speed * 0.08, MAX_PENDULUM_STRETCH);
    const horizontalForce = -motion.vx * ANGULAR_SWING_FORCE;
    const verticalForce = motion.vy * VERTICAL_SWING_FORCE;
    const gravityForce = -Math.sin(currentState.physics.angle) * GRAVITY;
    const angularVelocity =
      (currentState.physics.angularVelocity + horizontalForce + verticalForce + gravityForce) *
      ANGULAR_DAMPING;
    const unclampedAngle = currentState.physics.angle + angularVelocity;
    const angle = Math.max(-MAX_SWING_ANGLE, Math.min(MAX_SWING_ANGLE, unclampedAngle));

    const targetX = currentState.currentX + Math.sin(angle) * ropeLength;
    const targetY = currentState.currentY + Math.cos(angle) * ropeLength;
    const dx = targetX - currentState.physics.x;
    const dy = targetY - currentState.physics.y;
    const vx = (currentState.physics.vx + dx * SPRING_STIFFNESS) * DAMPING;
    const vy = (currentState.physics.vy + dy * SPRING_STIFFNESS) * DAMPING;

    pointerMotionRef.current = {
      ...motion,
      vx: motion.vx * 0.92,
      vy: motion.vy * 0.92,
      speed: motion.speed * 0.92,
    };

    setDragStateWithRef((previousState) => ({
      ...previousState,
      physics: {
        x: previousState.physics.x + vx,
        y: previousState.physics.y + vy,
        vx,
        vy,
        angle,
        angularVelocity,
      },
    }));

    rafRef.current = requestAnimationFrame(simulate);
  }, [setDragStateWithRef]);

  const startDrag = useCallback(
    (event: React.MouseEvent, itemId: string) => {
      if (event.button !== 0) {
        return;
      }

      suppressClickRef.current = false;
      pointerMotionRef.current = {
        ...INITIAL_POINTER_MOTION,
        x: event.clientX,
        y: event.clientY,
        time: performance.now(),
      };
      stopSimulation();
      const nextState: DragState = {
        phase: "pending",
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
        physics: {
          ...INITIAL_PHYSICS_STATE,
          x: event.clientX,
          y: event.clientY + BASE_PENDULUM_LENGTH,
        },
        draggedId: itemId,
        dropTargetId: null,
      };
      dragStateRef.current = nextState;
      setDragState(nextState);
    },
    [stopSimulation],
  );

  const updateDrag = useCallback(
    (event: MouseEvent) => {
      const currentState = dragStateRef.current;
      if (currentState.phase === "idle") {
        return;
      }

      const now = performance.now();
      const previousPointer = pointerMotionRef.current;
      const frameDuration = Math.max(now - previousPointer.time, 8);
      const frameScale = 16.67 / frameDuration;
      const vx = (event.clientX - previousPointer.x) * frameScale;
      const vy = (event.clientY - previousPointer.y) * frameScale;
      pointerMotionRef.current = {
        x: event.clientX,
        y: event.clientY,
        vx,
        vy,
        speed: Math.hypot(vx, vy),
        time: now,
      };

      if (currentState.phase === "pending") {
        const deltaX = event.clientX - currentState.startX;
        const deltaY = event.clientY - currentState.startY;
        if (Math.hypot(deltaX, deltaY) < DRAG_ACTIVATION_DISTANCE) {
          return;
        }

        const nextState: DragState = {
          ...currentState,
          phase: "dragging",
          currentX: event.clientX,
          currentY: event.clientY,
          physics: {
            ...INITIAL_PHYSICS_STATE,
            x: event.clientX,
            y: event.clientY + BASE_PENDULUM_LENGTH,
          },
          dropTargetId: resolveDropTargetId(event.clientX, event.clientY),
        };
        dragStateRef.current = nextState;
        setDragState(nextState);
        rafRef.current = requestAnimationFrame(simulate);
        return;
      }

      setDragStateWithRef((previousState) => ({
        ...previousState,
        currentX: event.clientX,
        currentY: event.clientY,
        dropTargetId: resolveDropTargetId(event.clientX, event.clientY),
      }));
    },
    [setDragStateWithRef, simulate],
  );

  const endDrag = useCallback(
    (event: MouseEvent) => {
      stopSimulation();
      const currentState = dragStateRef.current;
      if (currentState.phase === "dragging" && currentState.draggedId) {
        suppressClickRef.current = true;
        const dropTargetId = resolveDropTargetId(event.clientX, event.clientY);
        if (dropTargetId && onDrop) {
          onDrop(currentState.draggedId, dropTargetId);
        }
      }

      dragStateRef.current = INITIAL_DRAG_STATE;
      setDragState(INITIAL_DRAG_STATE);
    },
    [onDrop, stopSimulation],
  );

  useEffect(() => {
    if (dragState.phase === "idle") {
      return;
    }

    window.addEventListener("mousemove", updateDrag);
    window.addEventListener("mouseup", endDrag);
    return () => {
      window.removeEventListener("mousemove", updateDrag);
      window.removeEventListener("mouseup", endDrag);
    };
  }, [dragState.phase, endDrag, updateDrag]);

  useEffect(() => {
    if (dragState.phase !== "dragging") {
      return;
    }

    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.userSelect = previousUserSelect;
    };
  }, [dragState.phase]);

  useEffect(() => stopSimulation, [stopSimulation]);

  const consumeClickSuppression = useCallback(() => {
    const shouldSuppress = suppressClickRef.current;
    suppressClickRef.current = false;
    return shouldSuppress;
  }, []);

  return {
    isDragging: dragState.phase === "dragging",
    draggedId: dragState.draggedId,
    cursorX: dragState.currentX,
    cursorY: dragState.currentY,
    physicsX: dragState.physics.x,
    physicsY: dragState.physics.y,
    angle: dragState.physics.angle,
    activeDropTargetId: dragState.dropTargetId,
    consumeClickSuppression,
    startDrag,
  };
}

interface DragGhostProps {
  readonly visible: boolean;
  readonly cursorX: number;
  readonly cursorY: number;
  readonly physicsX: number;
  readonly physicsY: number;
  readonly angle: number;
  readonly label: string;
}

export function DragGhost({
  visible,
  cursorX,
  cursorY,
  physicsX,
  physicsY,
  angle,
  label,
}: DragGhostProps) {
  if (!visible) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-[9999]">
      <svg className="absolute inset-0 h-full w-full">
        {(() => {
          const dx = physicsX - cursorX;
          const dy = physicsY - cursorY;
          const distance = Math.hypot(dx, dy);
          const perpendicularX = distance > 0 ? -dy / distance : 0;
          const perpendicularY = distance > 0 ? dx / distance : 0;
          const bend = Math.sin(angle) * Math.min(32, distance * 0.35);
          const controlX = (cursorX + physicsX) / 2 + perpendicularX * bend;
          const controlY = (cursorY + physicsY) / 2 + perpendicularY * bend;
          const path = `M ${cursorX} ${cursorY} Q ${controlX} ${controlY} ${physicsX} ${physicsY}`;

          return (
            <>
              <path
                d={path}
                stroke="currentColor"
                strokeWidth="1.25"
                fill="none"
                strokeLinecap="round"
                className="text-primary/30"
              />
              <path
                d={path}
                stroke="currentColor"
                strokeWidth="0.6"
                fill="none"
                strokeLinecap="round"
                className="text-primary/55"
                strokeDasharray="2 3"
              />
            </>
          );
        })()}
      </svg>

      <div
        className="absolute -translate-x-1/2 rounded-xl border border-primary/25 bg-card/92 px-3 py-1.5 text-xs font-medium text-foreground shadow-xl shadow-primary/10 backdrop-blur-sm"
        style={{
          left: physicsX,
          top: physicsY,
          transform: `translate(-50%, 0) rotate(${angle * (180 / Math.PI) * 0.4}deg)`,
          transformOrigin: "top center",
        }}
      >
        {label}
      </div>

      <div
        className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/75 shadow-[0_0_18px_rgba(255,255,255,0.18)]"
        style={{ left: cursorX, top: cursorY }}
      />
    </div>
  );
}
